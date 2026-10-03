import { MODULE_BY_KEY } from '@/data/modules'
import {
  ACTION as CP_ACTION,
  CHECKPOINT_KEY,
  STATUS as CP_STATUS,
  guardAction,
  isAbnormal,
  isPending,
  normalizeFireTaken,
  normalizeVehicles,
} from '@/data/checkpoint-rules'
import { allRows, listRows, refreshRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 同一时刻只允许一个动作落库：两个值守端（含双击/双标签页）并发提交，只有第一个生效。
const inFlight = new Set<string>()

const DUTY_KEY = 'duty'
const RELIEF_CODE_PREFIX = 'CHEC-RELIEF-'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function reliefCode(checkpointId: number): string {
  return `${RELIEF_CODE_PREFIX}${String(checkpointId).padStart(4, '0')}`
}

/**
 * 检查站读模型：通行车辆数/收缴火种数强制钳制到合法区间，
 * 「运行状态」列与真实 status 保持一致——升级入口、站点导航、通行面板读的是同一份数据。
 */
function presentCheckpoint(row: EntryRow): EntryRow {
  const vehicles = normalizeVehicles(row['通行车辆数'])
  const closed = String(row.status) === CP_STATUS.closed
  const fireTaken = closed ? 0 : normalizeFireTaken(row['收缴火种数'], vehicles)
  return {
    ...row,
    '通行车辆数': vehicles,
    '收缴火种数': fireTaken,
    '运行状态': row.status,
    pending: isPending(String(row.status)),
    abnormal: isAbnormal(String(row.status)),
  }
}

/** 旧数据（含文本样例值）首次读取时就地修正并落库，保证后续所有面板拿到的都是合法值。 */
function reconcileCheckpoint(): EntryRow[] {
  const raw = listRows(CHECKPOINT_KEY)
  let changed = false
  const fixed = raw.map((row) => {
    const presented = presentCheckpoint(row)
    if (
      presented['通行车辆数'] !== row['通行车辆数'] ||
      presented['收缴火种数'] !== row['收缴火种数'] ||
      presented['运行状态'] !== row['运行状态'] ||
      presented.pending !== row.pending ||
      presented.abnormal !== row.abnormal
    ) {
      changed = true
    }
    return presented
  })
  if (changed) {
    saveRows(CHECKPOINT_KEY, fixed)
  }
  return changed ? listRows(CHECKPOINT_KEY) : fixed
}

/**
 * 换岗待办联动：每个「等待换岗」站点在值勤排班里对应一条待办；
 * 换岗完成 -> 已交接；关闭站点 -> 已调班（待办撤销）。
 * 其他模块的待办必须跟着检查站状态变化，不能残留。
 *
 * @param checkpoints 刚落库的检查站快照；必须由调用方传入，不能在这里再读缓存——
 * saveAll 为防旧快照覆盖会刷新缓存，动作执行期间读缓存可能拿到陈旧种子数据。
 */
function reconcileReliefTodos(checkpointsOverride?: EntryRow[]): EntryRow[] {
  const checkpoints = checkpointsOverride ?? listRows(CHECKPOINT_KEY)
  const duty = [...listRows(DUTY_KEY)]

  for (const cp of checkpoints) {
    const code = reliefCode(Number(cp.id))
    const idx = duty.findIndex((row) => String(row['排班编号']) === code)
    const stationName = String(cp['站点位置'] ?? cp['站点编号'] ?? cp.id)

    if (String(cp.status) === CP_STATUS.awaitingRelief) {
      const todo: EntryRow = {
        // 同一站点的待办永远是同一条：再次换岗复用旧记录（含已交接/已调班的终态行），
        // 只有从未生成过时才取新 id。
        id: idx >= 0 ? duty[idx].id : nextReliefId(duty),
        status: '待确认',
        pending: true,
        abnormal: false,
        version: idx >= 0 ? (duty[idx].version ?? 0) + 1 : 1,
        sourceModule: CHECKPOINT_KEY,
        sourceId: Number(cp.id),
        '排班编号': code,
        '值勤日期': String(cp['值班日期'] ?? ''),
        '值勤时段': '待接班',
        '值勤岗位': `防火检查站 ${stationName}`,
        '值勤人员': String(cp['值守人员'] ?? ''),
        '接班人员': '待安排',
        '交接记录': '检查站发起换岗，等待值守端确认交接',
        '排班状态': '待确认',
      }
      if (idx >= 0) {
        if (duty[idx].status !== '待确认') {
          duty[idx] = { ...duty[idx], ...todo, id: duty[idx].id }
        }
      } else {
        duty.push(todo)
      }
    } else if (idx >= 0) {
      // 站点离开等待换岗：完成换岗记已交接；关闭等撤销情形记已调班，待办随之消失。
      const done = String(cp.status) === CP_STATUS.normal
      const target = done ? '已交接' : '已调班'
      if (duty[idx].status !== target) {
        duty[idx] = {
          ...duty[idx],
          status: target,
          pending: false,
          abnormal: target === '已调班',
          version: (duty[idx].version ?? 0) + 1,
          '排班状态': target,
          '交接记录': done
            ? '检查站换岗已完成，值守交接闭环'
            : '检查站关闭或变更检查等级，换岗待办撤销',
        }
      }
    }
  }

  // 纯计算：返回值勤排班的最新快照，由调用方和检查站状态在同一事务里落库。
  return duty
}

function nextReliefId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === CHECKPOINT_KEY) {
    const items = reconcileCheckpoint()
    const matched = filterRows(items, filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length }
  }
  if (key === DUTY_KEY) {
    // 先确保换岗待办已生成，再展示值勤排班。
    const cpRows = reconcileCheckpoint()
    const dutyRows = reconcileReliefTodos(cpRows)
    // 仅在确有变更时落库（例如旧库里从未生成过待办）。
    const existing = listRows(DUTY_KEY)
    if (JSON.stringify(existing) !== JSON.stringify(dutyRows)) {
      saveRows(DUTY_KEY, dutyRows)
    }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedVersion?: number,
): ActionResult {
  const meta = moduleMeta(key)
  const lockKey = `${key}:${id}:${action}`
  if (inFlight.has(lockKey)) {
    return { ok: false, message: '该操作正在提交，请勿重复操作' }
  }
  inFlight.add(lockKey)
  try {
    if (key === CHECKPOINT_KEY) {
      return runCheckpointAction(meta, id, action, expectedVersion)
    }
    return runGenericAction(meta, id, action, expectedVersion)
  } finally {
    inFlight.delete(lockKey)
  }
}

function checkVersion(row: EntryRow | undefined, expectedVersion?: number): ActionResult | null {
  if (!row) {
    return null
  }
  const currentVersion = row.version ?? 0
  // 行上已有版本号时，调用方必须携带匹配版本（双击、两个值守端并发都靠它拦住）；
  // 只有旧数据（从未带过版本）且调用方也没传时，才放行兼容。
  if (expectedVersion === undefined && row.version === undefined) {
    return null
  }
  if (expectedVersion !== currentVersion) {
    return {
      ok: false,
      message: '站点状态已被另一值守端更新，请刷新后按最新状态操作',
    }
  }
  return null
}

function runGenericAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  expectedVersion?: number,
): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 乐观锁校验前强制重读持久层：防止用本端旧快照把另一值守端的提交覆盖掉。
  const rows = refreshRows()[meta.key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 先校验版本，再判幂等：否则同一行已被另一端改成同目标状态时，
  // 旧快照请求会被幂等分支“静默成功”，等于并发两次都生效。
  const conflict = checkVersion(rows[index], expectedVersion)
  if (conflict) {
    return conflict
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    version: (rows[index].version ?? 0) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(meta.key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runCheckpointAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  expectedVersion?: number,
): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const snapshot = refreshRows()
  const rows = [...(snapshot[CHECKPOINT_KEY] ?? [])]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  // 先版本后幂等：旧快照发起的重复动作不能在另一端已生效后再次成功。
  const conflict = checkVersion(current, expectedVersion)
  if (conflict) {
    return conflict
  }

  // 先判定、后变更：守卫不通过就整体返回，不写任何数据、不留任何副作用（失败可安全重试）。
  const denied = guardAction(action, presentCheckpoint(current))
  if (denied) {
    return { ok: false, message: denied }
  }
  if (String(current.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const closed = target === CP_STATUS.closed
  const vehicles = normalizeVehicles(current['通行车辆数'])
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: isPending(target),
    abnormal: isAbnormal(target),
    version: (current.version ?? 0) + 1,
    // 关闭即停止检查：通行与缴获计数必须清零，不能把火种数带进关闭态。
    '通行车辆数': closed ? 0 : vehicles,
    '收缴火种数': closed ? 0 : normalizeFireTaken(current['收缴火种数'], vehicles),
    '运行状态': target,
  }
  rows[index] = updated

  // 检查站状态与值勤待办在同一快照提交：要么一起生效，要么一起不生效。
  // 用刚组装好的 rows 计算待办，避免 saveAll 刷新缓存后读到陈旧种子数据。
  const dutyPatch = reconcileReliefTodos(rows)
  saveAll({ [CHECKPOINT_KEY]: rows, [DUTY_KEY]: dutyPatch })

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  // 检查站与值勤待办先对齐，概览统计才不会和模块页冲突。
  const cpRows = reconcileCheckpoint()
  const dutyRows = reconcileReliefTodos(cpRows)
  if (JSON.stringify(listRows(DUTY_KEY)) !== JSON.stringify(dutyRows)) {
    saveAll({ [CHECKPOINT_KEY]: cpRows, [DUTY_KEY]: dutyRows })
  }
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((item) => {
    const entries = rows[item.key] ?? []
    return {
      name: item.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export { CP_ACTION, CP_STATUS }

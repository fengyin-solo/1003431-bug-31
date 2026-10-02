import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ACTION_ARRANGE_SHIFT,
  ACTION_CLOSE,
  ACTION_UPGRADE,
  ALLOWED_TRANSITIONS,
  CHECKPOINT_KEY,
  DUTY_KEY,
  FIELD_RUN_STATE,
  FIELD_SOURCES,
  FIELD_VEHICLES,
  STATUS_CLOSED,
  STATUS_NORMAL,
  STATUS_WAITING_SHIFT,
  clampCheckpointCounters,
  isCheckpointPending,
  normalizeCheckpointRow,
} from '@/data/checkpoint-rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 值勤排班跨模块联动：检查站发起/关闭换岗时，靠这个字段找到对应的换岗待办。
const LINK_FIELD = '联动站点编号'
const SHIFT_TODO_DONE = new Set(['已交接', '已调班'])
const DUTY_ACTION_HANDOVER = '记录交接'
const DUTY_ACTION_RESCHEDULE = '申请调班'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function fail(message: string, conflict = false): ActionResult {
  return { ok: false, message, conflict }
}

function rowRev(row: EntryRow): number {
  return typeof row.rev === 'number' && Number.isFinite(row.rev) ? Math.trunc(row.rev) : 0
}

/** 乐观锁：页面带着它读到的版本号提交，对不上就说明另一端已经改过，本次提交不生效。 */
function checkRev(row: EntryRow, expectedRev: number | undefined): ActionResult | null {
  if (expectedRev === undefined) {
    return null
  }
  const currentRev = rowRev(row)
  if (currentRev !== expectedRev) {
    return fail(
      `该记录刚被另一端更新（版本 ${expectedRev} → ${currentRev}），本次提交未生效，请按最新状态重试`,
      true,
    )
  }
  return null
}

/** 检查站数据做读时规整：非法状态回落、运行状态字段对齐、车辆/火种数钳到上限内。 */
function ensureCheckpointIntegrity(): void {
  const rows = listRows(CHECKPOINT_KEY)
  let changed = false
  const next = rows.map((row) => {
    const normalized = normalizeCheckpointRow(row)
    if (!normalized) {
      return row
    }
    changed = true
    return normalized
  })
  if (changed) {
    saveRows(CHECKPOINT_KEY, next)
  }
}

function readRows(key: string): EntryRow[] {
  if (key === CHECKPOINT_KEY) {
    ensureCheckpointIntegrity()
  }
  return listRows(key)
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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(readRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 页面按当前状态取可执行动作：关闭的站点拿不到「升级检查」，等待换岗中拿不到重复换岗。 */
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  if (key !== CHECKPOINT_KEY) {
    return meta.actions
  }
  return meta.actions.filter((action) =>
    (ALLOWED_TRANSITIONS[action] ?? []).includes(String(row.status)),
  )
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedRev?: number,
): ActionResult {
  const meta = moduleMeta(key)
  if (!meta.actionTargets[action]) {
    return fail(`${meta.entity}没有登记「${action}」这个动作`)
  }
  if (key === CHECKPOINT_KEY) {
    return runCheckpointAction(id, action, expectedRev)
  }
  if (key === DUTY_KEY) {
    return runDutyAction(id, action, expectedRev)
  }
  return runGenericAction(key, id, action)
}

function runGenericAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  const rows = readRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return fail(`${meta.entity}已经是「${target}」，不用重复操作`)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    rev: rowRev(rows[index]) + 1,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function transitionDenied(action: string, current: string): string {
  if (action === ACTION_UPGRADE && current === STATUS_CLOSED) {
    return '站点已临时关闭，不能升级检查；需先恢复值守后再升级'
  }
  if (action === ACTION_UPGRADE && current === STATUS_WAITING_SHIFT) {
    return '站点正在等待换岗，换岗完成后才能升级检查'
  }
  if (action === ACTION_ARRANGE_SHIFT && current === STATUS_CLOSED) {
    return '站点已临时关闭，不再安排换岗'
  }
  return `当前状态「${current}」下不能执行「${action}」`
}

function runCheckpointAction(
  id: number,
  action: string,
  expectedRev: number | undefined,
): ActionResult {
  const meta = moduleMeta(CHECKPOINT_KEY)
  const target = meta.actionTargets[action]
  ensureCheckpointIntegrity()
  const rows = listRows(CHECKPOINT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const row = rows[index]
  const conflict = checkRev(row, expectedRev)
  if (conflict) {
    return conflict
  }
  const current = String(row.status)
  if (current === target) {
    return fail(`${meta.entity}已经是「${target}」，不用重复操作`)
  }
  if (!ALLOWED_TRANSITIONS[action].includes(current)) {
    return fail(transitionDenied(action, current))
  }

  // 计数先做上限钳制，保证落库值永远在 [0, 上限] 内；火种数不超过车辆数。
  const counters = clampCheckpointCounters(row[FIELD_VEHICLES], row[FIELD_SOURCES])
  const updated: EntryRow = {
    ...row,
    status: target,
    rev: rowRev(row) + 1,
    pending: isCheckpointPending(target),
    abnormal: false,
    [FIELD_RUN_STATE]: target,
    [FIELD_VEHICLES]: counters.vehicles,
    [FIELD_SOURCES]: counters.sources,
  }
  let suffix = ''
  if (action === ACTION_CLOSE) {
    // 站点关闭：本岗车辆通行与火种收缴全部停止，计数清零，避免火种残留到下一岗。
    updated[FIELD_VEHICLES] = 0
    updated[FIELD_SOURCES] = 0
    suffix = cancelShiftTodo(row)
  } else if (action === ACTION_ARRANGE_SHIFT) {
    suffix = createShiftTodo(row)
  }

  const next = [...rows]
  next[index] = updated
  saveRows(CHECKPOINT_KEY, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

function runDutyAction(
  id: number,
  action: string,
  expectedRev: number | undefined,
): ActionResult {
  const meta = moduleMeta(DUTY_KEY)
  const target = meta.actionTargets[action]
  const rows = readRows(DUTY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const row = rows[index]
  const conflict = checkRev(row, expectedRev)
  if (conflict) {
    return conflict
  }
  const current = String(row.status)
  if (current === target) {
    return fail(`${meta.entity}已经是「${target}」，不用重复操作`)
  }

  const terminal = target === '已交接' || target === '已调班'
  const updated: EntryRow = {
    ...row,
    status: target,
    rev: rowRev(row) + 1,
    pending: !terminal,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(DUTY_KEY, next)

  // 换岗待办办完，检查站同步结束「等待换岗」；站点若已被关闭（更严格状态），不重新打开。
  let suffix = ''
  const stationCode = row[LINK_FIELD]
  if (stationCode) {
    if (action === DUTY_ACTION_HANDOVER) {
      suffix = completeShiftArrange(String(stationCode))
    } else if (action === DUTY_ACTION_RESCHEDULE) {
      suffix = cancelShiftArrange(String(stationCode))
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

/** 安排换岗：在值勤排班模块生成一条待确认的换岗待办；已有未办结待办时不重复生成。 */
function createShiftTodo(station: EntryRow): string {
  const stationCode = String(station['站点编号'] ?? '')
  const rows = listRows(DUTY_KEY)
  const exists = rows.some(
    (row) => row[LINK_FIELD] === stationCode && !SHIFT_TODO_DONE.has(String(row.status)),
  )
  if (exists) {
    return ''
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  const todo: EntryRow = {
    id: nextId,
    status: '待确认',
    pending: true,
    abnormal: false,
    rev: 1,
    排班编号: `SW-${stationCode}`,
    值勤日期: today,
    值勤时段: '待排班',
    值勤岗位: `防火检查站（${stationCode}）`,
    值勤人员: String(station['值守人员'] ?? ''),
    接班人员: '待安排',
    交接记录: '检查站发起换岗，等待排班确认',
    排班状态: '待确认',
    [LINK_FIELD]: stationCode,
  }
  saveRows(DUTY_KEY, [...rows, todo])
  return '，值勤排班已生成换岗待办'
}

/** 关闭站点：把该站未办结的换岗待办标记为已调班（撤销换岗），待办随之消失。 */
function cancelShiftTodo(station: EntryRow): string {
  const stationCode = String(station['站点编号'] ?? '')
  const rows = listRows(DUTY_KEY)
  let canceled = 0
  const next = rows.map((row) => {
    if (row[LINK_FIELD] !== stationCode || SHIFT_TODO_DONE.has(String(row.status))) {
      return row
    }
    canceled += 1
    return {
      ...row,
      status: '已调班',
      pending: false,
      rev: rowRev(row) + 1,
      排班状态: '已调班',
      交接记录: '检查站已关闭，换岗安排撤销',
    }
  })
  if (canceled > 0) {
    saveRows(DUTY_KEY, next)
    return '，该站未办结的换岗待办已撤销'
  }
  return ''
}

/** 换岗完成（值勤端记录交接）：检查站回到正常检查，新岗计数从零开始。 */
function completeShiftArrange(stationCode: string): string {
  const rows = listRows(CHECKPOINT_KEY)
  const index = rows.findIndex((row) => String(row['站点编号']) === stationCode)
  if (index < 0 || rows[index].status !== STATUS_WAITING_SHIFT) {
    return ''
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: STATUS_NORMAL,
    rev: rowRev(rows[index]) + 1,
    pending: false,
    abnormal: false,
    [FIELD_RUN_STATE]: STATUS_NORMAL,
    [FIELD_VEHICLES]: 0,
    [FIELD_SOURCES]: 0,
  }
  saveRows(CHECKPOINT_KEY, next)
  return '，检查站已完成换岗并恢复正常检查'
}

/** 换岗待办被申请调班：检查站取消等待，回到正常检查；已关闭则保持关闭。 */
function cancelShiftArrange(stationCode: string): string {
  const rows = listRows(CHECKPOINT_KEY)
  const index = rows.findIndex((row) => String(row['站点编号']) === stationCode)
  if (index < 0 || rows[index].status !== STATUS_WAITING_SHIFT) {
    return ''
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: STATUS_NORMAL,
    rev: rowRev(rows[index]) + 1,
    pending: false,
    [FIELD_RUN_STATE]: STATUS_NORMAL,
  }
  saveRows(CHECKPOINT_KEY, next)
  return '，检查站已取消等待换岗'
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of readRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
  ensureCheckpointIntegrity()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    const pending =
      meta.key === CHECKPOINT_KEY
        ? entries.filter((row) => isCheckpointPending(String(row.status))).length
        : entries.filter((row) => row.pending).length
    return {
      name: meta.name,
      created: entries.length,
      pending,
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

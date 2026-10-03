import type { EntryRow } from './types'

/**
 * 防火检查站领域规则。
 *
 * 唯一事实来源：升级入口（页面按钮）、站点导航（侧栏角标）、通行面板（统计卡片）
 * 以及跨模块的换岗待办，全部从这里推导，避免三处各算各的导致结果冲突。
 */

export const CHECKPOINT_KEY = 'checkpoint'

export const STATUS = {
  normal: '正常检查',
  closed: '临时关闭',
  escalated: '升级检查',
  awaitingRelief: '等待换岗',
} as const

/** 检查标准的严格程度：冲突时一律以更严格的标准为准（数值越大越严格）。 */
export const STRICTNESS_RANK: Record<string, number> = {
  [STATUS.closed]: 0, // 关闭不参与检查，放行入口必须全部收起
  [STATUS.normal]: 1,
  [STATUS.awaitingRelief]: 1, // 同等级：换岗待办期间维持原检查力度
  [STATUS.escalated]: 2, // 最严格，已是最高档，禁止再升级
}

export const ACTION = {
  escalate: '升级检查',
  close: '关闭站点',
  relieve: '安排换岗',
  completeRelief: '完成换岗',
  reopen: '恢复开放',
} as const

/** 单日通行车辆数合法区间（值班日期维度的登记上限）。 */
export const VEHICLE_MIN = 0
export const VEHICLE_MAX = 999
/** 缴获（收缴）火种数合法区间，且不得超过通行车辆数（一车至多上缴一个火种）。 */
export const FIRE_TAKEN_MIN = 0
export const FIRE_TAKEN_PER_VEHICLE_CAP = 1

export type NumberField = '通行车辆数' | '收缴火种数'

/** 把任意输入钳制/解析成合法非负整数；非法文本按 0 处理（解决样例文本与超范围写入）。 */
export function clampCount(value: unknown, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) {
    return min
  }
  return Math.min(max, Math.max(min, parsed))
}

export function normalizeVehicles(value: unknown): number {
  return clampCount(value, VEHICLE_MIN, VEHICLE_MAX)
}

export function normalizeFireTaken(value: unknown, vehicles: number): number {
  const max = Math.min(vehicles, vehicles * FIRE_TAKEN_PER_VEHICLE_CAP)
  return clampCount(value, FIRE_TAKEN_MIN, max)
}

/** 入口守卫：返回 null 表示允许，否则给出拒绝文案（同时定义了判定条件与上限）。 */
export function guardAction(action: string, row: EntryRow): string | null {
  const current = String(row.status)

  switch (action) {
    case ACTION.escalate:
      if (current === STATUS.closed) {
        return '站点已临时关闭，不能升级检查；如需设卡请先恢复开放'
      }
      if (current === STATUS.escalated) {
        return '已是最高等级的升级检查，不能继续升级'
      }
      // 正常检查、等待换岗（维持原检查力度）都可以升级
      return null
    case ACTION.close:
      if (current === STATUS.closed) {
        return '站点已经是临时关闭状态，不用重复操作'
      }
      return null
    case ACTION.reopen:
      if (current !== STATUS.closed) {
        return '只有临时关闭的站点才能恢复开放'
      }
      return null
    case ACTION.relieve:
      if (current === STATUS.closed) {
        return '站点已临时关闭，不再安排换岗'
      }
      if (current === STATUS.awaitingRelief) {
        return '该站点已在等待换岗，待值勤排班完成交接即可'
      }
      return null
    case ACTION.completeRelief:
      if (current !== STATUS.awaitingRelief) {
        return '只有等待换岗的站点才能完成换岗'
      }
      return null
    default:
      return `没有登记「${action}」这个动作`
  }
}

/** 同等级规则发生冲突时的裁决顺序：关闭优先（先封站）> 升级（更严格检查）> 换岗。 */
export const ACTION_PRIORITY = [ACTION.close, ACTION.escalate, ACTION.relieve]

/** 取两个状态中检查标准更严格的一个；关闭态不参与比较时按另一态处理。 */
export function stricterStatus(a: string, b: string): string {
  if (a === STATUS.closed || b === STATUS.closed) {
    return STATUS.closed
  }
  return (STRICTNESS_RANK[b] ?? -1) > (STRICTNESS_RANK[a] ?? -1) ? b : a
}

/** 关闭后必须清零的业务计数：站点不检查，也就没有通行车辆和缴获火种。 */
export function isClosed(status: string): boolean {
  return status === STATUS.closed
}

/** pending 语义：只有等待换岗算待办，其余状态（含关闭、升级）均非待办。 */
export function isPending(status: string): boolean {
  return status === STATUS.awaitingRelief
}

/** abnormal 语义：临时关闭视为需要关注的异常态。 */
export function isAbnormal(status: string): boolean {
  return status === STATUS.closed
}

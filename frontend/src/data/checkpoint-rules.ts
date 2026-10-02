import type { EntryRow } from './types'

/**
 * 防火检查站的领域规则集中在这里：关闭、换岗、升级的判定条件、状态严格度优先级、
 * 数值上限与跨模块联动标记。local-service 只按这些规则执行，页面组件不做业务判断。
 */

export const CHECKPOINT_KEY = 'checkpoint'
export const DUTY_KEY = 'duty'

export const STATUS_NORMAL = '正常检查'
export const STATUS_CLOSED = '临时关闭'
export const STATUS_UPGRADED = '升级检查'
export const STATUS_WAITING_SHIFT = '等待换岗'

export const ACTION_UPGRADE = '升级检查'
export const ACTION_CLOSE = '关闭站点'
export const ACTION_ARRANGE_SHIFT = '安排换岗'

export const FIELD_VEHICLES = '通行车辆数'
export const FIELD_SOURCES = '收缴火种数'
export const FIELD_RUN_STATE = '运行状态'

/** 单站单班登记的通行车辆数上限；火种数不得超过车辆数（一车至多登记一次火种）。 */
export const MAX_VEHICLES = 500
export const MAX_SOURCES_PER_VEHICLE = 1

/**
 * 状态严格度（检查标准从严到宽）。同一站点出现冲突结论时，以更严格的检查标准为准：
 * 临时关闭 > 升级检查 > 等待换岗 > 正常检查。
 * 同等级规则之间采用「先提交者生效」，由 local-service 的乐观锁兜底。
 */
export const STATUS_RANK: Record<string, number> = {
  [STATUS_CLOSED]: 4,
  [STATUS_UPGRADED]: 3,
  [STATUS_WAITING_SHIFT]: 2,
  [STATUS_NORMAL]: 1,
}

/**
 * 关闭、换岗、升级的允许来源（判定条件）：
 * - 升级检查：仅「正常检查」可升级。已关闭的站点不允许做检查升级；升级中、等待换岗中不重复升级。
 * - 关闭站点：仅还在运行的站点（正常检查 / 升级检查 / 等待换岗）可关闭，已关闭不重复关闭。
 * - 安排换岗：仅「正常检查 / 升级检查」可发起；关闭的站点不安排换岗，等待换岗中不重复安排。
 */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  [ACTION_UPGRADE]: [STATUS_NORMAL],
  [ACTION_CLOSE]: [STATUS_NORMAL, STATUS_UPGRADED, STATUS_WAITING_SHIFT],
  [ACTION_ARRANGE_SHIFT]: [STATUS_NORMAL, STATUS_UPGRADED],
}

export function isCheckpointStatus(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
}

/** 两个状态冲突时取检查标准更严格的一个。 */
export function stricterStatus(a: string, b: string): string {
  return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b
}

/** 进入等待换岗后才算检查站的待办；关闭/升级/正常都不占待办口径。 */
export function isCheckpointPending(status: string): boolean {
  return status === STATUS_WAITING_SHIFT
}

/** 把任意输入解析为非负整数；无法解析（如占位字符串）按 0 处理。 */
export function parseCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

/**
 * 通行车辆数 / 收缴火种数的上限钳制：
 * 车辆数钳到 [0, MAX_VEHICLES]；火种数钳到 [0, 车辆数]（受车辆数上限间接约束）。
 */
export function clampCheckpointCounters(vehicles: unknown, sources: unknown): {
  vehicles: number
  sources: number
} {
  const clampedVehicles = Math.min(parseCount(vehicles), MAX_VEHICLES)
  const maxSources = clampedVehicles * MAX_SOURCES_PER_VEHICLE
  const clampedSources = Math.min(parseCount(sources), maxSources)
  return { vehicles: clampedVehicles, sources: clampedSources }
}

/**
 * 规整一条检查站记录：状态非法时回落到正常检查，运行状态字段与主状态对齐，
 * 计数做上限钳制。返回 null 表示不需要落盘修改。
 */
export function normalizeCheckpointRow(row: EntryRow): EntryRow | null {
  const status = isCheckpointStatus(String(row.status)) ? String(row.status) : STATUS_NORMAL
  const { vehicles, sources } = clampCheckpointCounters(row[FIELD_VEHICLES], row[FIELD_SOURCES])
  const pending = isCheckpointPending(status)
  const next: EntryRow = {
    ...row,
    status,
    pending,
    [FIELD_RUN_STATE]: status,
    [FIELD_VEHICLES]: vehicles,
    [FIELD_SOURCES]: sources,
  }
  const changed =
    next.status !== row.status ||
    next.pending !== row.pending ||
    row[FIELD_RUN_STATE] !== status ||
    row[FIELD_VEHICLES] !== vehicles ||
    row[FIELD_SOURCES] !== sources
  return changed ? next : null
}

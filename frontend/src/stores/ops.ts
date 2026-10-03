import { defineStore } from 'pinia'

import { listEntries } from '@/api/local-service'
import { STATUS } from '@/data/checkpoint-rules'
import type { EntryRow } from '@/data/types'

/**
 * 检查站运营状态：升级入口（页面按钮）、站点导航（侧栏角标）、
 * 通行面板（统计卡片）共用的一份实时推导，任何写入后统一刷新，杜绝三处结果冲突。
 */
export const useOpsStore = defineStore('ops', {
  state: () => ({
    checkpointTotal: 0,
    normalCount: 0,
    fireTakenTotal: 0,
    awaitingReliefCount: 0,
    closedCount: 0,
    escalatedCount: 0,
    dutyPendingCount: 0,
    rows: [] as EntryRow[],
    listening: false,
  }),
  getters: {
    strictestStatus(): string {
      // 冲突时以更严格的检查标准为准：存在升级检查就提示升级检查，其次关闭，最后正常。
      if (this.rows.some((row) => row.status === STATUS.escalated)) {
        return STATUS.escalated
      }
      if (this.rows.some((row) => row.status === STATUS.closed)) {
        return STATUS.closed
      }
      return STATUS.normal
    },
  },
  actions: {
    refresh() {
      const payload = listEntries('checkpoint')
      this.rows = payload.items
      this.checkpointTotal = payload.items.length
      this.normalCount = payload.items.filter(
        (row) => String(row.status) === STATUS.normal,
      ).length
      this.fireTakenTotal = payload.items.reduce(
        (sum, row) => sum + Number(row['收缴火种数'] ?? 0),
        0,
      )
      this.awaitingReliefCount = payload.items.filter(
        (row) => String(row.status) === STATUS.awaitingRelief,
      ).length
      this.closedCount = payload.items.filter(
        (row) => String(row.status) === STATUS.closed,
      ).length
      this.escalatedCount = payload.items.filter(
        (row) => String(row.status) === STATUS.escalated,
      ).length
      // 换岗待办联动值勤排班：导航角标与排班页待办同源。
      this.dutyPendingCount = listEntries('duty').items.filter((row) => row.pending).length
    },
    bindAutoRefresh() {
      if (this.listening || typeof window === 'undefined') {
        return
      }
      this.listening = true
      // 另一值守端跨标签页提交后重新统计（本页写入后由页面主动 refresh）。
      window.addEventListener('storage', (event) => {
        if (event.key === 'forest-fire-patrol:entries') {
          this.refresh()
        }
      })
      this.refresh()
    },
  },
})

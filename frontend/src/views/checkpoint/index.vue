<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-rule">
        判定规则：关闭站点停止检查并清零通行与火种；升级检查为最高档；换岗生成值勤待办，冲突时以更严格检查标准为准
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in availableActions(row)" :key="action">
              <button
                class="link"
                type="button"
                :disabled="busyKey === actionKey(action, row)"
                :title="busyKey === actionKey(action, row) ? '正在提交…' : ''"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  CP_ACTION,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { guardAction } from '@/data/checkpoint-rules'
import { useOpsStore } from '@/stores/ops'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('checkpoint')
const columns = ["站点编号", "站点位置", "值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const statuses = ["正常检查", "升级检查", "等待换岗", "临时关闭"]
const ops = useOpsStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const busyKey = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 通行面板：直接读共享运营状态，与站点导航、升级入口同源。
const stats = computed(() => [
  { label: '站点总数', value: ops.checkpointTotal },
  { label: '正常检查数', value: ops.normalCount },
  { label: '收缴火种数', value: ops.fireTakenTotal },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 按当前状态判定可用动作：关闭的站点不显示升级/换岗入口，只有恢复开放。
function availableActions(row: EntryRow): string[] {
  const candidates = [
    CP_ACTION.escalate,
    CP_ACTION.close,
    CP_ACTION.relieve,
    CP_ACTION.completeRelief,
    CP_ACTION.reopen,
  ]
  return candidates.filter((action) => guardAction(action, row) === null)
}

function actionKey(action: string, row: EntryRow): string {
  return `${action}:${row.id}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  busyKey.value = actionKey(action, row)
  try {
    // 携带行版本：另一值守端若已提交，本次并发提交会被乐观锁拒绝，只允许一次生效。
    const result = applyAction(meta.key, Number(row.id), action, row.version ?? 0)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
  } finally {
    busyKey.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ops.refresh()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

function onExternalChange(event: StorageEvent) {
  // 另一值守端（跨标签页）提交后，本端列表与入口立即对齐，避免按旧状态操作。
  if (event.key && event.key.includes('entries')) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onExternalChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', onExternalChange)
})
</script>

<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">森林防火巡护管理系统</h1>
      <nav class="nav-list">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
        >
          <span>{{ item.label }}</span>
          <span v-if="badgeFor(item.path)" class="nav-badge" :class="badgeClassFor(item.path)">
            {{ badgeFor(item.path) }}
          </span>
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向森林火险监测、巡护任务调度、防火设施维护与应急响应指挥的林区防火管理平台。</span>
        <span class="head-user">
          当前值班：{{ session.operator }} · {{ session.shiftLabel }} · 全站检查标准：{{ ops.strictestStatus }}
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'

import { useOpsStore } from '@/stores/ops'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const ops = useOpsStore()
const route = useRoute()

const navItems = [{ label: "运营概览", path: "/" }, { label: "巡护任务", path: "/patrol" }, { label: "火险监测", path: "/firewatch" }, { label: "瞭望台管理", path: "/lookout" }, { label: "防火隔离带", path: "/firebreak" }, { label: "扑火队伍", path: "/fireteam" }, { label: "消防装备", path: "/equipment" }, { label: "气象观测", path: "/weather" }, { label: "火情报告", path: "/firereport" }, { label: "无人机巡查", path: "/drone" }, { label: "防火宣传", path: "/campaign" }, { label: "防火检查站", path: "/checkpoint" }, { label: "值勤排班", path: "/duty" }, { label: "物资储备", path: "/supply" }, { label: "林区道路", path: "/forestroad" }, { label: "防火林带", path: "/firebelt" }, { label: "应急演练", path: "/drill" }, { label: "焚烧审批", path: "/burnpermit" }, { label: "林木生长", path: "/treegrowth" }]

const dutyPendingCount = computed(() => ops.dutyPendingCount)

function badgeFor(path: string): number {
  if (path === '/checkpoint') {
    // 导航角标优先提示换岗待办，没有待办时提示关闭站点。
    return ops.awaitingReliefCount || ops.closedCount
  }
  if (path === '/duty') {
    return dutyPendingCount.value
  }
  return 0
}

function badgeClassFor(path: string): string {
  if (path === '/checkpoint') {
    return ops.awaitingReliefCount ? 'badge-pending' : 'badge-closed'
  }
  return 'badge-pending'
}

onMounted(() => {
  ops.bindAutoRefresh()
})

watch(
  () => route.fullPath,
  () => ops.refresh(),
)
</script>

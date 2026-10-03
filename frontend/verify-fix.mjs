import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

// ---- 浏览器环境桩 ----
const memory = new Map()
const listeners = { storage: [], custom: [] }
globalThis.window = global.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
  addEventListener: (name, fn) => {
    if (name === 'storage') listeners.storage.push(fn)
    else listeners.custom.push(fn)
  },
  dispatchEvent: (evt) => listeners.custom.forEach((fn) => fn(evt)),
  CustomEvent: class CustomEvent {
    constructor(type) {
      this.type = type
    }
  },
}
globalThis.CustomEvent = globalThis.window.CustomEvent

const harness = `
import { listEntries, runAction, loadOverview } from '../src/api/local-service.ts'
import { normalizeVehicles, normalizeFireTaken, guardAction, STRICTNESS_RANK, stricterStatus } from '../src/data/checkpoint-rules.ts'

const results = []
const ok = (name, cond, extra = '') => results.push({ name, pass: !!cond, extra })
const cp = () => listEntries('checkpoint').items
const duty = () => listEntries('duty').items
// 默认按最新版本提交，模拟页面按钮；要测旧版本冲突时再显式传版本号。
const act = (id, action) =>
  runAction('checkpoint', Number(id), action, cp().find((r) => Number(r.id) === Number(id))?.version ?? 0)

// 1. 种子数据数值合法，关闭站点计数为零，运行状态列与 status 一致
let rows = cp()
ok('种子-通行车辆数全部为数字', rows.every(r => typeof r['通行车辆数'] === 'number' && Number.isFinite(r['通行车辆数'])))
ok('种子-车辆数在 0-999 区间', rows.every(r => r['通行车辆数'] >= 0 && r['通行车辆数'] <= 999))
const closed = rows.find(r => r.status === '临时关闭')
ok('种子-关闭站点通行/火种为零', closed['通行车辆数'] === 0 && closed['收缴火种数'] === 0)
ok('种子-运行状态列与status一致', rows.every(r => r['运行状态'] === r.status))

// 2. 关闭后不能升级、不能换岗（判定条件）
const closedId = Number(closed.id)
ok('关闭站点-升级被拒绝', act(closedId, '升级检查').ok === false)
ok('关闭站点-换岗被拒绝', act(closedId, '安排换岗').ok === false)
ok('关闭站点-状态仍是临时关闭', cp().find(r => r.id === closedId).status === '临时关闭')

// 恢复开放后可升级
ok('恢复开放成功', act(closedId, '恢复开放').ok === true)
ok('恢复开放后状态为正常检查', cp().find(r => r.id === closedId).status === '正常检查')

// 3. 升级上限：升级检查不可再升级
let r1 = cp().find(r => r.status === '正常检查')
const id1 = Number(r1.id)
ok('正常站点升级成功', act(id1, '升级检查').ok === true)
ok('升级后状态为升级检查', cp().find(r => r.id === id1).status === '升级检查')
ok('升级检查不可再升级', act(id1, '升级检查').ok === false)

// 4. 关闭会清零通行车辆与缴获火种
ok('升级站点火种保留', cp().find(r => r.id === id1)['收缴火种数'] === 8)
act(id1, '关闭站点')
let after = cp().find(r => r.id === id1)
ok('关闭后通行清零', after['通行车辆数'] === 0)
ok('关闭后缴获火种清零（不残留）', after['收缴火种数'] === 0)
ok('关闭后升级入口拒绝', act(id1, '升级检查').ok === false)
act(id1, '恢复开放')

// 5. 换岗：正常 -> 等待换岗（修正原错误映射到“正常检查”）
r1 = cp().find(r => r.status === '正常检查')
const rid = Number(r1.id)
ok('安排换岗成功', act(rid, '安排换岗').ok === true)
ok('换岗后状态为等待换岗', cp().find(r => r.id === rid).status === '等待换岗')
ok('重复换岗被拒绝', act(rid, '安排换岗').ok === false)
ok('等待换岗可升级（同等级维持力度时允许提级）', act(rid, '升级检查').ok === true)
act(rid, '关闭站点')
act(rid, '恢复开放')
act(rid, '安排换岗')

// 6. 其他模块换岗待办必须跟着变化（duty 联动）
let todos = duty().filter(r => String(r['排班编号']).startsWith('CHEC-RELIEF-'))
ok('换岗生成值勤待办', todos.length === 1 && todos[0].status === '待确认' && todos[0].pending === true)

// 完成换岗 -> 待办变已交接
ok('完成换岗成功', act(rid, '完成换岗').ok === true)
ok('完成换岗后站点回正常检查', cp().find(r => r.id === rid).status === '正常检查')
todos = duty().filter(r => String(r['排班编号']).startsWith('CHEC-RELIEF-'))
ok('换岗待办标记已交接', todos.length === 1 && todos[0].status === '已交接' && todos[0].pending === false)

// 再次换岗：待办重新变为待确认（跟着变化，不残留已交接）
act(rid, '安排换岗')
todos = duty().filter(r => String(r['排班编号']).startsWith('CHEC-RELIEF-'))
ok('再次换岗待办重新激活', todos[0].status === '待确认' && todos[0].pending === true)

// 关闭站点：待办撤销为已调班
act(rid, '关闭站点')
todos = duty().filter(r => String(r['排班编号']).startsWith('CHEC-RELIEF-'))
ok('关闭站点后待办撤销（已调班）', todos[0].status === '已调班' && todos[0].pending === false)
act(rid, '恢复开放')

// 7. 失败重试安全：守卫拒绝不产生任何副作用，状态不变
const before = JSON.stringify(cp().find(r => r.id === rid))
const fail = act(rid, '升级检查') // 正常->升级 OK
const vEscalated = cp().find(r => r.id === rid).version
const fail2 = runAction('checkpoint', rid, '升级检查', vEscalated) // 已升级，重复拒绝
ok('重复升级拒绝且提示清晰', fail2.ok === false)
// 用旧版本号并发（模拟另一值守端基于旧快照提交）
const conflict = runAction('checkpoint', rid, '关闭站点', vEscalated - 99)
ok('旧版本号并发提交被乐观锁拒绝', conflict.ok === false)

// 8. 两个值守端并发提交只允许一次生效：同一版本号连续两次关闭
const cur = cp().find(r => r.id === rid)
const v = cur.version ?? 0
const a = runAction('checkpoint', rid, '关闭站点', v)
const b = runAction('checkpoint', rid, '关闭站点', v)
ok('并发第一次生效', a.ok === true)
ok('并发第二次被拒绝（只允许一次）', b.ok === false)
const finalRow = cp().find(r => r.id === rid)
ok('并发后只产生一次版本递增', finalRow.version === v + 1)

// 9. 上限钳制
ok('车辆数钳制上限999', normalizeVehicles(100000) === 999)
ok('非法文本车辆数归零', normalizeVehicles('防火检查站样例') === 0)
ok('负数归零', normalizeVehicles(-5) === 0)
ok('火种不超过车辆数', normalizeFireTaken(500, 100) === 100)
ok('火种合法值保留', normalizeFireTaken(8, 126) === 8)

// 10. 冲突以更严格标准为准
ok('严格度排序 升级>正常', STRICTNESS_RANK['升级检查'] > STRICTNESS_RANK['正常检查'])
ok('stricterStatus取升级检查', stricterStatus('正常检查', '升级检查') === '升级检查')
ok('关闭优先于一切', stricterStatus('升级检查', '临时关闭') === '临时关闭')

// 11. 面板统计与行数据同源
const ov = loadOverview()
const cpModule = ov.modules.find(m => m.name === '防火检查站')
const pendingCount = cp().filter(r => r.pending).length
const closedCountNow = cp().filter(r => r.abnormal).length
ok('概览待处理与列表pending一致', cpModule.pending === pendingCount)
ok('概览异常与列表abnormal一致', cpModule.abnormal === closedCountNow)

// 输出
const failed = results.filter(r => !r.pass)
for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.extra ? ' :: ' + r.extra : ''))
console.log('\\n' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length) process.exit(1)
`

writeFileSync('/workspace/frontend/.verify/harness.ts', harness)

await build({
  entryPoints: ['/workspace/frontend/.verify/harness.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: '/workspace/frontend/.verify/harness.mjs',
  absWorkingDir: '/workspace/frontend',
  logLevel: 'silent',
  alias: { '@': '/workspace/frontend/src' },
})

await import(pathToFileURL('/workspace/frontend/.verify/harness.mjs').href + `?t=${Date.now()}`)
rmSync('/workspace/frontend/.verify/harness.ts', { force: true })
rmSync('/workspace/frontend/.verify/harness.mjs', { force: true })

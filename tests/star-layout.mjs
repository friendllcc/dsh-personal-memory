/**
 * 星系布局回归：我=恒星、人=行星、属性=卫星。
 * 纯几何断言，不依赖浏览器/DOM。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fail++; console.log(`FAIL  ${name} ${detail}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dpm-star-'))
const outfile = join(dir, 'graph.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/client-memory-graph.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile, logLevel: 'silent',
})
const G = await import(pathToFileURL(outfile).href)

const node = (id, label, entityType, count = 1) => ({
  id: `ent:${id}`, label, kind: 'entity', count, levels: {}, entityType, rowIds: [],
})
const edge = (a, b, weight = 1, kind = 'relation') => ({
  source: `ent:${a}`, target: `ent:${b}`, weight, kind,
})

const graph = {
  nodes: [
    node('me', '我', 'person', 9),
    node('wife', '老婆', 'person', 4),
    node('allergy', '海鲜过敏', 'health', 2),
    node('boss', '老大', 'person', 2),
    node('school', '幼儿园', 'organization', 1),
    node('hz', '杭州', 'location', 1),
  ],
  edges: [
    edge('me', 'wife', 3),
    edge('wife', 'allergy', 2),
    edge('me', 'boss', 2),
    edge('boss', 'school', 2),
    edge('me', 'hz', 1),
  ],
}

console.log('=== 1. 层级识别 ===')
const h = G.starHierarchy(graph)
ok('自动找到「我」作为恒星', h?.rootId === 'ent:me', JSON.stringify(h?.rootId))
ok('老婆/老大是行星', h?.planets.map((p) => p.label).join(',') === '老婆,老大', JSON.stringify(h?.planets.map((p) => p.label)))
ok('海鲜过敏挂在老婆下', h?.parentOf.get('ent:allergy') === 'ent:wife', JSON.stringify([...h?.parentOf ?? []]))
ok('幼儿园挂在老天下', h?.parentOf.get('ent:school') === 'ent:boss', JSON.stringify([...h?.parentOf ?? []]))
ok('杭州直接挂我', h?.parentOf.get('ent:hz') === 'ent:me', JSON.stringify([...h?.parentOf ?? []]))
ok('没有我 → null', G.starHierarchy({ nodes: [node('x', 'X', 'item')], edges: [] }) === null)

console.log('=== 2. 几何位置 ===')
const layout = G.computeStarLayout(graph, 760, 500)
const P = (id) => layout.get(`ent:${id}`)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
ok('恒星在画布中心', P('me').x === 380 && P('me').y === 250, JSON.stringify(P('me')))
ok('行星在内圈（属性星座在外圈）', dist(P('wife'), P('me')) > 70 && dist(P('wife'), P('me')) < 160, JSON.stringify([dist(P('wife'), P('me')), dist(P('boss'), P('me'))]))
ok('卫星贴着行星', dist(P('allergy'), P('wife')) < 60 && dist(P('school'), P('boss')) < 60, JSON.stringify([dist(P('allergy'), P('wife')), dist(P('school'), P('boss'))]))
ok('我的属性在独立簇里（不贴恒星）', dist(P('hz'), P('me')) > 45 && dist(P('hz'), P('me')) < 240, String(dist(P('hz'), P('me'))))
ok('所有点都在画布内', [...layout.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 760 && p.y >= 0 && p.y <= 500))
ok('同输入同输出', JSON.stringify([...layout]) === JSON.stringify([...G.computeStarLayout(graph, 760, 500)]))

console.log('=== 3. 没有「我」时退回力导向 ===')
const plain = { nodes: [node('a', 'A', 'item'), node('b', 'B', 'item')], edges: [edge('a', 'b')] }
const fallback = G.computeStarLayout(plain, 760, 500)
ok('退回流布且每个点都有位置', fallback.size === 2 && [...fallback.values()].every((p) => Number.isFinite(p.x)), JSON.stringify([...fallback]))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

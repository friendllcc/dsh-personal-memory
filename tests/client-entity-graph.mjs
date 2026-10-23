/**
 * 实体视图接入图管线的单测：分类、点节点/点边的来源记忆解析。
 *
 * 运行：node tests/client-entity-graph.mjs
 * client-memory-graph.ts 运行时依赖 i18n，Node 的 .js→.ts 解析不生效，
 * 所以这里用 esbuild 先打成一个临时 ESM 再 import（测试环境有 esbuild）。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name} ${detail}`)
  }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const dir = mkdtempSync(join(tmpdir(), 'dpm-entity-graph-'))
const outfile = join(dir, 'graph.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/client-memory-graph.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile,
  logLevel: 'silent',
})
const G = await import(pathToFileURL(outfile).href)

const rows = [
  {
    id: 'r1', level: 'user', title: null, content: '老婆对海鲜严重过敏', importance: 1,
    keywords: ['老婆', '海鲜过敏'], status: 'active', corrected: 0, project: null,
    subcategory: null, goal: null, hit_count: 0, created_at: 1, updated_at: 2, last_accessed_at: null,
  },
  {
    id: 'r2', level: 'fact', title: null, content: '年度体检', importance: 1,
    keywords: ['年度体检'], status: 'active', corrected: 0, project: null,
    subcategory: null, goal: null, hit_count: 0, created_at: 1, updated_at: 1, last_accessed_at: null,
  },
]

section('1. 分类映射')
ok('entity/health → health', G.nodeCategory({ kind: 'entity', entityType: 'health', levels: {} }) === 'health')
ok('entity/person → person', G.nodeCategory({ kind: 'entity', entityType: 'person', levels: {} }) === 'person')
ok('entity/concept → thing', G.nodeCategory({ kind: 'entity', entityType: 'concept', levels: {} }) === 'thing')
ok('图例包含新分类', ['health', 'event', 'location', 'organization', 'item'].every((c) => G.CATEGORY_ORDER.includes(c)), JSON.stringify(G.CATEGORY_ORDER))

section('2. 点节点 → 来源记忆')
{
  const wife = { id: 'ent:老婆', label: '老婆', kind: 'entity', entityType: 'person', count: 1, levels: { user: 1 }, rowIds: ['r1'] }
  const got = G.rowsForNode(wife, rows)
  ok('实体节点按 rowIds 精确取（不靠关键词）', got.length === 1 && got[0].id === 'r1', JSON.stringify(got.map((r) => r.id)))
}

section('3. 点边 → 共同来源记忆')
{
  const graph = {
    nodes: [
      { id: 'ent:老婆', label: '老婆', kind: 'entity', entityType: 'person', count: 1, levels: {}, rowIds: ['r1'] },
      { id: 'ent:海鲜过敏', label: '海鲜过敏', kind: 'entity', entityType: 'health', count: 1, levels: {}, rowIds: ['r1', 'r2'] },
      { id: 'me', label: '我', kind: 'me', count: 2, levels: {} },
    ],
    edges: [
      { source: 'me', target: 'ent:老婆', weight: 1, kind: 'mine' },
      { source: 'ent:老婆', target: 'ent:海鲜过敏', weight: 1, kind: 'cooc' },
    ],
  }
  const e = graph.edges[1]
  const got = G.rowsForEdge(e, graph, rows)
  ok('实体边取交集', got.length === 1 && got[0].id === 'r1', JSON.stringify(got.map((r) => r.id)))
  const m = graph.edges[0]
  const gotM = G.rowsForEdge(m, graph, rows)
  ok('「我」到实体：取该实体来源记忆', gotM.length === 1 && gotM[0].id === 'r1', JSON.stringify(gotM.map((r) => r.id)))
}

section('4. 端到端：派生 → 别名折叠 → 跳数过滤')
{
  const { buildEntityOverview } = await import('../src/client-entities.ts')
  const rows2 = [
    ...rows,
    {
      id: 'r3', level: 'user', title: null, content: '我的名字叫畅大喵，老婆叫我大喵', importance: 1,
      keywords: ['畅大喵', '老婆'], status: 'active', corrected: 0, project: null,
      subcategory: null, goal: null, hit_count: 0, created_at: 1, updated_at: 3, last_accessed_at: null,
    },
  ]
  const ov = buildEntityOverview(rows2, { scope: 'personal' })
  const aliases = G.collectMeAliases(rows2)
  const folded = G.foldGraphAliases(ov.graph, aliases)
  ok('自报姓名被识别', aliases.includes('畅大喵'), JSON.stringify(aliases))
  ok('折叠后不再有本名节点', !folded.nodes.some((n) => n.label === '畅大喵'), JSON.stringify(folded.nodes.map((n) => n.label)))
  ok('折叠后仍保留「我」', folded.nodes.some((n) => n.kind === 'me'))
  const depths = G.nodeDepths(folded, 'me')
  ok('所有节点都能从「我」到达', folded.nodes.every((n) => depths.has(n.id)), JSON.stringify(folded.nodes.map((n) => n.label)))
  const sub = G.filterGraphByDepth(folded, depths, 2)
  ok('跳数过滤不炸且非空', sub.nodes.length > 0 && sub.edges.every((e) => sub.nodes.some((n) => n.id === e.source) && sub.nodes.some((n) => n.id === e.target)))
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
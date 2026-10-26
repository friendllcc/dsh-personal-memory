/**
 * LLM 实体抽取回归（不调真模型，用 mock callLLM）：
 *   - JSON 解析（含 ```json 包裹）
 *   - 实体/关系落库、关系去重、非法关系跳过
 *   - 已抽标记（pending 归零）
 *   - 重抽时清掉旧链接/旧关系
 *
 * 运行：node tests/entities-llm.mjs
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
const section = (t) => console.log(`\n=== ${t} ===`)

const dir = mkdtempSync(join(tmpdir(), 'dpm-entities-'))
const bundle = async (entry, name) => {
  const outfile = join(dir, name)
  await build({
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile, logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}
const D = await bundle('db.ts', 'db.mjs')
const E = await bundle('entities.ts', 'entities.mjs')

section('1. JSON 解析')
{
  ok('纯 JSON', E.parseExtraction('{"entities":[{"name":"老婆","type":"person"}],"relations":[]}')?.entities.length === 1)
  ok('```json 包裹', E.parseExtraction('```json\n{"entities":[{"name":"老婆","type":"person"}]}\n```')?.entities.length === 1)
  ok('前后废话', E.parseExtraction('结果如下：{"entities":[{"name":"老婆","type":"person"}]} 完毕')?.entities.length === 1)
  ok('坏 JSON → null', E.parseExtraction('not json') === null)
  ok('未知类型 → concept', E.parseExtraction('{"entities":[{"name":"X","type":"weird"}]}')?.entities[0].type === 'concept')
  ok('未知关系 → related_to', E.parseExtraction('{"entities":[{"name":"A","type":"person"},{"name":"B","type":"person"}],"relations":[{"from":"A","to":"B","type":"weird"}]}')?.relations[0].type === 'related_to')
  ok('关系引用不存在的实体 → 丢弃', E.parseExtraction('{"entities":[{"name":"A","type":"person"}],"relations":[{"from":"A","to":"B","type":"related_to"}]}')?.relations.length === 0)
}

section('2. 落库 + 关系 + pending')
{
  const db = new D.MemoryDb(join(dir, 'ent.db'))
  const row = db.insert({ level: 'fact', content: '老婆对海鲜严重过敏，不能吃海鲜' })
  const before = db.entityStats()
  ok('初始 pending = 1', before.pending === 1, JSON.stringify(before))
  ok('初始无实体', before.entities === 0)

  const call = async () => JSON.stringify({
    entities: [
      { name: '老婆', type: 'person' },
      { name: '海鲜过敏', type: 'health' },
    ],
    relations: [
      { from: '老婆', to: '海鲜过敏', type: 'has_allergy' },
      { from: '老婆', to: '不存在', type: 'related_to' },
    ],
  })
  const n = await E.extractMemoryEntities(db, row.id, call)
  ok('写入 2 个实体', n === 2, String(n))
  const stats = db.entityStats()
  ok('pending 归零', stats.pending === 0, JSON.stringify(stats))
  ok('实体数 = 2', stats.entities === 2, JSON.stringify(stats))
  ok('关系数 = 1（非法关系被忽略）', stats.relations === 1, JSON.stringify(stats))
  const graph = db.entityGraph()
  ok('图节点带来源记忆 id', graph.nodes.every((node) => node.rowIds.includes(row.id)))
  ok('图边带关系类型', graph.edges[0]?.relation_type === 'has_allergy', JSON.stringify(graph.edges))

  // 重抽：清掉旧的，换成新实体
  const call2 = async () => JSON.stringify({ entities: [{ name: '海鲜', type: 'item' }], relations: [] })
  await E.extractMemoryEntities(db, row.id, call2)
  const graph2 = db.entityGraph()
  ok('重抽清掉旧链接', graph2.nodes.length === 1 && graph2.nodes[0].name === '海鲜', JSON.stringify(graph2.nodes))
  ok('重抽清掉旧关系', graph2.edges.length === 0, JSON.stringify(graph2.edges))

  // 内容变更 → 抽取失效（否则图谱永远停在旧内容）
  db.update('fact', row.id, { content: '内容改了，实体需要重抽' })
  ok('内容变更后回到 pending', db.entityStats().pending === 1, JSON.stringify(db.entityStats()))
  ok('内容变更后旧实体不再展示', db.entityGraph().nodes.length === 0, JSON.stringify(db.entityGraph().nodes))

  // 删除记忆 → 实体联动清理
  await E.extractMemoryEntities(db, row.id, call2)
  ok('删除前实体存在', db.entityGraph().nodes.length === 1)
  db.remove('fact', row.id)
  ok('删除记忆后实体清空', db.entityGraph().nodes.length === 0, JSON.stringify(db.entityGraph().nodes))
  db.close()
}

section('3. LLM 失败不标记 done')
{
  const db = new D.MemoryDb(join(dir, 'fail.db'))
  const row = db.insert({ level: 'fact', content: '测试失败重试' })
  const n = await E.extractMemoryEntities(db, row.id, async () => '')
  ok('空返回 → -1', n === -1, String(n))
  ok('失败后仍 pending（下轮重试）', db.entityStats().pending === 1, JSON.stringify(db.entityStats()))
  db.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
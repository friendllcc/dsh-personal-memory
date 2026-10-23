/**
 * 检索质量回归（对应评测里三个真实 badcase）：
 *  ① coverage 分母改为「查询词数」——长记忆不再因为词多而吃亏；
 *  ② 正文以 0.45 权重参与命中——关键词漏词时正文能兜底，但不会盖过关键词；
 *  ③ 归档 ×0.4 仍可检索——dream 归档「疗程已结束」后，问「还在吃吗」还能找到答案。
 *
 * 运行：node tests/retrieval.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'dpm-retrieval-'))
const bundle = async (entry, name) => {
  const outfile = join(dir, name)
  await build({
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}
const B = await bundle('bm25.ts', 'bm25.mjs')
const D = await bundle('db.ts', 'db.mjs')

const now = 1_700_000_000_000
function doc(o) {
  const keywords = o.keywords ?? []
  return {
    id: 'd',
    level: 'fact',
    title: null,
    // keywordHitScore 的「关键词面」就是 content（注入链路会把 keywords.join(' ') 塞进来）
    content: keywords.join(' '),
    keywords,
    importance: 1,
    created_at: now,
    updated_at: now,
    ...o,
  }
}

section('1. coverage 分母 = 查询词数（长记忆不吃亏）')
{
  const query = '海鲜过敏'
  // 同样命中「海鲜过敏」，A 的关键词表很长，B 只有命中词
  const a = doc({
    id: 'a',
    keywords: ['海鲜过敏', '旅行', '成都', '酒店', '大熊猫', '亲子', '自驾', '新疆', '暑假', '行程', '会议'],
  })
  const b = doc({ id: 'b', keywords: ['海鲜过敏'] })
  const hits = B.keywordHitScore(query, [a, b], { k: 10, now: null })
  const sa = hits.find((h) => h.id === 'a')?.score ?? 0
  const sb = hits.find((h) => h.id === 'b')?.score ?? 0
  ok('长记忆与短记忆同分（旧实现长记忆会被除成 1/11）', Math.abs(sa - sb) < 1e-9, `${sa} vs ${sb}`)
}

section('2. 正文 0.45 权重')
{
  const query = '海鲜过敏'
  const kwOnly = doc({ id: 'kw', keywords: ['海鲜过敏'], body: '完全无关的一段话' })
  const bodyOnly = doc({
    id: 'body',
    content: '无关词甲 无关词乙',
    keywords: ['无关词甲', '无关词乙'],
    body: '老婆海鲜过敏，不能吃海鲜',
  })
  const hits = B.keywordHitScore(query, [kwOnly, bodyOnly], { k: 10, now: null })
  const sKw = hits.find((h) => h.id === 'kw')?.score ?? 0
  const sBody = hits.find((h) => h.id === 'body')?.score ?? 0
  ok('只在正文命中也能召回', sBody > 0, String(sBody))
  ok('关键词命中权重高于正文', sKw > sBody, `${sKw} vs ${sBody}`)
  ok('正文权重约为 0.45', sBody > 0 && Math.abs(sBody / sKw - B.BODY_HIT_WEIGHT) < 0.06, `${sBody / sKw}`)
}

section('3. 归档 ×0.4 仍可检索')
{
  const base = { keywords: ['降血脂疗程', '医嘱'], content: '降血脂疗程', importance: 2, updated_at: now }
  const active = doc({ ...base, id: 'active', demote: 1 })
  const archived = doc({ ...base, id: 'archived', demote: B.ARCHIVED_DEMOTE })
  const hits = B.search('降血脂疗程', [active, archived], { k: 10, now: null })
  const sActive = hits.find((h) => h.id === 'active')?.score ?? 0
  const sArchived = hits.find((h) => h.id === 'archived')?.score ?? 0
  ok('归档条目仍出现在结果里', sArchived > 0, String(sArchived))
  ok('归档分数 = active × 0.4', sActive > 0 && Math.abs(sArchived / sActive - B.ARCHIVED_DEMOTE) < 1e-9, `${sArchived / sActive}`)

  const stale = doc({ ...base, id: 'stale', demote: B.STALE_DEMOTE })
  const hits2 = B.search('降血脂疗程', [active, stale], { k: 10, now: null })
  const sStale = hits2.find((h) => h.id === 'stale')?.score ?? 0
  ok('stale（已完成）仍可检索', sStale > 0, String(sStale))
  ok('stale 分数 = active × 0.7', sActive > 0 && Math.abs(sStale / sActive - B.STALE_DEMOTE) < 1e-9, `${sStale / sActive}`)
}

section('4. db.listSearchable 口径')
{
  const db = new D.MemoryDb(join(dir, 'searchable.db'))
  const a = db.insert({ level: 'fact', content: 'active 条目' })
  const b = db.insert({ level: 'fact', content: 'archived 条目' })
  const c = db.insert({ level: 'fact', content: 'stale 条目' })
  db.update('fact', b.id, { status: 'archived' })
  db.update('fact', c.id, { status: 'stale' })
  const ids = db.listSearchable('fact').map((r) => r.id)
  ok('active 可检索', ids.includes(a.id))
  ok('archived 仍可检索', ids.includes(b.id), JSON.stringify(ids))
  ok('stale 仍可检索（仅降权）', ids.includes(c.id), JSON.stringify(ids))
  db.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
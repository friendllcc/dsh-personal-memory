/**
 * semantic 模块测试（v0.4.0 向量语义检索）：resolveSemantic 兜底、CONFIG_DEFAULTS
 * parity、contentHashOf/embeddingText、cosine、mergeRankings(RRF)、SemanticBreaker
 * 熔断、embedTexts（fake fetch：成功/HTTP 错/脏数据/超时）、SemanticRuntime
 * fail-soft、db 向量方法（roundtrip/remove 联动/孤儿清扫）、semanticRank、
 * SemanticIndexer 一趟补缺 + 重嵌跳过。
 * 运行：node tests/semantic.mjs（esbuild 打包源码，与 src 同步；无需先 build）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// 沙箱 home：bundle 模块级 env 读取发生在 import 时，先指好再 import。
const HOME = mkdtempSync(join(tmpdir(), 'mm-sem-home-'))
process.env.DSH_PERSONAL_MEMORY_HOME = HOME
process.env.DSH_PERSONAL_MEMORY_LEGACY_HOME = mkdtempSync(join(tmpdir(), 'mm-sem-legacy-'))

// 落盘再 import：db.ts → prompt-loader.ts 在模块级 fileURLToPath(import.meta.url)，
// data: URL 没有 file scheme 会直接炸，所以 bundle 写到临时文件。
const bundleDir = mkdtempSync(join(tmpdir(), 'mm-sem-bundle-'))
const bundleFile = join(bundleDir, 'bundle.mjs')
await build({
  stdin: {
    contents: [
      "export * from './src/semantic.ts'",
      "export { MemoryDb } from './src/db.ts'",
      "export { CONFIG_DEFAULTS } from './src/defaults.ts'",
    ].join(';'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundleFile,
  logLevel: 'silent',
})
const {
  SEMANTIC_DEFAULTS, resolveSemantic, contentHashOf, embeddingText, cosine, mergeRankings,
  SemanticBreaker, SemanticRuntime, SemanticIndexer, semanticRank, embedTexts,
  MemoryDb, CONFIG_DEFAULTS,
} = await import(pathToFileURL(bundleFile).href)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

const CFG = { ...SEMANTIC_DEFAULTS, enabled: true }

// ── resolveSemantic：兜底解析 ─────────────────────────────────────────────────
check('resolve: undefined → 出厂默认（关）', (() => {
  const s = resolveSemantic(undefined)
  return s.enabled === false && s.recall === true && s.baseUrl === 'https://api.openai.com/v1'
    && s.apiKey === '' && s.model === 'text-embedding-3-small' && s.topK === 5 && s.minScore === 0.25
})())
check('resolve: 部分覆盖保留其余默认', (() => {
  const s = resolveSemantic({ enabled: true, model: 'bge-m3' })
  return s.enabled === true && s.model === 'bge-m3' && s.topK === 5 && s.recall === true
})())
check('resolve: 脏类型/越界夹紧', (() => {
  const s = resolveSemantic({ topK: 99, minScore: 2, baseUrl: '  ', model: '' })
  return s.topK === 20 && s.minScore === 1 && s.baseUrl === SEMANTIC_DEFAULTS.baseUrl && s.model === SEMANTIC_DEFAULTS.model
})())
check('resolve: 非布尔字段不炸', resolveSemantic({ enabled: 'yes' }).enabled === false)

// ── CONFIG_DEFAULTS.semantic 与 SEMANTIC_DEFAULTS parity（client 副本不漂移）──
check('parity: defaults.ts 副本与 host 默认一致', JSON.stringify(CONFIG_DEFAULTS.semantic) === JSON.stringify(SEMANTIC_DEFAULTS),
  JSON.stringify(CONFIG_DEFAULTS.semantic))

// ── contentHashOf / embeddingText ────────────────────────────────────────────
check('hash: 同内容同指纹', contentHashOf('t', 'c') === contentHashOf('t', 'c'))
check('hash: title/content 任一变化指纹变', contentHashOf('t', 'c') !== contentHashOf('t', 'c2') && contentHashOf(null, 'c') !== contentHashOf('t', 'c'))
check('hash: 16 位 hex', /^[0-9a-f]{16}$/.test(contentHashOf(null, 'x')))
check('embeddingText: title 拼 content 且截断 2000', (() => {
  const t = embeddingText('ab', 'x'.repeat(3000))
  return t.startsWith('ab\n') && t.length === 2000
})())

// ── cosine ───────────────────────────────────────────────────────────────────
check('cosine: 同向=1', Math.abs(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2, 3])) - 1) < 1e-5)
check('cosine: 正交=0', Math.abs(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))) < 1e-6)
check('cosine: 维度不符/零向量=0', cosine(Float32Array.from([1]), Float32Array.from([1, 2])) === 0 && cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1])) === 0)

// ── mergeRankings（RRF k=60）─────────────────────────────────────────────────
{
  const a = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
  const b = [{ id: 'w' }, { id: 'y' }]
  const merged = mergeRankings(a, b, (h) => h.id)
  check('rrf: 两路都中的项排最前（y 双路加成）', merged[0].id === 'y', JSON.stringify(merged.map((h) => h.id)))
  check('rrf: 并集完整', merged.length === 4)
  check('rrf: 确定性（同分按 key 定序）',
    JSON.stringify(mergeRankings(a, b, (h) => h.id).map((h) => h.id)) === JSON.stringify(merged.map((h) => h.id)))
  check('rrf: 单路空表等于另一路', mergeRankings([], b, (h) => h.id).map((h) => h.id).join() === 'w,y')
}

// ── SemanticBreaker：3 连败 → 冷却；成功复位 ─────────────────────────────────
{
  const br = new SemanticBreaker(3, 60_000)
  check('breaker: 初始关', br.open === false)
  br.fail(); br.fail()
  check('breaker: 2 连败未熔断', br.open === false)
  br.fail()
  check('breaker: 3 连败熔断', br.open === true)
  const br2 = new SemanticBreaker(1, -1) // 冷却 -1ms = 立即过期
  br2.fail()
  check('breaker: 冷却过期自动恢复', br2.open === false)
  const br3 = new SemanticBreaker(5, 60_000)
  br3.fail(); br3.ok(); br3.fail()
  check('breaker: 成功清零连败计数', br3.open === false)
}

// ── embedTexts（fake fetch）──────────────────────────────────────────────────
const okFetch = async (url, opts) => {
  const body = JSON.parse(opts.body)
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: body.input.map((t) => ({ embedding: [t.length, t.charCodeAt(0) % 7, 1] })) }),
  }
}
{
  const r = await embedTexts(CFG, ['abc', 'de'], { fetchImpl: okFetch })
  check('embed: 成功返回向量与维度', r.dim === 3 && r.vectors.length === 2 && Math.abs(r.vectors[0][0] - 3) < 1e-6)
  let seenAuth = ''
  await embedTexts({ ...CFG, apiKey: 'sk-test' }, ['x'], {
    fetchImpl: async (url, opts) => { seenAuth = String(opts.headers.authorization ?? ''); return okFetch(url, opts) },
  })
  check('embed: apiKey 非空带 Bearer 头', seenAuth === 'Bearer sk-test')
  let seenAuth2 = 'unset'
  await embedTexts({ ...CFG, apiKey: '' }, ['x'], {
    fetchImpl: async (url, opts) => { seenAuth2 = 'authorization' in opts.headers ? String(opts.headers.authorization) : 'absent'; return okFetch(url, opts) },
  })
  check('embed: apiKey 空不带鉴权头（本地网关）', seenAuth2 === 'absent')
  let seenUrl = ''
  await embedTexts({ ...CFG, baseUrl: 'http://127.0.0.1:11434/v1/' }, ['x'], {
    fetchImpl: async (url, opts) => { seenUrl = url; return okFetch(url, opts) },
  })
  check('embed: baseUrl 尾斜杠归一', seenUrl === 'http://127.0.0.1:11434/v1/embeddings', seenUrl)
  let threw = ''
  await embedTexts(CFG, ['x'], { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }).catch((e) => { threw = e.message })
  check('embed: HTTP 500 抛错', threw.includes('500'))
  threw = ''
  await embedTexts(CFG, ['x', 'y'], { fetchImpl: okFetch }).catch(() => {})
  // okFetch 按 input 长度返回，条数永远相符；条数不符场景：
  await embedTexts(CFG, ['x'], { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) }).catch((e) => { threw = e.message })
  check('embed: 返回条数不符抛错', threw.includes('条数不符'))
  threw = ''
  await embedTexts(CFG, ['x'], { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [] }] }) }) }).catch((e) => { threw = e.message })
  check('embed: 空向量抛错', threw.length > 0)
  const t0 = Date.now()
  threw = ''
  await embedTexts(CFG, ['x'], {
    timeoutMs: 50,
    fetchImpl: (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted')))),
  }).catch((e) => { threw = e.message })
  check('embed: 超时经 AbortController 落实', threw === 'aborted' && Date.now() - t0 < 3000, `${Date.now() - t0}ms`)
  const empty = await embedTexts(CFG, [])
  check('embed: 空输入零调用', empty.vectors.length === 0 && empty.dim === 0)
}

// ── SemanticRuntime：usable 闸 + fail-soft + 熔断联动 ────────────────────────
{
  const off = new SemanticRuntime({ ...SEMANTIC_DEFAULTS }, okFetch) // enabled=false
  check('runtime: 关闭时 usable=false 且不发请求', off.usable() === false && (await off.embedQuery('q')) === null)
  let calls = 0
  const ok = new SemanticRuntime(CFG, async (u, o) => { calls++; return okFetch(u, o) })
  check('runtime: 开启时 usable=true', ok.usable() === true)
  const v = await ok.embedQuery('hello')
  check('runtime: 查询向量返回', v !== null && v.length === 3 && calls === 1)
  const boom = new SemanticRuntime(CFG, async () => { throw new Error('endpoint down') })
  check('runtime: 失败返回 null（不抛）', (await boom.embedQuery('q')) === null)
  await boom.embedQuery('q'); await boom.embedQuery('q')
  check('runtime: 3 连败后熔断（usable=false）', boom.usable() === false)
  check('runtime: 熔断中直接 null 不发请求', (await boom.embedQuery('q')) === null)
}

// ── v0.4.2 热生效：活配置视图（同引用、属性可变）翻动即生效 + 端点漂移复位熔断 ──
{
  // 模拟 index.ts 的 getter 化活视图：运行时捕获同一对象，属性值随后变化
  const live = { ...CFG }
  let fails = 0
  const rtLive = new SemanticRuntime(live, async () => { fails++; throw new Error('down') })
  await rtLive.embedQuery('a'); await rtLive.embedQuery('b'); await rtLive.embedQuery('c')
  check('hot: 3 连败熔断', rtLive.usable() === false && fails === 3)
  live.enabled = false; live.enabled = true // 纯开关翻动：端点身份未变
  check('hot: 开关翻动不复位熔断', rtLive.usable() === false)
  live.baseUrl = 'http://localhost:11434/v1' // 端点换了 → 熔断复位（新端点不背旧连败）
  check('hot: 端点漂移复位熔断', rtLive.usable() === true)
  live.apiKey = 'k2' // apiKey 也算端点身份
  check('hot: apiKey 漂移同样复位', rtLive.usable() === true)
  // 热启用语义：关闭时构造的运行时，翻动开关即可用（无需换新实例）
  const live2 = { ...SEMANTIC_DEFAULTS } // enabled=false
  const rtOff = new SemanticRuntime(live2, okFetch)
  check('hot: 关闭构造 usable=false 不发请求', rtOff.usable() === false && (await rtOff.embedQuery('x')) === null)
  live2.enabled = true
  check('hot: 开关热翻即生效（下一轮对话可用）', rtOff.usable() === true && (await rtOff.embedQuery('x')) !== null)
  live2.enabled = false
  check('hot: 热停用即时回落', rtOff.usable() === false)
}

// ── db 向量方法：roundtrip / remove 联动 / 孤儿清扫 ───────────────────────────
const dbDir = mkdtempSync(join(tmpdir(), 'mm-sem-db-'))
const db = new MemoryDb(join(dbDir, 'memory.db'))
{
  const r1 = db.insert({ level: 'fact', content: 'Python 装饰器语法糖', title: '装饰器' })
  const r2 = db.insert({ level: 'fact', content: 'Rust 所有权与借用检查' })
  db.upsertEmbedding('fact', r1.id, 'm1', contentHashOf(r1.title, r1.content), Float32Array.from([1, 0, 0]))
  const got = db.getEmbedding('fact', r1.id)
  check('db: 向量写入读取 roundtrip（float 精度）', got !== undefined && got.model === 'm1' && Math.abs(got.vector[0] - 1) < 1e-7 && got.vector.length === 3)
  db.upsertEmbedding('fact', r1.id, 'm1', 'h2', Float32Array.from([0.5, 0.5, 0]))
  check('db: upsert 覆盖同键', db.getEmbedding('fact', r1.id).hash === 'h2')
  db.upsertEmbedding('fact', r2.id, 'm1', contentHashOf(r2.title, r2.content), Float32Array.from([0, 1, 0]))
  check('db: 无向量行返回 undefined', db.getEmbedding('fact', 'no-such-id') === undefined)

  // semanticRank：阈值/排序/hash 新鲜/模型匹配
  const ranked = semanticRank(db, { ...CFG, model: 'm1', topK: 5, minScore: 0.1 }, Float32Array.from([1, 0, 0]), [
    { level: 'fact', id: r1.id, title: r1.title, content: r1.content }, // hash=h2 ≠ 当前内容 → 跳过
    { level: 'fact', id: r2.id, title: r2.title, content: r2.content }, // 正交 cos=0 < 0.1 → 跳过
  ])
  check('rank: hash 过期跳过 + 低于阈值过滤', ranked.length === 0, JSON.stringify(ranked))
  db.upsertEmbedding('fact', r1.id, 'm1', contentHashOf(r1.title, r1.content), Float32Array.from([0.9, 0.1, 0]))
  const ranked2 = semanticRank(db, { ...CFG, model: 'm1', topK: 5, minScore: 0.1 }, Float32Array.from([1, 0, 0]), [
    { level: 'fact', id: r1.id, title: r1.title, content: r1.content },
    { level: 'fact', id: r2.id, title: r2.title, content: r2.content },
  ])
  check('rank: 新鲜向量按分数命中', ranked2.length === 1 && ranked2[0].id === r1.id && ranked2[0].score > 0.9)
  const ranked3 = semanticRank(db, { ...CFG, model: 'OTHER-MODEL' }, Float32Array.from([1, 0, 0]), [
    { level: 'fact', id: r1.id, title: r1.title, content: r1.content },
  ])
  check('rank: 模型不符跳过（换模型不重打分）', ranked3.length === 0)

  // remove 联动清理向量
  check('db: remove 联动删向量', db.remove('fact', r2.id) === true && db.getEmbedding('fact', r2.id) === undefined)
  // 孤儿清扫：手工造孤儿（直接删主表行绕过 remove 的联动）
  const r3 = db.insert({ level: 'fact', content: '孤儿条目' })
  db.upsertEmbedding('fact', r3.id, 'm1', 'h', Float32Array.from([1, 0]))
  db.remove('fact', r3.id) // 联动已删向量
  db.upsertEmbedding('fact', r3.id, 'm1', 'h', Float32Array.from([1, 0])) // 主表无此行 → 孤儿
  check('db: 孤儿清扫', db.sweepOrphanEmbeddings() === 1 && db.getEmbedding('fact', r3.id) === undefined)
  check('db: 无孤儿时清扫返回 0', db.sweepOrphanEmbeddings() === 0)
}

// ── SemanticIndexer：补缺 + 新鲜跳过 + 换模型重嵌 ────────────────────────────
{
  const iDb = new MemoryDb(join(mkdtempSync(join(tmpdir(), 'mm-sem-idx-')), 'memory.db'))
  const a = iDb.insert({ level: 'fact', content: '阿尔法记忆' })
  const b = iDb.insert({ level: 'lesson', content: '贝塔教训' })
  const c = iDb.insert({ level: 'topic', content: '伽马话题' })
  // c 已嵌入且 hash 新鲜 → 应跳过
  iDb.upsertEmbedding('topic', c.id, CFG.model, contentHashOf(c.title, c.content), Float32Array.from([9, 9, 9]))
  const calls = []
  const idxFetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push(body.input.length)
    return { ok: true, status: 200, json: async () => ({ data: body.input.map((t) => ({ embedding: [t.length, 1, 0] })) }) }
  }
  const rt = new SemanticRuntime(CFG, idxFetch)
  const idx = new SemanticIndexer(iDb, rt, () => {}, 60_000, 64, 16)
  await idx.pass()
  check('indexer: 补缺两条（新鲜跳过）', iDb.getEmbedding('fact', a.id) !== undefined && iDb.getEmbedding('lesson', b.id) !== undefined)
  check('indexer: 新鲜行不重嵌（c 向量未被覆盖）', iDb.getEmbedding('topic', c.id).vector[0] === 9)
  check('indexer: 批量调用一次完成（2 ≤ batchSize）', calls.length === 1 && calls[0] === 2, JSON.stringify(calls))
  await idx.pass()
  check('indexer: 第二趟全部新鲜 → 零调用', calls.length === 1)
  // 换模型 → 全部重嵌
  const rt2 = new SemanticRuntime({ ...CFG, model: 'm2' }, idxFetch)
  const idx2 = new SemanticIndexer(iDb, rt2, () => {}, 60_000, 64, 16)
  await idx2.pass()
  check('indexer: 换模型后旧向量重嵌为新模型',
    iDb.getEmbedding('fact', a.id).model === 'm2' && iDb.getEmbedding('topic', c.id).model === 'm2')
  // 关开关 → pass 空转
  const rt3 = new SemanticRuntime({ ...SEMANTIC_DEFAULTS }, idxFetch)
  const idx3 = new SemanticIndexer(iDb, rt3, () => {}, 60_000, 64, 16)
  const before = calls.length
  await idx3.pass()
  check('indexer: runtime 不可用时空转（不发请求）', calls.length === before)
  iDb.close()
}

// ── v0.4.2：索引器恒启 + 活配置热启用——关闭时 pass 空转，开关翻动后下一趟自动回填 ──
{
  const hDb = new MemoryDb(join(mkdtempSync(join(tmpdir(), 'mm-sem-hot-')), 'memory.db'))
  const h1 = hDb.insert({ level: 'fact', content: '热启用回填甲' })
  const h2 = hDb.insert({ level: 'fact', content: '热启用回填乙' })
  let hotCalls = 0
  const liveCfg = { ...SEMANTIC_DEFAULTS } // enabled=false，端点/模型用出厂默认（非空）
  const rtH = new SemanticRuntime(liveCfg, async (url, opts) => {
    hotCalls++
    const body = JSON.parse(opts.body)
    return { ok: true, status: 200, json: async () => ({ data: body.input.map((t) => ({ embedding: [t.length, 1, 0] })) }) }
  })
  const idxH = new SemanticIndexer(hDb, rtH, () => {}, 60_000, 64, 16)
  await idxH.pass()
  check('hot-indexer: 关闭时 pass 空转零调用', hotCalls === 0)
  liveCfg.enabled = true // 设置页保存 → 活视图翻动（生产经 applyLiveConfig getter）
  await idxH.pass()
  check('hot-indexer: 开关热翻后下一趟自动回填',
    hotCalls === 1 && hDb.getEmbedding('fact', h1.id) !== undefined && hDb.getEmbedding('fact', h2.id) !== undefined)
  hDb.close()
}

db.close()
rmSync(dbDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

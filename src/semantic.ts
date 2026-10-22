/**
 * dsh-personal-memory — 向量语义检索（v0.4.0，默认关闭，用户在设置里显式开启）。
 *
 * 设计要点：
 * - **隐私红线**：开启后记忆内容会发到配置的 embedding 端点（默认 OpenAI 兼容
 *   /embeddings）。所以 enabled 默认 false，设置页开关旁明示隐私提示。
 * - **fail-soft 到底**：任何一步失败（网络/鉴权/超时/熔断中）都静默回落纯关键词
 *   链路，绝不影响注入/检索主流程。熔断器连续失败 3 次冷却 10 分钟。
 * - **存储**：向量落 memory_embeddings 表（见 db.ts），内容指纹 sha256[:16]
 *   校验新鲜度——内容改过但还没重嵌入的旧向量不参与打分（hash 不符即跳过），
 *   SemanticIndexer 后台追平。
 * - **两路消费**：① 每条用户消息关键词无命中时的语义召回兜底（hit 链）；
 *   ② memory_search 工具的关键词×语义 RRF 混合排序。
 */

import { createHash } from 'node:crypto'
import { LEVELS, type Level, type MemoryDb, type MemoryRow } from './db.js'

export interface SemanticConfig {
  /** 总开关（默认 false——记忆内容出本机，必须用户显式开）。 */
  enabled: boolean
  /** 每条消息关键词无命中时的语义召回兜底（enabled 前提下）。 */
  recall: boolean
  /** OpenAI 兼容端点根（POST {baseUrl}/embeddings）。 */
  baseUrl: string
  /** 鉴权 key；留空 = 不带 Authorization（本地网关如 ollama 兼容层）。 */
  apiKey: string
  /** embedding 模型名（换模型后旧向量 hash 校验不符自动重嵌入）。 */
  model: string
  /** 语义召回/混合排序的语义侧条数上限。 */
  topK: number
  /** cosine 相似度下限（低于视为无关，防弱相关噪音注入）。 */
  minScore: number
}

/** 出厂默认（defaults.ts 有一份字面量副本供 client 设置页用，parity 测试保证同步）。 */
export const SEMANTIC_DEFAULTS: SemanticConfig = {
  enabled: false,
  recall: true,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'text-embedding-3-small',
  topK: 5,
  minScore: 0.25,
}

/** 兜底解析：手编 YAML 不经设置页校验，这里逐字段防守。 */
export function resolveSemantic(raw: unknown): SemanticConfig {
  const s = (raw ?? {}) as Partial<SemanticConfig>
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : SEMANTIC_DEFAULTS.enabled,
    recall: typeof s.recall === 'boolean' ? s.recall : SEMANTIC_DEFAULTS.recall,
    baseUrl: typeof s.baseUrl === 'string' && s.baseUrl.trim() !== '' ? s.baseUrl.trim() : SEMANTIC_DEFAULTS.baseUrl,
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    model: typeof s.model === 'string' && s.model.trim() !== '' ? s.model.trim() : SEMANTIC_DEFAULTS.model,
    topK: typeof s.topK === 'number' && Number.isFinite(s.topK) ? Math.max(1, Math.min(20, Math.round(s.topK))) : SEMANTIC_DEFAULTS.topK,
    minScore: typeof s.minScore === 'number' && Number.isFinite(s.minScore) ? Math.max(0, Math.min(1, s.minScore)) : SEMANTIC_DEFAULTS.minScore,
  }
}

/** 向量内容指纹：title+content 的 sha256 前 16 hex（新鲜度校验用，非安全用途）。 */
export function contentHashOf(title: string | null, content: string): string {
  return createHash('sha256').update(`${title ?? ''}\n${content}`).digest('hex').slice(0, 16)
}

/** 嵌入文本面（与 contentHashOf 同口径；截断 2000 字防 token 爆炸）。 */
export function embeddingText(title: string | null, content: string): string {
  return `${title ?? ''}\n${content}`.slice(0, 2000)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * RRF 融合两路排序（k=60 标准常数）：score = Σ 1/(k + rank)。
 * 确定性：分相同按 key 字典序定序。
 */
export function mergeRankings<T>(primary: readonly T[], secondary: readonly T[], keyOf: (x: T) => string, k = 60): T[] {
  const score = new Map<string, number>()
  const rep = new Map<string, T>()
  const add = (list: readonly T[]): void => {
    list.forEach((item, i) => {
      const key = keyOf(item)
      score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1))
      if (!rep.has(key)) rep.set(key, item)
    })
  }
  add(primary)
  add(secondary)
  return [...score.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([key]) => rep.get(key)!)
}

/** 熔断器：连续失败 maxFailures 次 → 冷却 cooldownMs（期间 usable=false，静默跳过）。 */
export class SemanticBreaker {
  private failures = 0
  private cooldownUntil = 0
  constructor(
    private readonly maxFailures = 3,
    private readonly cooldownMs = 600_000,
  ) {}
  get open(): boolean {
    return Date.now() < this.cooldownUntil
  }
  ok(): void {
    this.failures = 0
    this.cooldownUntil = 0
  }
  fail(now = Date.now()): void {
    this.failures++
    if (this.failures >= this.maxFailures) {
      this.cooldownUntil = now + this.cooldownMs
      this.failures = 0
    }
  }
}

export interface EmbedResult {
  vectors: Float32Array[]
  dim: number
}

/**
 * OpenAI 兼容 /embeddings 批量调用。fetchImpl 可注入替身（测试）；超时经
 * AbortController 落实（召回路 4s，索引路 30s，由调用方给）。
 * 返回条数/维度与请求不符即抛错（熔断器计数），绝不静默收脏数据。
 */
export async function embedTexts(
  cfg: SemanticConfig,
  texts: string[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], dim: 0 }
  const f = opts.fetchImpl ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000)
  try {
    const res = await f(`${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey.trim() !== '' ? { authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
    const data = (await res.json()) as { data?: Array<{ embedding?: unknown }> }
    const list = Array.isArray(data.data) ? data.data : []
    if (list.length !== texts.length) throw new Error(`embeddings 返回条数不符：期望 ${texts.length} 实得 ${list.length}`)
    const vectors = list.map((item) => {
      const arr = item.embedding
      if (!Array.isArray(arr) || arr.length === 0 || arr.some((x) => typeof x !== 'number')) {
        throw new Error('embeddings 返回空向量或非法分量')
      }
      return Float32Array.from(arr as number[])
    })
    const dim = vectors[0].length
    if (vectors.some((v) => v.length !== dim)) throw new Error('embeddings 向量维度不一致')
    return { vectors, dim }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 语义运行时：配置 + 熔断器 + 嵌入调用。index.ts 在 apply 时构造一个实例，
 * 经 setSemanticRuntime 注入工具层。config 可为活视图（v0.4.2 起 index.ts 传入
 * applyLiveConfig getter 化的对象）：usable()/embed* 每次调用读最新值，设置页
 * 改动下一轮对话即生效，不换实例、不重启。端点身份（baseUrl/apiKey/model）
 * 漂移时自动复位熔断器——新端点不背旧端点的连败（否则修完端点还要干等冷却）。
 */
export class SemanticRuntime {
  private readonly breaker = new SemanticBreaker()
  private lastIdentity: string | undefined
  constructor(
    readonly config: SemanticConfig,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** 端点身份漂移检测：变了就复位熔断器（连败计数 + 冷却一并清零）。 */
  private syncIdentity(): void {
    const id = `${this.config.baseUrl} ${this.config.apiKey} ${this.config.model}`
    if (this.lastIdentity !== undefined && id !== this.lastIdentity) this.breaker.ok()
    this.lastIdentity = id
  }

  /** 当前可用：开关开 + 端点/模型非空 + 未熔断。 */
  usable(): boolean {
    this.syncIdentity()
    return this.config.enabled && this.config.baseUrl.trim() !== '' && this.config.model.trim() !== '' && !this.breaker.open
  }

  /** 单文本嵌入（召回路）；失败/不可用返回 null（调用方静默跳过语义路）。 */
  async embedQuery(text: string, timeoutMs = 4000): Promise<Float32Array | null> {
    if (!this.usable()) return null
    try {
      const { vectors } = await embedTexts(this.config, [text], { fetchImpl: this.fetchImpl, timeoutMs })
      this.breaker.ok()
      return vectors[0] ?? null
    } catch {
      this.breaker.fail()
      return null
    }
  }

  /** 批量嵌入（索引器路）；语义同 embedQuery。 */
  async embedBatch(texts: string[], timeoutMs = 30_000): Promise<Float32Array[] | null> {
    if (!this.usable() || texts.length === 0) return null
    try {
      const { vectors } = await embedTexts(this.config, texts, { fetchImpl: this.fetchImpl, timeoutMs })
      this.breaker.ok()
      return vectors
    } catch {
      this.breaker.fail()
      return null
    }
  }
}

export interface SemanticHit {
  level: Level
  id: string
  score: number
}

/**
 * 候选集语义打分：queryVec × 库存向量 cosine，minScore 过滤 + topK 截断。
 * 模型不符（换过模型）或内容 hash 过期（改过还没重嵌入）的向量跳过。
 * 返回按分数降序（同分按 id 定序，确定性）。
 */
export function semanticRank(
  db: MemoryDb,
  cfg: SemanticConfig,
  queryVec: Float32Array,
  candidates: ReadonlyArray<Pick<MemoryRow, 'level' | 'id' | 'title' | 'content'>>,
): SemanticHit[] {
  const scored: SemanticHit[] = []
  for (const c of candidates) {
    const e = db.getEmbedding(c.level, c.id)
    if (e === undefined || e.model !== cfg.model) continue
    if (e.hash !== contentHashOf(c.title, c.content)) continue
    const score = cosine(queryVec, e.vector)
    if (score >= cfg.minScore) scored.push({ level: c.level, id: c.id, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return scored.slice(0, cfg.topK)
}

/**
 * 语义索引器：周期性把「没嵌过 / 内容变了 / 换模型了」的 active 记忆补嵌入，
 * 孤儿向量（主表已删）顺带清扫。小步慢跑：每趟最多 perPass 行、batchSize 一批，
 * 不追求即时追平，求稳求省（个人库千条级，一小时能铺几千条）。
 * kick() 供写入路径（新增/更新记忆）触发即时补嵌。
 */
export class SemanticIndexer {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  constructor(
    private readonly db: MemoryDb,
    private readonly runtime: SemanticRuntime,
    private readonly log: (msg: string) => void = () => {},
    private readonly intervalMs = 60_000,
    private readonly perPass = 64,
    private readonly batchSize = 16,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.pass(), this.intervalMs)
    void this.pass()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  kick(): void {
    void this.pass()
  }

  /** 跑一趟（重入保护：上一趟没跑完直接返回）。 */
  async pass(): Promise<void> {
    if (this.running) return
    if (!this.runtime.usable()) return
    this.running = true
    try {
      const rows: MemoryRow[] = []
      for (const level of LEVELS) rows.push(...this.db.list(level, { status: 'active' }))
      const pending = rows
        .filter((r) => {
          const e = this.db.getEmbedding(r.level, r.id)
          if (e === undefined) return true
          if (e.model !== this.runtime.config.model) return true
          return e.hash !== contentHashOf(r.title, r.content)
        })
        .slice(0, this.perPass)
      for (let i = 0; i < pending.length; i += this.batchSize) {
        const batch = pending.slice(i, i + this.batchSize)
        const vectors = await this.runtime.embedBatch(batch.map((r) => embeddingText(r.title, r.content)))
        if (vectors === null) break // 失败/熔断：下趟再来
        batch.forEach((r, j) => {
          const v = vectors[j]
          if (v !== undefined) {
            this.db.upsertEmbedding(r.level, r.id, this.runtime.config.model, contentHashOf(r.title, r.content), v)
          }
        })
      }
      const swept = this.db.sweepOrphanEmbeddings()
      if (swept > 0) this.log(`dsh-personal-memory: 语义索引孤儿清扫 ${swept} 条`)
    } catch (e) {
      this.log(`dsh-personal-memory: 语义索引趟失败（下趟重试）：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.running = false
    }
  }
}

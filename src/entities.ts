/**
 * LLM 实体抽取（手动重建 / dream 收尾触发；**不在写入路径调用**）。
 *
 * 为什么不用关键词 + 规则：
 *   keywords 是「用户问什么词能检索到这条记忆」，不是实体。按词形分类/过滤永远有
 *   badcase（住院→机构、加价绕路→地点、11月→概念）。这里直接把记忆正文交给模型，
 *   由模型给出实体类型和关系类型；代码只做 JSON 解析与合法性兜底。
 *
 * 存储：entities / memory_entities / entity_relations / entity_extract_done 四张表。
 * 每个实体、每条关系都带来源记忆 id，可回溯、可重建、可清空。
 */

import { getPromptLang } from './prompt-loader.js'
import type { MemoryDb } from './db.js'

export type EntityType = 'person' | 'location' | 'organization' | 'item' | 'event' | 'health' | 'concept'

export const ENTITY_TYPES: readonly EntityType[] = ['person', 'location', 'organization', 'item', 'event', 'health', 'concept']

export type RelationType =
  | 'has_allergy'
  | 'lives_in'
  | 'works_at'
  | 'plans'
  | 'prefers'
  | 'avoids'
  | 'owns'
  | 'treats'
  | 'related_to'

export const RELATION_TYPES: readonly RelationType[] = [
  'has_allergy', 'lives_in', 'works_at', 'plans', 'prefers', 'avoids', 'owns', 'treats', 'related_to',
]

export interface ExtractedEntity { name: string; type: EntityType }
export interface ExtractedRelation { from: string; to: string; type: RelationType }
export interface Extraction { entities: ExtractedEntity[]; relations: ExtractedRelation[] }

export type CallLLM = (messages: unknown[], options?: Record<string, unknown>) => Promise<string>

const ZH_PROMPT = `你是个人记忆的实体抽取器。从一条记忆里抽取「关于这个人」的实体和它们之间的关系。

只输出严格 JSON，不要解释、不要 markdown：
{
  "entities": [{"name": "实体名", "type": "person|location|organization|item|event|health|concept"}],
  "relations": [{"from": "实体名", "to": "实体名", "type": "has_allergy|lives_in|works_at|plans|prefers|avoids|owns|treats|related_to"}]
}

规则：
- 只抽具体的人、地点、机构、物品、事件、健康状况、长期偏好/红线。
- 当记忆描述主人自己（“我/我的…”）时，用规范名「我」作为一个 type=person 的实体，并与相关实体建立关系；不要用「用户」「本人」等其他写法。
- 不要抽：代码符号、文件路径、配置键、工具/API 名、日期时间、动作短语、泛称（用户/公司/医生/其他品牌/平台客服）。
- 如果这条记忆讲的是**代码、文件格式、配置、工具/API 实现、会话文件、调试过程、插件/系统内部机制**，它不属于个人生活知识：直接返回 {"entities":[],"relations":[]}。
- 同一事物的不同写法合并成一个规范名（例如 妻子/太太→老婆，协和→协和医院，健康检查→体检）。
- 关系方向：from 是主体，to 是客体；不确定就用 related_to。
- 中文名称原样输出，不翻译、不罗马化。
- 没有实体就返回 {"entities":[],"relations":[]}。`

const EN_PROMPT = `You extract a personal knowledge graph from one memory entry.

Return strict JSON only (no markdown, no explanation):
{
  "entities": [{"name": "entity name", "type": "person|location|organization|item|event|health|concept"}],
  "relations": [{"from": "entity", "to": "entity", "type": "has_allergy|lives_in|works_at|plans|prefers|avoids|owns|treats|related_to"}]
}

Rules:
- Only concrete people, places, organizations, items, events, health conditions, long-term preferences/red lines.
- When the memory is about the owner themselves ("I / my ..."), use the canonical entity "我" (or "Me" for English text) with type=person, and relate it to the other entities. Do NOT use "the user" / "the owner".
- Do NOT extract code identifiers, file paths, config keys, tool/API names, dates, times, verb phrases, or generic references (the user/company/doctor/other brands).
- If the memory is about code, file formats, configs, tool/API internals, session files, debugging, or plugin/system internals, it is NOT personal-life knowledge: return {"entities":[],"relations":[]}.
- Merge obvious variants of the same thing into one canonical name (wife/spouse -> wife, 协和 -> 协和医院).
- Relations: from is the subject, to is the object; use related_to when unsure.
- Keep original language; do not translate.
- If nothing, return {"entities":[],"relations":[]}.`

function systemPrompt(): string {
  return getPromptLang().toLowerCase().startsWith('zh') ? ZH_PROMPT : EN_PROMPT
}

/** 从模型输出里取 JSON（兼容 ```json 包裹、前后废话）。 */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch { /* 继续找花括号块 */ }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 解析 + 合法性兜底（不做分类规则：类型/关系由模型给，未知值才回退）。 */
export function parseExtraction(text: string): Extraction | null {
  const raw = extractJson(text)
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as { entities?: unknown; relations?: unknown }
  if (!Array.isArray(obj.entities)) return null

  const entities: ExtractedEntity[] = []
  const seen = new Set<string>()
  for (const item of obj.entities) {
    const e = item as { name?: unknown; type?: unknown }
    const name = typeof e?.name === 'string' ? e.name.trim() : ''
    if (name === '' || name.length > 40) continue
    if (seen.has(name)) continue
    seen.add(name)
    const type = (typeof e.type === 'string' && (ENTITY_TYPES as readonly string[]).includes(e.type)
      ? e.type
      : 'concept') as EntityType
    entities.push({ name, type })
  }

  const relations: ExtractedRelation[] = []
  const relSeen = new Set<string>()
  if (Array.isArray(obj.relations)) {
    for (const item of obj.relations) {
      const r = item as { from?: unknown; to?: unknown; type?: unknown }
      const from = typeof r?.from === 'string' ? r.from.trim() : ''
      const to = typeof r?.to === 'string' ? r.to.trim() : ''
      if (from === '' || to === '' || from === to) continue
      if (!seen.has(from) || !seen.has(to)) continue
      const type = (typeof r.type === 'string' && (RELATION_TYPES as readonly string[]).includes(r.type)
        ? r.type
        : 'related_to') as RelationType
      const key = `${from}\u0000${to}\u0000${type}`
      if (relSeen.has(key)) continue
      relSeen.add(key)
      relations.push({ from, to, type })
    }
  }
  return { entities, relations }
}

/**
 * 抽一条记忆。
 * @returns 写入的实体数；LLM 失败/解析失败返回 -1（不标记 done，下轮重试）。
 */
export async function extractMemoryEntities(
  db: MemoryDb,
  memoryId: string,
  callLLM: CallLLM,
  logger?: { warn?: (m: string) => void },
): Promise<number> {
  const found = db.findById(memoryId)
  if (found === undefined) return -1
  const row = found.row
  const content = row.title ? `${row.title}\n${row.content}` : row.content
  if (content.trim() === '') {
    db.markEntityExtracted(memoryId)
    return 0
  }

  let text = ''
  try {
    text = await callLLM([
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: [{ type: 'text', text: content }] },
    ])
  } catch (e) {
    logger?.warn?.(`[jt-pa] 实体抽取调用失败：${e instanceof Error ? e.message : String(e)}`)
    return -1
  }
  if (text.trim() === '') return -1

  const parsed = parseExtraction(text)
  if (parsed === null) {
    logger?.warn?.(`[jt-pa] 实体抽取返回无法解析（${memoryId.slice(0, 8)}）`)
    return -1
  }

  // 重抽前清掉这条记忆的旧链接/旧关系（幂等）
  db.clearMemoryEntities(memoryId)
  const idByName = new Map<string, string>()
  for (const e of parsed.entities) {
    const id = db.upsertEntity(e.name, e.type)
    db.linkMemoryEntity(memoryId, id, 'llm')
    idByName.set(e.name, id)
  }
  for (const r of parsed.relations) {
    const from = idByName.get(r.from)
    const to = idByName.get(r.to)
    if (from === undefined || to === undefined) continue
    db.upsertRelation(from, to, r.type, memoryId)
  }
  db.markEntityExtracted(memoryId)
  // 重抽后旧的实体可能已没有来源记忆：清掉，避免图谱出现点不开的空节点。
  db.deleteOrphanEntities()
  return parsed.entities.length
}

const REPAIR_ZH_PROMPT = `你是个人记忆的关系补全器。给你一个实体 X、它出现的记忆，以及「已有实体列表」，请只根据这些记忆判断 X 与列表中的哪些实体存在关系。

只输出严格 JSON，不要解释、不要 markdown：
{"relations":[{"to":"已有实体名","type":"has_allergy|lives_in|works_at|plans|prefers|avoids|owns|treats|related_to"}]}

规则：
- to 只能从「已有实体列表」里选，不能是 X 自己。
- 只连记忆里明确支持的关系；不确定、太弱或没有就返回 {"relations":[]}。
- 不要为了连线而编造关系。
- 中文名称原样输出，不翻译、不罗马化。`

const REPAIR_EN_PROMPT = `You complete relations for a personal knowledge graph. Given entity X, the memories it appears in, and a list of existing entities, decide which existing entities X relates to, based ONLY on those memories.

Output strict JSON, no prose, no markdown:
{"relations":[{"to":"existing entity name","type":"has_allergy|lives_in|works_at|plans|prefers|avoids|owns|treats|related_to"}]}

Rules:
- "to" MUST be one of the existing entity names, never X itself.
- Only relations explicitly supported by the memories; if unsure or none, return {"relations":[]}.
- Never invent a relation just to connect a node.`

export function parseRelationRepair(text: string): Array<{ to: string; type: RelationType }> {
  const json = extractJson(text)
  if (json === null) return []
  const rows = Array.isArray((json as { relations?: unknown }).relations)
    ? (json as { relations: unknown[] }).relations
    : []
  const out: Array<{ to: string; type: RelationType }> = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const to = typeof r.to === 'string' ? r.to.trim() : ''
    const type = typeof r.type === 'string' && (RELATION_TYPES as readonly string[]).includes(r.type)
      ? (r.type as RelationType)
      : 'related_to'
    if (to === '') continue
    out.push({ to, type })
  }
  return out.slice(0, 20)
}

/**
 * 对「最终图上没有任何边」的实体，用它出现的记忆再问一次模型，补语义关系。
 * 只在批量抽取刚跑完时触发（手动重建 / dream 收尾），不在写入路径调用。
 */
export async function repairIsolatedEntities(
  db: MemoryDb,
  callLLM: CallLLM,
  opts: { limit?: number; logger?: { warn?: (m: string) => void } } = {},
): Promise<{ checked: number; relations: number; failed: number }> {
  const isolated = db.isolatedEntities(opts.limit ?? 8)
  if (isolated.length === 0) return { checked: 0, relations: 0, failed: 0 }

  const all = db.entityGraph(500).nodes
  const byName = new Map(all.map((n) => [n.name, n]))
  let relations = 0
  let failed = 0

  for (const ent of isolated) {
    const memories = ent.rowIds
      .map((id) => db.findById(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
    const content = memories
      .map((m) => (m.row.title ? `${m.row.title}\n${m.row.content}` : m.row.content))
      .filter((c) => c.trim() !== '')
      .join('\n---\n')
      .slice(0, 4000)
    if (content.trim() === '') continue

    const names = all.filter((n) => n.id !== ent.id).map((n) => n.name).slice(0, 80)
    if (names.length === 0) continue

    let text = ''
    try {
      text = await callLLM([
        { role: 'system', content: getPromptLang().toLowerCase().startsWith('zh') ? REPAIR_ZH_PROMPT : REPAIR_EN_PROMPT },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: `实体 X：${ent.name}（${ent.type}）\n\n它出现的记忆：\n${content}\n\n已有实体列表：\n${names.join('\n')}`,
          }],
        },
      ])
    } catch (e) {
      failed++
      logger?.warn?.(`[jt-pa] 孤立实体补关系调用失败（${ent.name}）：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (text.trim() === '') { failed++; continue }

    for (const r of parseRelationRepair(text)) {
      const to = byName.get(r.to)
      if (to === undefined || to.id === ent.id) continue
      db.upsertRelation(ent.id, to.id, r.type, ent.rowIds[0] ?? null)
      relations++
    }
  }

  return { checked: isolated.length, relations, failed }
}

/** 批量抽「还没抽过」的记忆（dream 收尾 / 手动重建）。 */
let extracting = false

export async function extractPendingEntities(
  db: MemoryDb,
  callLLM: CallLLM,
  opts: { limit?: number; logger?: { warn?: (m: string) => void } } = {},
): Promise<{ processed: number; entities: number; failed: number }> {
  // dream 收尾与手动重建可能同时触发：同一时刻只允许一批，避免重复调用/互相清写。
  if (extracting) return { processed: 0, entities: 0, failed: 0, repaired: 0 }
  extracting = true
  try {
    return await extractPendingEntitiesInner(db, callLLM, opts)
  } finally {
    extracting = false
  }
}

async function extractPendingEntitiesInner(
  db: MemoryDb,
  callLLM: CallLLM,
  opts: { limit?: number; logger?: { warn?: (m: string) => void } } = {},
): Promise<{ processed: number; entities: number; failed: number; repaired: number }> {
  const ids = db.rowsNeedingEntityExtraction(opts.limit ?? 6)
  let processed = 0
  let entities = 0
  let failed = 0
  for (const id of ids) {
    const n = await extractMemoryEntities(db, id, callLLM, opts.logger)
    if (n < 0) {
      failed++
      continue
    }
    processed++
    entities += n
  }
  // 批量抽完再补一次孤立实体：只补「最终图上完全没有任何边」的，模型决定连不连。
  let repaired = 0
  if (processed > 0) {
    const r = await repairIsolatedEntities(db, callLLM, { limit: 8, logger: opts.logger })
    repaired = r.relations
    if (r.checked > 0) {
      opts.logger?.warn?.(`[jt-pa] 孤立实体补关系：检查 ${r.checked} 个，补了 ${r.relations} 条，失败 ${r.failed}`)
    }
  }
  return { processed, entities, failed, repaired }
}
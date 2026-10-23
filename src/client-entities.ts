/**
 * dsh-personal-memory — 实体派生层（client 端纯函数）。
 *
 * ── 为什么是「派生」而不是「抽取表」
 * 本插件原来的关系网直接拿 `keywords` 当节点：零成本、永不过期，但节点是**词**
 * 不是**实体**——没有类型、没有语义边，「老婆 —海鲜过敏」表达不出来。
 * 另起一套实体表 + LLM 抽取当然能做到，但会引入孤儿、重复、工程概念泄漏、
 * 抽一条烧一次 LLM 这些成本（我们在另一个实现里全踩过）。
 *
 * 所以这里走中间路线：**在客户端把已有数据（keywords + 正文引号 + project）派生
 * 成实体**。不建表、不调 LLM、不改宿主，实体永远与记忆同步；派生规则是纯函数，
 * 可直接单测。语义边（has_allergy 之类）留给未来的可选层，不阻塞展示。
 *
 * ── 规则刻意保守
 * 宁可少认，不可认错：代码符号、泛称指代、并列短语、口语整句一律不认；
 * 类型靠「后缀/词典/姓氏/所在层」推断；同义变体用严格规则合并（详见 merge 段）。
 */

import type { ExplorerRow, GraphEdge, GraphNode, MemoryGraph } from './client-memory-graph.js'

export type EntityType =
  | 'person'
  | 'health'
  | 'event'
  | 'location'
  | 'organization'
  | 'item'
  | 'concept'
  | 'project'

/** 实体节点（GraphNode 的超集：带上来源记忆与类型）。 */
export interface EntityNode extends GraphNode {
  kind: 'entity'
  entityType: EntityType
  rowIds: readonly string[]
  userHits: number
}

export interface EntityPersonCard {
  id: string
  label: string
  count: number
  /** 与该人直接相连的实体（最多 5 个，按重要度）。 */
  items: string[]
}

export interface EntityThemeGroup {
  type: EntityType
  /** 该类型的真实实体数（items 只是截断后的前 12 个，UI 必须显示 total）。 */
  total: number
  items: Array<{ id: string; label: string; count: number }>
}

export interface EntityOverview {
  graph: MemoryGraph
  persons: EntityPersonCard[]
  themes: EntityThemeGroup[]
  stats: { total: number; entities: number; edges: number }
}

export interface EntityOverviewOptions {
  /** personal = 只含全局/未标记记忆；project = 只含项目锚定记忆；all = 全部。 */
  scope?: 'personal' | 'project' | 'all'
  /** 图上最多画多少个实体（人物恒保留）。默认 40；展开传 Infinity。 */
  limit?: number
  /** 「我」节点的显示名（默认中文；界面语言由调用方传入）。 */
  meLabel?: string
}

// ── 准入：哪些「词」不配当实体 ────────────────────────────────────────────────

const GENERIC = new Set([
  '我', '你', '他', '她', '我们', '你们', '他们', '本人', '用户', '自己', '大家', '别人', '某人',
  '公司', '单位', '医生', '老师', '朋友', '同事', '客服', '平台客服', '产品经理', '人工高级主管',
  '其他品牌', '其他', '品牌', '模型', 'agent', 'web', 'profile', 'dream', '首次设置', '插件引导提示',
  '到货', '应该没问题', '不用管', '已完成', '已归档', 'stale 条目', '本话题跟踪事件', '评测工作',
  '各种', '一些', '东西', '这件事', '那件事',
])

/** 单字实体白名单（词典词；其余单字一律不认，避免把「猫」「书」以外的碎片画上图）。 */
const SINGLE_OK = new Set(['猫', '狗', '书', '车', '房'])
/** 纯数字但确实是实体的（机构热线）。 */
const NUMERIC_OK = new Set(['12315', '110', '120', '119'])

const CODE_RULES: RegExp[] = [
  /[\\/]/, // 路径
  /\.(ts|js|mjs|cjs|tsx|jsx|json|yml|yaml|md|log|db|ps1|sh|toml|lock)$/i, // 文件名
  /[{}<>$]/, // 模板/占位符
  /^[a-z][a-z0-9_]*=[^\s]+$/i, // 赋值
  /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/, // snake_case 配置键
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/, // 全大写常量
]

function looksLikeCamel(label: string): boolean {
  return label.length >= 8 && /^[A-Za-z][A-Za-z0-9]*$/.test(label) && /[a-z]/.test(label) && /[A-Z]/.test(label)
}

export function isCodeLikeLabel(label: string): boolean {
  if (looksLikeCamel(label)) return true
  return CODE_RULES.some((re) => re.test(label))
}

export function isGenericLabel(label: string): boolean {
  return GENERIC.has(label.toLowerCase()) || GENERIC.has(label)
}

/** 口语整句 / 定语片段：不是实体。 */
export function isSentenceLabel(label: string): boolean {
  if (/^(不用|不要|应该|可以|已经|还是|然后|如果|因为|所以|但是|而且|现在|以后|记得|帮我|给|把|被)/.test(label)) return true
  if (/[的了呢吗吧啊呀]$/.test(label)) return true
  if (label.length > 14 && /[，。！？；：、,;:!?]/.test(label)) return true
  return false
}

/** 准入判定（导出给测试）。 */
export function isEntityLabel(label: string): boolean {
  const s = label.trim()
  if (s.length === 0 || s.length > 24) return false
  if (!/\p{L}/u.test(s) && !NUMERIC_OK.has(s)) return false
  if (s.length === 1 && !SINGLE_OK.has(s)) return false
  if (CODE_RULES.some((re) => re.test(s)) || looksLikeCamel(s)) return false
  if (isGenericLabel(s) || isSentenceLabel(s)) return false
  if (/[\/、]/.test(s)) return false // 并列短语：A/B、A、B
  return true
}

// ── 归一与类型推断 ───────────────────────────────────────────────────────────

/** 归一化：去装饰、去括号注释、去「的」（≥4 字时）。 */
export function normalizeEntityLabel(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim().replace(/^[-—·•\s]+|[-—·•\s]+$/g, '')
  s = s.replace(/[（(][^）)]*[）)]/g, '').trim()
  if (s.length >= 4) s = s.replace(/的/g, '')
  return s
}

const CITY_PREFIX = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '天津', '南京', '武汉', '西安', '苏州',
  '长沙', '郑州', '合肥', '济南', '青岛', '厦门', '福州', '昆明', '大连', '宁波', '无锡', '佛山',
  '东莞', '珠海', '三亚', '海南', '新疆', '西藏', '云南', '四川', '浙江', '江苏', '广东', '山东',
  '河南', '河北', '湖南', '湖北', '福建', '安徽', '江西', '山西', '陕西', '辽宁', '吉林', '黑龙江',
  '广西', '贵州', '甘肃', '青海', '宁夏', '内蒙古',
]
const ORG_EXACT = new Set([
  '腾讯', '阿里', '阿里巴巴', '百度', '字节', '字节跳动', '美团', '京东', '华为', '小米', '协和',
  '优衣库', '始祖鸟', '山姆', '盒马', '星巴克', '麦当劳', '肯德基', '12315',
])
const ORG_SUFFIX = /(公司|集团|银行|医院|大学|学校|平台|客服|协会|政府|局|院|所|店|网|台)$/
const LOC_SUFFIX =
  /(市|区|县|镇|村|街|路|巷|广场|公园|机场|车站|火车站|高铁站|会展中心|中心|酒店|餐厅|咖啡馆|商场|大厦|园区|科技园|门口|附近|室|号楼|馆|咖)$/
/** 区县名（与城市前缀配合做「杭州 + 杭州滨江」的包含合并）。 */
const DISTRICT_PREFIX = ['滨江', '朝阳', '南山', '西湖', '海淀', '浦东', '天河', '福田', '宝安', '龙岗', '余杭', '萧山', '徐汇', '静安', '黄浦', '越秀', '海珠']
const ITEM_EXACT = new Set(['猫', '狗', '书', '车', '房', '海鲜', '花生', '坚果', '咖啡因', '恐龙'])
const ITEM_SUFFIX =
  /(书|码|券|咖啡|奶|茶|菜|肉|果|药|衣|鞋|包|机|猫|狗|花|油|酱|盐|糖|酒|水|饭|面|豆|蛋|虾|蟹|鱼|内脏|零食|水果|坚果|花生|鲜|食品)$/
const ITEM_CONTAINS = /券|代金券|优惠券/
const EVENT_RE =
  /生日|会议|体检|出差|旅行|旅游|聚餐|汇算|面试|婚礼|节日|假期|手术|复查|挂号|入院|出院|搬家|迁居|周年|行程|超时|事件|聚会|约会|出游/
const HEALTH_RE = /过敏|休克|症$|病$|炎$|痛$|损伤|疗程|反流|骨折|血压|血糖|失眠|抑郁|焦虑|感染|结石|息肉|癌|康复|过敏原/
/** 抽象名词：user 层里的这类词不该因为「在 user 层」就被判成人物。 */
const CONCEPTISH = /协议|原则|红线|偏好|习惯|流程|方案|计划|规则|策略|标准|底线|意识|能力|水平/

/**
 * 关系称谓词典：这些词是「人」，不依赖姓氏（老婆/弟弟/老大…）。
 * 绝不能像旧版那样「只要在 user 层、2–3 字就当人物」——真实数据里
 * 周末/运动/膝盖/健康/工作 全被误判成人物。
 */
const CONCRETE_PERSON_TERMS = new Set([
  '老婆', '老公', '弟弟', '妹妹', '哥哥', '姐姐', '爸爸', '妈妈',
  '爷爷', '奶奶', '外公', '外婆', '姥爷', '姥姥', '岳父', '岳母', '公公', '婆婆',
  '老大', '老二', '老三', '叔叔', '阿姨', '舅舅', '姑姑', '表哥', '表姐', '堂哥', '堂姐',
])
// 泛称/关系集合（孩子、儿子、家人、家庭、兄弟、朋友、同事、医生…）**不当人物节点**：
// 它们不是具体的人，画成人卡只会重复（老大/老二/儿子/孩子四张卡）。
// 这些词仍会作为普通关键词出现在「关键词」视图里。

/** 同义归一（只收明显同一个人的写法；不同的人同名绝不合并）。 */
const SYNONYM: Readonly<Record<string, string>> = {
  妻子: '老婆',
  太太: '老婆',
  夫人: '老婆',
  丈夫: '老公',
  子女: '孩子',
  儿女: '孩子',
  爸妈: '父母',
}
/** 同义词按长度倒序做**词内替换**（妻子生日 → 老婆生日；不只是全等匹配）。 */
const SYNONYM_KEYS = Object.entries(SYNONYM).sort((a, b) => b[0].length - a[0].length)
function applySynonyms(label: string): string {
  let out = label
  for (const [from, to] of SYNONYM_KEYS) if (out.includes(from)) out = out.split(from).join(to)
  return out
}

/** 规则/红线类概念：虽是 concept，但对这个人重要，保留在实体视图。 */
const RULE_CONCEPT_RE = /红线|底线|协议|原则|偏好|习惯|准则|规矩|禁忌|忌口/

const PERSON_SURNAMES = new Set(
  '王李张刘陈杨赵吴徐孙朱胡郭何林罗郑梁谢冯邓曹彭肖潘袁蔡蒋杜吕丁沈姚卢姜崔钟谭陆汪廖贾韦邹孟邱尹薛闫侯郝龚邵覃'.split(''),
)
const PERSON_COMPOUND = [
  '欧阳', '司马', '诸葛', '上官', '夏侯', '司徒', '慕容', '公孙', '宇文', '长孙', '皇甫', '令狐',
  '钟离', '拓跋', '轩辕', '百里', '东郭', '西门',
]
const PERSON_SUFFIX = ['总', '老师', '经理', '博士', '哥', '姐', '同学', '同事', '工']

function looksLikePersonName(label: string): boolean {
  const s = label.trim()
  if (!/^[\u4e00-\u9fff]{2,5}$/.test(s)) return false
  const hasSurname = PERSON_SURNAMES.has(s[0]) || PERSON_COMPOUND.some((cs) => s.startsWith(cs))
  if (!hasSurname) return false
  if (PERSON_SUFFIX.some((suffix) => s.length > suffix.length && s.endsWith(suffix))) return true
  if (PERSON_COMPOUND.some((cs) => s.startsWith(cs))) return s.length >= 3 && s.length <= 4
  return s.length >= 2 && s.length <= 4
}

/**
 * 类型推断。顺序即优先级：
 * 健康 → 事件 → 机构 → 地点 → 物品 → 人物 → 概念。
 * 放在前面的都带明确语素（过敏/生日/公司/机场/券…），比「在 user 层」这种
 * 弱信号可靠；人物兜底只对 2–3 字、无抽象后缀的短标签生效。
 */
export function inferEntityType(label: string, rowLevel: string): EntityType {
  const s = label.trim()
  if (HEALTH_RE.test(s)) return 'health'
  if (EVENT_RE.test(s)) return 'event'
  // 动作短语（订餐厅/买衣服/打车）：不是地点也不是物品；放在事件之后，
  // 「看病挂号」这类先命中事件的仍然保留。
  if (/^(订|买|去|做|看|吃|喝|打|找|问|说|办|选|约|送|取|改|换|加|减|停|开始|继续)/.test(s)) return 'concept'
  if (ORG_EXACT.has(s) || ORG_SUFFIX.test(s)) return 'organization'
  if (CITY_PREFIX.some((c) => s.startsWith(c)) || LOC_SUFFIX.test(s)) return 'location'
  if (ITEM_EXACT.has(s) || ITEM_SUFFIX.test(s) || ITEM_CONTAINS.test(s)) return 'item'
  if (CONCRETE_PERSON_TERMS.has(s) || looksLikePersonName(s)) return 'person'
  return 'concept'
}

const TYPE_PRIORITY: readonly EntityType[] = [
  'project', 'person', 'health', 'event', 'location', 'organization', 'item', 'concept',
]

// ── 行数据辅助（不 import graph 的运行时函数，保持纯） ─────────────────────────

function projectsOf(field: string | null): string[] {
  if (field === null || field === '') return []
  return field
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '全局' && s.toLowerCase() !== 'global')
}

const QUOTED = /[「『《]([^」』》]{2,24})[」』》]|["“]([^"”]{2,24})["”]/g

interface Agg {
  key: string
  label: string
  labelCount: Map<string, number>
  types: Set<EntityType>
  rowIds: Set<string>
  levels: Record<string, number>
  lastUpdated: number
  hits: number
}

function bumpLevel(levels: Record<string, number>, level: string): void {
  levels[level] = (levels[level] ?? 0) + 1
}

/**
 * 从记忆行派生实体图。
 *
 * 数据流：rows → 候选词（keywords / 引号专名 / project）→ 准入 → 类型 → 归一合并
 * → 同义合并 → 节点/边 → 「我」锚点 → 分组（人卡/主题）。
 */
export function buildEntityOverview(
  rows: readonly ExplorerRow[],
  options: EntityOverviewOptions = {},
): EntityOverview {
  const scope = options.scope ?? 'personal'
  const limit = options.limit ?? 40
  const scoped = rows.filter((row) => {
    const hasProject = projectsOf(row.project).length > 0
    if (scope === 'personal') return !hasProject
    if (scope === 'project') return hasProject
    return true
  })

  const aggs = new Map<string, Agg>()
  /** 每行派生出的实体 key（建边用）。 */
  const rowKeys = new Map<string, string[]>()
  /** project 名 → key（项目归属边用）。 */
  const rowProjectKeys = new Map<string, string[]>()

  const add = (raw: string, seedType: EntityType | null, row: ExplorerRow): void => {
    const normalized = normalizeEntityLabel(raw)
    const label = applySynonyms(normalized)
    if (!isEntityLabel(label)) return
    const type = seedType ?? inferEntityType(label, row.level)
    // project 名用 project 类型；其余用推断/合并优先级
    const key = label.toLowerCase()
    let agg = aggs.get(key)
    if (agg === undefined) {
      agg = {
        key,
        label,
        labelCount: new Map([[label, 1]]),
        types: new Set([type]),
        rowIds: new Set([row.id]),
        levels: {},
        lastUpdated: row.updated_at,
        hits: row.hit_count,
      }
      aggs.set(key, agg)
    } else {
      agg.labelCount.set(label, (agg.labelCount.get(label) ?? 0) + 1)
      agg.types.add(type)
      agg.rowIds.add(row.id)
      if (row.updated_at > agg.lastUpdated) agg.lastUpdated = row.updated_at
      agg.hits += row.hit_count
    }
    bumpLevel(agg.levels, row.level)
    // 出现次数最高（同数取更长）的写法作为展示名
    const best = [...agg.labelCount.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]
    if (best !== undefined) agg.label = best[0]
  }

  for (const row of scoped) {
    const keys: string[] = []
    const pushUnique = (raw: string, seedType: EntityType | null): void => {
      add(raw, seedType, row)
      const label = normalizeEntityLabel(raw)
      const key = label.toLowerCase()
      if (aggs.has(key) && !keys.includes(key)) keys.push(key)
    }
    for (const kw of row.keywords) pushUnique(kw, null)
    for (const m of `${row.title ?? ''}\n${row.content}`.matchAll(QUOTED)) {
      pushUnique(m[1] ?? m[2] ?? '', null)
    }
    const projectKeys: string[] = []
    for (const p of projectsOf(row.project)) {
      const label = normalizeEntityLabel(p)
      if (!isEntityLabel(label)) continue
      pushUnique(p, 'project')
      const key = label.toLowerCase()
      if (!projectKeys.includes(key)) projectKeys.push(key)
    }
    rowKeys.set(row.id, keys.slice(0, 8))
    rowProjectKeys.set(row.id, projectKeys)
  }

  // ── 同义合并：去「的」/空白/括号后相同；同类型下包含（差 ≤2、短名 ≥3）；编辑距离 ≤1 ──
  const mergeSameType = (a: Agg, b: Agg): boolean => {
    if (a.types.size === 0 || b.types.size === 0) return false
    const typeA = TYPE_PRIORITY.find((t) => a.types.has(t)) ?? 'concept'
    const typeB = TYPE_PRIORITY.find((t) => b.types.has(t)) ?? 'concept'
    if (typeA !== typeB) return false
    // 含数字的标签不做模糊合并：过敏项1/过敏项2、房间1/房间2 是不同实体，
    // 编辑距离只有 1，合并了就是灾难（只有完全相同才走精确归并）。
    if (/\d/.test(a.key) || /\d/.test(b.key)) return false
    const ca = a.key.replace(/[\s·・]/g, '')
    const cb = b.key.replace(/[\s·・]/g, '')
    if (ca === cb) return true
    const [s, l] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
    // 地点特例：杭州 + 杭州滨江 / 滨江 + 杭州滨江 合并（城市/区县是上级行政区，不是笔误）
    if (typeA === 'location' && l.length - s.length <= 4) {
      if (CITY_PREFIX.includes(s) && l.startsWith(s)) return true
      if (DISTRICT_PREFIX.includes(s) && (l.startsWith(s) || l.endsWith(s))) return true
    }
    if (s.length >= 3 && l.length - s.length <= 2 && l.includes(s)) return true
    if (ca.length >= 4 && cb.length >= 4 && withinOneEdit(ca, cb)) return true
    return false
  }

  /** 被合并掉的 key → 保留 key（行数据里还引用旧 key，建边时要能找回来）。 */
  const keyAlias = new Map<string, string>()

  const mergeInto = (target: Agg, other: Agg, canonicalLabel?: string): void => {
    keyAlias.set(other.key, target.key)
    for (const [label, n] of other.labelCount) target.labelCount.set(label, (target.labelCount.get(label) ?? 0) + n)
    for (const t of other.types) target.types.add(t)
    for (const id of other.rowIds) target.rowIds.add(id)
    for (const [level, n] of Object.entries(other.levels)) target.levels[level] = (target.levels[level] ?? 0) + n
    if (other.lastUpdated > target.lastUpdated) target.lastUpdated = other.lastUpdated
    target.hits += other.hits
    aggs.delete(other.key)
    const best = [...target.labelCount.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0]
    if (canonicalLabel !== undefined) target.label = canonicalLabel
    else if (best !== undefined) target.label = best[0]
  }

  // 模糊合并（包含关系/编辑距离）是 O(n²)。个人库通常几百个实体，没问题；
  // 超大库（>1200）时直接跳过模糊合并——精确归并（同 key）在 add 阶段已完成，
  // 不能为了几对同义词把面板卡死。
  const FUZZY_MERGE_MAX = 1200
  let merged = true
  for (let round = 0; round < 5 && merged; round++) {
    if (aggs.size > FUZZY_MERGE_MAX) break
    merged = false
    const list = [...aggs.values()]
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (!aggs.has(a.key)) continue
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (!aggs.has(b.key)) continue
        if (!mergeSameType(a, b)) continue
        // 保留哪个名字：地点包含合并时永远保留**更长**的（杭州滨江 > 杭州，
        // 北京朝阳 > 北京——上级行政区名不是笔误，丢了区县就丢了精度）；
        // 其余按提及次数、再按名字长度。
        const aType = TYPE_PRIORITY.find((t) => a.types.has(t)) ?? 'concept'
        const ca = a.key
        const cb = b.key
        const [shortKey, longKey] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
        const locationContainment =
          aType === 'location' &&
          ((CITY_PREFIX.includes(shortKey) && longKey.startsWith(shortKey)) ||
            (DISTRICT_PREFIX.includes(shortKey) && (longKey.startsWith(shortKey) || longKey.endsWith(shortKey))))
        const keep = locationContainment
          ? (a.label.length >= b.label.length ? a : b)
          : (a.rowIds.size > b.rowIds.size || (a.rowIds.size === b.rowIds.size && a.label.length >= b.label.length) ? a : b)
        const drop = keep === a ? b : a
        // 地点合并展示更长（更精确）的名字：杭州滨江 优先于 杭州
        mergeInto(keep, drop, locationContainment ? (a.label.length >= b.label.length ? a.label : b.label) : undefined)
        merged = true
        break // 继续下一个 a（原来的 break outer 每轮只合并一对，导致多对重复合不完）
      }
    }
  }

  // ── 节点 ──
  const userLevelRows = new Set<string>()
  for (const row of scoped) if (row.level === 'user' || row.level === 'rules') userLevelRows.add(row.id)

  const nodes: EntityNode[] = []
  const idByKey = new Map<string, string>()
  for (const agg of aggs.values()) {
    const type = TYPE_PRIORITY.find((t) => agg.types.has(t)) ?? 'concept'
    const label = agg.label
    const id = `ent:${label.toLowerCase()}`
    idByKey.set(agg.key, id)
    let userHits = 0
    for (const rid of agg.rowIds) if (userLevelRows.has(rid)) userHits++
    nodes.push({
      id,
      label,
      kind: 'entity',
      entityType: type,
      count: agg.rowIds.size,
      levels: agg.levels,
      lastUpdated: agg.lastUpdated,
      hits: agg.hits,
      rowIds: [...agg.rowIds],
      userHits,
    })
  }

  // ── 个人视图只收「实体」：概念里的纯话题词（饮食/周末/工作…）留给关键词视图。
  //    保留：非 concept 类型、rules 层出现过的、以及红线/协议类概念。
  const isEntityLike = (n: EntityNode): boolean =>
    n.entityType !== 'concept' ||
    (n.levels.rules ?? 0) > 0 ||
    RULE_CONCEPT_RE.test(n.label)
  const allowed = new Set(
    nodes.filter((n) => scope !== 'personal' || isEntityLike(n)).map((n) => n.id),
  )
  const entityNodes = nodes.filter((n) => allowed.has(n.id))

  // 合并后 key → id 可能变化：沿 alias 链解析回保留实体
  const idByLabel = new Map<string, string>()
  for (const node of nodes) idByLabel.set(normalizeEntityLabel(node.label).toLowerCase(), node.id)
  const resolveId = (key: string): string | undefined => {
    let k = key
    for (let i = 0; i < 8; i++) {
      const next = keyAlias.get(k)
      if (next === undefined) break
      k = next
    }
    return idByKey.get(k) ?? idByLabel.get(k)
  }

  const rowsEntities = new Map<string, string[]>()
  for (const row of scoped) {
    const keys = rowKeys.get(row.id) ?? []
    const ids: string[] = []
    for (const key of keys) {
      const id = resolveId(key)
      if (id !== undefined && allowed.has(id) && !ids.includes(id)) ids.push(id)
    }
    rowsEntities.set(row.id, ids)
  }

  // ── 边 ──
  const edgeMap = new Map<string, GraphEdge & { kind: 'mine' | 'project' | 'cooc' }>()
  const edgeKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  const bumpEdge = (a: string, b: string, kind: 'mine' | 'project' | 'cooc'): void => {
    if (a === b) return
    const key = edgeKey(a, b)
    const prev = edgeMap.get(key)
    if (prev === undefined) {
      edgeMap.set(key, { source: a < b ? a : b, target: a < b ? b : a, weight: 1, kind })
      return
    }
    prev.weight++
    const rank = (k: string): number => (k === 'mine' ? 0 : k === 'project' ? 1 : 2)
    if (rank(kind) < rank(prev.kind)) prev.kind = kind
  }

  for (const row of scoped) {
    const ids = rowsEntities.get(row.id) ?? []
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) bumpEdge(ids[i], ids[j], 'cooc')
    }
    for (const pid of rowProjectKeys.get(row.id) ?? []) {
      const id = resolveId(pid)
      if (id === undefined || !allowed.has(id)) continue
      for (const other of ids) if (other !== id) bumpEdge(id, other, 'project')
    }
  }

  // ── 「我」锚点 ──
  const meId = 'me'
  const levels: Record<string, number> = {}
  let lastUpdated = 0
  let hits = 0
  for (const row of scoped) {
    bumpLevel(levels, row.level)
    if (row.updated_at > lastUpdated) lastUpdated = row.updated_at
    hits += row.hit_count
  }
  const me: GraphNode = { id: meId, label: options.meLabel ?? '我', kind: 'me', count: scoped.length, levels, lastUpdated, hits }

  const importance = (n: EntityNode): number => n.userHits * 100 + n.count * 5
  const persons = entityNodes.filter((n) => n.entityType === 'person')
  for (const p of persons) bumpEdge(meId, p.id, 'mine')
  // 项目节点全部直连「我」（项目视图的锚点）
  for (const n of entityNodes) if (n.entityType === 'project') bumpEdge(meId, n.id, 'mine')
  const profile = entityNodes
    .filter((n) => n.entityType !== 'person' && n.userHits > 0)
    .sort((a, b) => importance(b) - importance(a))
    .slice(0, 14)
  for (const n of profile) bumpEdge(meId, n.id, 'mine')

  const degree = new Map<string, number>()
  for (const e of edgeMap.values()) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  for (const n of entityNodes) {
    if ((degree.get(n.id) ?? 0) === 0) bumpEdge(meId, n.id, 'mine')
  }

  // ── 上限：人物恒保留，其余按重要度截断 ──
  const allNodes = [me, ...entityNodes] as GraphNode[]
  const allEdges = [...edgeMap.values()] as GraphEdge[]
  const personIds = new Set(persons.map((p) => p.id))
  let keptNodes = allNodes
  let keptEdges = allEdges
  if (limit !== Infinity && entityNodes.length + 1 > limit) {
    const keepOther = entityNodes
      .filter((n) => !personIds.has(n.id))
      .sort((a, b) => importance(b) - importance(a))
      .slice(0, Math.max(0, limit - persons.length - 1))
    const keep = new Set<string>([meId, ...personIds, ...keepOther.map((n) => n.id)])
    keptNodes = allNodes.filter((n) => keep.has(n.id))
    keptEdges = allEdges.filter((e) => keep.has(e.source) && keep.has(e.target))
  }

  // ── 分组：人卡 + 主题 ──
  const nodeById = new Map(keptNodes.map((n) => [n.id, n]))
  const neighborsOf = (id: string): EntityNode[] =>
    keptEdges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => nodeById.get(e.source === id ? e.target : e.source))
      .filter((n): n is EntityNode => n !== undefined && n.kind === 'entity')
      .sort((a, b) => importance(b) - importance(a))

  const personCards: EntityPersonCard[] = persons
    .slice()
    .sort((a, b) => importance(b) - importance(a))
    .filter((p) => nodeById.has(p.id))
    .map((p) => ({
      id: p.id,
      label: p.label,
      count: p.count,
      items: neighborsOf(p.id).slice(0, 5).map((n) => n.label),
    }))

  const themeTypes: EntityType[] = ['health', 'event', 'location', 'organization', 'item', 'concept']
  const themes: EntityThemeGroup[] = themeTypes.map((type) => {
    const all = entityNodes
      .filter((n) => n.entityType === type && nodeById.has(n.id))
      .sort((a, b) => importance(b) - importance(a))
    return {
      type,
      total: all.length,
      items: all.slice(0, 12).map((n) => ({ id: n.id, label: n.label, count: n.count })),
    }
  })

  return {
    graph: { nodes: keptNodes, edges: keptEdges },
    persons: personCards,
    themes,
    stats: { total: entityNodes.length, entities: keptNodes.length - 1, edges: keptEdges.length },
  }
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (l.length - s.length > 1) return false
  let i = 0
  let j = 0
  let diff = 0
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++
      j++
      continue
    }
    if (++diff > 1) return false
    if (s.length === l.length) {
      i++
      j++
    } else {
      j++
    }
  }
  return true
}
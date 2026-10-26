/**
 * dsh-personal-memory — 个人记忆库展示面板的纯计算层（client 端）。
 *
 * 与 DOM/react 无关（同 client-fold.ts 的拆分惯例）：图谱构建、布局、卡片过滤/
 * 摘要、相对时间。宿主端 db.ts 不可 import（node:fs/node:sqlite 是 host 依赖），
 * 这里按 API 投影的数据形状（ExplorerRow）自持一份轻量语义副本：七层枚举、
 * 全局标记判定、project 字段的多值拆分（与 db.ts 的同名函数同口径——db.ts 的
 * 注释里写了为什么：模型按 prompt 写字面值，跨语言历史数据里「全局 / global」
 * 都出现过，宁可宽认）。
 */

import { t } from './i18n/index.js'

/** 测试接点（与 client-fold 的 setUiLocaleForTest 同款惯例）：界面语言。 */
export { setUiLocaleForTest, getUiLocale } from './i18n/index.js'

/** 七层枚举（与 db.ts LEVELS 同序；level→文案/配色在展示层自持）。 */
export const EXPLORER_LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'] as const
export type ExplorerLevel = (typeof EXPLORER_LEVELS)[number]

/** 全局标记真值（与 db.ts 的 GLOBAL_PROJECT_CANON / _EN 一致；当前语言包写法
 *  在宿主侧才知道，这里宽认两个真值足够展示用）。 */
const GLOBAL_CANON = '全局'
const GLOBAL_CANON_EN = 'global'

function isGlobalProjectField(field: string | null): boolean {
  if (field === null) return false
  const trimmed = field.trim()
  return trimmed === GLOBAL_CANON || trimmed.toLowerCase() === GLOBAL_CANON_EN
}

/** project 字段 → 项目名列表（逗号分隔多值；全局标记/空 = 无具体项目）。 */
export function rowProjects(field: string | null): string[] {
  if (field === null || isGlobalProjectField(field)) return []
  return field.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 行的项目展示标签：全局标记=全局；空=未标记；多值 join '/'。 */
export function rowProjectLabel(field: string | null): string {
  if (isGlobalProjectField(field)) return t('explorer.project.global')
  if (field === null || field === '') return t('explorer.project.unlabeled')
  return rowProjects(field).join('/')
}

/** /dsh-personal-memory/api/memories 的行投影（host 端 MemoryRow 的 JSON 形状）。 */
export interface ExplorerRow {
  id: string
  level: ExplorerLevel
  title: string | null
  content: string
  importance: number
  keywords: string[]
  status: 'active' | 'stale' | 'archived' | string
  corrected: number
  project: string | null
  subcategory: string | null
  goal: string | null
  hit_count: number
  created_at: number
  updated_at: number
  last_accessed_at: number | null
}

/** /dsh-personal-memory/api/stats 的投影。 */
export interface ExplorerStats {
  levels: Record<string, number>
  total?: number
  projects: string[]
  homeDir: string
}

/** 层级配色（徽章/图谱着色；主题无关的固定色板）。 */
export const LEVEL_COLORS: Record<ExplorerLevel, string> = {
  soul: '#b39ddb', // 紫：AI 自身
  user: '#81c784', // 绿：用户
  project: '#64b5f6', // 蓝：项目
  fact: '#ffb74d', // 橙：事实
  lesson: '#e57373', // 红：教训
  topic: '#4db6ac', // 青：话题
  rules: '#ffd54f', // 黄：准则
}

/** 层级文案键（t() 的键名；与 i18n keys.ts 的 explorer.level.* 同名）。 */
export const LEVEL_LABEL_KEYS: Record<ExplorerLevel, `explorer.level.${ExplorerLevel}`> = {
  soul: 'explorer.level.soul',
  user: 'explorer.level.user',
  project: 'explorer.level.project',
  fact: 'explorer.level.fact',
  lesson: 'explorer.level.lesson',
  topic: 'explorer.level.topic',
  rules: 'explorer.level.rules',
}

export function levelLabel(level: string): string {
  const key = LEVEL_LABEL_KEYS[level as ExplorerLevel]
  return key === undefined ? level : t(key)
}

// ── 知识图谱（关键词共现 + 项目归属）──────────────────────────────────────────

export interface GraphNode {
  /** 'kw:<label>' 或 'prj:<label>' 或中心 ME_NODE_ID（前缀区分同名关键词/项目）。 */
  id: string
  label: string
  kind: 'keyword' | 'project' | 'me' | 'entity'
  /** 出现次数（关键词=含它的记忆数；项目=归属它的记忆数；中心=记忆总数）。 */
  count: number
  /** 该节点记忆的层级分布（着色用主导层）。 */
  levels: Record<string, number>
  /** 关联记忆里最近一次的 updated_at（tooltip「最近更新」；me=全库最新）。 */
  lastUpdated?: number
  /** 关联记忆的 hit_count 总和（tooltip「累计命中」；同一条记忆按关键词/项目数重复计）。 */
  hits?: number
  /** 实体节点：类型（person/location/...；决定分类配色）。 */
  entityType?: string
  /** 实体节点：来源记忆 id（点节点直接取来源记忆，不靠关键词反查）。 */
  rowIds?: readonly string[]
}

export interface GraphEdge {
  source: string
  target: string
  /** 共现/归属次数（边粗细）。 */
  weight: number
  /** 边的语义：mine=我→直连锚点；project=项目归属；cooc=关键词共现；relation=LLM 关系。 */
  kind: 'mine' | 'project' | 'cooc' | 'relation'
  /** LLM 关系类型（has_allergy / lives_in / ...），仅 relation 边有。 */
  relation_type?: string
}

export interface MemoryGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface BuildGraphOptions {
  /** 关键词节点上限（按出现次数取头部）。 */
  maxKeywordNodes?: number
  /** 项目节点上限。 */
  maxProjectNodes?: number
  /** 关键词共现边上限（按权重取头部）。 */
  maxEdges?: number
}

/** 主导层级（节点着色）：levels 直方图里计数最大的层，平局取枚举序在前者。 */
function dominantLevel(levels: Record<string, number>): ExplorerLevel {
  let best: ExplorerLevel = 'fact'
  let bestCount = -1
  for (const level of EXPLORER_LEVELS) {
    const count = levels[level] ?? 0
    if (count > bestCount) {
      best = level
      bestCount = count
    }
  }
  return best
}

/** 节点主导层（暴露给渲染层做配色）。 */
export function nodeDominantLevel(node: GraphNode): ExplorerLevel {
  return dominantLevel(node.levels)
}

/**
 * 从记忆行构建知识图谱：关键词节点 + 共现边（同一条记忆的 keywords 两两共现），
 * 项目节点 + 归属边（记忆的关键词挂到它的 project 名下）。全局标记/未标记的
 * 记忆只参与关键词共现，不产生项目边。确定性：同名输入同输出（截断按
 * 次数降序、id 升序的稳定排序）。
 */
export function buildGraph(rows: readonly ExplorerRow[], options: BuildGraphOptions = {}): MemoryGraph {
  const { maxKeywordNodes = 60, maxProjectNodes = 40, maxEdges = 220 } = options
  interface NodeAgg { count: number; levels: Map<string, number>; lastUpdated: number; hits: number }
  const kwCount = new Map<string, NodeAgg>()
  const prjCount = new Map<string, NodeAgg>()
  const kwEdges = new Map<string, number>()
  const prjEdges = new Map<string, number>()

  const bumpNode = (map: Map<string, NodeAgg>, key: string, level: string, updatedAt: number, hits: number): void => {
    let entry = map.get(key)
    if (entry === undefined) {
      entry = { count: 0, levels: new Map(), lastUpdated: 0, hits: 0 }
      map.set(key, entry)
    }
    entry.count++
    entry.levels.set(level, (entry.levels.get(level) ?? 0) + 1)
    if (updatedAt > entry.lastUpdated) entry.lastUpdated = updatedAt
    entry.hits += hits
  }

  for (const row of rows) {
    // 关键词去重（同一条记忆里重复关键词只算一次）
    const seen = new Set<string>()
    for (const kw of row.keywords) {
      const label = canonicalKeyword(kw.trim())
      if (label.length === 0 || seen.has(label)) continue
      if (isGraphNoise(label)) continue
      seen.add(label)
      bumpNode(kwCount, label, row.level, row.updated_at, row.hit_count)
    }
    // 共现边：seen 里两两配对（排序后的组合键保证无向唯一）
    const labels = [...seen].sort()
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const key = `${labels[i]}\u0000${labels[j]}`
        kwEdges.set(key, (kwEdges.get(key) ?? 0) + 1)
      }
    }
    // 项目归属边
    for (const project of rowProjects(row.project)) {
      bumpNode(prjCount, project, row.level, row.updated_at, row.hit_count)
      for (const label of labels) {
        const key = `${project}\u0000${label}`
        prjEdges.set(key, (prjEdges.get(key) ?? 0) + 1)
      }
    }
  }

  // 头部截断：次数降序、标签升序（稳定确定性）
  const topKws = [...kwCount.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxKeywordNodes)
  const topPrjs = [...prjCount.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxProjectNodes)

  const nodes: GraphNode[] = []
  const nodeIds = new Set<string>()
  for (const [label, agg] of topKws) {
    const id = `kw:${label}`
    nodeIds.add(id)
    nodes.push({ id, label, kind: 'keyword', count: agg.count, levels: Object.fromEntries(agg.levels), lastUpdated: agg.lastUpdated, hits: agg.hits })
  }
  for (const [label, agg] of topPrjs) {
    const id = `prj:${label}`
    nodeIds.add(id)
    nodes.push({ id, label, kind: 'project', count: agg.count, levels: Object.fromEntries(agg.levels), lastUpdated: agg.lastUpdated, hits: agg.hits })
  }

  const edges: GraphEdge[] = []
  const keepEdges = (map: Map<string, number>, prefixSource: 'kw' | 'prj', cap: number, kind: GraphEdge['kind']): void => {
    const entries = [...map.entries()]
      .filter(([key]) => {
        const [a, b] = key.split('\u0000')
        const idA = prefixSource === 'kw' ? `kw:${a}` : `prj:${a}`
        return nodeIds.has(idA) && nodeIds.has(`kw:${b}`)
      })
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    for (const [key, weight] of entries.slice(0, cap)) {
      const [a, b] = key.split('\u0000')
      edges.push({
        source: prefixSource === 'kw' ? `kw:${a}` : `prj:${a}`,
        target: `kw:${b}`,
        weight,
        kind,
      })
    }
  }
  keepEdges(kwEdges, 'kw', maxEdges, 'cooc')
  keepEdges(prjEdges, 'prj', Math.max(1, Math.floor(maxEdges / 2)), 'project')
  // 重排全局稳定（项目边追加在关键词边之后）：按 source,target 排序
  edges.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  return { nodes, edges }
}

// ── 以人为中心的关系网（v0.3.0；v0.3.1 起多跳拓扑 + 语义分类着色）─────────────

/** 中心「我」节点 id（不与 kw:/prj: 前缀冲突）。 */
export const ME_NODE_ID = 'me'

/**
 * 节点语义分类（图谱着色 + 图例）：me=我；project=项目；person=人物·画像
 * （关键词主导层为 user——关于这个人的记忆）；self=AI 自身（主导 soul）；
 * experience=经验·原则（主导 lesson/rules）；thing=事物（主导 fact/topic/project）。
 * 分类是从既有数据（层级直方图）推导的诚实近似：不做实体抽取，宁缺毋滥。
 */
export type GraphCategory =
  | 'me'
  | 'person'
  | 'health'
  | 'event'
  | 'location'
  | 'organization'
  | 'item'
  | 'project'
  | 'thing'
  | 'experience'
  | 'self'

/** 分类配色（主题无关的柔和固定色板；深浅主题下都可读）。 */
export const CATEGORY_COLORS: Record<GraphCategory, string> = {
  me: '#3b82f6', // 蓝：我
  person: '#f59e0b', // 琥珀：人物
  health: '#ef4444', // 红：健康
  event: '#ec4899', // 玫红：事件
  location: '#22c55e', // 绿：地点
  organization: '#0ea5e9', // 天蓝：机构
  item: '#a855f7', // 紫：物品
  project: '#14b8a6', // 青绿：项目
  thing: '#94a3b8', // 灰：概念/其他
  experience: '#f472b6', // 粉：经验·原则
  self: '#64748b', // 深灰蓝：AI 自身
}

/** 图例展示顺序。 */
export const CATEGORY_ORDER: readonly GraphCategory[] = [
  'me', 'person', 'health', 'event', 'location', 'organization', 'item', 'project', 'thing', 'experience', 'self',
]

// ── 人名形状识别（v0.4.1）────────────────────────────────────────────────────
// 只认明显形态，不是 NER：① 2–4 个汉字且首字是「安全姓氏」（剔除了与高频词碰撞的
// 高/金/钱/白/方/万/向/江/龙/汤/石/田/毛/熊/马/夏/雷/段/史/陶/范/许/顾/贺/周/曾/余/
// 程/任/付/苏/叶/黄/黎等——"周末/任何/程序/黄河"这类词绝不该变人物）；② 姓氏+称谓
// （王工/李总/张老师/陈博士/刘同学…，含 4–5 字「姓名+称谓」）；③ 复姓（欧阳修/司马懿）。
// 英文刻意不做形状判断（"DeepSeek Harness" 这类产品名无法与人名形状区分，误伤更大）。
const ZH_SURNAMES: ReadonlySet<string> = new Set(
  '王李张刘陈杨赵吴徐孙朱胡郭何林罗郑梁谢冯邓曹彭肖潘袁蔡蒋杜吕丁沈姚卢姜崔钟谭陆汪廖贾韦邹孟邱尹薛闫侯郝龚邵覃'.split(''),
)
const ZH_COMPOUND_SURNAMES: readonly string[] = [
  '欧阳', '司马', '诸葛', '上官', '夏侯', '司徒', '慕容', '公孙', '宇文', '长孙', '皇甫', '令狐', '钟离', '拓跋', '轩辕', '百里', '东郭', '西门',
]
const ZH_NAME_SUFFIXES: readonly string[] = ['总', '老师', '经理', '博士', '哥', '姐', '同学', '同事', '工']

/** 同义/缩写归一：同一个东西的多种写法收敛成一个节点。 */
const GRAPH_ALIASES: Readonly<Record<string, string>> = {
  协和: '协和医院',
  会展: '会展中心',
  个人所得税: '个税',
  健康检查: '体检',
}
function canonicalKeyword(label: string): string {
  // 称谓同义：妻子生日 / 太太生日 → 老婆生日（不只是全等匹配）
  let s = label.replace(/妻子|太太/g, '老婆').replace(/丈夫/g, '老公')
  return GRAPH_ALIASES[s] ?? s
}

/**
 * 关键词准入：LLM 抽的 keywords 不全是实体。实测真实库里的噪声：
 *   代码/技术：scanZstdFrames、session.v4.jsonl.zstd、lark-cli、token_missing、stale
 *   日期/编号：11月、12月5日、10月底、502、661234、四年级、C座
 *   动作/口语：下单、庆生、不能久坐、不喝咖啡、待办
 *   泛称：孩子、家人、公司、职业、礼物、医嘱
 * 这些进图只会让「分类很奇怪」，在 buildGraph 入口直接丢掉（记忆本体不受影响）。
 */
const GRAPH_NOISE_TERMS = new Set([
  '孩子', '家人', '家庭', '儿子', '女儿', '亲属', '公司', 'AI公司', '互联网', '职业', '产品经理',
  '礼物', '专属礼物', '兴趣', '待办', '医嘱', '行程', '不能久坐', '买衣服', '买书', '养猫',
  '办住院', '值机', '作废', '到货', '医生', '医疗', '医疗资源', '姓名', '学龄期', '家属', '审批待办',
])
export function isGraphNoise(label: string): boolean {
  const s = label.trim()
  if (s.length === 0) return true
  if (GRAPH_NOISE_TERMS.has(s)) return true
  // 代码形态：路径/扩展名/占位符/snake_case/全大写常量/长驼峰/技术词
  if (/[\\/]/.test(s)) return true
  if (/\.[a-z0-9]{1,5}$/i.test(s)) return true
  if (/[{}<>$]/.test(s)) return true
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/i.test(s)) return true
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s)) return true
  if (s.length >= 8 && /^[A-Za-z][A-Za-z0-9]*$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) return true
  if (/zstd|token|session|auth|jsonl|scanZstd|decompress|DSH|deepseek|lark-cli|agent研发|agent评测|stale/i.test(s)) return true
  // 日期 / 编号 / 座位
  if (/^\d+$/.test(s)) return true
  if (/^\d{1,2}月(\d{1,2}日)?$/.test(s) || /^\d{4}年/.test(s)) return true
  if (/^\d+月底?$/.test(s) || /^\d+年级$/.test(s) || /^\d+(\.\d+)?岁$/.test(s)) return true
  if (/^[一二三四五六七八九十]+年级$/.test(s) || /^[一二三四五六七八九十两]+岁半?$/.test(s)) return true
  if (/bot身份|user身份|会话文件|会话记录|文件格式/.test(s)) return true
  if (/^[A-Z]\d*座$/.test(s)) return true
  // 动作 / 口语 / 相对时间
  if (/^(不能|不要|不喝|不吃|不坐|别|请|先|已|下单|庆生|预约|记得|帮我|买|养|办|订|去|做|看|吃|喝|值机|作废|到货)/.test(s)) return true
  if (/^(本周|下周|上周|下个月|今天|明天|昨天)/.test(s)) return true
  if (/^周[一二三四五六日天]$/.test(s)) return true
  if (/首帧|多帧|解码|解压|会话|记录|文件|历史对话|agent|token|zstd/i.test(s)) return true
  // 动作/判断类短语（参会/否决/回杭州/坐车/加价绕路…）
  if (/^(参|否|回|坐|加价|只|解|前往|返回|决定|选择)/.test(s)) return true
  return false
}

/** 关键词标签是否「长得像人名」（见上方姓氏表注释的取舍）。 */
export function isPersonNameLabel(label: string): boolean {
  const s = label.trim()
  if (!/^[一-鿿]{2,5}$/.test(s)) return false
  const hasSurname = ZH_SURNAMES.has(s[0]) || ZH_COMPOUND_SURNAMES.some((cs) => s.startsWith(cs))
  if (!hasSurname) return false
  // 姓氏 + 称谓后缀（王工/李经理/张建国老师）：2–5 字
  if (ZH_NAME_SUFFIXES.some((suffix) => s.length > suffix.length && s.endsWith(suffix))) return true
  // 裸姓名：复姓 3–4 字（欧阳锋/欧阳娜娜）；单姓 2–4 字（张三/陈建国）
  if (ZH_COMPOUND_SURNAMES.some((cs) => s.startsWith(cs))) return s.length >= 3 && s.length <= 4
  return s.length >= 2 && s.length <= 4
}

// ── 关键词语义分类（替代原来的「按记忆层级」分组）──────────────────────────
// 旧实现把 user 层所有词都叫「人物·画像」、lesson/rules 全叫「经验·原则」，
// 于是地点/健康/事件全混进人物和道理里。这里先按**词形**判语义，判不出来才回退层级。
const RELATION_TERMS = new Set([
  '老婆', '妻子', '太太', '老公', '丈夫', '弟弟', '妹妹', '哥哥', '姐姐', '爸爸', '妈妈',
  '爷爷', '奶奶', '外公', '外婆', '岳父', '岳母', '公公', '婆婆', '老大', '老二', '老三',
  '家人', '家庭', '孩子', '儿子', '女儿', '父母', '兄弟', '姐妹', '朋友', '同事', '老板', '领导',
])
const HEALTH_RE = /过敏|休克|症$|病$|炎$|痛$|损伤|半月板|疗程|反流|骨折|血压|血糖|失眠|抑郁|焦虑|感染|结石|息肉|癌|康复/
const EVENT_RE = /生日|会议|体检|健康检查|检查|出差|旅行|旅游|聚餐|汇算|面试|婚礼|节日|假期|手术|复查|挂号|入院|住院|出院|搬家|迁居|周年|行程|超时|事件|聚会|约会|出游/
const ORG_EXACT = new Set(['腾讯', '阿里', '阿里巴巴', '百度', '字节', '美团', '京东', '华为', '小米', '协和', '优衣库', '始祖鸟', '12315'])
const ORG_SUFFIX = /(公司|集团|银行|医院|大学|学校|平台|客服|协会|政府|局|院|所|店|网|台)$/
const CITY_PREFIX = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '天津', '南京', '武汉', '西安', '苏州',
  '长沙', '郑州', '合肥', '济南', '青岛', '厦门', '福州', '昆明', '大连', '宁波', '无锡', '三亚',
  '海南', '新疆', '西藏', '云南', '四川', '浙江', '江苏', '广东', '山东', '河南', '河北', '湖南',
  '湖北', '福建', '安徽', '江西', '山西', '陕西', '辽宁', '吉林', '黑龙江', '广西', '贵州', '甘肃',
  '南山', '城西', '朝阳', '滨江', '西湖', '海淀', '浦东', '天河', '福田', '余杭', '萧山',
]
const LOC_SUFFIX = /(市|区|县|镇|村|街|路|巷|广场|公园|机场|车站|火车站|高铁站|会展中心|会展|中心|酒店|餐厅|咖啡馆|商场|大厦|园区|科技园|门口|附近|室|号楼|馆|咖)$/
const ITEM_EXACT = new Set(['猫', '狗', '书', '车', '房', '海鲜', '花生', '坚果', '咖啡因', '恐龙'])
const ITEM_SUFFIX = /(书|码|券|咖啡|奶|茶|菜|肉|果|药|衣|鞋|包|机|猫|狗|花|油|酱|盐|糖|酒|水|饭|面|豆|蛋|虾|蟹|鱼|内脏|零食|水果|坚果|花生|鲜|食品)$/

/** 词形 → 语义分类；判不出来返回 null（交给层级回退）。 */
function semanticCategory(label: string): GraphCategory | null {
  const s = label.trim()
  if (RELATION_TERMS.has(s) || isPersonNameLabel(s)) return 'person'
  if (HEALTH_RE.test(s)) return 'health'
  if (EVENT_RE.test(s)) return 'event'
  if (CITY_PREFIX.some((c) => s.startsWith(c)) || LOC_SUFFIX.test(s)) return 'location'
  if (ORG_EXACT.has(s) || ORG_SUFFIX.test(s)) return 'organization'
  if (ITEM_EXACT.has(s) || ITEM_SUFFIX.test(s) || /券|代金券|优惠券/.test(s)) return 'item'
  return null
}

/** 节点的语义分类：me/project 由 kind 决定；关键词先按词形判语义，再回退层级。 */
export function nodeCategory(node: Pick<GraphNode, 'kind' | 'levels'> & { label?: string }): GraphCategory {
  if (node.kind === 'me') return 'me'
  if (node.kind === 'project') return 'project'
  if (node.kind === 'entity') {
    const t = (node as { entityType?: string }).entityType
    if (t === 'person' || t === 'health' || t === 'event' || t === 'location' || t === 'organization' || t === 'item') return t
    if (t === 'project') return 'project'
    return 'thing'
  }
  if (typeof node.label === 'string') {
    const semantic = semanticCategory(node.label)
    if (semantic !== null) return semantic
  }
  if (!Object.values(node.levels).some((count) => count > 0)) return 'thing'
  const dom = dominantLevel(node.levels)
  if (dom === 'soul') return 'self'
  if (dom === 'lesson' || dom === 'rules') return 'experience'
  return 'thing'
}

/** 分类的展示文案（图例 / 抽屉头着色点 title）。 */
export function categoryLabel(cat: GraphCategory): string {
  switch (cat) {
    case 'me': return t('explorer.graph.me')
    case 'project': return t('explorer.graph.legend.project')
    case 'person': return t('explorer.graph.cat.person')
    case 'health': return t('explorer.graph.cat.health')
    case 'event': return t('explorer.graph.cat.event')
    case 'location': return t('explorer.graph.cat.location')
    case 'organization': return t('explorer.graph.cat.organization')
    case 'item': return t('explorer.graph.cat.item')
    case 'thing': return t('explorer.graph.cat.thing')
    case 'experience': return t('explorer.graph.cat.experience')
    case 'self': return levelLabel('soul')
  }
}

/** 直连「我」的画像关键词上限（user/soul 层出现过的关键词取头部，其余靠共现/归属到达）。 */
export const PROFILE_EDGE_CAP = 10

/**
 * 以人为中心的多跳关系网：在 buildGraph（关键词共现 + 项目归属）之上加一个
 * 钉在画布中心的「我」节点。「我」不再星型直连所有节点，只连两类锚点：
 * ① 全部项目节点（我参与的项目）；② 画像关键词（user/soul 层出现过的，
 * 上限 PROFILE_EDGE_CAP 个）——它们是关于"这个人本身"的记忆切面。
 * 事物/经验类关键词经由项目归属边或共现边间接到达（多跳）；
 * 完全没有关系的孤立节点兜底直连「我」（任何一条记忆都不该在图里消失）。
 * 点中心节点=看全部（rowsForNode 返回全集）。
 */
export function buildPersonalGraph(rows: readonly ExplorerRow[], options: BuildGraphOptions = {}): MemoryGraph {
  const base = buildGraph(rows, options)
  if (rows.length === 0) return { nodes: [], edges: [] }
  const levels: Record<string, number> = {}
  let meUpdated = 0
  let meHits = 0
  for (const row of rows) {
    levels[row.level] = (levels[row.level] ?? 0) + 1
    if (row.updated_at > meUpdated) meUpdated = row.updated_at
    meHits += row.hit_count
  }
  const me: GraphNode = { id: ME_NODE_ID, label: t('explorer.graph.me'), kind: 'me', count: rows.length, levels, lastUpdated: meUpdated, hits: meHits }

  // 现有边的邻接计数（孤立兜底判定用）
  const degree = new Map<string, number>()
  const bump = (id: string): void => { degree.set(id, (degree.get(id) ?? 0) + 1) }
  for (const edge of base.edges) { bump(edge.source); bump(edge.target) }

  const meEdges: GraphEdge[] = []
  const direct = new Set<string>()
  const linkMe = (node: GraphNode): void => {
    if (direct.has(node.id)) return
    direct.add(node.id)
    meEdges.push({ source: ME_NODE_ID, target: node.id, weight: node.count, kind: 'mine' })
  }
  // ① 项目全直连
  for (const node of base.nodes) if (node.kind === 'project') linkMe(node)
  // ② 画像关键词（user/soul 层出现过）取头部直连
  base.nodes
    .filter((node) => node.kind === 'keyword' && ((node.levels.user ?? 0) > 0 || (node.levels.soul ?? 0) > 0))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, PROFILE_EDGE_CAP)
    .forEach(linkMe)
  // ③ 孤立兜底：没有任何边的节点直连我
  for (const node of base.nodes) if ((degree.get(node.id) ?? 0) === 0) linkMe(node)

  const edges = [...base.edges, ...meEdges]
  edges.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  return { nodes: [me, ...base.nodes], edges }
}

// ── 「我」的别名折叠（v0.4.0）：用户自报名字不该以独立节点出现在关系网里 ────────

/** 别名收集上限（user 层自报条目通常一两条；多报几个昵称也兜得住）。 */
export const ME_ALIAS_CAP = 6

// 中文自报：名字叫/名叫/名字是/姓名是/称呼我（为）/叫我/我的名字是 + 2–4 个汉字，
// 且捕获后不能紧跟汉字（否则长句「叫我相信未来会更好」会吞进半截词）。
const ZH_NAME_RE = /(?:我的名字是|名字叫|名叫|名字是|姓名是|称呼我为|称呼我|叫我)([一-鿿]{2,4})(?![一-鿿])/g
// 英文自报：my name is / name is / call me / i'm / i am + 拉丁名（贪心吃最多 4 个词，
// 再剥掉小写开头的尾巴词——「bob and i like」→「bob」，「Chen Jianguo」两个大写词保留）。
const EN_NAME_RE = /(?:my name is|name is|call me|i'm|i am)\s+([A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){0,3})/gi

/**
 * 从 user 层记忆的自报语句里收集用户姓名/别名（展示层用途：折叠关系网里
 * 「用户自己的名字成了独立节点」的怪相）。只读 user 层——其它层的「叫我…」
 * 更可能是转述而非自报。按出现先后去重（大小写不敏感），上限 ME_ALIAS_CAP。
 */
export function collectMeAliases(rows: readonly ExplorerRow[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const alias = raw.trim().replace(/\s+/g, ' ')
    if (alias.length < 2 || alias.length > 24) return
    const key = alias.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(alias)
  }
  const pushEn = (raw: string): void => {
    const words = raw.trim().split(' ')
    // 剥掉小写开头的尾巴词（连词/谓词误入：「bob and i」→「bob」）
    while (words.length > 1 && /^[a-z]/.test(words[words.length - 1] ?? '')) words.pop()
    push(words.join(' '))
  }
  for (const row of rows) {
    if (row.level !== 'user') continue
    const text = `${row.title ?? ''}\n${row.content}`
    ZH_NAME_RE.lastIndex = 0
    EN_NAME_RE.lastIndex = 0
    for (let m = ZH_NAME_RE.exec(text); m !== null; m = ZH_NAME_RE.exec(text)) push(m[1] ?? '')
    for (let m = EN_NAME_RE.exec(text); m !== null; m = EN_NAME_RE.exec(text)) pushEn(m[1] ?? '')
  }
  return out.slice(0, ME_ALIAS_CAP)
}

/**
 * 把标签命中「我」的别名的关键词/项目节点折叠进中心 me 节点：
 * 节点移除；它的边重定向到 me（语义改为 mine——「我与之共现/归属」），
 * 两端点对相同的多条边合并（权重求和，类型优先级 mine > project > cooc），
 * 折叠产生的自环丢弃。me 的 count/levels 本就覆盖全部行，无需改。
 * 没有 me 节点（裸 buildGraph）或没有命中别名时原样返回。
 */
export function foldGraphAliases(graph: MemoryGraph, aliases: readonly string[]): MemoryGraph {
  if (aliases.length === 0) return graph
  const meNode = graph.nodes.find((n) => n.kind === 'me')
  if (meNode === undefined) return graph
  const aliasKeys = new Set(aliases.map((a) => a.toLowerCase()))
  const match = (label: string): boolean => {
    const l = label.trim()
    // 含汉字的标签走精确匹配（中文名本无大小写）；纯拉丁标签大小写不敏感
    if (/[一-鿿]/.test(l)) return aliases.some((a) => a === l)
    return aliasKeys.has(l.toLowerCase())
  }
  const folded = new Set(graph.nodes.filter((n) => n.kind !== 'me' && match(n.label)).map((n) => n.id))
  if (folded.size === 0) return graph
  const kindRank = (k: GraphEdge['kind']): number => (k === 'mine' ? 0 : k === 'project' ? 1 : 2)
  const merged = new Map<string, GraphEdge>()
  for (const edge of graph.edges) {
    const src = folded.has(edge.source) ? meNode.id : edge.source
    const dst = folded.has(edge.target) ? meNode.id : edge.target
    if (src === dst) continue // 折叠出的自环（me↔别名）丢弃
    const redirected = folded.has(edge.source) || folded.has(edge.target)
    const kind: GraphEdge['kind'] = redirected ? 'mine' : edge.kind
    // 无向归并：同两点间方向相反的两条边也合并（折叠常把 prj-kw 与 kw-kw 拧成同一条 me 边）
    const key = src < dst ? `${src}\u0000${dst}` : `${dst}\u0000${src}`
    const prev = merged.get(key)
    if (prev === undefined) {
      merged.set(key, { source: src, target: dst, weight: edge.weight, kind })
    } else {
      prev.weight += edge.weight
      if (kindRank(kind) < kindRank(prev.kind)) prev.kind = kind
    }
  }
  const edges = [...merged.values()]
  edges.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  return { nodes: graph.nodes.filter((n) => !folded.has(n.id)), edges }
}

/**
 * 边 → 关联记忆行（v0.4.0 边点选抽屉「关系详情」的数据源）：
 * - mine：另一端节点的 rowsForNode（我↔项目/画像关键词）；
 * - project：项目名 ∧ 关键词同时命中的行；
 * - cooc：两个关键词同时命中的行。
 * 返回按 updated_at 倒序。
 */
export function rowsForEdge(edge: Pick<GraphEdge, 'source' | 'target' | 'kind'>, graph: MemoryGraph, rows: readonly ExplorerRow[]): ExplorerRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const a = byId.get(edge.source)
  const b = byId.get(edge.target)
  if (a === undefined || b === undefined) return []
  const entityIds = (n: GraphNode): readonly string[] | null =>
    n.kind === 'entity' && Array.isArray((n as { rowIds?: readonly string[] }).rowIds)
      ? (n as { rowIds: readonly string[] }).rowIds
      : null
  const ea = entityIds(a)
  const eb = entityIds(b)
  if (ea !== null || eb !== null) {
    let out = [...rows]
    if (ea !== null) {
      const set = new Set(ea)
      out = out.filter((row) => set.has(row.id))
    }
    if (eb !== null) {
      const set = new Set(eb)
      out = out.filter((row) => set.has(row.id))
    }
    out.sort((x, y) => y.updated_at - x.updated_at)
    return out
  }
  const kwOf = (n: GraphNode): string | null => (n.kind === 'keyword' ? n.label : null)
  const prjOf = (n: GraphNode): string | null => (n.kind === 'project' ? n.label : null)
  const hasKw = (row: ExplorerRow, kw: string): boolean => {
    const l = kw.toLowerCase()
    return row.keywords.some((k) => k.toLowerCase() === l)
  }
  let out: ExplorerRow[]
  if (edge.kind === 'mine') {
    const other = a.kind === 'me' ? b : a
    out = rowsForNode(other, rows)
  } else if (edge.kind === 'project') {
    const prj = prjOf(a) ?? prjOf(b)
    const kw = kwOf(a) ?? kwOf(b)
    if (prj === null || kw === null) return []
    out = rows.filter((row) => rowProjects(row.project).includes(prj) && hasKw(row, kw))
  } else {
    const k1 = kwOf(a)
    const k2 = kwOf(b)
    if (k1 === null || k2 === null) return []
    out = rows.filter((row) => hasKw(row, k1) && hasKw(row, k2))
  }
  out = [...out]
  out.sort((x, y) => y.updated_at - x.updated_at)
  return out
}

/**
 * 各节点到根节点（默认「我」）的 BFS 跳数。不可达的节点不进表
 * （正常构建下不存在——孤立兜底保证全连通；防御未知输入）。
 */
export function nodeDepths(graph: MemoryGraph, rootId: string = ME_NODE_ID): Map<string, number> {
  const depths = new Map<string, number>()
  if (!graph.nodes.some((n) => n.id === rootId)) return depths
  const adj = new Map<string, string[]>()
  const link = (a: string, b: string): void => {
    const list = adj.get(a)
    if (list === undefined) adj.set(a, [b])
    else list.push(b)
  }
  for (const edge of graph.edges) { link(edge.source, edge.target); link(edge.target, edge.source) }
  depths.set(rootId, 0)
  let frontier = [rootId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!depths.has(nb)) {
          depths.set(nb, (depths.get(id) ?? 0) + 1)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return depths
}

/** 按跳数过滤子图：只保留 depth ≤ maxDepth 的节点，两端都在的边才保留。 */
export function filterGraphByDepth(graph: MemoryGraph, depths: ReadonlyMap<string, number>, maxDepth: number): MemoryGraph {
  const keep = new Set(
    graph.nodes.filter((n) => (depths.get(n.id) ?? Number.POSITIVE_INFINITY) <= maxDepth).map((n) => n.id),
  )
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  }
}

/**
 * 节点 → 关联记忆行（关系网点节点后侧边抽屉的数据源）：
 * - 中心「我」→ 全部记忆；
 * - 关键词节点 → keywords 含该词（大小写不敏感）的行；
 * - 项目节点 → project 多值字段含该项目名的行。
 * 返回按 updated_at 倒序（最近活跃在前）。
 */
export function rowsForNode(node: Pick<GraphNode, 'kind' | 'label'>, rows: readonly ExplorerRow[]): ExplorerRow[] {
  let out: ExplorerRow[]
  if (node.kind === 'me') {
    out = [...rows]
  } else if (node.kind === 'entity' && Array.isArray((node as { rowIds?: readonly string[] }).rowIds)) {
    const ids = new Set((node as { rowIds: readonly string[] }).rowIds)
    out = rows.filter((row) => ids.has(row.id))
  } else if (node.kind === 'keyword') {
    const kw = node.label.toLowerCase()
    out = rows.filter((row) => row.keywords.some((k) => k.toLowerCase() === kw))
  } else {
    out = rows.filter((row) => rowProjects(row.project).includes(node.label))
  }
  out.sort((a, b) => b.updated_at - a.updated_at)
  return out
}

/** 该层的记忆是否有 project 字段语义（编辑表单据此决定是否显示项目输入框；
 *  与 db.ts update() 只写这些层的 project 列同口径）。 */
export function levelHasProject(level: string): boolean {
  return level === 'project' || level === 'fact' || level === 'lesson' || level === 'topic' || level === 'rules'
}

// ── 图谱布局（确定性力导向近似：圆环初始 + 斥力/弹簧/向心迭代）────────────────

export interface GraphPoint { x: number; y: number }

/**
 * 计算图谱布局（确定性：同输入同输出，无随机数）。圆环初始位置 + 若干轮
 * 「节点互斥 + 边弹簧 + 向心」松驰，最后夹紧到画布内。规模上限 ~100 节点
 * （buildGraph 的截断保证），O(n²) 迭代在面板里是一次性毫秒级开销。
 * pinToCenter 给定时该节点每轮钉死在画布中心（关系网的「我」），其余节点
 * 环绕它松驰。
 * v0.4.0：边类型力学——项目归属边更短更紧（同项目的关键词聚成一簇）、
 * 共现边更长更松（弱关联不挤在一起）、我→锚点边保持基准。
 */
export function computeGraphLayout(
  graph: MemoryGraph,
  width = 760,
  height = 500,
  iterations = 240,
  pinToCenter?: string,
): Map<string, GraphPoint> {
  const { nodes, edges } = graph
  const pos = new Map<string, GraphPoint>()
  if (nodes.length === 0) return pos
  const cx = width / 2
  const cy = height / 2
  const radius = (Math.min(width, height) / 2) * 0.78
  nodes.forEach((node, i) => {
    if (node.id === pinToCenter) {
      pos.set(node.id, { x: cx, y: cy })
      return
    }
    const angle = (2 * Math.PI * i) / nodes.length
    pos.set(node.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
  })
  if (nodes.length === 1) {
    pos.set(nodes[0].id, { x: cx, y: cy })
    return pos
  }

  // 边类型力学系数（见函数 docstring）
  const EDGE_MECHANICS: Record<GraphEdge['kind'], { spring: number; lenScale: number }> = {
    mine: { spring: 0.06, lenScale: 1.0 },
    project: { spring: 0.09, lenScale: 0.85 },
    cooc: { spring: 0.045, lenScale: 1.25 },
  }
  const edgeList = edges.map((e) => {
    const mech = EDGE_MECHANICS[e.kind] ?? EDGE_MECHANICS.cooc
    return { ...e, len: Math.max(46, 108 - 12 * (e.weight - 1)) * mech.lenScale, spring: mech.spring }
  })
  const pad = 26
  const repulse = 5200
  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations // 冷却：步长随轮次收缩
    const disp = new Map<string, GraphPoint>()
    for (const node of nodes) disp.set(node.id, { x: 0, y: 0 })
    // 斥力（所有点对）
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id)!
        const b = pos.get(nodes[j].id)!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dSq = dx * dx + dy * dy + 40 // +40 防零距爆炸
        const f = repulse / dSq
        const d = Math.sqrt(dSq)
        const ux = dx / d
        const uy = dy / d
        const da = disp.get(nodes[i].id)!
        const db = disp.get(nodes[j].id)!
        da.x += ux * f; da.y += uy * f
        db.x -= ux * f; db.y -= uy * f
      }
    }
    // 弹簧（边拉向目标长度；劲度按边类型分档）
    for (const e of edgeList) {
      const a = pos.get(e.source)
      const b = pos.get(e.target)
      if (a === undefined || b === undefined) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - e.len) * e.spring
      const ux = dx / d
      const uy = dy / d
      const da = disp.get(e.source)!
      const db = disp.get(e.target)!
      da.x += ux * f; da.y += uy * f
      db.x -= ux * f; db.y -= uy * f
    }
    // 应用（带向心 + 冷却 + 夹紧）
    for (const node of nodes) {
      const p = pos.get(node.id)!
      if (node.id === pinToCenter) {
        p.x = cx
        p.y = cy
        continue
      }
      const d = disp.get(node.id)!
      const toCxDx = (cx - p.x) * 0.004
      const toCyDy = (cy - p.y) * 0.004
      let nx = p.x + (d.x + toCxDx) * temp
      let ny = p.y + (d.y + toCyDy) * temp
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
        nx = cx
        ny = cy
      }
      p.x = Math.min(Math.max(nx, pad), width - pad)
      p.y = Math.min(Math.max(ny, pad), height - pad)
    }
  }
  return pos
}

// ── 卡片视图：过滤 / 摘要 / 相对时间 ─────────────────────────────────────────

/** 项目筛选的特殊键（选项列表里 'all' 之外的两个哨兵）。 */
export const PROJECT_GLOBAL_KEY = '__meow_global__'
export const PROJECT_UNSET_KEY = '__meow_unset__'

export interface RowFilter {
  /** '' 或 'all' = 全部层。 */
  level: string
  /** 'all' | PROJECT_GLOBAL_KEY | PROJECT_UNSET_KEY | 项目名。 */
  project: string
  /** 大小写不敏感子串（标题/正文/目标句）。 */
  query: string
  /** 图谱点选/关键词云点选的关键词（'' = 不限）。 */
  keyword: string
  /** 'active'|'stale'|'archived'；''/'all'/undefined = 不限（v0.3.2 状态过滤）。 */
  status?: string
}

export function filterRows(rows: readonly ExplorerRow[], filter: RowFilter): ExplorerRow[] {
  const q = filter.query.trim().toLowerCase()
  const kw = filter.keyword.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter.level !== '' && filter.level !== 'all' && row.level !== filter.level) return false
    if (filter.project === PROJECT_GLOBAL_KEY) {
      if (!isGlobalProjectField(row.project)) return false
    } else if (filter.project === PROJECT_UNSET_KEY) {
      if (row.project !== null && row.project !== '') return false
    } else if (filter.project !== '' && filter.project !== 'all') {
      if (!rowProjects(row.project).includes(filter.project)) return false
    }
    if (filter.status !== undefined && filter.status !== '' && filter.status !== 'all' && row.status !== filter.status) return false
    if (kw !== '' && !row.keywords.some((k) => k.toLowerCase() === kw)) return false
    if (q !== '') {
      const title = row.title ?? ''
      const goal = row.goal ?? ''
      if (!row.content.toLowerCase().includes(q) && !title.toLowerCase().includes(q) && !goal.toLowerCase().includes(q)) return false
    }
    return true
  })
}

/** 排序模式（管理标签页排序下拉）：最近更新 / 最重要 / 最常命中。 */
export type SortMode = 'updated' | 'importance' | 'hits'
export const SORT_MODES: readonly SortMode[] = ['updated', 'importance', 'hits']

/** 稳定排序（同键按 updated_at 倒序兜底，再按 id 定序——同输入同输出）。 */
export function sortRows(rows: readonly ExplorerRow[], mode: SortMode): ExplorerRow[] {
  const out = [...rows]
  const byUpdatedThenId = (a: ExplorerRow, b: ExplorerRow): number =>
    b.updated_at - a.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (mode === 'importance') {
    out.sort((a, b) => b.importance - a.importance || byUpdatedThenId(a, b))
  } else if (mode === 'hits') {
    out.sort((a, b) => b.hit_count - a.hit_count || byUpdatedThenId(a, b))
  } else {
    out.sort(byUpdatedThenId)
  }
  return out
}

/** 高频关键词云（总览首页）：count 降序、label 升序稳定截断。 */
export function topKeywords(rows: readonly ExplorerRow[], limit = 30): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const seen = new Set<string>()
    for (const kw of row.keywords) {
      const label = kw.trim()
      if (label === '' || seen.has(label)) continue
      seen.add(label)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }))
}

// ── 记忆体检（v0.3.3 总览「记忆体检」区）──────────────────────────────────────

export interface HygieneResult {
  /** status=stale 的条目（已被引擎标记过时）。 */
  stale: ExplorerRow[]
  /** 久未命中：活跃但 30 天没更新、从未命中、重要度 ≤2 的条目（画像层豁免——
   *  soul/user 每轮全量注入，命中数恒低是设计内）。 */
  forgotten: ExplorerRow[]
}

/** 体检清单：两组都按最久未更新在前（最值得先清理）。 */
export function hygieneRows(rows: readonly ExplorerRow[], now = Date.now()): HygieneResult {
  const cutoff = now - 30 * 86_400_000
  const oldestFirst = (a: ExplorerRow, b: ExplorerRow): number =>
    a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const stale = rows.filter((r) => r.status === 'stale').sort(oldestFirst)
  const forgotten = rows
    .filter((r) => r.status === 'active' && r.hit_count === 0 && r.importance <= 2 && r.updated_at < cutoff
      && r.level !== 'soul' && r.level !== 'user')
    .sort(oldestFirst)
  return { stale, forgotten }
}

// ── 时间线（v0.3.3 时间线标签页：按创建日分组）───────────────────────────────

export interface TimelineGroup {
  /** yyyy-mm-dd（分组键，排序用）。 */
  key: string
  /** 本地化日期标签。 */
  label: string
  rows: ExplorerRow[]
}

/** 按创建日分组（本地时区），天与组内都按新的在前。 */
export function timelineGroups(rows: readonly ExplorerRow[]): TimelineGroup[] {
  const byDay = new Map<string, ExplorerRow[]>()
  for (const row of rows) {
    const d = new Date(row.created_at)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const list = byDay.get(key)
    if (list === undefined) byDay.set(key, [row])
    else list.push(row)
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, groupRows]) => {
      const [y, m, d] = key.split('-').map(Number)
      groupRows.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { key, label: t('datetime.ymdFull', { y, m, d }), rows: groupRows }
    })
}

/** 卡片标题：title 为空时取正文首行（截 60 字）。 */
export function cardTitle(row: ExplorerRow): string {
  if (row.title !== null && row.title.trim() !== '') return row.title
  const firstLine = row.content.split('\n')[0] ?? ''
  return firstLine.slice(0, 60)
}

/** 卡片摘要：正文（去掉与标题相同的首行后）的前 200 字，多行折叠为空格。 */
export function cardSnippet(row: ExplorerRow): string {
  let text = row.content
  if (row.title === null || row.title.trim() === '') {
    const lines = row.content.split('\n')
    if (lines.length > 1) text = lines.slice(1).join(' ')
  }
  return text.replaceAll('\n', ' ').slice(0, 200)
}

/** 记忆时间戳（updated_at）的人性化显示：相对时间 → 30 天外回落日期。 */
export function formatWhen(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return t('explorer.time.none')
  const diff = now - ms
  if (diff < 60_000) return t('explorer.time.justNow')
  if (diff < 3600_000) return t('explorer.time.minutes', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('explorer.time.hours', { n: Math.floor(diff / 3600_000) })
  if (diff < 30 * 86_400_000) return t('explorer.time.days', { n: Math.floor(diff / 86_400_000) })
  const d = new Date(ms)
  return t('datetime.ymdFull', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
}

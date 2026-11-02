/**
 * client-memory-graph 纯逻辑测试：buildGraph（关键词共现 + 项目归属图谱）、
 * computeGraphLayout（确定性布局）、filterRows（层级/项目/关键词/子串过滤）、
 * rowProjects/rowProjectLabel（全局标记口径）、cardTitle/cardSnippet、formatWhen、
 * hygieneRows（记忆体检清单）、timelineGroups（按创建日分组）。
 * 运行：node tests/client-memory-graph.mjs（构建后；内部 esbuild 打包源码保证与 src 同步）。
 */
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/client-memory-graph.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const {
  buildGraph, buildPersonalGraph, computeGraphLayout, filterRows, formatWhen, cardTitle, cardSnippet,
  rowProjects, rowProjectLabel, levelLabel, levelHasProject, nodeDominantLevel, rowsForNode,
  nodeCategory, categoryLabel, nodeDepths, filterGraphByDepth, sortRows, topKeywords,
  hygieneRows, timelineGroups, collectMeAliases, foldGraphAliases, rowsForEdge, isPersonNameLabel,
  graphInputRows, isOrgLabel, classifyPersonDomain, extractRelationLabel,
  buildRelationsGraph, sectorLayout,
  CATEGORY_COLORS, CATEGORY_ORDER, DOMAIN_ORDER, DOMAIN_COLORS, PROFILE_EDGE_CAP, ME_ALIAS_CAP,
  RELATION_SIGNALS, RELATION_TITLES, EXPAND_CAP,
  PROJECT_GLOBAL_KEY, PROJECT_UNSET_KEY, EXPLORER_LEVELS, ME_NODE_ID,
  setUiLocaleForTest,
} = await import(modUrl)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// 测试语言定格英文（t() 走静态查表；文案断言与语言无关的部分不依赖它）
setUiLocaleForTest('en')

/** 行工厂（缺省字段补齐）。 */
function row(over = {}) {
  return {
    id: over.id ?? 'r1', level: over.level ?? 'fact', title: over.title ?? null,
    content: over.content ?? '内容', importance: over.importance ?? 1,
    keywords: over.keywords ?? [], status: over.status ?? 'active', corrected: over.corrected ?? 0,
    project: over.project ?? null, subcategory: over.subcategory ?? null, goal: over.goal ?? null,
    hit_count: over.hit_count ?? 0, created_at: over.created_at ?? 1, updated_at: over.updated_at ?? 1,
    last_accessed_at: over.last_accessed_at ?? null,
    ...over,
  }
}

// ── rowProjects / rowProjectLabel：project 字段口径（与 db.ts 同语义的展示副本）──
check('rowProjects: 逗号多值拆分', JSON.stringify(rowProjects('a, b')) === JSON.stringify(['a', 'b']))
check('rowProjects: 全局标记不算项目', rowProjects('全局').length === 0 && rowProjects('global').length === 0)
check('rowProjects: null/空串无项目', rowProjects(null).length === 0 && rowProjects('').length === 0)
check('rowProjectLabel: 全局标记', rowProjectLabel('全局') === 'Global')
check('rowProjectLabel: 未标记', rowProjectLabel(null) === 'Unlabeled')
check('rowProjectLabel: 多值 join', rowProjectLabel('a,b') === 'a/b')

// ── levelLabel ─────────────────────────────────────────────────────────────
check('levelLabel: 七层文案', levelLabel('soul') === 'AI self' && levelLabel('rules') === 'Rules')
check('levelLabel: 未知层回落原文', levelLabel('mystery') === 'mystery')
check('EXPLORER_LEVELS: 七层同序', EXPLORER_LEVELS.length === 7 && EXPLORER_LEVELS[0] === 'soul' && EXPLORER_LEVELS[6] === 'rules')

// ── buildGraph：关键词共现 + 项目归属 ────────────────────────────────────────
const graphRows = [
  row({ id: '1', keywords: ['k1', 'k2'], project: 'p1' }),
  row({ id: '2', keywords: ['k1', 'k2'], project: 'p1' }),
  row({ id: '3', level: 'soul', keywords: ['k3'] }),
  row({ id: '4', level: 'project', keywords: ['k1', 'k3'], project: '全局' }),
]
const g = buildGraph(graphRows)
const nodeOf = (id) => g.nodes.find((n) => n.id === id)
const edge = (s, t) => g.edges.find((e) => e.source === s && e.target === t)
check('graph: 3 关键词节点 + 1 项目节点', g.nodes.length === 4
  && nodeOf('kw:k1') !== undefined && nodeOf('kw:k2') !== undefined
  && nodeOf('kw:k3') !== undefined && nodeOf('prj:p1') !== undefined,
  JSON.stringify(g.nodes.map((n) => n.id)))
check('graph: 关键词计数（同条去重）', nodeOf('kw:k1').count === 3 && nodeOf('kw:k2').count === 2 && nodeOf('kw:k3').count === 2)
check('graph: 项目计数', nodeOf('prj:p1').count === 2)
check('graph: 全局标记不产生项目节点', g.nodes.every((n) => n.id !== 'prj:全局' && n.id !== 'prj:global'))
check('graph: 共现边权重（k1-k2 两次）', edge('kw:k1', 'kw:k2')?.weight === 2)
check('graph: 共现边（k1-k3 一次）', edge('kw:k1', 'kw:k3')?.weight === 1)
check('graph: 无 k2-k3 边（未共现）', edge('kw:k2', 'kw:k3') === undefined)
check('graph: 项目归属边（p1→k1/k2 各两次）', edge('prj:p1', 'kw:k1')?.weight === 2 && edge('prj:p1', 'kw:k2')?.weight === 2)
check('graph: 未标记/全局记忆不挂项目边', !g.edges.some((e) => e.source.startsWith('prj:') && e.source !== 'prj:p1'))
check('graph: 节点带层级直方图（k1 主导 fact）', nodeDominantLevel(nodeOf('kw:k1')) === 'fact' && nodeDominantLevel(nodeOf('kw:k3')) === 'soul')
// 确定性：两次构建结果一致
const g2 = buildGraph(graphRows)
check('graph: 确定性（同输入同输出）', JSON.stringify(g) === JSON.stringify(g2))
// 空行集
const gEmpty = buildGraph([])
check('graph: 空输入空图谱', gEmpty.nodes.length === 0 && gEmpty.edges.length === 0)
// 截断：只留 1 个关键词节点时，端点缺失的边全部丢弃
const gCap = buildGraph(graphRows, { maxKeywordNodes: 1 })
check('graph: 节点截断丢弃失边', gCap.nodes.length === 2 // kw:k1 + prj:p1
  && gCap.edges.length === 1 && edge('prj:p1', 'kw:k1') !== undefined,
  JSON.stringify(gCap.edges))
// 重复关键词（同一条内）只计一次
const gDup = buildGraph([row({ keywords: ['k1', 'k1', ' k1 '] })])
check('graph: 同条重复关键词去重', gDup.nodes.length === 1 && gDup.nodes[0].count === 1)

// ── computeGraphLayout：确定性 + 有界 ────────────────────────────────────────
const layout = computeGraphLayout(g, 760, 500)
check('layout: 每个节点都有坐标', g.nodes.every((n) => layout.has(n.id)))
check('layout: 坐标有界（pad 26 内）', g.nodes.every((n) => {
  const p = layout.get(n.id)
  return p.x >= 25 && p.x <= 735 && p.y >= 25 && p.y <= 475
}), JSON.stringify([...layout.entries()]))
check('layout: 坐标有限', g.nodes.every((n) => Number.isFinite(layout.get(n.id).x) && Number.isFinite(layout.get(n.id).y)))
const layout2 = computeGraphLayout(g, 760, 500)
check('layout: 确定性（同输入同输出）', JSON.stringify([...layout.entries()]) === JSON.stringify([...layout2.entries()]))
const single = computeGraphLayout(buildGraph([row({ keywords: ['only'] })]), 760, 500)
check('layout: 单节点居中', single.get('kw:only').x === 380 && single.get('kw:only').y === 250)
check('layout: 空图谱空表', computeGraphLayout({ nodes: [], edges: [] }).size === 0)

// ── filterRows ──────────────────────────────────────────────────────────────
const filterSeed = [
  row({ id: 'a', level: 'fact', content: 'Node sqlite', keywords: ['sqlite'], project: 'dsh' }),
  row({ id: 'b', level: 'soul', content: 'I am a partner', keywords: ['partner'], project: '全局' }),
  row({ id: 'c', level: 'lesson', title: 'T1', content: '被纠正', keywords: ['corrected'], project: null }),
]
const f = (patch) => filterRows(filterSeed, { level: '', project: 'all', query: '', keyword: '', ...patch })
check('filter: 空 filter 全量', f({}).length === 3)
check('filter: level', f({ level: 'fact' }).map((r) => r.id).join() === 'a')
check('filter: project 名匹配', f({ project: 'dsh' }).map((r) => r.id).join() === 'a')
check('filter: 全局哨兵', f({ project: PROJECT_GLOBAL_KEY }).map((r) => r.id).join() === 'b')
check('filter: 未标记哨兵', f({ project: PROJECT_UNSET_KEY }).map((r) => r.id).join() === 'c')
check('filter: 关键词', f({ keyword: 'sqlite' }).map((r) => r.id).join() === 'a')
check('filter: 查询大小写不敏感（标题）', f({ query: 't1' }).map((r) => r.id).join() === 'c')
check('filter: 查询命中正文', f({ query: 'partner' }).length === 1)
check('filter: 组合', f({ level: 'soul', keyword: 'partner' }).length === 1 && f({ level: 'fact', keyword: 'partner' }).length === 0)

// ── filterRows: status（v0.3.2 状态过滤）──
const statusSeed = [
  row({ id: 'a', status: 'active' }),
  row({ id: 'b', status: 'stale' }),
  row({ id: 'c', status: 'archived' }),
]
const fs = (patch) => filterRows(statusSeed, { level: '', project: 'all', query: '', keyword: '', ...patch })
check('filter: status 活跃/陈旧/归档', fs({ status: 'active' }).map((r) => r.id).join() === 'a'
  && fs({ status: 'stale' }).map((r) => r.id).join() === 'b'
  && fs({ status: 'archived' }).map((r) => r.id).join() === 'c')
check('filter: status all/缺省不限', fs({ status: 'all' }).length === 3 && fs({}).length === 3)

// ── sortRows（v0.3.2 排序下拉）──
const sortSeed = [
  row({ id: 'a', importance: 3, hit_count: 5, updated_at: 10 }),
  row({ id: 'b', importance: 5, hit_count: 1, updated_at: 30 }),
  row({ id: 'c', importance: 5, hit_count: 9, updated_at: 20 }),
  row({ id: 'd', importance: 1, hit_count: 0, updated_at: 40 }),
]
check('sort: updated 最近更新优先', sortRows(sortSeed, 'updated').map((r) => r.id).join() === 'd,b,c,a')
check('sort: importance 重要度优先（同分按更新倒序）', sortRows(sortSeed, 'importance').map((r) => r.id).join() === 'b,c,a,d',
  sortRows(sortSeed, 'importance').map((r) => r.id).join())
check('sort: hits 命中数优先', sortRows(sortSeed, 'hits').map((r) => r.id).join() === 'c,a,b,d')
check('sort: 不改原数组', sortSeed.map((r) => r.id).join() === 'a,b,c,d')

// ── topKeywords（v0.3.2 总览关键词云）──
const cloudSeed = [
  row({ keywords: ['b', 'a', 'a'] }), // 同条重复去重
  row({ keywords: ['b', 'c'] }),
  row({ keywords: ['b'] }),
  row({ keywords: [] }),
]
check('cloud: 计数与排序（count 降序、label 升序）',
  JSON.stringify(topKeywords(cloudSeed)) === JSON.stringify([
    { label: 'b', count: 3 }, { label: 'a', count: 1 }, { label: 'c', count: 1 },
  ]))
check('cloud: limit 截断', topKeywords(cloudSeed, 2).length === 2)
check('cloud: 空行集 → 空', topKeywords([]).length === 0)

// ── cardTitle / cardSnippet ─────────────────────────────────────────────────
check('cardTitle: title 优先', cardTitle(row({ title: '标题', content: '正文' })) === '标题')
check('cardTitle: 无 title 取首行截断', cardTitle(row({ title: null, content: '首行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长\n次行' })) === '首行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长')
check('cardSnippet: 有 title 时整段正文', cardSnippet(row({ title: 't', content: 'L1\nL2' })) === 'L1 L2')
check('cardSnippet: 无 title 时去首行', cardSnippet(row({ title: null, content: '首\nL2\nL3' })) === 'L2 L3')

// ── formatWhen ─────────────────────────────────────────────────────────────
const now = 1_800_000_000_000
check('formatWhen: null → 无时间文案', formatWhen(null, now) === 'no date')
check('formatWhen: 刚刚', formatWhen(now - 30_000, now) === 'just now')
check('formatWhen: 分钟', formatWhen(now - 5 * 60_000, now) === '5 min ago')
check('formatWhen: 小时', formatWhen(now - 3 * 3_600_000, now) === '3 h ago')
check('formatWhen: 天', formatWhen(now - 2 * 86_400_000, now) === '2 d ago')
const old = new Date(now - 40 * 86_400_000)
check('formatWhen: 30 天外回落日期', formatWhen(old.getTime(), now) === `${old.getFullYear()}/${old.getMonth() + 1}/${old.getDate()}`)

// ── buildPersonalGraph：以「我」为中心的关系网 ──────────────────────────────
const pg = buildPersonalGraph(graphRows)
const pNodeOf = (id) => pg.nodes.find((n) => n.id === id)
const pMe = pNodeOf(ME_NODE_ID)
check('personal graph: 中心「我」节点在最前', pg.nodes[0] === pMe && pMe.kind === 'me' && pMe.label === 'Me')
check('personal graph: 中心计数=记忆总数', pMe.count === graphRows.length, String(pMe.count))
check('personal graph: 中心层级直方图', pMe.levels.fact === 2 && pMe.levels.soul === 1 && pMe.levels.project === 1, JSON.stringify(pMe.levels))
check('personal graph: 保留原图谱节点', pNodeOf('kw:k1') !== undefined && pNodeOf('prj:p1') !== undefined)
// v0.3.1 起多跳拓扑：我只直连 ①全部项目 ②画像关键词（user/soul 层）③孤立兜底；
// 事物类关键词经项目归属/共现边间接到达。测试数据里：k3 来自 soul 行 → 直连；
// k1/k2 只在 fact/project 层 → 不直连但可达（k1 经 p1/k3，k2 经 k1）。
const meEdges = pg.edges.filter((e) => e.source === ME_NODE_ID)
check('personal graph: 我只直连锚点（项目 + 画像关键词）',
  meEdges.length === 2
  && meEdges.some((e) => e.target === 'prj:p1' && e.weight === 2)
  && meEdges.some((e) => e.target === 'kw:k3' && e.weight === 2),
  JSON.stringify(meEdges))
check('personal graph: 事物关键词不直连我（多跳到达）',
  !meEdges.some((e) => e.target === 'kw:k1') && !meEdges.some((e) => e.target === 'kw:k2'))
check('personal graph: 我的边 kind=mine', meEdges.every((e) => e.kind === 'mine'))
check('personal graph: 共现边 kind=cooc', pg.edges.find((e) => e.source === 'kw:k1' && e.target === 'kw:k2')?.kind === 'cooc')
check('personal graph: 归属边 kind=project', pg.edges.find((e) => e.source === 'prj:p1' && e.target === 'kw:k1')?.kind === 'project')
check('personal graph: 原共现边保留', pg.edges.some((e) => e.source === 'kw:k1' && e.target === 'kw:k2'))
check('personal graph: 确定性', JSON.stringify(buildPersonalGraph(graphRows)) === JSON.stringify(pg))
check('personal graph: 空行集 → 空图（无中心节点）', buildPersonalGraph([]).nodes.length === 0)

// ── 多跳拓扑：孤立兜底 / 画像直连上限 ────────────────────────────────────────
// 孤立兜底：单条只有一个关键词的记忆 → 该关键词无共现/归属边，直连我（不消失）
const lonely = buildPersonalGraph([row({ keywords: ['lonely'] })])
check('multi-hop: 孤立关键词兜底直连我',
  lonely.edges.some((e) => e.source === ME_NODE_ID && e.target === 'kw:lonely' && e.kind === 'mine'))
// 画像直连上限：PROFILE_EDGE_CAP 个之外的画像关键词靠共现边到达（不再直连我）
const capRows = []
for (let i = 1; i <= PROFILE_EDGE_CAP + 2; i++) {
  capRows.push(row({ id: `u${i}`, level: 'user', keywords: [`k${String(i).padStart(2, '0')}`, 'hub'] }))
}
const capGraph = buildPersonalGraph(capRows)
const capMeEdges = capGraph.edges.filter((e) => e.source === ME_NODE_ID)
check('multi-hop: 画像关键词直连数有上限', capMeEdges.length === PROFILE_EDGE_CAP, String(capMeEdges.length))
check('multi-hop: 上限外画像关键词不直连但仍可达（hub 共现边）',
  !capMeEdges.some((e) => e.target === 'kw:k11')
  && capGraph.edges.some((e) => e.source === 'kw:hub' && e.target === 'kw:k11' && e.kind === 'cooc'))
check('multi-hop: 上限外的节点仍在图里', capGraph.nodes.some((n) => n.id === 'kw:k11'))

// ── nodeDepths：从我出发的 BFS 跳数 ──────────────────────────────────────────
const depths = nodeDepths(pg)
check('depths: 我=0，直连锚点=1', depths.get(ME_NODE_ID) === 0 && depths.get('prj:p1') === 1 && depths.get('kw:k3') === 1)
check('depths: 间接节点=2（k1/k2 经项目或画像关键词到达）', depths.get('kw:k1') === 2 && depths.get('kw:k2') === 2,
  JSON.stringify([...depths.entries()]))
check('depths: 根缺席 → 空表', nodeDepths(buildGraph(graphRows), ME_NODE_ID).size === 0)
// 共现链：me→p1→b→c 真三跳（c 无项目、只与 b 共现）
const chain = buildPersonalGraph([
  row({ id: 'c1', keywords: ['a', 'b'], project: 'p1' }),
  row({ id: 'c2', keywords: ['b', 'c'] }),
])
const chainDepths = nodeDepths(chain)
check('depths: 共现链真三跳（me→p1→b→c）',
  chainDepths.get('prj:p1') === 1 && chainDepths.get('kw:b') === 2 && chainDepths.get('kw:c') === 3,
  JSON.stringify([...chainDepths.entries()]))

// ── filterGraphByDepth：跳数过滤子图 ─────────────────────────────────────────
const hop1 = filterGraphByDepth(pg, depths, 1)
check('hop filter: 1 跳只留我 + 直连锚点',
  hop1.nodes.length === 3 && hop1.nodes.every((n) => [ME_NODE_ID, 'kw:k3', 'prj:p1'].includes(n.id)),
  JSON.stringify(hop1.nodes.map((n) => n.id)))
check('hop filter: 1 跳只留我的边', hop1.edges.length === 2 && hop1.edges.every((e) => e.kind === 'mine'))
const hop2 = filterGraphByDepth(pg, depths, 2)
check('hop filter: 2 跳收进全部间接节点（本数据最深 2 跳）',
  hop2.nodes.length === pg.nodes.length && hop2.edges.length === pg.edges.length)
check('hop filter: 0 跳只剩我', filterGraphByDepth(pg, depths, 0).nodes.length === 1
  && filterGraphByDepth(pg, depths, 0).edges.length === 0)
// 共现链上的逐跳收窄：每收窄一跳，最深节点与其边一起消失
const chainHop2 = filterGraphByDepth(chain, chainDepths, 2)
check('hop filter: 链上 2 跳裁掉第 3 跳节点及边',
  !chainHop2.nodes.some((n) => n.id === 'kw:c')
  && !chainHop2.edges.some((e) => e.target === 'kw:c')
  && chainHop2.nodes.some((n) => n.id === 'kw:b'))

// ── nodeCategory / categoryLabel / CATEGORY_COLORS：语义分类 ─────────────────
check('category: me/project 由 kind 决定', nodeCategory({ kind: 'me', levels: {} }) === 'me'
  && nodeCategory({ kind: 'project', levels: { fact: 5 } }) === 'project')
// v0.4.3：人物不再由「主导 user 层」推断（那是实体/词形的职责），关键词节点回落 thing
check('category: 主导 user 关键词回落 thing（人物改由实体/词形判定）', nodeCategory({ kind: 'keyword', levels: { user: 2, fact: 1 } }) === 'thing')
check('category: 主导 soul → self', nodeCategory({ kind: 'keyword', levels: { soul: 1 } }) === 'self')
check('category: 主导 lesson/rules → experience',
  nodeCategory({ kind: 'keyword', levels: { lesson: 2, fact: 1 } }) === 'experience'
  && nodeCategory({ kind: 'keyword', levels: { rules: 1 } }) === 'experience')
check('category: 主导 fact/topic/project → thing',
  nodeCategory({ kind: 'keyword', levels: { fact: 3, lesson: 1 } }) === 'thing'
  && nodeCategory({ kind: 'keyword', levels: { topic: 1 } }) === 'thing'
  && nodeCategory({ kind: 'keyword', levels: { project: 2 } }) === 'thing')
check('category: 空直方图兜底 thing', nodeCategory({ kind: 'keyword', levels: {} }) === 'thing')
check('category: 十一类配色齐全且互不相同（v0.4.3 实体语义分类）',
  CATEGORY_ORDER.length === 11
  && CATEGORY_ORDER.every((c) => typeof CATEGORY_COLORS[c] === 'string')
  && new Set(CATEGORY_ORDER.map((c) => CATEGORY_COLORS[c])).size === 11)

// ── isPersonNameLabel / nodeCategory 人名形状（v0.4.1：人物不再因主导 fact 层被误归事物）──
check('personName: 常见中文姓名', ['张三', '陈建国', '李四强', '王健林'].every(isPersonNameLabel))
check('personName: 复姓', ['欧阳锋', '司马懿', '欧阳娜娜'].every(isPersonNameLabel))
check('personName: 姓氏+称谓', ['王工', '李总', '张老师', '陈博士', '刘同学', '赵同事', '孙经理', '吴姐', '郑哥', '张建国老师'].every(isPersonNameLabel))
check('personName: 安全姓氏表剔除高频词碰撞',
  ['周末', '任何', '程序', '黄河', '曾经', '余额', '付款', '任务', '黎明', '高温', '钱包', '白菜', '方法', '方向', '历史'].every((s) => !isPersonNameLabel(s)))
check('personName: 非姓名拒绝', ['咖啡', '机器学习', '部署', '数据库迁移', 'DeepSeek', '我'].every((s) => !isPersonNameLabel(s)))
check('personName: 英文不做形状判断（产品名与人名不可分）', !isPersonNameLabel('Chen Jianguo') && !isPersonNameLabel('John Smith'))
check('personName: 非汉字/超长/单字拒绝', ['张三abc', '欧阳修123', '张', '', '  '].every((s) => !isPersonNameLabel(s)))
check('category: 人名形状优先于主导层（fact 主导的人名 → person）',
  nodeCategory({ kind: 'keyword', levels: { fact: 3, lesson: 1 }, label: '张三' }) === 'person'
  && nodeCategory({ kind: 'keyword', levels: { topic: 2 }, label: '李总' }) === 'person')
check('category: 词形判不出语义的回落主导层（fact 主导 → thing）',
  nodeCategory({ kind: 'keyword', levels: { fact: 3 }, label: '部署' }) === 'thing')
check('category: 词形优先于主导层（咖啡 → item）',
  nodeCategory({ kind: 'keyword', levels: { fact: 3 }, label: '咖啡' }) === 'item')
check('category: 无 label 的旧调用形状不受影响',
  nodeCategory({ kind: 'keyword', levels: { fact: 3 } }) === 'thing')
check('categoryLabel: 各类文案（en，v0.4.3 语义分类）',
  categoryLabel('me') === 'Me' && categoryLabel('project') === 'project'
  && categoryLabel('person') === 'people' && categoryLabel('thing') === 'concepts'
  && categoryLabel('experience') === 'lessons' && categoryLabel('self') === 'AI self'
  && categoryLabel('health') === 'health' && categoryLabel('event') === 'events'
  && categoryLabel('location') === 'places' && categoryLabel('organization') === 'organizations'
  && categoryLabel('item') === 'items')

// ── computeGraphLayout：钉住中心 ────────────────────────────────────────────
const pinLayout = computeGraphLayout(pg, 760, 500, 240, ME_NODE_ID)
check('pin layout: 中心节点钉在画布中心', pinLayout.get(ME_NODE_ID).x === 380 && pinLayout.get(ME_NODE_ID).y === 250)
check('pin layout: 确定性（同输入同输出）', JSON.stringify([...computeGraphLayout(pg, 760, 500, 240, ME_NODE_ID)]) === JSON.stringify([...pinLayout]))
check('pin layout: 其余节点在界内', [...pinLayout.values()].every((p) => p.x >= 0 && p.x <= 760 && p.y >= 0 && p.y <= 500))

// ── rowsForNode：节点 → 关联记忆（抽屉数据源）──────────────────────────────
const assocRows = [
  row({ id: 'a', keywords: ['Partner', 'x'], project: 'p1', updated_at: 10 }),
  row({ id: 'b', keywords: ['partner'], project: 'p2', updated_at: 30 }),
  row({ id: 'c', keywords: ['y'], project: 'p1, p2', updated_at: 20 }),
  row({ id: 'd', keywords: [], project: null, updated_at: 40 }),
]
check('rowsForNode: 中心「我」= 全部（按 updated_at 倒序）',
  JSON.stringify(rowsForNode({ kind: 'me', label: 'Me' }, assocRows).map((r) => r.id)) === JSON.stringify(['d', 'b', 'c', 'a']))
check('rowsForNode: 关键词大小写不敏感',
  JSON.stringify(rowsForNode({ kind: 'keyword', label: 'partner' }, assocRows).map((r) => r.id)) === JSON.stringify(['b', 'a']))
check('rowsForNode: 项目命中多值字段',
  JSON.stringify(rowsForNode({ kind: 'project', label: 'p2' }, assocRows).map((r) => r.id)) === JSON.stringify(['b', 'c']))
check('rowsForNode: 无关联空集', rowsForNode({ kind: 'keyword', label: 'zzz' }, assocRows).length === 0)

// ── levelHasProject：编辑表单的项目字段开关（与 db.update 写列口径一致）─────
check('levelHasProject: 有项目列的层', levelHasProject('project') && levelHasProject('fact') && levelHasProject('lesson') && levelHasProject('topic') && levelHasProject('rules'))
check('levelHasProject: 无项目列的层', !levelHasProject('soul') && !levelHasProject('user') && !levelHasProject('mystery'))

// ── hygieneRows：记忆体检清单（已过时 + 久未命中）────────────────────────────
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime()
const DAY = 86400000
const hygRows = [
  row({ id: 's1', status: 'stale', updated_at: NOW - 5 * DAY }),
  row({ id: 's2', status: 'stale', updated_at: NOW - 40 * DAY }),
  row({ id: 'f1', hit_count: 0, importance: 1, updated_at: NOW - 60 * DAY }),
  row({ id: 'f2', hit_count: 0, importance: 2, updated_at: NOW - 31 * DAY }),
  row({ id: 'a1', hit_count: 0, importance: 1, updated_at: NOW - 10 * DAY }), // 太新鲜
  row({ id: 'a2', hit_count: 3, importance: 1, updated_at: NOW - 60 * DAY }), // 有命中
  row({ id: 'a3', hit_count: 0, importance: 4, updated_at: NOW - 60 * DAY }), // 高重要度
  row({ id: 'p1', level: 'soul', hit_count: 0, importance: 1, updated_at: NOW - 90 * DAY }), // 画像豁免
  row({ id: 'p2', level: 'user', hit_count: 0, importance: 1, updated_at: NOW - 90 * DAY }), // 画像豁免
  row({ id: 'ar', status: 'archived', hit_count: 0, importance: 1, updated_at: NOW - 90 * DAY }),
]
const hyg = hygieneRows(hygRows, NOW)
check('hygiene: stale 全收（最久未更新在前）',
  JSON.stringify(hyg.stale.map((r) => r.id)) === JSON.stringify(['s2', 's1']))
check('hygiene: forgotten = 30 天+零命中且低重要度（最久在前）',
  JSON.stringify(hyg.forgotten.map((r) => r.id)) === JSON.stringify(['f1', 'f2']))
check('hygiene: 画像层（soul/user）豁免于 forgotten',
  !hyg.forgotten.some((r) => r.id === 'p1' || r.id === 'p2'))
check('hygiene: 有命中/高重要度/新鲜/已归档均不进 forgotten', hyg.forgotten.length === 2)
check('hygiene: 空输入空结果', hygieneRows([], NOW).stale.length === 0 && hygieneRows([], NOW).forgotten.length === 0)

// ── timelineGroups：按创建日分组（时间线标签页数据源）────────────────────────
const d1Morning = new Date(2026, 9, 20, 9, 0, 0).getTime()
const d1Evening = new Date(2026, 9, 20, 18, 30, 0).getTime()
const d2 = new Date(2026, 9, 18, 8, 0, 0).getTime()
const tlRows = [
  row({ id: 'b', created_at: d1Morning }),
  row({ id: 'a', created_at: d1Evening }), // 同天更晚 → 组内排前
  row({ id: 'c', created_at: d2 }),
]
const tl = timelineGroups(tlRows)
check('timeline: 按天分组且新天在前',
  tl.length === 2 && tl[0].label === '2026/10/20' && tl[1].label === '2026/10/18',
  JSON.stringify(tl.map((g) => g.label)))
check('timeline: 组内按创建时刻新→旧', JSON.stringify(tl[0].rows.map((r) => r.id)) === JSON.stringify(['a', 'b']))
check('timeline: 分组行数完整', tl[0].rows.length === 2 && tl[1].rows.length === 1)
check('timeline: 空输入空组', timelineGroups([]).length === 0)

// ── v0.4.0 节点富化：lastUpdated / hits ──────────────────────────────────────
const rich = buildGraph([
  row({ id: 'r1', keywords: ['k1'], project: 'p1', hit_count: 3, updated_at: 100 }),
  row({ id: 'r2', keywords: ['k1'], project: 'p1', hit_count: 5, updated_at: 300 }),
  row({ id: 'r3', keywords: ['k1'], hit_count: 2, updated_at: 200 }),
])
const richK1 = rich.nodes.find((n) => n.id === 'kw:k1')
const richP1 = rich.nodes.find((n) => n.id === 'prj:p1')
check('node enrich: lastUpdated 取最大 updated_at', richK1.lastUpdated === 300)
check('node enrich: hits 累加 hit_count', richK1.hits === 10 && richP1.hits === 8)
const richMe = buildPersonalGraph([
  row({ id: 'r1', hit_count: 1, updated_at: 100 }),
  row({ id: 'r2', hit_count: 4, updated_at: 50 }),
]).nodes.find((n) => n.id === ME_NODE_ID)
check('node enrich: me 节点 lastUpdated/hits 覆盖全库', richMe.lastUpdated === 100 && richMe.hits === 5)

// ── v0.4.0 collectMeAliases：从 user 层自报语句识别姓名 ───────────────────────
const aliasRows = [
  row({ id: 'u1', level: 'user', content: '我的名字叫陈建国，今年 40 岁。' }),
  row({ id: 'u2', level: 'user', content: 'My name is Chen Jianguo, nice to meet you.' }),
  row({ id: 'u3', level: 'user', content: '大家都称呼我为老陈' }),
  row({ id: 'u4', level: 'fact', content: '叫我小李就行' }), // 非 user 层不收
  row({ id: 'u5', level: 'user', content: '叫我相信未来会更好' }), // 捕获后紧跟汉字 → 拒收
]
const aliases = collectMeAliases(aliasRows)
check('aliases: 中文自报命中（名字叫）', aliases.includes('陈建国'), JSON.stringify(aliases))
check('aliases: 中文自报命中（称呼我为）', aliases.includes('老陈'))
check('aliases: 英文自报命中（my name is，大小写不敏感去重）', aliases.some((a) => a.toLowerCase() === 'chen jianguo'))
check('aliases: 非 user 层不收', !aliases.includes('小李'))
check('aliases: 捕获后紧跟汉字的长句拒收', !aliases.includes('相信未来'))
check('aliases: 去重 + 上限',
  collectMeAliases(Array.from({ length: 20 }, (_, i) => row({ id: `x${i}`, level: 'user', content: `叫我别名${i}号` }))).length <= ME_ALIAS_CAP)
check('aliases: 空输入空数组', collectMeAliases([]).length === 0)

// ── v0.4.0 foldGraphAliases：用户姓名节点折叠进「我」──────────────────────────
// 注意 v0.4.3 关键词准入：「喝茶」是动作前缀噪声、「dsh」命中技术词正则，都会被
// buildGraph 丢掉——夹具关键词用「龙井」（存活）验证折叠语义本身。
const foldRows = [
  row({ id: 'f1', level: 'user', keywords: ['陈建国', '龙井'], content: '我的名字叫陈建国' }),
  row({ id: 'f2', level: 'fact', keywords: ['陈建国', '阿里'], project: '陈建国' }),
  row({ id: 'f3', level: 'fact', keywords: ['阿里'], project: 'dsh-plugin' }),
]
const foldedGraph = foldGraphAliases(buildPersonalGraph(foldRows), collectMeAliases(foldRows))
check('fold: 姓名关键词节点消失', !foldedGraph.nodes.some((n) => n.label === '陈建国'), JSON.stringify(foldedGraph.nodes.map((n) => n.id)))
check('fold: 同名项目节点也折叠', !foldedGraph.nodes.some((n) => n.id === 'prj:陈建国'))
check('fold: me 节点仍在', foldedGraph.nodes.some((n) => n.id === ME_NODE_ID))
check('fold: 别名的边重定向为 me 的 mine 边',
  foldedGraph.edges.some((e) => e.kind === 'mine' && ((e.source === ME_NODE_ID && e.target === 'kw:龙井') || (e.target === ME_NODE_ID && e.source === 'kw:龙井'))),
  JSON.stringify(foldedGraph.edges))
check('fold: 无自环', foldedGraph.edges.every((e) => e.source !== e.target))
check('fold: 同端点边合并（权重求和）',
  (() => {
    const seen = new Set()
    for (const e of foldedGraph.edges) {
      const k = `${e.source}|${e.target}`
      if (seen.has(k)) return false
      seen.add(k)
    }
    return true
  })())
check('fold: 未命中别名原样返回', foldGraphAliases(buildPersonalGraph(foldRows), ['无名氏']).nodes.length === buildPersonalGraph(foldRows).nodes.length)
check('fold: 无 me 节点原样返回', (() => { const bg = buildGraph(foldRows); return foldGraphAliases(bg, ['陈建国']) === bg })())
check('fold: 确定性', JSON.stringify(foldGraphAliases(buildPersonalGraph(foldRows), ['陈建国'])) === JSON.stringify(foldGraphAliases(buildPersonalGraph(foldRows), ['陈建国'])))
check('fold: 拉丁标签大小写不敏感折叠',
  (() => {
    const g2 = buildPersonalGraph([row({ level: 'user', keywords: ['Alice'], content: 'Call me Alice.' }), row({ keywords: ['alice', 'tea'] })])
    const fg = foldGraphAliases(g2, collectMeAliases([row({ level: 'user', content: 'Call me Alice.' })]))
    return !fg.nodes.some((n) => n.label.toLowerCase() === 'alice')
  })())

// ── v0.4.0 rowsForEdge：边 → 关联记忆（关系详情抽屉数据源）────────────────────
const edgeRows = [
  row({ id: 'e1', keywords: ['k1', 'k2'], project: 'p1', updated_at: 10 }),
  row({ id: 'e2', keywords: ['k1', 'k2'], project: 'p1', updated_at: 30 }),
  row({ id: 'e3', keywords: ['k1'], project: 'p1', updated_at: 20 }),
  row({ id: 'e4', keywords: ['k2'], project: 'p2', updated_at: 40 }),
]
const edgeGraph = buildPersonalGraph(edgeRows)
const coocEdge = edgeGraph.edges.find((e) => e.kind === 'cooc' && [e.source, e.target].includes('kw:k1') && [e.source, e.target].includes('kw:k2'))
check('edge rows: cooc = 双关键词交集（新在前）',
  JSON.stringify(rowsForEdge(coocEdge, edgeGraph, edgeRows).map((r) => r.id)) === JSON.stringify(['e2', 'e1']))
const projEdge = edgeGraph.edges.find((e) => e.kind === 'project' && e.source === 'prj:p1' && e.target === 'kw:k1')
check('edge rows: project = 项目∧关键词',
  JSON.stringify(rowsForEdge(projEdge, edgeGraph, edgeRows).map((r) => r.id)) === JSON.stringify(['e2', 'e3', 'e1']))
const mineEdge = edgeGraph.edges.find((e) => e.kind === 'mine' && (e.target === 'prj:p1' || e.source === 'prj:p1'))
check('edge rows: mine = 另一端节点的关联集',
  JSON.stringify(rowsForEdge(mineEdge, edgeGraph, edgeRows).map((r) => r.id)) === JSON.stringify(['e2', 'e3', 'e1']))
check('edge rows: 端点不在图里 → 空集', rowsForEdge({ source: 'kw:ghost', target: 'kw:k1', kind: 'cooc' }, edgeGraph, edgeRows).length === 0)
check('edge rows: kind 与端点类型不匹配 → 空集',
  rowsForEdge({ source: 'prj:p1', target: 'kw:k1', kind: 'cooc' }, edgeGraph, edgeRows).length === 0)

// ── v0.4.0 边类型力学：布局仍确定性有界（弹簧系数换档不破坏不变量）────────────
const mechLayout = computeGraphLayout(edgeGraph, 760, 500, 240, ME_NODE_ID)
check('edge mechanics: 布局确定性保持',
  JSON.stringify([...computeGraphLayout(edgeGraph, 760, 500, 240, ME_NODE_ID)]) === JSON.stringify([...mechLayout]))
check('edge mechanics: 坐标有界且中心钉住',
  mechLayout.get(ME_NODE_ID).x === 380 && mechLayout.get(ME_NODE_ID).y === 250
  && [...mechLayout.values()].every((p) => p.x >= 0 && p.x <= 760 && p.y >= 0 && p.y <= 500))
check('edge mechanics: 项目簇比共现对更紧（p1-k1 距离 < k1-k2 距离…同权重下）',
  (() => {
    const d = (a, b) => { const pa = mechLayout.get(a); const pb = mechLayout.get(b); return Math.hypot(pa.x - pb.x, pa.y - pb.y) }
    return d('prj:p1', 'kw:k1') < d('kw:k1', 'kw:k2')
  })(),
  (() => {
    const d = (a, b) => { const pa = mechLayout.get(a); const pb = mechLayout.get(b); return Math.hypot(pa.x - pb.x, pa.y - pb.y).toFixed(1) }
    return `proj=${d('prj:p1', 'kw:k1')} cooc=${d('kw:k1', 'kw:k2')}`
  })())

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

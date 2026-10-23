/**
 * 实体派生层单测（纯函数，不需要宿主/构建）。
 *
 * 运行：node tests/client-entities.mjs
 * 依赖 Node 24 的类型剥离（直接 import .ts）。
 */
import {
  buildEntityOverview,
  inferEntityType,
  isEntityLabel,
  normalizeEntityLabel,
} from '../src/client-entities.ts'

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

let seq = 0
function row(o) {
  const now = 1_700_000_000_000 + seq++
  return {
    id: `r${seq}`,
    level: 'fact',
    title: null,
    content: '',
    importance: 1,
    keywords: [],
    status: 'active',
    corrected: 0,
    project: null,
    subcategory: null,
    goal: null,
    hit_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    ...o,
  }
}

const rows = [
  row({ level: 'user', content: '老婆对海鲜严重过敏，绝对不能吃', keywords: ['老婆', '海鲜过敏'] }),
  row({ level: 'user', content: '两个孩子的生日要记', keywords: ['老大', '老二', '生日'] }),
  row({ level: 'user', content: '咖啡因彻底戒了，改喝热燕麦奶', keywords: ['咖啡因', '热燕麦奶'] }),
  row({ level: 'user', content: '妻子说周末想出门', keywords: ['妻子', '周末'] }),
  row({ level: 'user', content: '孩子和儿子都由家人照看', keywords: ['孩子', '儿子', '家人'] }),
  row({ level: 'fact', content: '一堆过敏记录', keywords: Array.from({ length: 13 }, (_, i) => `过敏项${i + 1}`) }),
  row({ level: 'fact', content: '常住杭州滨江，周末室内游泳', keywords: ['杭州滨江', '室内游泳'] }),
  row({ level: 'fact', content: '杭州 滨江 通勤', keywords: ['杭州', '滨江'] }),
  row({ level: 'fact', content: '下周三去协和医院做年度体检', keywords: ['协和医院', '年度体检'] }),
  row({ level: 'fact', content: '给老大买恐龙百科全书', keywords: ['恐龙百科全书', '优衣库', 'S码'] }),
  row({ level: 'fact', content: '膝盖半月板损伤，医生要求戒跑', keywords: ['膝盖半月板损伤', '半月板损伤'] }),
  row({ level: 'fact', content: '老婆生日在 12 月 5 日', keywords: ['老婆生日'] }),
  row({ level: 'fact', content: '老婆的生日要提前订西餐厅', keywords: ['老婆的生日', '西餐厅'] }),
  row({ level: 'fact', content: '靠过道座位比靠过道座舒服', keywords: ['靠过道座位', '靠过道座'] }),
  row({ level: 'fact', content: '用户说自己很忙，我记住了', keywords: ['用户', '我', '应该没问题'] }),
  row({ level: 'project', project: 'jt-pa-memory', content: '插件配置在 cordis.patch.yml，数据存 SQLite', keywords: ['jt-pa-memory', 'cordis.patch.yml', 'promptLang', 'SQLite'] }),
]

section('1. 准入')
ok('拒绝路径/文件名', !isEntityLabel('src/index.ts') && !isEntityLabel('cordis.patch.yml'))
ok('拒绝配置键/长驼峰', !isEntityLabel('promptLang'))
ok('拒绝泛称/指代', !isEntityLabel('用户') && !isEntityLabel('我'))
ok('拒绝口语整句', !isEntityLabel('应该没问题') && !isEntityLabel('给模型看的'))
ok('拒绝并列短语', !isEntityLabel('代金券/优惠券补偿'))
ok('保留单字词典词', isEntityLabel('猫') && !isEntityLabel('的'))
ok('归一：去「的」+ 去括号', normalizeEntityLabel('老婆的生日') === '老婆生日' && normalizeEntityLabel('靠过道座（C/D座）') === '靠过道座')

section('2. 类型推断')
ok('人物', inferEntityType('老婆', 'user') === 'person')
ok('健康', inferEntityType('海鲜过敏', 'fact') === 'health')
ok('地点（城市前缀）', inferEntityType('杭州滨江', 'fact') === 'location')
ok('地点（场所后缀）', inferEntityType('城西会展中心', 'fact') === 'location')
ok('机构（医院）', inferEntityType('协和医院', 'fact') === 'organization')
ok('机构（词典）', inferEntityType('腾讯', 'fact') === 'organization')
ok('物品（书）', inferEntityType('恐龙百科全书', 'fact') === 'item')
ok('物品（码）', inferEntityType('S码', 'fact') === 'item')
ok('事件（体检）', inferEntityType('年度体检', 'fact') === 'event')
ok('概念（活动）', inferEntityType('室内游泳', 'user') === 'concept')
ok('抽象名词不误判人物', inferEntityType('终身健康红线', 'user') === 'concept')
ok('关系称谓判人物（老婆）', inferEntityType('老婆', 'user') === 'person')
ok('话题词不判人物（周末）', inferEntityType('周末', 'user') === 'concept')
ok('泛称/集合不当人物（孩子/儿子/家人）', ['孩子', '儿子', '家人'].every((s) => inferEntityType(s, 'user') === 'concept'))

section('3. 个人视图 + 去重 + 归属')
{
  const ov = buildEntityOverview(rows, { scope: 'personal' })
  const labels = ov.graph.nodes.filter((n) => n.kind !== 'me').map((n) => n.label)
  const allLabels = buildEntityOverview(rows, { scope: 'all' }).graph.nodes.filter((n) => n.kind !== 'me').map((n) => n.label)
  ok('不含工程实体', !labels.includes('jt-pa-memory') && !labels.includes('promptLang') && !labels.includes('cordis.patch.yml'), JSON.stringify(labels))
  ok('不含泛称', !labels.includes('用户') && !labels.includes('我'), JSON.stringify(labels))
  ok('含人物/健康/地点/事件', ['老婆', '海鲜过敏', '杭州滨江', '年度体检'].every((x) => labels.includes(x)), JSON.stringify(labels))
  ok('同义词合并（妻子 → 老婆）', labels.includes('老婆') && !labels.includes('妻子'), JSON.stringify(labels))
  ok('泛称不进入人物节点', !['孩子', '儿子', '家人'].some((x) => labels.includes(x)), JSON.stringify(labels))
  ok('同义词词内替换（妻子生日 → 老婆生日）', allLabels.includes('老婆生日') && !allLabels.some((n) => n.includes('妻子')), JSON.stringify(allLabels))
  ok('主题组 total 是真实计数（不被 12 截断）',
    buildEntityOverview(rows, { scope: 'personal' }).themes.some((g) => g.type === 'health' && g.total > 12 && g.items.length === 12),
    JSON.stringify(buildEntityOverview(rows, { scope: 'personal' }).themes.map((g) => [g.type, g.total, g.items.length])))
  ok('个人视图过滤话题概念（周末/室内游泳）', !labels.includes('周末') && !labels.includes('室内游泳'), JSON.stringify(labels))
  ok('城市/区县合并到更精确的地名（杭州滨江）', labels.includes('杭州滨江') && !labels.includes('杭州') && !labels.includes('滨江'), JSON.stringify(labels))
  ok('含「我」中心', ov.graph.nodes.some((n) => n.kind === 'me'))
  ok('去「的」重复合并', allLabels.filter((n) => n.includes('老婆') && n.includes('生日')).length === 1, JSON.stringify(allLabels))
  ok('差一字重复合并（靠过道座）', allLabels.filter((n) => n.startsWith('靠过道座')).length === 1, JSON.stringify(allLabels))
  ok('不同过敏原不合并（海鲜过敏 vs 半月板损伤）', labels.includes('海鲜过敏') && labels.includes('膝盖半月板损伤'))
  const me = ov.graph.nodes.find((n) => n.kind === 'me')
  const wife = ov.graph.nodes.find((n) => n.label === '老婆')
  ok('「我」连到人物', ov.graph.edges.some((e) => [e.source, e.target].includes(me.id) && [e.source, e.target].includes(wife.id)), JSON.stringify(ov.graph.edges))
  ok('人卡有老婆', ov.persons.some((p) => p.label === '老婆'), JSON.stringify(ov.persons))
  ok('主题组 health 含海鲜过敏', ov.themes.some((g) => g.type === 'health' && g.items.some((i) => i.label === '海鲜过敏')))
  ok('实体节点带来源记忆 id', (wife.rowIds ?? []).length > 0)
  ok('统计合理', ov.stats.total >= ov.stats.entities && ov.stats.entities > 0, JSON.stringify(ov.stats))
}

section('4. 项目视图')
{
  const ov = buildEntityOverview(rows, { scope: 'project' })
  const labels = ov.graph.nodes.filter((n) => n.kind !== 'me').map((n) => n.label)
  ok('含项目实体', labels.includes('jt-pa-memory'), JSON.stringify(labels))
  ok('不含生活实体', !labels.includes('老婆') && !labels.includes('海鲜过敏'), JSON.stringify(labels))
  ok('项目边存在', ov.graph.edges.some((e) => e.kind === 'project'), JSON.stringify(ov.graph.edges.map((e) => e.kind)))
}

section('5. 上限与展开')
{
  const ov = buildEntityOverview(rows, { scope: 'personal', limit: 5 })
  const ovAll = buildEntityOverview(rows, { scope: 'personal', limit: Infinity })
  ok('limit 生效', ov.graph.nodes.length <= 5, String(ov.graph.nodes.length))
  ok('人物在上限下仍保留', ov.graph.nodes.some((n) => n.label === '老婆'), JSON.stringify(ov.graph.nodes.map((n) => n.label)))
  ok('stats.total 反映全量', ov.stats.total === ovAll.stats.total, `${ov.stats.total} vs ${ovAll.stats.total}`)
  ok('偏离的边被裁掉', ov.graph.edges.every((e) => ov.graph.nodes.some((n) => n.id === e.source) && ov.graph.nodes.some((n) => n.id === e.target)))
}

section('6. 大库性能')
{
  const big = []
  for (let i = 0; i < 2000; i++) {
    big.push(row({
      level: i % 5 === 0 ? 'user' : 'fact',
      content: `记忆 ${i}`,
      keywords: [`人物${i % 80}`, `地点${i % 60}`, `事件${i % 50}`, `概念${i % 120}`, `物品${i % 70}`],
    }))
  }
  const t0 = Date.now()
  const ov = buildEntityOverview(big, { scope: 'personal', limit: 40 })
  const ms = Date.now() - t0
  ok('2000 行 < 500ms', ms < 500, `${ms}ms`)
  ok('上限生效（人物+40 以内）', ov.graph.nodes.length <= 41, String(ov.graph.nodes.length))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
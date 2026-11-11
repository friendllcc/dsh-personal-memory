/**
 * settings-page 测试：设置页的 i18n 接线（标签与字段文案跟随 DSH 语言设置）。
 *
 * 用 React 桩 + DOM 桩渲染一次真实组件树（createElement 形式，无需 JSX），覆盖：
 * 字段表键完整性、页面文案随语言切换、错误文案本地化、scope 双腿软取
 * （v0.3.0 起设置页内嵌记忆库面板，settings.section 槽注册已移除）。
 * 运行：node tests/settings-page.mjs
 */
import { build } from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'

// React 桩：组件只用到 createElement / useCallback / useSyncExternalStore /
// useState（渲染一次即可，不需要调度器）。渲染结果是一个普通对象树，直接断言。
const reactStub = `
export function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() }
}
export function useCallback(fn) { return fn }
export function useState(init) { return [init, () => {}] }
export function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() }
export const __stub = true
`

// 单一入口：settings-page 与 i18n 必须在同一 bundle 图里（两个实例的语言状态互不相通）。
const ENTRY = 'tests/_settings-page-entry.ts'
writeFileSync(
  ENTRY,
  [
    "export { acquireSettingsScope, MemorySettingsSection, parseSuppressWindows, serializeSuppressWindows } from '../src/settings-page.ts'",
    "export { setUiLocaleForTest, getUiLocale, t } from '../src/i18n/index.js'",
  ].join('\n'),
  'utf8',
)

let modUrl
try {
  const { outputFiles } = await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'react-stub',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-stub', namespace: 'stub' }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: reactStub, loader: 'js' }))
        },
      },
    ],
  })
  const code = new TextDecoder().decode(outputFiles[0].contents)
  modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
} finally {
  rmSync(ENTRY, { force: true })
}
const settings = await import(modUrl)

// v0.4.7 scoped 变体 bundle：banner 注入包名变量（对齐 build.mjs 真实 client 产物
// factory 头部的 var __DPM_PACKAGE_NAME__）——用它验证 0.1.7 腿的候选筛选能命中
// scoped 条目 id（@cmjt/dsh-personal-memory）也能回落旧名。
let scopedSettings
{
  writeFileSync(
    ENTRY,
    [
      "export { acquireSettingsScope, MemorySettingsSection, parseSuppressWindows, serializeSuppressWindows } from '../src/settings-page.ts'",
      "export { setUiLocaleForTest, getUiLocale, t } from '../src/i18n/index.js'",
    ].join('\n'),
    'utf8',
  )
  try {
    const { outputFiles } = await build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      banner: { js: 'var __DPM_PACKAGE_NAME__ = "@cmjt/dsh-personal-memory";' },
      plugins: [
        {
          name: 'react-stub',
          setup(build) {
            build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-stub', namespace: 'stub' }))
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: reactStub, loader: 'js' }))
          },
        },
      ],
    })
    const code = new TextDecoder().decode(outputFiles[0].contents)
    scopedSettings = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  } finally {
    rmSync(ENTRY, { force: true })
  }
}

// ── DOM 桩：CSS 注入与 render 期间的 window 访问 ─────────────────────────────
const head = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (el) => head.push(el) },
}
globalThis.window = { setTimeout: () => 1 }

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name} ${detail}`)
  }
}

/** 收集树里的所有字符串：子节点 + 字符串型 props（placeholder/title 等）。 */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  const props = node.props ?? {}
  const fromProps = Object.entries(props)
    .filter(([key, value]) => key !== 'children' && typeof value === 'string')
    .map(([, value]) => value)
  return [...fromProps, ...texts(props.children), ...texts(node.children ?? [])]
}

/** render 一次当前设置页（scope 桩：writable、有 user 层覆盖值）。 */
function renderPage() {
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { enabled: true, hitTopK: 5 }, user: { hitTopK: 5 }, base: {}, writable: true, mode: 'user' }),
    set: async () => {},
    unset: async () => {},
  }
  return settings.MemorySettingsSection({ scope })
}

// ── 1. 页面标题（v0.3.0 起 = 面板「设置」标签页内 H2，不再是宿主设置窗口分区名）──
console.log('=== 1. 页面标题随语言 ===')
settings.setUiLocaleForTest('zh')
check('zh 页面标题=设置（「个人记忆」名字已去掉）', texts(renderPage()).includes('设置'))
settings.setUiLocaleForTest('en')
check('en 页面标题=Settings', texts(renderPage()).includes('Settings'))
settings.setUiLocaleForTest('pt-br')
check('pt-br 页面标题=Configurações', texts(renderPage()).includes('Configurações'))

// ── 2. 页面文案随语言切换 ───────────────────────────────────────────────────
console.log('=== 2. 页面渲染文案 ===')
settings.setUiLocaleForTest('zh')
let page = texts(renderPage())
check('zh 页面标题', page.includes('设置'))
check('zh 分组标题', page.includes('基础') && page.includes('空闲整理（dream）') && page.includes('语言'))
check('zh 字段标签', page.includes('总开关') && page.includes('prompt 与检索语言'))
check('zh 徽章', page.includes('已覆盖') && page.includes('默认'))
// 回归（v0.4.1）：宿主 value 层缺席的键（raw===undefined，如宿主跑旧版不认识 semantic）
// 不得误标「已覆盖」——此桩里只有 hitTopK=5≠默认2 一个真覆盖。
check('zh 徽章数：缺席键不误标已覆盖（仅 hitTopK 一个）',
  page.filter((s) => s === '已覆盖').length === 1,
  `实得 ${page.filter((s) => s === '已覆盖').length}`)
check('zh 恢复默认按钮', page.includes('恢复默认'))
check('zh 占位符（字面量原样）', page.includes('.dsh-personal-memory'))
check('zh 占位符（i18n 键翻译）', page.includes('zh / en'))
// 回归防线：promptLang 只选模型文案包，设置页不得宣称内置 pt-br（src/prompts/ 只有 zh + en）。
check('zh 不宣称内置 pt-br 提示包', !page.some((s) => s.includes('内置巴西葡语')))
check('zh 说明界面语言由 DSH 决定', page.some((s) => s.includes('界面语言与它无关')))

settings.setUiLocaleForTest('en')
page = texts(renderPage())
check('en 页面标题', page.includes('Settings'))
check('en 分组标题', page.includes('Basics') && page.includes('Idle consolidation (dream)') && page.includes('Language'))
check('en 字段标签', page.includes('Master switch') && page.includes('Prompt and retrieval language'))
check('en 徽章', page.includes('Overridden') && page.includes('Default'))
check('en 恢复默认按钮', page.includes('Restore default'))
check('en 提示不宣称内置 pt-br', !page.some((s) => s.includes('built-in Brazilian Portuguese pack')))
check('en 说明界面语言由 DSH 决定', page.some((s) => s.includes('UI language is unrelated')))

settings.setUiLocaleForTest('pt-br')
page = texts(renderPage())
check('pt-br 页面标题', page.includes('Configurações'))
check('pt-br 分组标题', page.includes('Básico') && page.includes('Consolidação ociosa (dream)') && page.includes('Idioma'))
check('pt-br 字段标签', page.includes('Chave geral') && page.includes('Idioma dos prompts e da busca'))
check('pt-br 徽章', page.includes('Alterado') && page.includes('Padrão'))
check('pt-br 恢复默认按钮', page.includes('Restaurar padrão'))
check('pt-br 占位符', page.includes('ex.: zai-coding-cn/glm-5.3-flash'))
check('pt-br 提示不宣称内置 pt-br', !page.some((s) => s.includes('pacote português do Brasil embutido')))
check('pt-br 说明界面语言由 DSH 决定', page.some((s) => s.includes('idioma da interface não tem relação')))

// ── 3. 峰时解析错误文案本地化 ───────────────────────────────────────────────
console.log('=== 3. 峰时解析错误文案 ===')
settings.setUiLocaleForTest('zh')
check('zh 格式错误', settings.parseSuppressWindows('abc').error === '时段格式应为 "HH:MM-HH:MM"，收到 "abc"')
check('zh 空段错误', settings.parseSuppressWindows(',').error === '至少一个时段')
settings.setUiLocaleForTest('en')
check('en 格式错误', settings.parseSuppressWindows('abc').error === 'A window must look like "HH:MM-HH:MM"; got "abc"')
check('en 空段错误', settings.parseSuppressWindows(',').error === 'At least one window is required')
settings.setUiLocaleForTest('pt-br')
check('pt-br 格式错误', settings.parseSuppressWindows('abc').error === 'O intervalo deve ter o formato "HH:MM-HH:MM"; recebido "abc"')
check('解析成功路径不变', JSON.stringify(settings.parseSuppressWindows('09:00-12:00, 14:00-18:00').value) === JSON.stringify([{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]))
check('序列化不变', settings.serializeSuppressWindows([{ start: '09:00', end: '12:00' }]) === '09:00-12:00')

// ── 4. 双版本 scope 获取：0.1.6 settingsScope 腿 / 0.1.7 configForms 腿 ─────
// v0.3.0 起设置页内嵌记忆库面板：acquireSettingsScope 只做双腿软取 + 回调交付，
// 不碰 settings.section 槽。本节锁死：软取分腿、configForms 就绪前轮询等待、
// 双缺安全降级（onUnavailable 回调）、dispose 停止轮询。
console.log('=== 4. 双版本 scope 获取（settingsScope / configForms）===')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** ctx.get 形态的宿主桩（真实宿主两版都有 ctx.get；返回 undefined=服务缺席）。 */
function ctxWithGet(services) {
  return { get: (name) => services[name] }
}

/** configForms.get 产出的共享表单桩：0.1.7 ConfigForm 的形状（含 mode/revision）。 */
function makeFormStub() {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { enabled: true }, base: {}, user: {}, writable: true, revision: 3, mode: 'host' }),
    set: async () => true,
    unset: async () => true,
  }
}

// 4.1 0.1.6 腿（ctx.get 软取路线）：bind 的命名空间结果原样当 scope，同步回调。
{
  const bound = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, writable: true, mode: 'user' }), set: async () => {}, unset: async () => {} }
  const bindArgs = []
  const delivered = []
  const ctx = ctxWithGet({ settingsScope: { bind: (args) => { bindArgs.push(args); return bound } } })
  const disposeLeg = settings.acquireSettingsScope(ctx, (scope) => delivered.push(scope))
  check('0.1.6 腿同步交付 scope', delivered.length === 1, String(delivered.length))
  check('0.1.6 腿绑定 dsh-personal-memory 命名空间', bindArgs.length >= 1 && bindArgs[0].namespace === 'dsh-personal-memory', JSON.stringify(bindArgs))
  check('0.1.6 腿 scope=bind 结果', delivered[0] === bound)
  disposeLeg()
}

// 4.2 0.1.7 腿（configForms 就绪）：get(entryId) 表单直接当 scope，组件可渲染。
{
  const form = makeFormStub()
  const getCalls = []
  const delivered = []
  const ctx = ctxWithGet({ configForms: { get: (id) => { getCalls.push(id); return form } } })
  const disposeLeg = settings.acquireSettingsScope(ctx, (scope) => delivered.push(scope))
  check('0.1.7 腿交付 scope', delivered.length === 1, String(delivered.length))
  check('0.1.7 腿以命名空间取表单', getCalls.includes('dsh-personal-memory'), JSON.stringify(getCalls))
  check('0.1.7 腿 scope=configForms 表单', delivered[0] === form)
  const page0 = texts(settings.MemorySettingsSection({ scope: form }))
  check('0.1.7 形状快照可渲染（标题在场）', page0.includes('Settings') || page0.includes('设置') || page0.includes('Configurações'))
  disposeLeg()
}

// 4.3 双缺（异常宿主）：onScope 永不回调、轮询放弃后 onUnavailable 回调、dispose 安全。
{
  const delivered = []
  let unavailable = 0
  const ctx = ctxWithGet({})
  const disposeLeg = settings.acquireSettingsScope(ctx, (scope) => delivered.push(scope), { pollMs: 5, maxPollAttempts: 2, onUnavailable: () => { unavailable += 1 } })
  check('双缺不交付 scope', delivered.length === 0, String(delivered.length))
  check('双缺尚未亮不可用', unavailable === 0, String(unavailable))
  await sleep(40)
  check('双缺轮询放弃后亮不可用', unavailable === 1, String(unavailable))
  check('放弃后仍不交付 scope', delivered.length === 0, String(delivered.length))
  disposeLeg()
}

// 4.4 0.1.7 腿（configForms 迟到）：提供方晚于插件 apply 就绪，轮询等到即交付。
{
  const form = makeFormStub()
  let calls = 0
  const delivered = []
  const ctx = ctxWithGet({ get configForms() { calls += 1; return calls > 3 ? { get: () => form } : undefined } })
  const disposeLeg = settings.acquireSettingsScope(ctx, (scope) => delivered.push(scope), { pollMs: 5, maxPollAttempts: 200 })
  check('configForms 缺席期间不交付', delivered.length === 0, String(delivered.length))
  await sleep(60)
  check('configForms 就绪后轮询交付', delivered.length === 1 && delivered[0] === form, String(delivered.length))
  disposeLeg()
  await sleep(20)
  check('dispose 后不再重复交付', delivered.length === 1, String(delivered.length))
}

// 4.5 v0.4.7 scoped 安装：镜像 served 命中 @cmjt 条目 id（包名由 banner 注入）。
console.log('=== 4.5 scoped 安装：镜像筛选命中 @cmjt/dsh-personal-memory ===')
{
  /** 带镜像的 configForms 桩（0.1.7 ConfigForms 形状：get + describe→mirror face）。 */
  const mirrorForms = (servedNs) => {
    const getCalls = []
    return {
      getCalls,
      configForms: {
        get: (id) => { getCalls.push(id); return makeFormStub() },
        describe: () => ({
          getSnapshot: () => ({ status: 'ready', view: { namespaces: servedNs.map((ns) => ({ ns, revision: 1 })) } }),
          subscribe: () => () => {},
          ensure: () => Promise.resolve(),
        }),
      },
    }
  }
  const a = mirrorForms(['@cmjt/dsh-personal-memory', 'ui-settings-general'])
  const deliveredA = []
  const d1 = scopedSettings.acquireSettingsScope(ctxWithGet({ configForms: a.configForms }), (scope) => deliveredA.push(scope))
  check('scoped: 取 @cmjt 表单', a.getCalls.length === 1 && a.getCalls[0] === '@cmjt/dsh-personal-memory', JSON.stringify(a.getCalls))
  check('scoped: 交付 scope', deliveredA.length === 1, String(deliveredA.length))
  d1()

  // 4.6 同一 scoped 包在旧 link/tgz 环境：served 只有旧名 → 命中旧名（回归保护）。
  const b = mirrorForms(['dsh-personal-memory', 'ui-settings-general'])
  const deliveredB = []
  const d2 = scopedSettings.acquireSettingsScope(ctxWithGet({ configForms: b.configForms }), (scope) => deliveredB.push(scope))
  check('scoped 包下旧环境: 取旧名表单', b.getCalls.length === 1 && b.getCalls[0] === 'dsh-personal-memory', JSON.stringify(b.getCalls))
  d2()

  // 4.7 候选都不在场：不交付、不盲取，轮询放弃亮不可用。
  {
    const c = mirrorForms(['ui-settings-general'])
    const deliveredC = []
    let unavailable = 0
    const d3 = scopedSettings.acquireSettingsScope(ctxWithGet({ configForms: c.configForms }), (scope) => deliveredC.push(scope), { pollMs: 5, maxPollAttempts: 2, onUnavailable: () => { unavailable += 1 } })
    check('候选缺席不盲取表单', deliveredC.length === 0 && c.getCalls.length === 0, JSON.stringify(c.getCalls))
    await sleep(40)
    check('候选缺席轮询放弃亮不可用', unavailable === 1 && deliveredC.length === 0, `${unavailable}/${deliveredC.length}`)
    d3()
  }
}


// ── 5. 全局目录控件（homeDir）：预设 radio + 实际路径显示 + 自定义输入 ──────────
// 收集树里的 radio（type/checked），按渲染序=default/user-home/plugin-root/custom。
function collectRadios(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  const props = node.props ?? {}
  if (props.type === 'radio') out.push(props)
  for (const c of [].concat(props.children ?? [], node.children ?? [])) collectRadios(c, out)
  return out
}
function collectTextInputs(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  const props = node.props ?? {}
  if (props.type === 'text') out.push(props)
  for (const c of [].concat(props.children ?? [], node.children ?? [])) collectTextInputs(c, out)
  return out
}

function renderWithHomeDir(snapshotValue, base) {
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: snapshotValue, user: snapshotValue, base, writable: true, mode: 'user' }),
    set: async () => {},
    unset: async () => {},
  }
  return settings.MemorySettingsSection({ scope })
}

const PRESETS_BASE = {
  homeDirPresets: {
    default: String.raw`C:\dsh\storages\dsh-personal-memory`,
    'user-home': String.raw`C:\Users\meow\.dsh-personal-memory`,
    'plugin-root': String.raw`C:\plugins\dsh-personal-memory\storage`,
  },
}

console.log('=== 5. 全局目录控件 ===')
settings.setUiLocaleForTest('zh')
{
  // 缺省值：default radio 选中，三个预设显示实际路径
  const tree = renderWithHomeDir({ enabled: true }, PRESETS_BASE)
  const page = texts(tree)
  const radios = collectRadios(tree)
  check('homeDir: 渲染四个 radio', radios.length === 4, String(radios.length))
  check('homeDir: 缺省=default 选中', radios[0] !== undefined && radios[0].checked === true && radios.slice(1).every((r) => !r.checked))
  check('homeDir: 三预设显示实际落点', page.some((s) => s.includes(String.raw`C:\dsh\storages\dsh-personal-memory`)) && page.some((s) => s.includes(String.raw`C:\Users\meow\.dsh-personal-memory`)) && page.some((s) => s.includes(String.raw`C:\plugins\dsh-personal-memory\storage`)))
  check('homeDir: 自定义选项存在', page.includes('自定义路径'))
  check('homeDir: hint 带多实例提醒', page.some((s) => s.includes('多个 dsh 实例')))
  // 布局结构：每个预设的实际路径是独立次行节点（等宽小字类），不是挤在名称行里
  const pathNodes = (function collectPaths(n, out = []) {
    if (n === null || n === undefined || typeof n !== 'object') return out
    const p = n.props ?? {}
    if (p.className === 'meowmm_set_homedir_path') out.push(p)
    for (const c of [].concat(p.children ?? [], n.children ?? [])) collectPaths(c, out)
    return out
  })(tree)
  check('homeDir: 三条路径各自独立次行节点', pathNodes.length === 3, String(pathNodes.length))

  // 预设标记值：对应 radio 选中
  const tree2 = renderWithHomeDir({ enabled: true, homeDir: 'user-home' }, PRESETS_BASE)
  texts(tree2)
  const radios2 = collectRadios(tree2)
  check('homeDir: 预设标记选中对应 radio', radios2[1] !== undefined && radios2[1].checked === true && !radios2[0].checked && !radios2[3].checked)

  // 历史标记 'dsh-storage'（v0.4.5 前预设值）归一显示为 default 选中
  const tree2b = renderWithHomeDir({ enabled: true, homeDir: 'dsh-storage' }, PRESETS_BASE)
  const radios2b = collectRadios(tree2b)
  check('homeDir: 历史标记 dsh-storage 归一为 default 选中', radios2b[0] !== undefined && radios2b[0].checked === true && radios2b.slice(1).every((r) => !r.checked))

  // 自定义绝对路径：custom radio 选中 + 输入框回填路径值
  const tree3 = renderWithHomeDir({ enabled: true, homeDir: String.raw`D:\data\meow` }, PRESETS_BASE)
  texts(tree3)
  const radios3 = collectRadios(tree3)
  const textInputs = collectTextInputs(tree3)
  check('homeDir: 自定义值选中 custom radio', radios3[3] !== undefined && radios3[3].checked === true && radios3.slice(0, 3).every((r) => !r.checked))
  check('homeDir: 自定义路径回填输入框', textInputs.some((p) => p.value === String.raw`D:\data\meow`))

  // 只读镜像横幅：mode='memory'（非 loopback 连接）时页面顶部亮牌——写入会被客户端丢弃
  const treeMem = renderWithHomeDir({ enabled: true }, PRESETS_BASE)
  const pageMem = texts({ ...treeMem })
  check('mirror: host 模式无横幅', !pageMem.some((s) => s.includes('只读镜像')))
  function withMode(baseTree, mode) { return null }
  const memScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { enabled: true }, user: { enabled: true }, base: {}, writable: true, mode: 'memory' }),
    set: async () => {},
    unset: async () => {},
  }
  const pageMem2 = texts(settings.MemorySettingsSection({ scope: memScope }))
  check('mirror: memory 模式亮只读横幅', pageMem2.some((s) => s.includes('只读镜像')))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

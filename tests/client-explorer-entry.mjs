/**
 * client-explorer-entry 纯逻辑测试（v0.4.4 顶栏迁移）：startMemoryExplorer 的
 * 三槽注册语义 + 新老宿主双入口互斥 + 嵌入面板/图标组件形状。
 * - sidebar.panellist 注册：id/order/label（顶栏行，与 插件/自动化任务 同级）；
 * - main 注册：key 必须与 panellist id 一致（宿主 selectPanel(id) 的门禁，
 *   key 不一致 → 点击侧栏行时宿主抛错）；
 * - footer 兜底互斥：panellist 先/后物化两种时序下，footer 最终都不驻留
 *   （老宿主上 panellist 永不物化 → footer 保留）；
 * - MemoryPanelIcon：svg 形状随宿主给定的 size；
 * - MemoryPanelPage：MemoryExplorerPanel 的 embedded 形态。
 * 运行：node tests/client-explorer-entry.mjs（构建后；内部 esbuild 打包源码保证
 * 与 src 同步；react/react-dom 是宿主外部件，这里以 stub 顶替——只查形状不渲染）。
 */
import { build } from 'esbuild'

const REACT_STUB = `
export function createElement(type, props, ...children) { return { type, props: props ?? {}, children } }
export const useState = () => [undefined, () => {}]
export const useCallback = (fn) => fn
export const useEffect = () => {}
export const useMemo = (fn) => fn()
export const useRef = () => ({ current: null })
export const useSyncExternalStore = () => undefined
`
const REACT_DOM_STUB = `
export function createPortal(node) { return node }
`

const { outputFiles } = await build({
  entryPoints: ['src/client-memory-explorer.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  plugins: [{
    name: 'stub-host-react',
    setup(b) {
      b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({ path: args.path.startsWith('react-dom') ? 'react-dom-stub' : 'react-stub', namespace: 'stub-r' }))
      b.onLoad({ filter: /.*/, namespace: 'stub-r' }, (args) => ({ contents: args.path === 'react-stub' ? REACT_STUB : REACT_DOM_STUB, loader: 'js' }))
    },
  }],
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { startMemoryExplorer, MemoryPanelIcon, MemoryPanelPage } = await import(modUrl)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ── document stub：startMemoryExplorer 注入面板 CSS 用（style.dataset/head）──
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
  querySelectorAll: () => [],
  body: {},
}

/** slots 桩：inject 记工厂（run(name) 即「槽物化」），register 记注册与注销。 */
function makeSlots() {
  const factories = new Map()
  const registrations = []
  const disposed = []
  const slots = {
    inject(name, factory) { factories.set(name, factory); return () => { factories.delete(name) } },
    register(options, component) {
      const rec = { options, component }
      registrations.push(rec)
      return () => {
        disposed.push(rec.options.key ?? rec.options.id)
        const at = registrations.indexOf(rec)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
  }
  return {
    slots,
    registrations,
    disposed,
    run: (name) => {
      const factory = factories.get(name)
      if (factory === undefined) throw new Error(`slot not injected: ${name}`)
      return factory()
    },
  }
}

/** ctx 桩：settingsScope 走 0.1.6 腿（同步绑定，不开轮询定时器，测试不挂起）。 */
const makeCtx = () => ({ get: (name) => (name === 'settingsScope' ? { bind: () => ({}) } : undefined) })

// ── 场景 A（新宿主）：panellist/main 物化后 footer 不注册 ─────────────────────
{
  const env = makeSlots()
  startMemoryExplorer(makeCtx(), env.slots)
  env.run('sidebar.panellist')
  env.run('main')
  env.run('sidebar.footer.action')
  const panellist = env.registrations.find((r) => r.options.name === 'sidebar.panellist')
  const main = env.registrations.find((r) => r.options.name === 'main')
  check('A: panellist 注册（id/order/label thunk）', panellist !== undefined
    && panellist.options.id === 'dsh-personal-memory'
    && panellist.options.order === 20
    && typeof panellist.options.label === 'function'
    && typeof panellist.options.label() === 'string'
    && panellist.options.label().length > 0,
    JSON.stringify(panellist?.options))
  check('A: main 注册（key 与 panellist id 一致——selectPanel 门禁）', main !== undefined
    && main.options.key === 'dsh-personal-memory'
    && main.options.key === panellist?.options.id,
    JSON.stringify(main?.options))
  check('A: main 面板组件是 MemoryPanelPage（embedded 形态）', main?.component === MemoryPanelPage)
  check('A: footer 不注册（panellist 已物化，无双入口）',
    env.registrations.filter((r) => r.options.name === 'sidebar.footer.action').length === 0,
    JSON.stringify(env.registrations.map((r) => r.options.name)))
}

// ── 场景 B（老宿主）：panellist 永不物化 → footer 兜底保留 ───────────────────
{
  const env = makeSlots()
  startMemoryExplorer(makeCtx(), env.slots)
  env.run('sidebar.footer.action')
  const footer = env.registrations.find((r) => r.options.name === 'sidebar.footer.action')
  check('B: 老宿主 footer 兜底注册（order 80 + MemoryExplorerEntry 浮层）', footer !== undefined
    && footer.options.order === 80
    && typeof footer.component === 'function',
    JSON.stringify(footer?.options))
}

// ── 场景 C（时序倒置）：footer 先物化，panellist 后到 → footer 被撤 ──────────
{
  const env = makeSlots()
  startMemoryExplorer(makeCtx(), env.slots)
  env.run('sidebar.footer.action')
  check('C: 前置——footer 已注册', env.registrations.some((r) => r.options.name === 'sidebar.footer.action'))
  env.run('sidebar.panellist')
  env.run('main')
  check('C: panellist 物化后 footer 撤销（只剩 panellist+main）',
    env.registrations.length === 2
    && env.registrations.every((r) => r.options.name === 'main' || r.options.name === 'sidebar.panellist'),
    JSON.stringify(env.registrations.map((r) => r.options.name)))
}

// ── 组件形状：图标随宿主 size；主列面板为 embedded ───────────────────────────
{
  const icon = MemoryPanelIcon({ size: 16 })
  check('icon: svg 形状随宿主给定 size', icon.type === 'svg'
    && icon.props.width === 16 && icon.props.height === 16
    && icon.children[0]?.type === 'path' && typeof icon.children[0]?.props.d === 'string',
    JSON.stringify({ type: icon.type, w: icon.props.width }))
  const fallback = MemoryPanelIcon({})
  check('icon: size 缺省兜底 18（窄栏 18/宽栏 16 均由宿主传）', fallback.props.width === 18 && fallback.props.height === 18)
  const page = MemoryPanelPage()
  check('page: MemoryExplorerPanel 的 embedded 形态（无背板无关闭）', typeof page.type === 'function'
    && page.props.embedded === true,
    JSON.stringify({ embedded: page.props?.embedded }))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

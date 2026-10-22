/**
 * dsh-personal-memory — UI 语言切换的重放注册表（client 端，v0.27.0）。
 *
 * 为什么需要：插件的大部分界面不是 React 渲染的，而是纯 DOM 原位插入（折叠横条、
 * 打点气泡、会话菜单项）。那些节点只在「应用一次」时写入文本，语言切换（DSH
 * 设置 → 通用 → 语言）不会自动重放它们。
 *
 * 机制：各管理器把自己的「用当前语言重放可见 UI」函数注册进来；i18n 层的
 * onUiLocaleChange 触发时统一调用一遍。要求重放函数幂等——与 MutationObserver
 * 自愈同款纪律（只写差异值，不重建节点），所以重放不会自我循环。
 *
 * React 渲染的部分（设置页）不走这里：它订阅 i18n 后自然重渲染。
 */

import { onUiLocaleChange } from './i18n/index.js'

/** 测试接点：界面语言（生产代码读 DSH locale 服务）。 */
export { setUiLocaleForTest, getUiLocale } from './i18n/index.js'

const replayers = new Set<() => void>()

/**
 * 注册一个重放函数（挂载时调用一次，返回注销函数）。
 * @param fn - 幂等重放：用当前语言刷新自有 DOM 节点的文本。
 * @returns 注销函数（与其它 disposer 一起在插件卸载时调用）。
 */
export function registerUiReplayer(fn: () => void): () => void {
  replayers.add(fn)
  return () => {
    replayers.delete(fn)
  }
}

/** 语言变化后重放全部已注册的可见 UI（单个失败不阻断其它）。 */
export function replayUiForLocale(): void {
  for (const fn of [...replayers]) {
    try {
      fn()
    } catch (error) {
      console.error('[dsh-personal-memory] UI 语言重放失败：', error)
    }
  }
}

// 折叠横条 / 打点气泡 / 会话菜单项的文案都是「应用一次」写入 DOM 的，没有各自的
// 订阅点可挂——统一在这里挂一条 i18n 订阅：语言一变就把已注册的重放函数跑一遍。
// 重放函数幂等且读模块内最新状态（同 MutationObserver 自愈通道），所以后挂的
// 管理器在语言切换时也会被刷新。
onUiLocaleChange(() => {
  replayUiForLocale()
})

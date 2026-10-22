# UI language layer / 界面文案层

dsh-personal-memory 的界面文案（v0.27.0+）与模型文案分家：

| 层 | 文件 | 选谁的语言 | 作用对象 |
|---|---|---|---|
| **UI/UX**（本层） | `src/i18n/*.ts` | **DSH 语言设置**（设置 → 通用 → 语言） | 用户看到的横条、气泡、菜单、设置页 |
| prompt（模型文案） | `src/prompts/<lang>/` | `promptLang` 配置 | 注入/反思/dream 文案、工具描述 |

两层互不影响：界面可以跟随外壳切成英文/葡语，而注入给模型的 prompt 仍按 `promptLang` 走（详见 [`src/prompts/README.md`](../prompts/README.md)）。

## 跟随 DSH 语言设置 / Following the DSH locale

DSH 0.1.5+ 的 locale 服务（`@deepseek-ai/dsh-client-locale`）是界面语言的唯一真源。
`installI18n(ctx)`（`client.ts` 的 apply 入口第一件事）会：

1. `ctx.get('locale')` 探测服务（**不写进 `inject`**——写进去会让插件在无 locale 的
   老宿主 / 受限动态包上整体挂起）；
2. `ctx.locale.addLanguage({ id: 'pt-br', label: 'Português (Brasil)', fallback: 'en' })`
   把本插件新增的语言挂进「设置 → 通用 → 语言」；
3. `ctx.locale.register('dsh-personal-memory', '<lang>', 字典)` 注册每种语言的字典
   （zh / en 是宿主内置语言，只注册字典、不重复声明目录项）；
4. `ctx.locale.subscribe` 订阅切换，`onUiLocaleChange` 广播给 UI。

查表走 DSH 自己的 fallback 链：`pt-br` 缺键自动落 `en`，绝不出现空串或键名。
设置页标签按官方契约**在语言切换时重新注册**（外壳不订阅 locale 状态）。

**无 locale 服务时**（老宿主 / 动态包）自动降级：用 `navigator.languages` 判定，
再走内置静态查表（`zh → en` 兜底），最后落 `zh`（插件历史默认语言，行为逐字不变）。

## 加一门语言 / Adding a language

界面文案加一门语言 = **两个文件改动**，不动 UI 代码：

1. 加字典文件 `src/i18n/<lang>.ts`，复制 `en.ts` 的键、翻译值
   （`{name}` 占位符保持原样；键集必须与 `en.ts` 一致——`Record<UiKey, string>`
   类型 + `npm test` 会同时卡住缺键和多余键）；
2. 在 `src/i18n/core.ts` 的 `SUPPORTED_UI_LOCALES` 加一行 `{ id: '<lang>', label: '<自称>' }`，
   并在 `DICTS` 与 `FALLBACK_CHAIN` 各加一项。

`fallback` 必须已经注册且链路最终落在 `en`（DSH 的硬约束）——所以新增语言一律
声明 `fallback: 'en'`。

纯 DOM 节点（折叠横条 / 打点气泡 / 会话菜单项）不随 React 重渲染更新：各管理器用
`registerUiReplayer()` 注册幂等重放函数，语言切换时统一重放（见
`src/client-i18n-replay.ts`）。React 渲染的部分（设置页）订阅 `onUiLocaleChange`
后自然重渲染。

## 自查 / Checks

- `node tests/client-i18n.mjs`：三语字典键集/占位符一致、语言解析、DSH 服务接线
  （语言与字典注册、fallback 链、切换广播、重复 install 幂等、服务异常降级）；
- `node tests/settings-page.mjs`：设置页标签随语言重注册 + 页面文案随语言切换。

/**
 * dsh-personal-memory — 个人记忆库面板（client 端，仿 mneme/dsh-personal-memory 的
 * 展示壳：入口按钮 + 全屏面板）。
 *
 * v0.3.3 五标签结构：
 * - 总览：画像文档（soul/user 可读全文）+ 七层分布 + 高频关键词云 + 最常命中/
 *   最近新增榜单 + 记忆体检（已过时/久未命中，一键归档）；
 * - 时间线：按创建日分组（AI 一天天记住了什么），点卡跳进管理页定位；
 * - 记忆管理：分门别类（七层 chips）+ 状态/项目/排序/服务端检索，支持新增/
 *   编辑/删除（host 写路由 /dsh-personal-memory/api/memory 的 POST/PATCH/DELETE）；
 * - 关系网：以「我」为中心的知识图谱——跳数控制、双击节点重聚焦、图例点击
 *   开关分类、滚轮缩放/背景平移/节点拖拽，点节点右侧抽屉列出关联记忆；
 * - 设置：原 dsh 设置窗口的「个人记忆」分区内嵌（settings-page.ts 的
 *   MemorySettingsSection + acquireSettingsScope 双腿软取 scope）。
 *
 * 数据流：rows = 管理页工作集（层级过滤/分页），allRows = 全量缓存（总览/时间线/
 * 关系网/体检的数据源）——手动点标签回该标签默认完整视图，跨标签跳转
 * （openInManage/goManage*）才是带过滤的编程导航（v0.3.3 修复「牵一发而动全身」）。
 *
 * 面板经 react-dom createPortal 挂到 body：根节点必须是 .meow-explorer-overlay
 * （position:fixed 全屏背板）——sheet 自身无定位，直接挂 body 会被画在应用
 * 末尾、视口之外（v0.2.0「点击没反应」回归的根因）。
 *
 * 纯计算（图谱构建/布局/过滤/摘要/相对时间/体检/时间线分组）在
 * client-memory-graph.ts——那一层无 react/DOM 依赖可单测；本文件只做 React 组装。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { onUiLocaleChange, t } from './i18n/index.js'
import {
  cardSnippet,
  cardTitle,
  CATEGORY_COLORS,
  CATEGORY_ORDER,
  categoryLabel,
  computeGraphLayout,
  EXPLORER_LEVELS,
  filterGraphByDepth,
  filterRows,
  formatWhen,
  hygieneRows,
  LEVEL_COLORS,
  levelHasProject,
  levelLabel,
  nodeCategory,
  nodeDepths,
  PROJECT_GLOBAL_KEY,
  PROJECT_UNSET_KEY,
  rowProjectLabel,
  rowsForEdge,
  rowsForNode,
  sortRows,
  timelineGroups,
  topKeywords,
  type ExplorerRow,
  type ExplorerStats,
  type GraphCategory,
  type GraphEdge,
  type GraphNode,
  type MemoryGraph,
  type RowFilter,
  type SortMode,
} from './client-memory-graph.ts'
import { acquireSettingsScope, injectSettingsCss, MemorySettingsSection } from './settings-page.ts'

/** 面板 API 基址（host 端 tryRegisterDreamRoutes 注册的六个路由）。 */
const API_BASE = '/dsh-personal-memory/api'

const BOOK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>'

const EXPLORER_CSS = `
.meow-explorer-entry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9));
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  opacity: .92;
  width: 100%;
  text-align: left;
}
.meow-explorer-entry:hover { background: rgba(127,127,127,.12); opacity: 1; }
.meow-explorer-entry svg { flex: none; }
.meow-explorer-overlay {
  position: fixed;
  inset: 0;
  z-index: 9990;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,.5);
}
.meow-explorer-sheet {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1080px, 94vw);
  height: min(760px, 90vh);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  border-radius: 14px;
  /* --dsw-alias-bg-layer-1 是宿主主题的高层面板底色（亮/暗双主题都有定义）；
     旧名 --dsw-alias-bg-surface 在宿主不存在，会在亮色主题下跌回深色兜底盘，
     与主题感知的深色文字叠成「深底黑字」。 */
  background: var(--dsw-alias-bg-layer-1, #232329);
  color: var(--dsw-alias-label-primary, rgba(235,235,235,.95));
  box-shadow: 0 18px 60px rgba(0,0,0,.5);
  overflow: hidden;
}
.meow-explorer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(127,127,127,.18);
  flex: none;
}
.meow-explorer-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.meow-explorer-head .meow-explorer-total { font-size: 12px; opacity: .7; }
.meow-explorer-head .meow-explorer-home { font-size: 11px; opacity: .55; margin-left: auto; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
.meow-explorer-btn {
  border: 1px solid rgba(127,127,127,.25);
  border-radius: 7px;
  background: rgba(127,127,127,.08);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}
.meow-explorer-btn:hover { background: rgba(127,127,127,.18); }
.meow-explorer-btn[data-active="true"] { background: rgba(110,168,254,.25); border-color: rgba(110,168,254,.5); }
.meow-explorer-btn[data-primary="true"] { background: rgba(110,168,254,.3); border-color: rgba(110,168,254,.6); }
.meow-explorer-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(127,127,127,.14);
  flex: none;
}
.meow-explorer-tab {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  padding: 9px 14px;
  cursor: pointer;
  opacity: .65;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.meow-explorer-tab:hover { opacity: .9; }
.meow-explorer-tab[data-active="true"] { opacity: 1; border-bottom-color: #6ea8fe; font-weight: 600; }
.meow-explorer-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(127,127,127,.14);
  flex: none;
}
.meow-explorer-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(127,127,127,.25);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
}
.meow-explorer-chip[data-active="true"] { background: rgba(110,168,254,.22); border-color: rgba(110,168,254,.55); }
.meow-explorer-chip .meow-explorer-count { opacity: .6; font-size: 11px; }
.meow-explorer-chip-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.meow-explorer-toolbar .meow-explorer-spacer { flex: 1; }
.meow-explorer-toolbar select, .meow-explorer-toolbar input {
  border: 1px solid rgba(127,127,127,.25);
  border-radius: 7px;
  background: rgba(127,127,127,.08);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
}
.meow-explorer-toolbar input { width: 200px; }
.meow-explorer-toolbar .meow-explorer-hint { font-size: 11px; opacity: .5; }
.meow-explorer-body { flex: 1; overflow: auto; padding: 14px 16px; }
.meow-explorer-body[data-view="graph"] { overflow: hidden; display: flex; flex-direction: column; }
.meow-explorer-status { padding: 28px 16px; text-align: center; font-size: 13px; opacity: .75; }
.meow-explorer-feedback { flex: none; padding: 6px 16px 0; font-size: 12px; }
.meow-explorer-feedback[data-kind="ok"] { color: #34d399; }
.meow-explorer-feedback[data-kind="err"] { color: #f43f5e; }
.meow-explorer-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.meow-explorer-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid rgba(127,127,127,.16);
  border-radius: 10px;
  background: rgba(127,127,127,.05);
  padding: 10px 12px;
}
.meow-explorer-card:hover { border-color: rgba(127,127,127,.3); }
.meow-explorer-card-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.meow-explorer-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  color: #111;
  border-radius: 5px;
  padding: 1px 6px;
  letter-spacing: .2px;
}
.meow-explorer-card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.meow-explorer-card-snippet {
  font-size: 12px;
  line-height: 1.6;
  opacity: .82;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.meow-explorer-card[data-expanded="true"] .meow-explorer-card-snippet {
  display: block;
  -webkit-line-clamp: unset;
  white-space: pre-wrap;
  word-break: break-word;
}
.meow-explorer-card-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; opacity: .6; margin-top: auto; }
.meow-explorer-card-meta .meow-explorer-meta-item { display: inline-flex; gap: 3px; align-items: center; }
.meow-explorer-card-actions { display: flex; gap: 6px; }
.meow-explorer-mini-btn {
  border: 1px solid rgba(127,127,127,.25);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  opacity: .8;
}
.meow-explorer-mini-btn:hover { opacity: 1; background: rgba(127,127,127,.12); }
.meow-explorer-mini-btn[data-danger="true"] { color: #e57373; border-color: rgba(229,115,115,.4); }
.meow-explorer-editor { display: flex; flex-direction: column; gap: 8px; }
.meow-explorer-editor label { font-size: 11px; opacity: .65; display: flex; flex-direction: column; gap: 3px; }
.meow-explorer-editor input, .meow-explorer-editor textarea, .meow-explorer-editor select {
  border: 1px solid rgba(127,127,127,.3);
  border-radius: 7px;
  background: rgba(127,127,127,.07);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
}
.meow-explorer-editor textarea { min-height: 88px; resize: vertical; line-height: 1.55; }
.meow-explorer-editor-row { display: flex; gap: 8px; }
.meow-explorer-editor-row > label { flex: 1; }
.meow-explorer-editor-actions { display: flex; gap: 8px; justify-content: flex-end; }
.meow-explorer-addwrap {
  border: 1px dashed rgba(127,127,127,.35);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.meow-explorer-graphwrap { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 8px; }
.meow-explorer-graph { width: 100%; height: 100%; cursor: grab; }
.meow-explorer-graph[data-panning="true"] { cursor: grabbing; }
.meow-explorer-graph text {
  fill: var(--dsw-alias-label-primary, rgba(235,235,235,.9));
  font-size: 10px;
  pointer-events: none;
  /* 文字描边光晕：压在连线上也可读（描边色=面板底色） */
  paint-order: stroke;
  stroke: var(--dsw-alias-bg-layer-1, #232329);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.meow-explorer-graph .meow-explorer-gnode { cursor: pointer; transition: opacity .15s ease; }
.meow-explorer-graph line { transition: opacity .15s ease; }
.meow-explorer-graph .meow-explorer-gnode:hover circle, .meow-explorer-graph .meow-explorer-gnode:hover rect { stroke-width: 2.5; }
/* 边热区悬停提亮可视线（CSS 优先级高于 presentation attribute，无需 !important） */
.meow-explorer-graph .meow-explorer-gedge:hover .meow-explorer-gedge-line { stroke: rgba(110,168,254,.85); }
.meow-explorer-graphbar {
  flex: none;
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
  padding: 8px 12px 0;
}
.meow-explorer-graphbar .meow-explorer-spacer { flex: 1; }
.meow-explorer-graphbar-label { font-size: 11px; opacity: .55; margin-right: 2px; }
.meow-explorer-graphbar .meow-explorer-chip { padding: 2px 10px; font-size: 11px; }
/* 状态降噪：陈旧/归档卡片降透明度（管理标签页） */
.meow-explorer-card[data-status="stale"] { opacity: .72; }
.meow-explorer-card[data-status="archived"] { opacity: .55; }
/* 总览首页 */
.meow-explorer-overview { padding: 4px 16px 18px; }
.meow-explorer-sec-title { margin: 16px 2px 8px; font-size: 12px; font-weight: 600; opacity: .75; }
.meow-explorer-sec-title:first-child { margin-top: 6px; }
.meow-explorer-doc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
.meow-explorer-doc-item {
  border: 1px solid rgba(127,127,127,.16);
  border-radius: 9px;
  padding: 10px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.meow-explorer-doc-item:hover { border-color: rgba(110,168,254,.5); }
.meow-explorer-doc-title { font-size: 12.5px; font-weight: 600; }
.meow-explorer-doc-content { font-size: 12px; line-height: 1.6; opacity: .88; white-space: pre-wrap; }
.meow-explorer-distbar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin: 0 2px; }
.meow-explorer-distbar > span { display: block; min-width: 2px; cursor: pointer; }
.meow-explorer-distchips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.meow-explorer-cloud { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; padding: 4px 2px; }
.meow-explorer-cloud-word { cursor: pointer; transition: opacity .15s ease; }
.meow-explorer-cloud-word:hover { opacity: 1 !important; text-decoration: underline; }
.meow-explorer-overview-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.meow-explorer-overview-cols .meow-explorer-dcard { cursor: pointer; }
.meow-explorer-legend {
  flex: none;
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 6px 16px;
  border-top: 1px solid rgba(127,127,127,.14);
  font-size: 11px;
  opacity: .8;
}
.meow-explorer-legend .meow-explorer-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 6px;
}
button.meow-explorer-legend-item { cursor: pointer; }
button.meow-explorer-legend-item:hover { background: rgba(127,127,127,.14); }
.meow-explorer-legend-item[data-off="true"] { opacity: .35; }
.meow-explorer-legend-item[data-off="true"] .meow-explorer-legend-text { text-decoration: line-through; }
/* 时间线标签页：左侧蓝色轨道 + 圆点，按创建日分组 */
.meow-explorer-timeline { padding: 4px 16px 18px; display: flex; flex-direction: column; gap: 2px; }
.meow-explorer-timeline-day {
  border-left: 2px solid rgba(110,168,254,.35);
  padding: 0 0 8px 12px;
  margin-left: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.meow-explorer-timeline-day .meow-explorer-sec-title { margin-top: 10px; position: relative; }
.meow-explorer-timeline-day .meow-explorer-sec-title::before {
  content: '';
  position: absolute;
  left: -19px;
  top: 3.5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(110,168,254,.7);
}
.meow-explorer-timeline-day .meow-explorer-sec-title .meow-explorer-drawer-count { margin-left: 6px; }
.meow-explorer-more { margin: 12px auto; display: block; }
.meow-explorer-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(360px, 46%);
  background: var(--dsw-alias-bg-layer-1, #232329);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  box-shadow: -12px 0 32px rgba(0,0,0,.35);
  display: flex;
  flex-direction: column;
  z-index: 2;
}
.meow-explorer-drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(127,127,127,.14);
  flex: none;
}
.meow-explorer-drawer-head h3 { margin: 0; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meow-explorer-drawer-count { font-size: 11px; opacity: .55; flex: none; }
.meow-explorer-drawer-body { flex: 1; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.meow-explorer-dcard {
  border: 1px solid rgba(127,127,127,.16);
  border-radius: 9px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}
.meow-explorer-dcard:hover { border-color: rgba(110,168,254,.5); }
.meow-explorer-dcard-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.meow-explorer-dcard-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meow-explorer-dcard-snippet {
  font-size: 11.5px;
  opacity: .78;
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.meow-explorer-dcard-meta { font-size: 10.5px; opacity: .55; }
`

/** fetch JSON（!ok 抛错；路由缺席/宿主旧版本时抛到面板的 error 态）。 */
async function apiFetch<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 120)}`}`)
  }
  return await response.json() as T
}

/** 写请求（POST/PATCH/DELETE）：JSON body；!ok 或 ok:false 都抛错（吞掉服务端
 *  error 字段文案，往调用方的 feedback 行送）。 */
async function apiSend(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text().catch(() => '')
  let parsed: { ok?: boolean; error?: string } = {}
  try { parsed = JSON.parse(text) as { ok?: boolean; error?: string } } catch { /* 非 JSON 响应：按状态码判断 */ }
  if (!response.ok || parsed.ok === false) {
    throw new Error(parsed.error ?? `HTTP ${response.status}`)
  }
}

// ── 记忆编辑/新增表单（管理标签页共用）────────────────────────────────────────

/** 表单草稿：keywords 用逗号分隔文本编辑，保存时才拆成数组。 */
interface MemoryDraft {
  level: string
  title: string
  content: string
  keywords: string
  project: string
  importance: number
}

function draftFromRow(row: ExplorerRow): MemoryDraft {
  return {
    level: row.level,
    title: row.title ?? '',
    content: row.content,
    keywords: row.keywords.join(', '),
    project: row.project ?? '',
    importance: row.importance,
  }
}

const EMPTY_DRAFT: MemoryDraft = { level: 'fact', title: '', content: '', keywords: '', project: '', importance: 1 }

function splitKeywords(text: string): string[] {
  return text.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 20)
}

interface EditorProps {
  /** 给定 = 编辑既有记忆（层级锁定，不能跨表搬）；缺省 = 新增。 */
  initial?: ExplorerRow
  busy: boolean
  onSave: (draft: MemoryDraft) => void
  onCancel: () => void
}

function MemoryEditor({ initial, busy, onSave, onCancel }: EditorProps) {
  const [draft, setDraft] = useState<MemoryDraft>(() => (initial === undefined ? { ...EMPTY_DRAFT } : draftFromRow(initial)))
  const set = (patch: Partial<MemoryDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const editing = initial !== undefined
  return createElement('div', { className: 'meow-explorer-editor' },
    createElement('div', { className: 'meow-explorer-editor-row' },
      createElement('label', null, t('explorer.form.level'),
        createElement('select', {
          value: draft.level,
          disabled: editing || busy,
          onChange: (e: { target: { value: string } }) => set({ level: e.target.value }),
        },
          EXPLORER_LEVELS.map((level) => createElement('option', { key: level, value: level }, levelLabel(level))),
        ),
      ),
      createElement('label', null, t('explorer.form.importance'),
        createElement('select', {
          value: String(draft.importance),
          disabled: busy,
          onChange: (e: { target: { value: string } }) => set({ importance: Number(e.target.value) }),
        },
          [1, 2, 3, 4, 5].map((n) => createElement('option', { key: n, value: String(n) }, `${n}${n >= 3 ? ' ' + '★'.repeat(n) : ''}`)),
        ),
      ),
    ),
    createElement('label', null, t('explorer.form.title'),
      createElement('input', {
        type: 'text', value: draft.title, disabled: busy,
        onChange: (e: { target: { value: string } }) => set({ title: e.target.value }),
      }),
    ),
    createElement('label', null, t('explorer.form.content'),
      createElement('textarea', {
        value: draft.content, disabled: busy,
        onChange: (e: { target: { value: string } }) => set({ content: e.target.value }),
      }),
    ),
    createElement('div', { className: 'meow-explorer-editor-row' },
      createElement('label', null, t('explorer.form.keywords'),
        createElement('input', {
          type: 'text', value: draft.keywords, disabled: busy,
          onChange: (e: { target: { value: string } }) => set({ keywords: e.target.value }),
        }),
      ),
      levelHasProject(draft.level)
        ? createElement('label', null, t('explorer.form.project'),
          createElement('input', {
            type: 'text', value: draft.project, disabled: busy,
            onChange: (e: { target: { value: string } }) => set({ project: e.target.value }),
          }),
        )
        : null,
    ),
    createElement('div', { className: 'meow-explorer-editor-actions' },
      createElement('button', { className: 'meow-explorer-btn', disabled: busy, onClick: onCancel }, t('explorer.cancel')),
      createElement('button', {
        className: 'meow-explorer-btn',
        'data-primary': 'true',
        disabled: busy || draft.content.trim() === '',
        title: draft.content.trim() === '' ? t('explorer.form.contentRequired') : undefined,
        onClick: () => onSave(draft),
      }, t('explorer.save')),
    ),
  )
}

// ── 记忆卡片（管理标签页）────────────────────────────────────────────────────

interface CardProps {
  row: ExplorerRow
  expanded: boolean
  editing: boolean
  confirmingDelete: boolean
  busy: boolean
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onDeleteAsk: (id: string) => void
  onDeleteConfirm: (row: ExplorerRow) => void
  onSaveEdit: (row: ExplorerRow, draft: MemoryDraft) => void
  onCancelEdit: () => void
}

function MemoryCard(props: CardProps) {
  const { row } = props
  const color = LEVEL_COLORS[row.level] ?? '#9e9e9e'
  if (props.editing) {
    return createElement('div', { className: 'meow-explorer-card', 'data-expanded': 'true', 'data-level': row.level },
      createElement('div', { className: 'meow-explorer-card-head' },
        createElement('span', { className: 'meow-explorer-badge', style: { background: color } }, levelLabel(row.level)),
        createElement('span', { className: 'meow-explorer-card-title', title: cardTitle(row) }, cardTitle(row)),
      ),
      createElement(MemoryEditor, {
        initial: row, busy: props.busy,
        onSave: (draft: MemoryDraft) => props.onSaveEdit(row, draft),
        onCancel: props.onCancelEdit,
      }),
    )
  }
  const meta: string[] = [formatWhen(row.updated_at), t('explorer.hits', { n: row.hit_count })]
  if (row.importance >= 3) meta.unshift('★'.repeat(Math.min(row.importance, 5)))
  if (row.level === 'lesson' && row.corrected === 1) meta.unshift('✔')
  if (row.status === 'stale') meta.push(t('explorer.status.stale'))
  else if (row.status === 'archived') meta.push(t('explorer.status.archived'))
  const project = rowProjectLabel(row.project)
  return createElement('div', {
    className: 'meow-explorer-card',
    'data-expanded': props.expanded ? 'true' : 'false',
    'data-level': row.level,
    'data-status': row.status,
  },
    createElement('div', { className: 'meow-explorer-card-head' },
      createElement('span', { className: 'meow-explorer-badge', style: { background: color } }, levelLabel(row.level)),
      createElement('span', { className: 'meow-explorer-card-title', title: cardTitle(row) }, cardTitle(row)),
    ),
    createElement('div', { className: 'meow-explorer-card-snippet', onClick: () => props.onToggle(row.id) },
      props.expanded ? row.content : cardSnippet(row),
    ),
    createElement('div', { className: 'meow-explorer-card-meta' },
      createElement('span', { className: 'meow-explorer-meta-item' }, project),
      ...meta.map((text, i) => createElement('span', { key: i, className: 'meow-explorer-meta-item' }, text)),
    ),
    createElement('div', { className: 'meow-explorer-card-actions' },
      createElement('button', {
        className: 'meow-explorer-mini-btn', disabled: props.busy,
        onClick: () => props.onEdit(row.id),
      }, t('explorer.edit')),
      props.confirmingDelete
        ? createElement('button', {
          className: 'meow-explorer-mini-btn', 'data-danger': 'true', disabled: props.busy,
          onClick: () => props.onDeleteConfirm(row),
        }, t('explorer.deleteConfirm'))
        : createElement('button', {
          className: 'meow-explorer-mini-btn', disabled: props.busy,
          onClick: () => props.onDeleteAsk(row.id),
        }, t('explorer.delete')),
    ),
  )
}

// ── 关系网（以人为中心的 SVG 图谱 + 关联记忆抽屉）─────────────────────────────

interface GraphProps {
  /** 已按跳数/分类过滤好的子图（panel 里算好传进来，布局只画它）。 */
  graph: MemoryGraph
  /** 钉在画布中心的节点（默认「我」，双击重聚焦后是聚焦节点）。 */
  rootId: string | null
  selectedId: string | null
  /** 当前在抽屉里展开的边（高亮描边；null=没有）。 */
  selectedEdge: GraphEdge | null
  /** 外部「重置视图」信号：数值变化即复位缩放/平移/手拖位置。 */
  viewResetSeq: number
  onNodeClick: (node: GraphNode) => void
  onNodeDoubleClick: (node: GraphNode) => void
  onEdgeClick: (edge: GraphEdge) => void
  onBackgroundDoubleClick: () => void
}

/** 边配色（按语义类型；悬停/选中触碰的边统一亮蓝）。 */
const EDGE_COLORS = {
  mine: 'rgba(110,168,254,.30)',
  project: 'rgba(62,198,160,.32)',
  cooc: 'rgba(160,170,190,.26)',
  relation: 'rgba(110,168,254,.34)',
} as const

/** 边类型的短文案（边 tooltip / 关系详情抽屉副标题）。 */
function edgeKindLabel(kind: GraphEdge['kind'], relationType?: string): string {
  if (kind === 'relation') return relationType ?? t('explorer.graph.edge.relation')
  return t(kind === 'mine' ? 'explorer.graph.edge.mine' : kind === 'project' ? 'explorer.graph.edge.project' : 'explorer.graph.edge.cooc')
}

/** 同一条边的判定（图重建/别名折叠后边对象身份变了，方向也可能翻转）。 */
function sameEdge(x: GraphEdge, y: GraphEdge): boolean {
  return x.kind === y.kind
    && ((x.source === y.source && x.target === y.target) || (x.source === y.target && x.target === y.source))
}

/** 节点悬停提示（v0.4.0 富化）：名称 · 分类 · 记忆数 · 累计命中 · 最近更新。 */
function nodeTip(node: GraphNode): string {
  const parts = [node.label]
  if (node.kind !== 'me') parts.push(categoryLabel(nodeCategory(node)))
  parts.push(t('explorer.drawer.count', { n: node.count }))
  if (node.hits !== undefined) parts.push(t('explorer.hits', { n: node.hits }))
  if (node.lastUpdated !== undefined) parts.push(formatWhen(node.lastUpdated))
  return parts.join(' · ')
}

/** 视野（缩放 + 平移）：translate(x,y) scale(k)。 */
interface GraphViewTransform { k: number; x: number; y: number }

const INITIAL_VIEW: GraphViewTransform = { k: 1, x: 0, y: 0 }

function GraphView({ graph, rootId, selectedId, selectedEdge, viewResetSeq, onNodeClick, onNodeDoubleClick, onEdgeClick, onBackgroundDoubleClick }: GraphProps) {
  const width = 760
  const height = 500
  const layout = useMemo(() => computeGraphLayout(graph, width, height, 240, rootId ?? undefined), [graph, rootId])
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [view, setView] = useState<GraphViewTransform>(INITIAL_VIEW)
  /** 手拖过的节点位置覆盖（优先于力导布局结果；子图变化即作废）。 */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { x: number; y: number }>>(() => new Map())
  const [panning, setPanning] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)
  /** 拖拽与单击同源 mousedown→mouseup：拖过 >3px 就吞掉随后的 click，防止拖完弹抽屉。 */
  const suppressClickRef = useRef(false)
  // 子图变化（跳数/聚焦/分类过滤）或外部复位信号 → 回初始视野、丢弃手拖位置
  useEffect(() => { setView(INITIAL_VIEW); setOverrides(new Map()) }, [graph, viewResetSeq])
  if (graph.nodes.length === 0) {
    return createElement('div', { className: 'meow-explorer-status' }, t('explorer.graph.empty'))
  }
  const posOf = (id: string): { x: number; y: number } | undefined => overrides.get(id) ?? layout.get(id)
  /** 屏幕坐标 → SVG 用户坐标（按实际渲染尺寸换算；viewBox 与 CSS 尺寸未必一致）。 */
  const toSvgPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect === undefined || rect === null || rect.width === 0) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left) * (width / rect.width),
      y: (clientY - rect.top) * (height / rect.height),
    }
  }
  // 滚轮缩放：以光标为锚点（React 的 wheel 是被动监听，不能 preventDefault——
  // 但 graph 视口 overflow:hidden，事件本无滚动默认行为；stopPropagation 防冒泡误伤宿主）。
  const onWheel = (e: { deltaY: number; clientX: number; clientY: number; stopPropagation: () => void }): void => {
    e.stopPropagation()
    const anchor = toSvgPoint(e.clientX, e.clientY)
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setView((v) => {
      const k = Math.min(3, Math.max(0.3, v.k * factor))
      const ratio = k / v.k
      return { k, x: anchor.x - (anchor.x - v.x) * ratio, y: anchor.y - (anchor.y - v.y) * ratio }
    })
  }
  // 背景拖拽平移：窗口级 mousemove/mouseup（指针划出 svg 也能继续拖）。
  const startPan = (e: { button: number; clientX: number; clientY: number }): void => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const base = view
    setPanning(true)
    const onMove = (ev: MouseEvent): void => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (rect === undefined || rect === null || rect.width === 0) return
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) suppressClickRef.current = true
      setView({
        ...base,
        x: base.x + (ev.clientX - startX) * (width / rect.width),
        y: base.y + (ev.clientY - startY) * (height / rect.height),
      })
    }
    const onUp = (): void => {
      setPanning(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // 节点拖拽：delta 换算要除掉当前缩放（拖拽期间 view 不变，取起始值即可）。
  const startNodeDrag = (node: GraphNode, e: { button: number; clientX: number; clientY: number; stopPropagation: () => void }): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect === undefined || rect === null || rect.width === 0) return
    const sxk = (width / rect.width) / view.k
    const syk = (height / rect.height) / view.k
    const orig = posOf(node.id) ?? { x: 0, y: 0 }
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const onMove = (ev: MouseEvent): void => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
        moved = true
        suppressClickRef.current = true
      }
      if (!moved) return
      const next = { x: orig.x + (ev.clientX - startX) * sxk, y: orig.y + (ev.clientY - startY) * syk }
      setOverrides((prev) => { const m = new Map(prev); m.set(node.id, next); return m })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // 悬停（优先）或选中节点 = 焦点：非邻居降噪变淡，关系路径一眼可见
  const focusId = hoverId ?? selectedId
  const neighbors = new Set<string>()
  if (focusId !== null) {
    neighbors.add(focusId)
    for (const e of graph.edges) {
      if (e.source === focusId) neighbors.add(e.target)
      if (e.target === focusId) neighbors.add(e.source)
    }
  }
  const isDim = (id: string): boolean => focusId !== null && !neighbors.has(id)
  const edgeWidth = (weight: number): number => 1 + Math.min(3, (weight - 1) * 0.5)
  const labelsById = new Map(graph.nodes.map((n) => [n.id, n.label]))
  return createElement('svg', {
    ref: svgRef,
    className: 'meow-explorer-graph',
    'data-panning': panning ? 'true' : 'false',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    onWheel,
    onMouseDown: startPan,
    onDoubleClick: onBackgroundDoubleClick,
  },
    createElement('g', { transform: `translate(${view.x},${view.y}) scale(${view.k})` },
      graph.edges.map((edge) => {
        const a = posOf(edge.source)
        const b = posOf(edge.target)
        if (a === undefined || b === undefined) return null
        const touched = focusId !== null && (edge.source === focusId || edge.target === focusId)
        const edgeSelected = selectedEdge !== null && sameEdge(selectedEdge, edge)
        const lit = touched || edgeSelected
        const tip = `${labelsById.get(edge.source) ?? edge.source} ↔ ${labelsById.get(edge.target) ?? edge.target} · ${edgeKindLabel(edge.kind, edge.relation_type)} · ${edge.weight}`
        return createElement('g', { key: `${edge.source}->${edge.target}`, className: 'meow-explorer-gedge' },
          // 可视细线（不接管事件；热区线负责交互，CSS hover 提亮这条）
          createElement('line', {
            className: 'meow-explorer-gedge-line',
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            stroke: lit ? 'rgba(110,168,254,.85)' : EDGE_COLORS[edge.kind],
            strokeWidth: edge.kind === 'relation' ? 1 + Math.min(1.4, (edge.weight - 1) * 0.3) + (lit ? 0.6 : 0) : edge.kind === 'mine' ? 1.2 : edgeWidth(edge.weight) + (lit ? 0.8 : 0),
            opacity: focusId !== null && !lit ? 0.12 : 1,
            style: { pointerEvents: 'none' },
          }),
          // 透明加粗热区：细线难点中；hover 提示「谁↔谁 · 什么关系 · 几条记忆」，单击开关系详情抽屉
          createElement('line', {
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            stroke: 'rgba(0,0,0,0)',
            strokeWidth: 12,
            style: { cursor: 'pointer', pointerEvents: 'stroke' },
            onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
            onClick: (e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              if (suppressClickRef.current) { suppressClickRef.current = false; return }
              onEdgeClick(edge)
            },
            onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
          }, createElement('title', null, tip)),
        )
      }),
      graph.nodes.map((node) => {
        const p = posOf(node.id)
        if (p === undefined) return null
        const isSelected = node.id === selectedId
        const isRoot = rootId !== null && node.id === rootId
        const cat = nodeCategory(node)
        const shared = {
          className: 'meow-explorer-gnode',
          onClick: () => {
            // 拖拽过的 mousedown→mouseup 会顺带触发 click：吞掉，别弹抽屉
            if (suppressClickRef.current) { suppressClickRef.current = false; return }
            onNodeClick(node)
          },
          onDoubleClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onNodeDoubleClick(node) },
          onMouseDown: (e: { button: number; clientX: number; clientY: number; stopPropagation: () => void }) => startNodeDrag(node, e),
          onMouseEnter: () => setHoverId(node.id),
          onMouseLeave: () => setHoverId(null),
          opacity: isDim(node.id) ? 0.2 : 1,
        }
        if (node.kind === 'me') {
          // 中心「我」：大实心圆 + 居中标签，视觉锚点（颜色=分类色 me）。
          return createElement('g', { key: node.id, ...shared },
            createElement('title', null, nodeTip(node)),
            createElement('circle', {
              cx: p.x, cy: p.y, r: 19, fill: CATEGORY_COLORS.me,
              stroke: isSelected ? '#fff' : 'rgba(110,168,254,.55)', strokeWidth: isSelected ? 3 : 1.5,
            }),
            createElement('text', {
              x: p.x, y: p.y + 4,
              style: { fill: '#10131a', fontSize: '12px', fontWeight: 700, textAnchor: 'middle', stroke: 'none' },
            }, node.label),
          )
        }
        const radius = 6 + Math.min(11, Math.log2(node.count + 1) * 2.4)
        const color = CATEGORY_COLORS[cat]
        const labelOffset = node.kind === 'project' ? radius + 10 : radius + 6
        // 标签降噪：低频关键词默认藏标签，悬停/选中及其邻居时浮现
        // 标签全显（用户反馈「有的实体不显示名字」）；长名字截断，完整名在 tooltip/抽屉里
        const showLabel = true
        const shownLabel = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label
        return createElement('g', { key: node.id, ...shared },
          createElement('title', null, nodeTip(node)),
          // 聚焦根节点的外圈描边提示（双击重聚焦的视觉锚）
          isRoot && createElement('circle', {
            cx: p.x, cy: p.y, r: radius + 5, fill: 'none',
            stroke: 'rgba(110,168,254,.6)', strokeWidth: 1.2, strokeDasharray: '3 3',
          }),
          node.kind === 'project'
            ? createElement('rect', {
              x: p.x - radius, y: p.y - radius, width: radius * 2, height: radius * 2,
              rx: 3, fill: color, fillOpacity: .85,
              stroke: isSelected ? '#fff' : color, strokeWidth: isSelected ? 2.5 : 1,
            })
            : createElement('circle', {
              cx: p.x, cy: p.y, r: radius, fill: color, fillOpacity: .85,
              stroke: isSelected ? '#fff' : color, strokeWidth: isSelected ? 2.5 : 1,
            }),
          showLabel && createElement('text', { x: p.x + labelOffset, y: p.y + 3.5 }, shownLabel),
        )
      }),
    ),
  )
}

interface DrawerProps {
  node: GraphNode
  rows: readonly ExplorerRow[]
  onClose: () => void
  onOpenInManage: (row: ExplorerRow) => void
}

/** 抽屉记忆卡列表（节点抽屉与 v0.4.0 边抽屉共用）。 */
function drawerCards(linked: readonly ExplorerRow[], onOpenInManage: (row: ExplorerRow) => void) {
  if (linked.length === 0) {
    return createElement('div', { className: 'meow-explorer-status' }, t('explorer.drawer.empty'))
  }
  return linked.map((row) => createElement('div', {
    key: row.id,
    className: 'meow-explorer-dcard',
    title: t('explorer.drawer.openInManage'),
    onClick: () => onOpenInManage(row),
  },
    createElement('div', { className: 'meow-explorer-dcard-head' },
      createElement('span', {
        className: 'meow-explorer-badge',
        style: { background: LEVEL_COLORS[row.level] ?? '#9e9e9e' },
      }, levelLabel(row.level)),
      createElement('span', { className: 'meow-explorer-dcard-title' }, cardTitle(row)),
    ),
    createElement('div', { className: 'meow-explorer-dcard-snippet' }, cardSnippet(row)),
    createElement('div', { className: 'meow-explorer-dcard-meta' },
      `${formatWhen(row.updated_at)} · ${rowProjectLabel(row.project)}`),
  ))
}

/** 节点关联记忆抽屉（从 sheet 右侧划出；点记忆卡跳回管理标签页定位该行）。 */
function NodeDrawer({ node, rows, onClose, onOpenInManage }: DrawerProps) {
  const linked = useMemo(() => rowsForNode(node, rows), [node, rows])
  const cat = nodeCategory(node)
  return createElement('div', { className: 'meow-explorer-drawer' },
    createElement('div', { className: 'meow-explorer-drawer-head' },
      createElement('span', {
        className: 'meow-explorer-chip-dot',
        style: { background: CATEGORY_COLORS[cat] },
        title: categoryLabel(cat),
      }),
      createElement('h3', { title: node.label }, t('explorer.drawer.title', { label: node.label })),
      createElement('span', { className: 'meow-explorer-drawer-count' }, t('explorer.drawer.count', { n: linked.length })),
      createElement('button', { className: 'meow-explorer-btn', onClick: onClose }, t('explorer.close')),
    ),
    createElement('div', { className: 'meow-explorer-drawer-body' }, drawerCards(linked, onOpenInManage)),
  )
}

interface EdgeDrawerProps {
  edge: GraphEdge
  /** 解析端点标签用（当前子图即可）。 */
  graph: MemoryGraph
  rows: readonly ExplorerRow[]
  onClose: () => void
  onOpenInManage: (row: ExplorerRow) => void
}

/** 边关联记忆抽屉（v0.4.0 关系详情：点一条边 = 看这条关系背后的记忆们）。 */
function EdgeDrawer({ edge, graph, rows, onClose, onOpenInManage }: EdgeDrawerProps) {
  const linked = useMemo(() => rowsForEdge(edge, graph, rows), [edge, graph, rows])
  const aLabel = graph.nodes.find((n) => n.id === edge.source)?.label ?? edge.source
  const bLabel = graph.nodes.find((n) => n.id === edge.target)?.label ?? edge.target
  return createElement('div', { className: 'meow-explorer-drawer' },
    createElement('div', { className: 'meow-explorer-drawer-head' },
      createElement('span', {
        className: 'meow-explorer-chip-dot',
        style: { background: '#6ea8fe' },
        title: edgeKindLabel(edge.kind, edge.relation_type),
      }),
      createElement('h3', { title: `${aLabel} ↔ ${bLabel}` }, t('explorer.drawer.edgeTitle', { a: aLabel, b: bLabel })),
      createElement('span', { className: 'meow-explorer-drawer-count' }, t('explorer.drawer.count', { n: linked.length })),
      createElement('button', { className: 'meow-explorer-btn', onClick: onClose }, t('explorer.close')),
    ),
    createElement('div', { className: 'meow-explorer-drawer-body' }, drawerCards(linked, onOpenInManage)),
  )
}

// ── 设置标签页（原「个人记忆」设置分区内嵌；scope 由 startMemoryExplorer 软取）───

type ScopeState = { status: 'pending' | 'ready' | 'unavailable'; scope: unknown }
let settingsScopeState: ScopeState = { status: 'pending', scope: undefined }
const scopeListeners = new Set<() => void>()

function getScopeState(): ScopeState {
  return settingsScopeState
}
function subscribeScope(cb: () => void): () => void {
  scopeListeners.add(cb)
  return () => { scopeListeners.delete(cb) }
}
function publishScopeState(next: ScopeState): void {
  settingsScopeState = next
  for (const fn of scopeListeners) fn()
}

function SettingsTab() {
  const state = useSyncExternalStore(subscribeScope, getScopeState, getScopeState)
  useEffect(() => { injectSettingsCss() }, [])
  if (state.status === 'pending') {
    return createElement('div', { className: 'meow-explorer-status' }, t('explorer.loading'))
  }
  if (state.status === 'unavailable') {
    return createElement('div', { className: 'meow-explorer-status' }, t('explorer.settings.unavailable'))
  }
  return createElement(MemorySettingsSection, { scope: state.scope })
}

// ── 总览首页（画像文档 + 分布 + 关键词云 + 榜单）─────────────────────────────

interface OverviewProps {
  rows: readonly ExplorerRow[]
  busy: boolean
  onOpenInManage: (row: ExplorerRow) => void
  onGoLevel: (level: string) => void
  onGoKeyword: (keyword: string) => void
  onArchive: (row: ExplorerRow) => void
}

/**
 * 总览首页：打开面板第一眼看到「AI 眼中的我」。soul/user 层渲染为可读文档
 * （不是卡片）；七层分布条、高频关键词云、最常命中/最近新增榜单都是入口——
 * 点哪里都跳进「记忆管理」对应过滤。底部「记忆体检」列出已过时/久未命中条目，
 * 一键归档（PATCH status）。
 */
function OverviewView({ rows, busy, onOpenInManage, onGoLevel, onGoKeyword, onArchive }: OverviewProps) {
  const soulRows = useMemo(() => rows.filter((r) => r.level === 'soul'), [rows])
  const userRows = useMemo(() => rows.filter((r) => r.level === 'user'), [rows])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const row of rows) c[row.level] = (c[row.level] ?? 0) + 1
    return c
  }, [rows])
  const keywords = useMemo(() => topKeywords(rows, 30), [rows])
  const hygiene = useMemo(() => hygieneRows(rows), [rows])
  const mostHit = useMemo(() => sortRows(rows, 'hits').filter((r) => r.hit_count > 0).slice(0, 5), [rows])
  const recent = useMemo(
    () => [...rows].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, 5),
    [rows],
  )
  if (rows.length === 0) {
    return createElement('div', { className: 'meow-explorer-status' }, t('explorer.overview.empty'))
  }

  // 画像文档条目（全文可读；点击进管理标签页定位该行）
  const docItem = (row: ExplorerRow) => createElement('div', {
    key: row.id,
    className: 'meow-explorer-doc-item',
    title: t('explorer.drawer.openInManage'),
    onClick: () => onOpenInManage(row),
  },
    row.title !== null && row.title.trim() !== ''
      && createElement('div', { className: 'meow-explorer-doc-title' }, row.title),
    createElement('div', { className: 'meow-explorer-doc-content' }, row.content),
    createElement('div', { className: 'meow-explorer-dcard-meta' },
      `${formatWhen(row.updated_at)} · ${t('explorer.hits', { n: row.hit_count })}`),
  )
  // 榜单小卡（复用抽屉卡片样式）
  const miniCard = (row: ExplorerRow) => createElement('div', {
    key: row.id,
    className: 'meow-explorer-dcard',
    title: t('explorer.drawer.openInManage'),
    onClick: () => onOpenInManage(row),
  },
    createElement('div', { className: 'meow-explorer-dcard-head' },
      createElement('span', {
        className: 'meow-explorer-badge',
        style: { background: LEVEL_COLORS[row.level] ?? '#9e9e9e' },
      }, levelLabel(row.level)),
      createElement('span', { className: 'meow-explorer-dcard-title' }, cardTitle(row)),
    ),
    createElement('div', { className: 'meow-explorer-dcard-meta' },
      `${formatWhen(row.updated_at)} · ${t('explorer.hits', { n: row.hit_count })}`),
  )
  // 体检小卡 = miniCard + 一键归档（点击归档不触发卡片跳转）
  const hygieneCard = (row: ExplorerRow) => createElement('div', {
    key: row.id,
    className: 'meow-explorer-dcard',
    'data-status': row.status,
    title: t('explorer.drawer.openInManage'),
    onClick: () => onOpenInManage(row),
  },
    createElement('div', { className: 'meow-explorer-dcard-head' },
      createElement('span', {
        className: 'meow-explorer-badge',
        style: { background: LEVEL_COLORS[row.level] ?? '#9e9e9e' },
      }, levelLabel(row.level)),
      createElement('span', { className: 'meow-explorer-dcard-title' }, cardTitle(row)),
    ),
    createElement('div', { className: 'meow-explorer-dcard-meta' },
      `${formatWhen(row.updated_at)} · ${t('explorer.hits', { n: row.hit_count })}`),
    createElement('div', null,
      createElement('button', {
        className: 'meow-explorer-mini-btn',
        disabled: busy,
        onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onArchive(row) },
      }, t('explorer.hygiene.archive')),
    ),
  )

  return createElement('div', { className: 'meow-explorer-overview' },
    // 画像文档：关于你 + AI 自身
    (userRows.length > 0 || soulRows.length > 0) && createElement('div', { className: 'meow-explorer-doc-grid' },
      userRows.length > 0 && createElement('section', null,
        createElement('h3', { className: 'meow-explorer-sec-title' }, t('explorer.overview.aboutYou')),
        userRows.map(docItem),
      ),
      soulRows.length > 0 && createElement('section', null,
        createElement('h3', { className: 'meow-explorer-sec-title' }, levelLabel('soul')),
        soulRows.map(docItem),
      ),
    ),
    // 七层分布：堆叠条 + 可点 chips
    createElement('h3', { className: 'meow-explorer-sec-title' }, t('explorer.overview.distribution')),
    createElement('div', { className: 'meow-explorer-distbar' },
      EXPLORER_LEVELS.filter((lv) => (counts[lv] ?? 0) > 0).map((lv) => createElement('span', {
        key: lv,
        style: { width: `${((counts[lv] ?? 0) / rows.length) * 100}%`, background: LEVEL_COLORS[lv] },
        title: `${levelLabel(lv)} ${counts[lv]}`,
        onClick: () => onGoLevel(lv),
      })),
    ),
    createElement('div', { className: 'meow-explorer-distchips' },
      EXPLORER_LEVELS.filter((lv) => (counts[lv] ?? 0) > 0).map((lv) => createElement('button', {
        key: lv,
        className: 'meow-explorer-chip',
        onClick: () => onGoLevel(lv),
      },
        createElement('span', { className: 'meow-explorer-chip-dot', style: { background: LEVEL_COLORS[lv] } }),
        `${levelLabel(lv)} ${counts[lv]}`,
      )),
    ),
    // 高频关键词云（字号随次数，点击按词过滤）
    keywords.length > 0 && createElement('h3', { className: 'meow-explorer-sec-title' }, t('explorer.overview.topKeywords')),
    keywords.length > 0 && createElement('div', { className: 'meow-explorer-cloud' },
      keywords.map(({ label, count }) => createElement('span', {
        key: label,
        className: 'meow-explorer-cloud-word',
        style: {
          fontSize: `${11 + Math.min(9, Math.log2(count + 1) * 3)}px`,
          opacity: 0.55 + Math.min(0.45, count * 0.1),
        },
        title: `${label} · ${count}`,
        onClick: () => onGoKeyword(label),
      }, label)),
    ),
    // 榜单：最常命中 TOP5 | 最近新增 5
    createElement('div', { className: 'meow-explorer-overview-cols' },
      mostHit.length > 0 && createElement('section', null,
        createElement('h3', { className: 'meow-explorer-sec-title' }, t('explorer.overview.mostHit')),
        mostHit.map(miniCard),
      ),
      recent.length > 0 && createElement('section', null,
        createElement('h3', { className: 'meow-explorer-sec-title' }, t('explorer.overview.recent')),
        recent.map(miniCard),
      ),
    ),
    // 记忆体检：已过时 | 久未命中（各列前 5 条；全量清单可在管理页用状态过滤）
    (hygiene.stale.length > 0 || hygiene.forgotten.length > 0)
      && createElement('h3', { className: 'meow-explorer-sec-title' }, t('explorer.hygiene.title')),
    (hygiene.stale.length > 0 || hygiene.forgotten.length > 0)
      && createElement('div', { className: 'meow-explorer-overview-cols' },
        hygiene.stale.length > 0 && createElement('section', null,
          createElement('h3', { className: 'meow-explorer-sec-title' }, `${t('explorer.hygiene.stale')} · ${hygiene.stale.length}`),
          hygiene.stale.slice(0, 5).map(hygieneCard),
        ),
        hygiene.forgotten.length > 0 && createElement('section', null,
          createElement('h3', { className: 'meow-explorer-sec-title' }, `${t('explorer.hygiene.forgotten')} · ${hygiene.forgotten.length}`),
          hygiene.forgotten.slice(0, 5).map(hygieneCard),
        ),
      ),
  )
}

// ── 时间线标签页（按创建日分组：AI 一天天记住了什么）──────────────────────────

interface TimelineProps {
  rows: readonly ExplorerRow[]
  onOpenInManage: (row: ExplorerRow) => void
}

/** 时间线：天为节（新→旧），节内小卡按创建时刻新→旧；点卡跳进管理页定位该行。 */
function TimelineView({ rows, onOpenInManage }: TimelineProps) {
  const groups = useMemo(() => timelineGroups(rows), [rows])
  if (rows.length === 0) {
    return createElement('div', { className: 'meow-explorer-status' }, t('explorer.empty'))
  }
  return createElement('div', { className: 'meow-explorer-timeline' },
    groups.map((group) => createElement('section', { key: group.key, className: 'meow-explorer-timeline-day' },
      createElement('h3', { className: 'meow-explorer-sec-title' },
        group.label,
        createElement('span', { className: 'meow-explorer-drawer-count' }, t('explorer.drawer.count', { n: group.rows.length })),
      ),
      group.rows.map((row) => createElement('div', {
        key: row.id,
        className: 'meow-explorer-dcard',
        title: t('explorer.drawer.openInManage'),
        onClick: () => onOpenInManage(row),
      },
        createElement('div', { className: 'meow-explorer-dcard-head' },
          createElement('span', {
            className: 'meow-explorer-badge',
            style: { background: LEVEL_COLORS[row.level] ?? '#9e9e9e' },
          }, levelLabel(row.level)),
          createElement('span', { className: 'meow-explorer-dcard-title' }, cardTitle(row)),
        ),
        createElement('div', { className: 'meow-explorer-dcard-snippet' }, cardSnippet(row)),
        createElement('div', { className: 'meow-explorer-dcard-meta' },
          `${formatWhen(row.created_at)} · ${rowProjectLabel(row.project)}`),
      )),
    )),
  )
}

// ── 面板 ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 300
/** 全量缓存单页上限（host /memories 路由把 limit 钳到 1000）。 */
const ALL_PAGE_LIMIT = 1000
/** 全量缓存翻页防御性封顶（10 页 = 1 万条，个人库够用且防失控循环）。 */
const ALL_MAX_PAGES = 10

type PanelTab = 'overview' | 'timeline' | 'manage' | 'graph' | 'settings'

interface EntityPayload {
  nodes: Array<{ id: string; name: string; type: string; count: number; rowIds: string[] }>
  edges: Array<{ source: string; target: string; relation_type: string; weight: number; memoryIds: string[] }>
  stats: { entities: number; relations: number; pending: number }
  llmReady: boolean
}

interface PanelProps { onClose: () => void }

function MemoryExplorerPanel({ onClose }: PanelProps) {
  const [stats, setStats] = useState<ExplorerStats | null>(null)
  // rows = 管理标签页的工作集（随层级过滤/分页变化）；allRows = 全量缓存，
  // 总览/时间线/关系网/体检的数据源——两者分离，管理页的层级过滤不再污染其它
  // 标签页（v0.3.3「牵一发而动全身」bug 的修复核心）。
  const [rows, setRows] = useState<readonly ExplorerRow[]>([])
  const [allRows, setAllRows] = useState<readonly ExplorerRow[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<PanelTab>('overview')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [filter, setFilter] = useState<RowFilter>({ level: '', project: 'all', query: '', keyword: '', status: 'all' })
  // 排序（管理标签页下拉）；服务端搜索结果（null=未在检索，用本地已载入）
  const [sort, setSort] = useState<SortMode>('updated')
  const [remoteRows, setRemoteRows] = useState<readonly ExplorerRow[] | null>(null)
  // 管理态：新增表单开关 / 行内编辑 id / 删除二次确认 id / 写操作进行中 / 反馈行
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // 关系网：抽屉里展示的节点；展示范围跳数（0=全部，默认 2 跳）；
  // 双击重聚焦的根（null=「我」）；图例关掉的分类；视图复位信号（数值变化即复位）
  const [drawerNode, setDrawerNode] = useState<GraphNode | null>(null)
  /** 关系详情抽屉里展开的边（v0.4.0；与 drawerNode 互斥——抽屉同一时刻只开一种）。 */
  const [drawerEdge, setDrawerEdge] = useState<GraphEdge | null>(null)
  const [hops, setHops] = useState(2)
  const [focusRoot, setFocusRoot] = useState<string | null>(null)
  const [hiddenCats, setHiddenCats] = useState<ReadonlySet<GraphCategory>>(() => new Set())
  const [viewResetSeq, setViewResetSeq] = useState(0)
  // 实体图谱（LLM 抽取结果；只在手动重建 / dream 收尾更新）
  const [entityData, setEntityData] = useState<EntityPayload | null>(null)
  const [entityStatus, setEntityStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'rebuilding'>('idle')
  // 语言切换时强制重渲染（onUiLocaleChange 注册即回调一次，卸载即退订）
  const [, setLocaleTick] = useState(0)
  const seqRef = useRef(0)
  const allSeqRef = useRef(0)
  const feedbackSeqRef = useRef(0)
  const searchSeqRef = useRef(0)

  const load = useCallback(async (level: string, offset: number, limitOverride?: number): Promise<void> => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ limit: String(limitOverride ?? PAGE_SIZE), offset: String(offset) })
      if (level !== '' && level !== 'all') query.set('level', level)
      const [nextStats, page] = await Promise.all([
        stats === null || offset === 0 ? apiFetch<ExplorerStats>(`${API_BASE}/stats`) : Promise.resolve(stats),
        apiFetch<{ rows: ExplorerRow[]; total: number; more: boolean }>(`${API_BASE}/memories?${query.toString()}`),
      ])
      if (seq !== seqRef.current) return // 过期响应（用户已切筛选/已关闭面板）
      setStats(nextStats)
      setRows(offset === 0 ? page.rows : (prev) => [...prev, ...page.rows])
      setMore(page.more)
    } catch (e) {
      if (seq !== seqRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [stats])

  /** 全量缓存：逐页取到完（host 钳 limit≤1000；页数封顶防失控）。失败静默——
   *  总览/图谱/时间线显示各自空态，错误行由管理页的 load 负责。 */
  const loadAll = useCallback(async (): Promise<void> => {
    const seq = ++allSeqRef.current
    try {
      let acc: ExplorerRow[] = []
      for (let page = 0; page < ALL_MAX_PAGES; page++) {
        const res = await apiFetch<{ rows: ExplorerRow[]; total: number; more: boolean }>(
          `${API_BASE}/memories?limit=${ALL_PAGE_LIMIT}&offset=${acc.length}`,
        )
        if (seq !== allSeqRef.current) return
        acc = acc.concat(res.rows)
        if (!res.more || res.rows.length === 0) break
      }
      if (seq === allSeqRef.current) setAllRows(acc)
    } catch {
      /* 静默：管理页的 load 会把同一后端的错误摆到错误行 */
    }
  }, [])

  useEffect(() => {
    void load('', 0)
    void loadAll()
    const unsubscribeLocale = onUiLocaleChange(() => setLocaleTick((v) => v + 1))
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      unsubscribeLocale()
      window.removeEventListener('keydown', onKeyDown)
      seqRef.current++ // 关闭后不再接受在途响应
      allSeqRef.current++
    }
  }, [])

  // 服务端搜索（防抖 300ms）：query 非空时全库检索（不限于已载入）；清空回本地。
  // 失败静默回落本地过滤（已载入范围）——检索增强不该成为新的报错来源。
  useEffect(() => {
    const q = filter.query.trim()
    if (q === '') {
      searchSeqRef.current++
      setRemoteRows(null)
      return
    }
    const timer = window.setTimeout(() => {
      const seq = ++searchSeqRef.current
      const params = new URLSearchParams({ q, limit: '200' })
      if (filter.level !== '' && filter.level !== 'all') params.set('level', filter.level)
      apiFetch<{ rows: ExplorerRow[]; total: number }>(`${API_BASE}/search?${params.toString()}`)
        .then((res) => { if (seq === searchSeqRef.current) setRemoteRows(res.rows) })
        .catch(() => { if (seq === searchSeqRef.current) setRemoteRows(null) })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [filter.query, filter.level])

  const readEntities = useCallback(async (): Promise<EntityPayload | null> => {
    try {
      return await apiFetch<EntityPayload>(`${API_BASE}/entities`)
    } catch {
      return null
    }
  }, [])

  const fetchEntities = useCallback(async (): Promise<EntityPayload | null> => {
    setEntityStatus('loading')
    const data = await readEntities()
    if (data === null) {
      setEntityStatus('error')
      return null
    }
    setEntityData(data)
    setEntityStatus('ready')
    return data
  }, [readEntities])

  useEffect(() => {
    if (tab === 'graph') void fetchEntities()
  }, [tab, fetchEntities])

  // dream 收尾会在后台补抽；面板开着时每 5s 拉一次，pending=0 自动停。
  useEffect(() => {
    if (tab !== 'graph' || entityData === null || entityData.stats.pending === 0) return
    const timer = setInterval(() => {
      void readEntities().then((data) => { if (data !== null) setEntityData(data) })
    }, 5000)
    return () => clearInterval(timer)
  }, [tab, entityData?.stats.pending, readEntities])

  /** 手动重建：清空 → 后台逐条调 LLM → 轮询到 pending=0。 */
  const rebuildEntities = useCallback(async (): Promise<void> => {
    if (entityStatus === 'rebuilding') return
    setEntityStatus('rebuilding')
    setFeedback(null)
    try {
      const res = await fetch(`${API_BASE}/entities-rebuild`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const json = (await res.json()) as { ok?: boolean; hint?: string; reason?: string }
      if (json.ok === false) {
        setFeedback({ kind: 'err', text: String(json.hint ?? json.reason ?? '实体抽取不可用') })
        setEntityStatus('ready')
        return
      }
      for (let i = 0; i < 150; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const data = await readEntities()
        if (data !== null) setEntityData(data)
        if (data !== null && data.stats.pending === 0) break
      }
      const final = await fetchEntities()
      if (final !== null && final.stats.pending > 0) {
        setFeedback({
          kind: 'err',
          text: t('explorer.graph.entityStats', {
            entities: String(final.stats.entities),
            relations: String(final.stats.relations),
            pending: String(final.stats.pending),
          }),
        })
      }
    } catch (e) {
      setFeedback({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
      setEntityStatus('error')
    }
  }, [entityStatus, readEntities, fetchEntities])

  // 实体表 → 图管线（GraphView 只认 nodes/edges）
  const fullGraph = useMemo(() => {
    const data = entityData
    if (data === null) return { nodes: [], edges: [] }
    return {
      nodes: data.nodes.map((n) => ({
        id: `ent:${n.id}`,
        label: n.name,
        kind: 'entity' as const,
        count: n.count,
        levels: {},
        entityType: n.type,
        rowIds: n.rowIds,
      })),
      edges: data.edges.map((e) => ({
        source: `ent:${e.source}`,
        target: `ent:${e.target}`,
        weight: e.weight,
        kind: 'relation' as const,
        relation_type: e.relation_type,
      })),
    }
  }, [entityData])

  const graph = useMemo(() => {
    let g = fullGraph
    if (focusRoot !== null && hops > 0 && g.nodes.some((n) => n.id === focusRoot)) {
      g = filterGraphByDepth(g, nodeDepths(g, focusRoot), hops)
    }
    if (hiddenCats.size > 0) {
      const kept = new Set(g.nodes.filter((n) => !hiddenCats.has(nodeCategory(n))).map((n) => n.id))
      g = {
        nodes: g.nodes.filter((n) => kept.has(n.id)),
        edges: g.edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
      }
    }
    return g
  }, [fullGraph, hops, focusRoot, hiddenCats])
  // 图例只列「当前子图里出现的分类 ∪ 被手动关掉但全图里还有的分类」（后者要能点回来）
  const legendCats = useMemo(() => {
    const present = new Set<GraphCategory>()
    for (const n of graph.nodes) present.add(nodeCategory(n))
    for (const cat of hiddenCats) {
      if (fullGraph.nodes.some((n) => nodeCategory(n) === cat)) present.add(cat)
    }
    return CATEGORY_ORDER.filter((cat) => present.has(cat))
  }, [graph, fullGraph, hiddenCats])
  // 跳数收窄后抽屉里的节点可能已不在子图里：自动收起抽屉
  useEffect(() => {
    if (drawerNode !== null && !graph.nodes.some((n) => n.id === drawerNode.id)) setDrawerNode(null)
  }, [graph, drawerNode])
  // 同理：展开的边若被过滤出子图（跳数收窄/分类关闭/数据变化），关系详情自动收起
  useEffect(() => {
    if (drawerEdge !== null && !graph.edges.some((e) => sameEdge(e, drawerEdge))) setDrawerEdge(null)
  }, [graph, drawerEdge])
  // 重聚焦的根若被图例关掉/从全图消失 → 回到全部
  useEffect(() => {
    if (focusRoot === null) return
    const node = fullGraph.nodes.find((n) => n.id === focusRoot)
    if (node === undefined || hiddenCats.has(nodeCategory(node))) setFocusRoot(null)
  }, [fullGraph, focusRoot, hiddenCats])

  /** 图例点击开关分类（「我」恒显，不给关）。 */
  const toggleCat = (cat: GraphCategory): void => {
    setHiddenCats((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  /** 写操作后的重载：保留已载入区间（limit 覆盖到当前行数），统计与全量缓存一并刷新。 */
  const reload = useCallback(async (): Promise<void> => {
    setStats(null)
    void loadAll()
    await load(filter.level, 0, Math.max(PAGE_SIZE, rows.length))
  }, [load, loadAll, filter.level, rows.length])

  const flash = (kind: 'ok' | 'err', text: string): void => {
    const seq = ++feedbackSeqRef.current
    setFeedback({ kind, text })
    window.setTimeout(() => {
      if (feedbackSeqRef.current === seq) setFeedback(null)
    }, 3500)
  }

  const setLevel = (level: string): void => {
    setFilter((f) => ({ ...f, level }))
    setEditingId(null)
    setDeleteId(null)
    setAdding(false)
    void load(level, 0)
  }
  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── 写操作（记忆管理标签页）──
  const doAdd = async (draft: MemoryDraft): Promise<void> => {
    setBusy(true)
    try {
      await apiSend(`${API_BASE}/memory`, 'POST', {
        level: draft.level,
        content: draft.content.trim(),
        title: draft.title.trim(),
        keywords: splitKeywords(draft.keywords),
        importance: draft.importance,
        ...(levelHasProject(draft.level) && draft.project.trim() !== '' ? { project: draft.project.trim() } : {}),
      })
      setAdding(false)
      flash('ok', t('explorer.saved'))
      await reload()
    } catch (e) {
      flash('err', t('explorer.saveFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  const doUpdate = async (row: ExplorerRow, draft: MemoryDraft): Promise<void> => {
    setBusy(true)
    try {
      await apiSend(`${API_BASE}/memory`, 'PATCH', {
        level: row.level,
        id: row.id,
        content: draft.content.trim(),
        title: draft.title.trim(),
        keywords: splitKeywords(draft.keywords),
        importance: draft.importance,
        ...(levelHasProject(row.level) ? { project: draft.project.trim() } : {}),
      })
      setEditingId(null)
      flash('ok', t('explorer.saved'))
      await reload()
    } catch (e) {
      flash('err', t('explorer.saveFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  const doDelete = async (row: ExplorerRow): Promise<void> => {
    setBusy(true)
    try {
      await apiSend(`${API_BASE}/memory?level=${encodeURIComponent(row.level)}&id=${encodeURIComponent(row.id)}`, 'DELETE')
      setDeleteId(null)
      flash('ok', t('explorer.deleted'))
      await reload()
    } catch (e) {
      flash('err', t('explorer.deleteFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  /** 体检区一键归档：PATCH status=archived（保留数据，只移出活跃视图）。 */
  const doArchive = async (row: ExplorerRow): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await apiSend(`${API_BASE}/memory`, 'PATCH', { level: row.level, id: row.id, status: 'archived' })
      flash('ok', t('explorer.status.archived'))
      await reload()
    } catch (e) {
      flash('err', t('explorer.saveFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  /** 抽屉记忆卡 → 跳回管理标签页并定位该行（按层级 + 标题子串过滤 + 展开）。 */
  const openInManage = (row: ExplorerRow): void => {
    setDrawerNode(null)
    setTab('manage')
    setEditingId(null)
    setDeleteId(null)
    setFilter({ level: row.level, project: 'all', query: cardTitle(row).slice(0, 30), keyword: '', status: 'all' })
    setExpanded(new Set([row.id]))
    void load(row.level, 0)
  }

  /** 总览分布条/层级 chip → 管理标签页按层过滤（重置其它过滤条件）。 */
  const goManageLevel = (level: string): void => {
    setTab('manage')
    setEditingId(null)
    setDeleteId(null)
    setAdding(false)
    setFilter({ level, project: 'all', query: '', keyword: '', status: 'all' })
    void load(level, 0)
  }
  /** 总览关键词云 → 管理标签页按关键词过滤（工具条显示可清除的关键词 chip）。 */
  const goManageKeyword = (keyword: string): void => {
    setTab('manage')
    setFilter((f) => ({ ...f, keyword, query: '', level: '' }))
    void load('', 0)
  }

  /** 手动点标签 = 回到该标签的默认完整视图（「具体看哪部分在当前标签里调，
   *  不牵一发而动全身」）：管理页清空全部过滤（层级过滤若变需重拉工作集），
   *  关系网跳数/重聚焦/图例分类全部归位。跨标签跳转（openInManage/goManage*）
   *  是带目标的编程导航，直接 setTab、不走这里。 */
  const selectTab = (key: PanelTab): void => {
    setTab(key)
    setAdding(false)
    setEditingId(null)
    setDeleteId(null)
    setDrawerNode(null)
    setDrawerEdge(null)
    if (key === 'manage') {
      const hadLevelScope = filter.level !== '' && filter.level !== 'all'
      setFilter({ level: '', project: 'all', query: '', keyword: '', status: 'all' })
      searchSeqRef.current++
      setRemoteRows(null)
      if (hadLevelScope) void load('', 0)
    }
    if (key === 'graph') {
      setHops(2)
      setFocusRoot(null)
      setHiddenCats(new Set())
    }
  }

  // 远端检索结果优先于本地已载入；先结构化过滤（状态/项目/关键词），再排序
  const visible = useMemo(
    () => sortRows(filterRows(remoteRows ?? rows, filter), sort),
    [remoteRows, rows, filter, sort],
  )
  const projects = useMemo(() => stats?.projects ?? [], [stats])

  const tabButton = (key: PanelTab, labelKey: 'explorer.tab.overview' | 'explorer.tab.timeline' | 'explorer.tab.manage' | 'explorer.tab.graph' | 'explorer.tab.settings') =>
    createElement('button', {
      key,
      className: 'meow-explorer-tab',
      'data-active': tab === key ? 'true' : 'false',
      onClick: () => selectTab(key),
    }, t(labelKey))

  // 关键：portal 到 body 的树必须以 .meow-explorer-overlay（position:fixed、
  // inset:0、z-index:9990）为根——sheet 自身没有定位，直接挂 body 会被画在
  // 应用末尾、视口之外，用户看到的就是「点击没反应」（v0.2.0 实测回归）。
  // 背板点击关闭；sheet 内点击 stopPropagation 防止穿透关闭。
  return createElement('div', {
    className: 'meow-explorer-overlay',
    onClick: onClose,
  },
    createElement('div', {
      className: 'meow-explorer-sheet',
      role: 'dialog',
      'aria-label': t('explorer.title'),
      onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    },
      // 头部：标题 + 总数 + 存储位置 + 刷新/关闭
      createElement('div', { className: 'meow-explorer-head' },
        createElement('h2', null, t('explorer.title')),
        stats !== null && createElement('span', { className: 'meow-explorer-total' },
          t('explorer.total', { n: stats.total ?? Object.values(stats.levels).reduce((a, b) => a + b, 0) })),
        stats !== null && createElement('span', {
          className: 'meow-explorer-home', title: `${t('explorer.home')}: ${stats.homeDir}`,
        }, `${t('explorer.home')}: ${stats.homeDir}`),
        createElement('button', { className: 'meow-explorer-btn', onClick: () => { void reload() } }, t('explorer.refresh')),
        createElement('button', { className: 'meow-explorer-btn', onClick: onClose }, t('explorer.close')),
      ),
      // 标签页栏：总览 / 时间线 / 记忆管理 / 关系网 / 设置
      createElement('div', { className: 'meow-explorer-tabs', role: 'tablist' },
        tabButton('overview', 'explorer.tab.overview'),
        tabButton('timeline', 'explorer.tab.timeline'),
        tabButton('manage', 'explorer.tab.manage'),
        tabButton('graph', 'explorer.tab.graph'),
        tabButton('settings', 'explorer.tab.settings'),
      ),
      feedback !== null && createElement('div', { className: 'meow-explorer-feedback', 'data-kind': feedback.kind }, feedback.text),
      error !== '' && createElement('div', { className: 'meow-explorer-status' },
        t('explorer.error', { msg: error })),

      // ── 总览标签页：画像文档 + 七层分布 + 关键词云 + 榜单 + 记忆体检 ──
      // （数据源是全量缓存 allRows：管理页的层级过滤影响不到这里）
      error === '' && tab === 'overview' && createElement('div', { className: 'meow-explorer-body' },
        loading && allRows.length === 0
          ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.loading'))
          : createElement(OverviewView, {
            rows: allRows,
            busy,
            onOpenInManage: openInManage,
            onGoLevel: goManageLevel,
            onGoKeyword: goManageKeyword,
            onArchive: (row) => void doArchive(row),
          }),
      ),

      // ── 时间线标签页：按创建日分组（AI 一天天记住了什么）──
      error === '' && tab === 'timeline' && createElement('div', { className: 'meow-explorer-body' },
        loading && allRows.length === 0
          ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.loading'))
          : createElement(TimelineView, { rows: allRows, onOpenInManage: openInManage }),
      ),

      // ── 设置标签页：内嵌原「个人记忆」设置分区 ──
      error === '' && tab === 'settings' && createElement('div', { className: 'meow-explorer-body' },
        createElement(SettingsTab),
      ),

      // ── 关系网标签页：LLM 实体图谱（手动重建 / dream 收尾抽取）───────────
      error === '' && tab === 'graph' && createElement('div', { className: 'meow-explorer-body', 'data-view': 'graph' },
        createElement('div', { className: 'meow-explorer-graphbar', role: 'group', 'aria-label': t('explorer.graph.rebuild') },
          createElement('button', {
            className: 'meow-explorer-chip',
            disabled: entityStatus === 'rebuilding',
            title: t('explorer.graph.rebuild'),
            onClick: () => void rebuildEntities(),
          }, entityStatus === 'rebuilding' ? t('explorer.graph.rebuilding') : t('explorer.graph.rebuild')),
          entityData !== null && createElement('span', { className: 'meow-explorer-graphbar-label' },
            entityStatus === 'rebuilding'
              ? t('explorer.graph.rebuilding')
              : t('explorer.graph.entityStats', {
                  entities: String(entityData.stats.entities),
                  relations: String(entityData.stats.relations),
                  pending: String(entityData.stats.pending),
                })),
          createElement('span', { className: 'meow-explorer-spacer' }),
          focusRoot !== null && createElement('button', {
            className: 'meow-explorer-chip',
            title: t('explorer.graph.backToAll'),
            onClick: () => setFocusRoot(null),
          }, `\u2190 ${t('explorer.graph.backToAll')}`),
          ...(focusRoot !== null
            ? ([1, 2, 0] as const).map((h) => createElement('button', {
                key: h,
                className: 'meow-explorer-chip',
                title: t('explorer.graph.hops.label'),
                'data-active': hops === h ? 'true' : 'false',
                onClick: () => setHops(h),
              }, t(h === 1 ? 'explorer.graph.hops.one' : h === 2 ? 'explorer.graph.hops.two' : 'explorer.graph.hops.all')))
            : []),
          createElement('button', {
            className: 'meow-explorer-chip',
            title: t('explorer.graph.resetView'),
            onClick: () => setViewResetSeq((v) => v + 1),
          }, '\u21ba'),
        ),
        createElement('div', { className: 'meow-explorer-graphwrap', title: t('explorer.graph.clickHint') },
          entityStatus === 'rebuilding' && (entityData === null || entityData.stats.entities === 0)
            ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.graph.rebuilding'))
            : (entityStatus === 'idle' || entityStatus === 'loading') && entityData === null
            ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.loading'))
            : entityStatus === 'error'
              ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.graph.entityEmpty'))
              : entityData === null || entityData.stats.entities === 0
                ? createElement('div', { className: 'meow-explorer-status' },
                    entityData !== null && entityData.llmReady === false
                      ? t('explorer.graph.llmOff')
                      : t('explorer.graph.entityEmpty'))
                : createElement(GraphView, {
                    graph,
                    rootId: focusRoot,
                    selectedId: drawerNode?.id ?? null,
                    selectedEdge: drawerEdge,
                    viewResetSeq,
                    onNodeClick: (node) => {
                      setDrawerEdge(null)
                      setDrawerNode((cur) => (cur?.id === node.id ? null : node))
                    },
                    onNodeDoubleClick: (node) => {
                      setFocusRoot(node.id === focusRoot ? null : node.id)
                      setDrawerNode(null)
                      setDrawerEdge(null)
                    },
                    onEdgeClick: (edge) => {
                      setDrawerNode(null)
                      setDrawerEdge((cur) => (cur !== null && sameEdge(cur, edge) ? null : edge))
                    },
                    onBackgroundDoubleClick: () => setFocusRoot(null),
                  }),
        ),
        createElement('div', { className: 'meow-explorer-legend' },
          ...legendCats.map((cat) => createElement('button', {
            key: cat,
            className: 'meow-explorer-legend-item',
            'data-off': hiddenCats.has(cat) ? 'true' : 'false',
            title: categoryLabel(cat),
            onClick: () => toggleCat(cat),
          },
            createElement('span', { className: 'meow-explorer-chip-dot', style: { background: CATEGORY_COLORS[cat] } }),
            createElement('span', { className: 'meow-explorer-legend-text' }, categoryLabel(cat)))),
          createElement('span', { style: { opacity: .55 } }, t('explorer.graph.clickHint')),
        ),
      ),

      // ── 记忆管理标签页：工具条 + 新增表单 + 卡片网格（带编辑/删除）──
      error === '' && tab === 'manage' && createElement('div', { className: 'meow-explorer-toolbar' },
        createElement('button', {
          className: 'meow-explorer-chip', 'data-active': filter.level === '' ? 'true' : 'false',
          onClick: () => setLevel(''),
        }, t('explorer.filter.all'), stats !== null && createElement('span', { className: 'meow-explorer-count' },
          Object.values(stats.levels).reduce((a, b) => a + b, 0))),
        ...EXPLORER_LEVELS.map((level) => createElement('button', {
          key: level,
          className: 'meow-explorer-chip',
          'data-active': filter.level === level ? 'true' : 'false',
          onClick: () => setLevel(level),
        },
          createElement('span', { className: 'meow-explorer-chip-dot', style: { background: LEVEL_COLORS[level] } }),
          levelLabel(level),
          stats !== null && createElement('span', { className: 'meow-explorer-count' }, stats.levels[level] ?? 0),
        )),
        createElement('span', { className: 'meow-explorer-spacer' }),
        createElement('button', {
          className: 'meow-explorer-btn',
          'data-primary': adding ? 'false' : 'true',
          onClick: () => { setAdding((v) => !v); setEditingId(null); setDeleteId(null) },
        }, t('explorer.add')),
        createElement('select', {
          value: filter.project,
          onChange: (e: { target: { value: string } }) => setFilter((f) => ({ ...f, project: e.target.value })),
          'aria-label': t('explorer.project.all'),
        },
          createElement('option', { value: 'all' }, t('explorer.project.all')),
          createElement('option', { value: PROJECT_GLOBAL_KEY }, t('explorer.project.global')),
          createElement('option', { value: PROJECT_UNSET_KEY }, t('explorer.project.unlabeled')),
          projects.map((name) => createElement('option', { key: name, value: name }, name)),
        ),
        createElement('select', {
          value: filter.status ?? 'all',
          onChange: (e: { target: { value: string } }) => setFilter((f) => ({ ...f, status: e.target.value })),
          'aria-label': t('explorer.status.label'),
          title: t('explorer.status.label'),
        },
          createElement('option', { value: 'all' }, t('explorer.status.label')),
          createElement('option', { value: 'active' }, t('explorer.status.active')),
          createElement('option', { value: 'stale' }, t('explorer.status.stale')),
          createElement('option', { value: 'archived' }, t('explorer.status.archived')),
        ),
        createElement('select', {
          value: sort,
          onChange: (e: { target: { value: string } }) => setSort(e.target.value as SortMode),
          'aria-label': t('explorer.sort.label'),
          title: t('explorer.sort.label'),
        },
          createElement('option', { value: 'updated' }, t('explorer.sort.updated')),
          createElement('option', { value: 'importance' }, t('explorer.sort.importance')),
          createElement('option', { value: 'hits' }, t('explorer.sort.hits')),
        ),
        createElement('input', {
          type: 'search', placeholder: t('explorer.search.placeholder'), value: filter.query,
          title: t('explorer.search.hint'),
          onChange: (e: { target: { value: string } }) => setFilter((f) => ({ ...f, query: e.target.value })),
        }),
        // 关键词过滤激活时显示可清除 chip（总览关键词云/图谱点选的来源提示）
        filter.keyword !== '' && createElement('button', {
          className: 'meow-explorer-chip',
          'data-active': 'true',
          title: t('explorer.keywordClear'),
          onClick: () => setFilter((f) => ({ ...f, keyword: '' })),
        }, `${filter.keyword} ×`),
      ),
      error === '' && tab === 'manage' && createElement('div', { className: 'meow-explorer-body' },
        adding && createElement('div', { className: 'meow-explorer-addwrap' },
          createElement(MemoryEditor, { busy, onSave: (draft) => void doAdd(draft), onCancel: () => setAdding(false) }),
        ),
        loading && rows.length === 0
          ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.loading'))
          : visible.length === 0
            ? createElement('div', { className: 'meow-explorer-status' }, t('explorer.empty'))
            : createElement('div', null,
              createElement('div', { className: 'meow-explorer-cards' },
                visible.map((row) => createElement(MemoryCard, {
                  key: row.id,
                  row,
                  expanded: expanded.has(row.id),
                  editing: editingId === row.id,
                  confirmingDelete: deleteId === row.id,
                  busy,
                  onToggle: toggleExpanded,
                  onEdit: (id) => { setEditingId(id); setAdding(false); setDeleteId(null) },
                  onDeleteAsk: (id) => { setDeleteId(id); setEditingId(null) },
                  onDeleteConfirm: (r) => void doDelete(r),
                  onSaveEdit: (r, draft) => void doUpdate(r, draft),
                  onCancelEdit: () => setEditingId(null),
                })),
              ),
              // 远端检索模式下结果已是全库匹配集，不再分页加载
              more && remoteRows === null && createElement('button', {
                className: 'meow-explorer-btn meow-explorer-more',
                onClick: () => void load(filter.level, rows.length),
              }, t('explorer.more', { n: Math.max(0, (stats?.total ?? rows.length) - rows.length) })),
            ),
      ),

      // 关系网节点抽屉（sheet 内右侧划出；sheet overflow:hidden 裁得住）
      // 行源用全量缓存：管理页的层级过滤不影响节点关联记忆的完整性
      tab === 'graph' && drawerNode !== null && createElement(NodeDrawer, {
        node: drawerNode,
        rows: allRows,
        onClose: () => setDrawerNode(null),
        onOpenInManage: openInManage,
      }),
      // 关系网边抽屉（v0.4.0 关系详情：这条边两端为何相连——背后的记忆们）
      tab === 'graph' && drawerEdge !== null && createElement(EdgeDrawer, {
        edge: drawerEdge,
        graph,
        rows: allRows,
        onClose: () => setDrawerEdge(null),
        onOpenInManage: openInManage,
      }),
    ),
  )
}

// ── 入口（sidebar.footer.action 槽组件）──────────────────────────────────────

interface EntryProps { wide?: boolean }

export function MemoryExplorerEntry({ wide }: EntryProps) {
  const [open, setOpen] = useState(false)
  return createElement('span', null,
    createElement('button', {
      type: 'button',
      className: 'meow-explorer-entry',
      onClick: () => setOpen(!open),
      title: t('explorer.open'),
      'aria-label': t('explorer.open'),
      'data-plugin-entry': 'dsh-personal-memory',
    },
      createElement('span', { 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: BOOK_SVG } }),
      wide === true ? createElement('span', null, t('explorer.title')) : null,
    ),
    open ? createPortal(createElement(MemoryExplorerPanel, { onClose: () => setOpen(false) }), document.body) : null,
  )
}

/**
 * 启动记忆库面板：注入面板 CSS（同 startDreamIconManager 的卫生模式：先清旧
 * style 再注入，data-plugin 自报家门防 0.1.6 加载器连坐删除）+ 注册
 * sidebar.footer.action 槽 + 双腿软取设置 scope（面板「设置」标签页的数据源）。
 * 槽服务缺席时返回 no-op 并告警（老宿主只降级）。
 */
export function startMemoryExplorer(ctx: { get?: (name: string) => unknown }, slots: { inject?: unknown; register?: unknown } | undefined | null): () => void {
  const inject = typeof slots?.inject === 'function' ? (slots as { inject: (a: string, b: () => unknown) => () => void }).inject.bind(slots) : undefined
  if (inject === undefined) {
    console.warn('[dsh-personal-memory] slots service unavailable; memory explorer entry disabled')
    return () => {}
  }
  // 设置标签页 scope：0.1.6 settingsScope.bind / 0.1.7 configForms 轮询（详见
  // settings-page.ts）；拿不到（异常宿主）→ 标签页停在「设置服务不可用」态。
  const disposeScope = acquireSettingsScope(ctx, (scope) => publishScopeState({ status: 'ready', scope }), {
    onUnavailable: () => publishScopeState({ status: 'unavailable', scope: undefined }),
  })
  for (const stale of Array.from(document.querySelectorAll('style[data-meow-explorer-css]'))) {
    stale.remove()
  }
  const style = document.createElement('style')
  style.dataset.meowExplorerCss = 'true'
  style.dataset.plugin = 'dsh-personal-memory'
  style.textContent = EXPLORER_CSS
  document.head.appendChild(style)
  const disposeSlot = inject('sidebar.footer.action', () => (slots as { register: (a: Record<string, unknown>, b: unknown) => () => void }).register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-personal-memory',
      order: 80,
      label: () => t('explorer.open'),
    },
    MemoryExplorerEntry,
  ))
  return () => {
    try {
      disposeSlot()
    } catch {
      /* 槽注销失败不阻塞 */
    }
    try {
      disposeScope()
    } catch {
      /* scope 轮询清理失败不阻塞 */
    }
    style.remove()
  }
}

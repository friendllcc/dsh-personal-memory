/**
 * migrate-merge.ts — 旧 per-workspace 记忆库合并进全局库（fork 全局化改造的遗留数据面）。
 *
 * 背景：上游 meow-memory 的记忆库住各工作区 <cwd>/.dsh-meow/memory.db（project 记忆）。
 * 本 fork 全局化后库住 activeHomeDir()/<dir>/memory.db——启动时把旧库合并进来，用户
 * 的历史记忆跨工作区全量保留。
 *
 * 合并策略（保守，与上游安全红线一致）：
 *  - 记忆条目（七层表）：按 id 主键 INSERT OR IGNORE（id 全局唯一，先到先得）；
 *    id 撞车（理论上不可能）保留全局库已有条目，旧库条目跳过；
 *  - windows / dream_skip / dream_meta：同主键 INSERT OR IGNORE（dream_meta 跳过
 *    last_check 检查门——那是旧实例的节流状态，不该带进新库）；
 *  - dream_log：整表追加（留痕表，无唯一键；带旧 id 原样插入，AUTOINCREMENT 接续）；
 *  - 会话账本 sessions/<id>.json：目标不存在才拷贝（旧库目录 → 全局目录）。
 *
 * 安全红线（沿用 home-dir.ts / migrate-v0.ts 的用户拍板口径）：
 *  - 绝不删除/改动旧工作区目录里的任何文件——只读源、写目标；
 *  - 任何一步失败：跳过该工作区，记日志，绝不影响插件启动；
 *  - 幂等：完成标记落全局目录 migrate-merge-state.json；未完成（有错误）下次启动重试，
 *    已合并的条目靠 INSERT OR IGNORE 天然去重。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { activeHomeDir } from './home-dir.js'
import { getDb, LEVELS, type Level, type MemoryDb } from './db.js'

const STATE_FILE = 'migrate-merge-state.json'

interface MigrateMergeState {
  merged?: boolean
  mergedAt?: string
  workspaces?: string[]
  memories?: number
  windows?: number
  sessions?: number
  errors?: Array<{ workspace: string; error: string }>
}

export interface MigrateMergeReport {
  ran: boolean
  reason?: string
  workspaces: string[]
  merged: number
  windows: number
  sessions: number
  errors: Array<{ workspace: string; error: string }>
}

function statePath(): string {
  return join(activeHomeDir(), STATE_FILE)
}

function readState(): MigrateMergeState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as MigrateMergeState
  } catch {
    return {}
  }
}

function writeState(state: MigrateMergeState): void {
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(state, null, 1), 'utf8')
}

/** 单工作区旧库的七层表列（与 db.ts SCHEMAS 一致；读侧按表名白名单拼 SQL，
 *  表名/列名都是代码内常量，无外部输入）。 */
const LEVEL_EXTRA_COLS: Record<Level, string[]> = {
  soul: [],
  user: [],
  project: ['project', 'subcategory'],
  fact: ['project'],
  lesson: ['corrected', 'project'],
  topic: ['goal', 'project'],
  rules: ['project'],
}

/** 把一个旧工作区库合并进全局库（单工作区；异常向上抛由调用方记账）。 */
function mergeOneWorkspace(globalDb: MemoryDb, legacyDbPath: string, dir: string): { memories: number; windows: number } {
  const legacy = new DatabaseSync(legacyDbPath, { readOnly: true })
  try {
    let memories = 0
    let windows = 0
    // 七层记忆表：逐行 INSERT OR IGNORE（列序 = COMMON_COLS + 层特化列）
    for (const level of LEVELS) {
      const cols = ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at', ...LEVEL_EXTRA_COLS[level]]
      const legacyCols = cols
      // 旧库列集可能缺新列（早期版本）：按旧库实际列投影，缺列以 NULL 补
      const actual = new Set(
        (legacy.prepare(`PRAGMA table_info(${level})`).all() as Array<{ name: string }>).map((c) => c.name),
      )
      const selectCols = cols.map((c) => (actual.has(c) ? c : 'NULL')).join(', ')
      const rows = legacy.prepare(`SELECT ${selectCols} FROM ${level}`).all() as Record<string, unknown>[]
      for (const row of rows) {
        const args = cols.map((c) => (actual.has(c) ? row[c] : null))
        memories += globalDb.insertIgnored(level, cols, args)
      }
    }
    // windows 窗口表
    {
      const cols = ['session_id', 'workspace', 'last_event_time', 'last_dream_time', 'dream_owner', 'dream_started_at', 'dream_progress_at', 'dream_group_idx', 'dream_T']
      const actual = new Set(
        (legacy.prepare('PRAGMA table_info(windows)').all() as Array<{ name: string }>).map((c) => c.name),
      )
      const selectCols = cols.map((c) => (actual.has(c) ? c : 'NULL')).join(', ')
      const rows = legacy.prepare(`SELECT ${selectCols} FROM windows`).all() as Record<string, unknown>[]
      for (const row of rows) {
        const args = cols.map((c) => (actual.has(c) ? row[c] : null))
        globalDb.insertIgnored('windows', cols, args)
      }
      windows = rows.length
    }
    // dream_skip 门控表 + dream_meta（跳过 last_check 检查门）
    for (const table of ['dream_skip', 'dream_meta'] as const) {
      const actual = new Set(
        (legacy.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
      )
      if (actual.size === 0) continue
      const cols = [...actual]
      const selectCols = cols.join(', ')
      const placeholders = cols.map(() => '?').join(', ')
      const rows = legacy.prepare(`SELECT ${selectCols} FROM ${table}`).all() as Record<string, unknown>[]
      for (const row of rows) {
        if (table === 'dream_meta' && row['key'] === 'last_check') continue
        const args = cols.map((c) => row[c])
        globalDb.insertIgnored(table, cols, args)
      }
    }
    // dream_log 留痕表：整表追加（保留旧 id，AUTOINCREMENT 自动接续）
    {
      const cols = ['id', 'run_at', 'summary', 'changes', 'note']
      const actual = new Set(
        (legacy.prepare('PRAGMA table_info(dream_log)').all() as Array<{ name: string }>).map((c) => c.name),
      )
      if (actual.size > 0) {
        const selectCols = cols.map((c) => (actual.has(c) ? c : 'NULL')).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const rows = legacy.prepare(`SELECT ${selectCols} FROM dream_log`).all() as Record<string, unknown>[]
        for (const row of rows) {
          const args = cols.map((c) => (actual.has(c) ? row[c] : null))
          globalDb.insertIgnored('dream_log', cols, args)
        }
      }
    }
    return { memories, windows }
  } finally {
    legacy.close()
  }
}

/**
 * 启动合并入口（apply 时调用，幂等）：
 *  - state.merged === true → 直接跳过（force=true 例外：persistence 补扫用——state
 *    已置位但可能还有 window-index 之外的旧工作区，OR IGNORE 幂等去重，重扫代价低）；
 *  - workspaces：调用方收集的候选（旧 window-index、sessionPersistence 的 cwd、
 *    当前进程 cwd）；逐个探测 <ws>/<LEGACY_DIR>/memory.db，存在才合并；
 *  - 任何单工作区失败只记 errors，全部完成后（无论有无错误，含部分成功）置
 *    merged=true——有错误的下次重试靠 OR IGNORE 去重，避免每次启动全量重扫
 *    大库（用户拍板：宁可少合并一条，不可拖慢每次启动）。
 */
export function mergeLegacyWorkspaceDbs(
  dir: string,
  legacyDir: string,
  workspaces: readonly string[],
  log: (m: string) => void,
  _now?: string,
  force = false,
): MigrateMergeReport {
  const empty: MigrateMergeReport = { ran: false, reason: 'already-merged', workspaces: [], merged: 0, windows: 0, sessions: 0, errors: [] }
  const state = readState()
  if (state.merged === true && !force) return empty
  const now = _now ?? new Date().toISOString()

  const report: MigrateMergeReport = { ran: true, workspaces: [], merged: 0, windows: 0, sessions: 0, errors: [] }
  const seen = new Set<string>()
  const candidates = workspaces.filter((w) => {
    if (typeof w !== 'string' || w.length === 0) return false
    if (seen.has(w)) return false
    seen.add(w)
    return existsSync(join(w, legacyDir, 'memory.db'))
  })
  if (candidates.length === 0) {
    // 没有旧库：同样置位（全新用户或已合并过目录搬迁），避免每次启动扫 persistence
    writeState({ merged: true, mergedAt: now, workspaces: [], memories: 0, windows: 0, sessions: 0, errors: [] })
    return { ...report, reason: 'no-legacy-dbs' }
  }

  const globalDb = getDb('', dir)
  let sessionsCopied = 0
  for (const ws of candidates) {
    report.workspaces.push(ws)
    try {
      const { memories, windows } = mergeOneWorkspace(globalDb, join(ws, legacyDir, 'memory.db'), dir)
      report.merged += memories
      report.windows += windows
      // 会话账本：旧库同目录 sessions/*.json → 全局 sessions/（目标不存在才拷）
      const legacySessions = join(ws, legacyDir, 'sessions')
      const globalSessions = join(activeHomeDir(), dir, 'sessions')
      if (existsSync(legacySessions)) {
        mkdirSync(globalSessions, { recursive: true })
        for (const name of readdirSync(legacySessions)) {
          if (!name.endsWith('.json')) continue
          const target = join(globalSessions, name)
          if (existsSync(target)) continue
          try {
            copyFileSync(join(legacySessions, name), target)
            sessionsCopied++
          } catch {
            /* 单文件失败：跳过（会话去重账本丢了只是重复注入一次，无数据损失） */
          }
        }
      }
      log(`dsh-personal-memory: merged legacy memory db from ${ws} (${memories} memories, ${windows} windows)`)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      report.errors.push({ workspace: ws, error })
      log(`dsh-personal-memory: legacy db merge FAILED for ${ws}: ${error}`)
    }
  }
  report.sessions = sessionsCopied
  writeState({ merged: true, mergedAt: now, workspaces: report.workspaces, memories: report.merged, windows: report.windows, sessions: sessionsCopied, errors: report.errors })
  if (report.merged > 0 || report.errors.length > 0) {
    log(`dsh-personal-memory: legacy merge done — ${report.merged} memories, ${report.windows} windows, ${sessionsCopied} session files, ${report.errors.length} errors`)
  }
  return report
}

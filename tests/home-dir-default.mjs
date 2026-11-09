/**
 * v0.4.5 出厂默认迁移回归（home-dir.ts）：
 *   - 全新安装：active = DSH_HOME/storages/dsh-personal-memory（不再落用户主目录）
 *   - 旧库升级：旧默认 ~/.dsh-personal-memory 有内容且新默认未建 → 模块加载先落
 *     旧目录，switchHomeDir(出厂默认) 整树迁移（同盘 rename，home-dir.json 留痕）
 *   - 新默认已有内容 → 直接启用不迁移
 *   - env 覆盖优先于一切探测
 *
 * 模块级 active 在 import 时定格 → 每个场景独立 esbuild bundle（不同 outfile URL
 * = 独立模块实例）+ 隔离 HOME/USERPROFILE/DSH_HOME，绝不触碰真实用户目录。
 * 运行：node tests/home-dir-default.mjs（构建后自动 esbuild，与 entities-llm 同款惯例）
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fail++; console.log(`FAIL  ${name} ${detail}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const root = mkdtempSync(join(tmpdir(), 'dpm-homedir-'))
const savedEnv = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH,
  DSH_HOME: process.env.DSH_HOME, DSH_PERSONAL_MEMORY_HOME: process.env.DSH_PERSONAL_MEMORY_HOME,
}

/** 独立 bundle import（每个 case 一个 outfile URL → 模块重新初始化，active 重新探测）。 */
const loadCase = async (name, setup) => {
  const home = join(root, name)
  const dsh = join(root, `${name}-dsh`)
  mkdirSync(home, { recursive: true })
  mkdirSync(dsh, { recursive: true })
  // 隔离用户主目录与 DSH 根：os.homedir() 在 Windows 读 USERPROFILE（HOMEDRIVE/HOMEPATH
  // 兜底）、其他平台 HOME，全部指到沙箱/清空；清掉插件 env 与 DSH_HOME 兜底，再按场景注入。
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.HOMEDRIVE
  delete process.env.HOMEPATH
  delete process.env.DSH_PERSONAL_MEMORY_HOME
  process.env.DSH_HOME = dsh
  setup?.(home, dsh)
  const outfile = join(root, `${name}.mjs`)
  await build({
    entryPoints: [fileURLToPath(new URL('../src/home-dir.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile, logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const restoreEnv = () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

section('1. 全新安装：默认落 DSH 根目录 Storage')
{
  const H = await loadCase('fresh', () => {})
  ok('active = DSH_HOME/storages/dsh-personal-memory', H.activeHomeDir() === join(root, 'fresh-dsh', 'storages', 'dsh-personal-memory'), H.activeHomeDir())
  ok('预设 default = 同一落点', H.homeDirPresets().default === H.activeHomeDir())
  ok('预设 user-home = 用户主目录旧默认', H.homeDirPresets()['user-home'] === join(root, 'fresh', '.dsh-personal-memory'))
  ok('LEGACY_HOME_DIR = 用户主目录旧默认', H.LEGACY_HOME_DIR === join(root, 'fresh', '.dsh-personal-memory'))
  ok('resolveHomeDir 缺省 = 出厂默认', H.resolveHomeDir(undefined) === H.activeHomeDir() && H.resolveHomeDir('') === H.activeHomeDir())
}

section('2. 旧库升级：旧默认有数据 → apply 迁移到新默认')
{
  const H = await loadCase('upgrade', (home) => {
    // 旧默认目录有真实数据形态：内层 .dsh-personal-memory/memory.db + 实例级文件
    const legacy = join(home, '.dsh-personal-memory')
    mkdirSync(join(legacy, '.dsh-personal-memory'), { recursive: true })
    writeFileSync(join(legacy, '.dsh-personal-memory', 'memory.db'), 'fake-db')
    mkdirSync(join(legacy, 'sessions'), { recursive: true })
    writeFileSync(join(legacy, 'sessions', 's1.json'), '{}')
    writeFileSync(join(legacy, 'perf.log'), 'log')
  })
  ok('模块加载先落旧默认（等待迁移）', H.activeHomeDir() === join(root, 'upgrade', '.dsh-personal-memory'), H.activeHomeDir())
  // apply 链路同款：switchHomeDir(resolveHomeDir(未配置))
  const sw = H.switchHomeDir(H.resolveHomeDir(undefined))
  const target = join(root, 'upgrade-dsh', 'storages', 'dsh-personal-memory')
  ok('迁移切换 changed+migrated', sw.changed && sw.migrated, JSON.stringify(sw))
  ok('active 切到新默认', H.activeHomeDir() === target, H.activeHomeDir())
  ok('数据整树搬到新默认', existsSync(join(target, '.dsh-personal-memory', 'memory.db')) && existsSync(join(target, 'sessions', 's1.json')) && existsSync(join(target, 'perf.log')))
  ok('迁移留痕 home-dir.json', existsSync(join(target, 'home-dir.json')) && readFileSync(join(target, 'home-dir.json'), 'utf8').includes('migratedFrom'))
  ok('搬移文件数=3', sw.files === 3, String(sw.files))
}

section('3. 新默认已有内容：直接启用，不迁移')
{
  const H = await loadCase('both', (home, dsh) => {
    const legacy = join(home, '.dsh-personal-memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'old.txt'), 'old')
    const def = join(dsh, 'storages', 'dsh-personal-memory')
    mkdirSync(def, { recursive: true })
    writeFileSync(join(def, 'new.txt'), 'new')
  })
  ok('active 直接落新默认（不回旧目录）', H.activeHomeDir() === join(root, 'both-dsh', 'storages', 'dsh-personal-memory'), H.activeHomeDir())
  const sw = H.switchHomeDir(H.resolveHomeDir(undefined))
  ok('switch 到自身 = same no-op', !sw.changed && sw.mode === 'same', JSON.stringify(sw))
}

section('4. env 覆盖优先于目录探测')
{
  const envHome = join(root, 'envcase-home')
  const H = await loadCase('env', (home) => {
    // 旧默认有数据（会误导探测），但 env 指向别处 → env 赢
    const legacy = join(home, '.dsh-personal-memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'x.txt'), 'x')
    process.env.DSH_PERSONAL_MEMORY_HOME = envHome
  })
  ok('active = env 路径', H.activeHomeDir() === envHome, H.activeHomeDir())
}

restoreEnv()
rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

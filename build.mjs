/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *
 * Everything is bundled (esbuild) so the plugin is self-contained:
 * @deepseek-ai/* imports are linked in at build time via the node_modules
 * junction mirrors (scripts/link-workspace.ps1); react stays external on the
 * client side (shell singleton, ModuleLoader resolves it).
 */
import { build, context } from 'esbuild';
import { cpSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

// 客户端模块注册 ID 必须等于 package name（DSH ClientModuleSystem 按
// "Entry name == package name" 等待 __ModuleLoader__.load 的注册，见
// packages/client/modules manifest.ts 的 BootModuleRow.id 注释）。v0.4.6 起
// npm 包名改为 scoped（@cmjt/dsh-personal-memory），ID 从 package.json 派生，
// 不再硬编码——改包名后忘改 banner 会报
// "loaded without registering <pkg> via __ModuleLoader__.load"。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const MODULE_ID = pkg.name;

// The @deepseek-ai/* packages live in the dsh-meow pnpm workspace, not in this
// package's node_modules. `node_modules/@deepseek-ai` holds junction mirrors
// (created by scripts/link-workspace.ps1) so esbuild can resolve both this
// plugin's direct imports and the transitive imports of bundled packages.
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
};

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react），
  // 不能打进 bundle——否则双 React 实例会崩掉 slots 渲染。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(MODULE_ID)},`,
      '  factory: (require) => {',
      // 包名常量（v0.4.7）：settings-page 用它定位 scoped 安装的设置条目 id
      // （= profile 条目 id = 包名）。与上面的注册 id 同源（MODULE_ID），单点维护。
      `    var __DPM_PACKAGE_NAME__ = ${JSON.stringify(MODULE_ID)};`,
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await (await context(hostOptions)).watch();
  await (await context(clientOptions)).watch();
  console.log('[build] watching src/ for changes...');
} else {
  // prompt 文案外置（v0.19.0）：src/prompts/<lang>/*.md → lib/prompts/，运行时
  // readFileSync 读取（prompt-loader.ts 以 import.meta.url 定位 lib/prompts），
  // 不参与 esbuild bundle。语言包 = 一个子目录，新增语言不需要动构建脚本。
  // filter：Delete_ 前缀（改名留痕协议产物）与 *.bak-*（改名/重建备份）都不进发布包。
  // 2026-09-20 实证：src/prompts 下的 *.bak-20260914-femwa-word 会被整目录 cpSync 拷进
  // lib/prompts，而 package.json 的 files 白名单含 lib/prompts/** → 6 个备份文件直接进了 tgz
  // （0.26.0 是 28 个文件，那次 pack 变成 34 个）。
  const keepInPackage = (p) => {
    const name = p.split(/[\\/]/).pop() ?? ''
    return !name.startsWith('Delete_') && !/\.bak(-|$)/.test(name)
  }
  // 发布门禁（v0.4.6，issue：客户端注册 ID 与 scoped 包名不一致）：shipped 的
  // cordis.patch.yml 行按包名引用安装产物（Node 解析）——包名改 scope 后忘了同步
  // patch 会导致 scoped 安装加载旧引用。banner 已派生自 package.json（必然一致），
  // 这里校验 patch 文件 id/name 两行引用同为本包名（引号可选，scoped 名必须加），
  // 不一致直接构建失败。
  const esc = MODULE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const idLine = new RegExp(`^\\s*-?\\s*id:\\s*['"]?${esc}['"]?\\s*$`, 'm')
  const nameLine = new RegExp(`^\\s*name:\\s*['"]?${esc}['"]?\\s*$`, 'm')
  const patchYml = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8');
  if (!idLine.test(patchYml) || !nameLine.test(patchYml)) {
    throw new Error(`[build] cordis.patch.yml 的 id/name 行必须引用包名 ${MODULE_ID}（与 package.json name 一致）`)
  }
  cpSync(new URL('./src/prompts', import.meta.url), new URL('./lib/prompts', import.meta.url), {
    recursive: true,
    filter: keepInPackage,
  });
  await Promise.all([build(hostOptions), build(clientOptions)]);
}

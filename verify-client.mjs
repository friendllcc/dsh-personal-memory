// 模拟浏览器 ModuleLoader：加载 lib/client.js 并 materialize，验证无 duplicate
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const factories = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load: (handoff) => {
      if (factories.has(handoff.id)) throw new Error(`DUPLICATE: ${handoff.id}`)
      factories.set(handoff.id, handoff.factory)
    },
  },
}
// mock require：react 等返回空对象即可（apply 定义不执行副作用）
const requireMock = (spec) => {
  if (spec === 'react' || spec === 'react/jsx-runtime' || spec === 'react-dom' || spec === 'react-dom/client') return {}
  throw new Error('unexpected require: ' + spec)
}
const code = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
const loadCount = (code.match(/window\.__ModuleLoader__\.load\(/g) || []).length
console.log('load call count:', loadCount)
if (loadCount !== 1) {
  console.error('FAIL: bundle still has multiple load calls')
  process.exit(1)
}
// 执行 bundle（注册 factory）——用 new Function 隔离作用域
new Function('window', code)(globalThis.window)
console.log('registered factories:', [...factories.keys()])
if (!factories.has('dsh-personal-memory')) {
  console.error('FAIL: dsh-personal-memory factory not registered')
  process.exit(1)
}
// materialize：调用 factory 模拟
const result = factories.get('dsh-personal-memory')(requireMock)
const names = Object.keys(result || {})
console.log('materialized exports:', names)
// 再执行一次 bundle（模拟重复执行场景）→ 应抛 duplicate（内核检测仍有效）
try {
  new Function('window', code)(globalThis.window)
  console.error('FAIL: duplicate not detected')
  process.exit(1)
} catch (e) {
  if (String(e.message).includes('DUPLICATE')) console.log('OK: kernel duplicate detection still works (expected)')
  else throw e
}
console.log('PASS: bundle is single-wrapper and materializes cleanly')

/**
 * LLM 接线：把 dsh 的 ctx.llm 包成「一次调用拿纯文本」。
 *
 * 只用于实体抽取（手动重建 / dream 收尾），不参与对话主链路。
 * 任何失败都返回空串——图谱是增强功能，绝不能影响记忆本体。
 */

export interface LlmLike {
  stream: (options: {
    provider: string
    model: string
    messages: unknown[]
    system?: string
    reasoningEffort?: string
  }) => AsyncIterable<{ type?: string; text?: string }>
}

/** 解析默认 provider/model（Service 实例 + 老版本扁平字段兜底）。 */
export function resolveDefaultRoute(ctx: unknown): { provider: string; model: string } | null {
  const c = ctx as Record<string, unknown> | undefined
  if (c === undefined || c === null) return null
  const reflect = (c as { reflect?: { get?: unknown } }).reflect
  const readService = (name: string): unknown => {
    if (typeof reflect?.get === 'function') {
      return (reflect as { get: (n: string, s?: boolean) => unknown }).get(name, false)
    }
    return (c as Record<string, unknown>)[name]
  }
  const svc = readService('agentDefaultModel') as
    | { currentSelection?: () => { provider?: unknown; model?: unknown } }
    | undefined
  if (svc !== undefined && svc !== null && typeof svc.currentSelection === 'function') {
    try {
      const sel = svc.currentSelection()
      if (typeof sel?.provider === 'string' && sel.provider !== '' && typeof sel?.model === 'string' && sel.model !== '') {
        return { provider: sel.provider, model: sel.model }
      }
    } catch { /* 落到兜底 */ }
  }
  if (svc !== undefined && svc !== null) {
    const o = svc as { provider?: unknown; model?: unknown }
    if (typeof o.provider === 'string' && o.provider !== '' && typeof o.model === 'string' && o.model !== '') {
      return { provider: o.provider, model: o.model }
    }
  }
  for (const [p, m] of [
    [readService('agentDefaultProvider'), readService('agentDefaultModelName')],
    [readService('defaultProvider'), readService('defaultModel')],
  ] as Array<[unknown, unknown]>) {
    if (typeof p === 'string' && p !== '' && typeof m === 'string' && m !== '') return { provider: p, model: m }
  }
  return null
}

function splitMessages(messages: unknown[]): { system: string; rest: unknown[] } {
  let system = ''
  const rest: unknown[] = []
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown }
    if (m?.role === 'system') {
      const content = m.content
      if (typeof content === 'string') system += content
      else if (Array.isArray(content)) {
        for (const b of content) {
          const blk = b as { type?: unknown; text?: unknown }
          if (blk?.type === 'text' && typeof blk.text === 'string') system += blk.text
        }
      }
      continue
    }
    rest.push(raw)
  }
  return { system, rest }
}

/** 造一个 callLLM（一次调用、拼流、超时兜底、失败返回空串）。 */
export function makeEntityCallLLM(
  llm: LlmLike,
  route: { provider: string; model: string },
  timeoutMs = 60_000,
): (messages: unknown[], options?: Record<string, unknown>) => Promise<string> {
  return async (messages, options = {}) => {
    const { system, rest } = splitMessages(messages)
    const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : route.provider
    const model = typeof options.model === 'string' && options.model !== '' ? options.model : route.model
    const req: Parameters<LlmLike['stream']>[0] = { provider, model, messages: rest }
    if (system !== '') req.system = system
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('entity extraction timeout')), timeoutMs)
    })
    try {
      const collect = async (): Promise<string> => {
        let text = ''
        for await (const chunk of llm.stream(req)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
        return text
      }
      return await Promise.race([collect(), timeout])
    } catch {
      return ''
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
/** 宿主模型平面接线：路由解析、ctx.llm 适配、缺凭据时的可读错误。 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createHostLlmClient, HostLlmError, type HostLlmRoute } from '../src/llm/host-client.js'
import { buildRouter, resolveSessionRoute } from '../src/dsh/adapters.js'
import type { SessionEventSource } from '../src/service/export-service.js'
import type { SessionEvent } from '../src/core/types.js'

const ROUTE: HostLlmRoute = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** 一个把给定事件序列当作日志的事件源。 */
function source(events: readonly SessionEvent[]): SessionEventSource {
  return { events: async () => events }
}

/** 造一条 request/header 事件（DSH 记录的实际形状：data.header.config）。 */
function headerEvent(provider: unknown, model: unknown): SessionEvent {
  return {
    type: 'request/header',
    seq: 1,
    time: 0,
    data: { header: { config: { provider, model } } },
  }
}

/** 造一个只实现 stream 的 llm 服务替身。 */
function llmService(chunks: readonly unknown[], calls: unknown[] = []): {
  stream: (options: unknown) => AsyncIterable<unknown>
} {
  return {
    stream(options: unknown) {
      calls.push(options)
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** 把这个替身包装成 Cordis 上下文（buildRouter 走 ctx.get('llm')）。 */
function llmContext(chunks: readonly unknown[], calls: unknown[] = []): Context {
  const service = llmService(chunks, calls)
  return {
    get(name: string) {
      return name === 'llm' ? service : undefined
    },
  } as unknown as Context
}

const STOP = { type: 'finish', reason: { kind: 'stop' } }

describe('resolveSessionRoute', () => {
  it('取最后一条 request/header 的 provider/model（跟随会话当前模型）', async () => {
    const route = await resolveSessionRoute(source([
      headerEvent('deepseek-official', 'deepseek-v4-pro'),
      { type: 'user/message', seq: 2, time: 0, data: {} },
      headerEvent('deepseek-official', 'deepseek-flash'),
    ]))
    expect(route).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('没有可用路由或日志不可读时返回 undefined（回退配置默认）', async () => {
    expect(await resolveSessionRoute(source([]))).toBeUndefined()
    expect(await resolveSessionRoute(source([headerEvent('', 'x'), headerEvent(3, null)])))
      .toBeUndefined()
    const broken: SessionEventSource = { events: async () => { throw new Error('archived') } }
    expect(await resolveSessionRoute(broken)).toBeUndefined()
  })
})

describe('createHostLlmClient', () => {
  it('把消息交给 ctx.llm.stream 并拼出文本与用量', async () => {
    const calls: unknown[] = []
    const service = llmService([
      { type: 'text-delta', index: 0, text: '{"modules":' },
      { type: 'reasoning-delta', index: 1, text: '不该进正文' },
      { type: 'text-delta', index: 0, text: '[]}' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 90 } },
      STOP,
    ], calls)
    const client = createHostLlmClient(service, ROUTE, 'session-x' as never)
    const result = await client.complete({
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '归类这段对话' },
      ],
      json: true,
    })

    expect(result.text).toBe('{"modules":[]}')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 4 })
    expect(client.model).toBe('deepseek-flash')
    const options = calls[0] as {
      provider: string
      model: string
      system?: string
      messages: { role: string; content: { type: string; text: string }[] }[]
      sessionId?: string
    }
    expect(options.provider).toBe('deepseek-official')
    expect(options.model).toBe('deepseek-flash')
    expect(options.system).toBe('系统提示')
    expect(options.messages.map(m => m.role)).toEqual(['user'])
    expect(options.messages[0]!.content[0]).toEqual({ type: 'text', text: '归类这段对话' })
    expect(options.sessionId).toBe('session-x')
  })

  it('多轮历史保留 assistant 角色', async () => {
    const calls: unknown[] = []
    const service = llmService([{ type: 'text-delta', index: 0, text: '好的' }, STOP], calls)
    const client = createHostLlmClient(service, ROUTE)
    await client.complete({
      messages: [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '第一轮回复' },
        { role: 'user', content: '第二轮' },
      ],
    })
    const options = calls[0] as { messages: { role: string }[] }
    expect(options.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('凭据类终态给出可操作的提示（不再是一个裸 HTTP 码）', async () => {
    const service = llmService([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key for route' },
      },
    }])
    const client = createHostLlmClient(service, ROUTE)
    const error = await client.complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(HostLlmError)
    expect((error as HostLlmError).code).toBe('MISSING_CREDENTIAL')
    expect((error as Error).message).toContain('模型凭据未配置')
    expect((error as Error).message).toContain('DeepSeek API Key')
  })

  it('非 stop 终态一律报错（含 max-tokens）', async () => {
    const service = llmService([{ type: 'finish', reason: { kind: 'max-tokens' } }])
    const client = createHostLlmClient(service, ROUTE)
    await expect(client.complete({ messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow(/maxTokens/)
  })
})

describe('buildRouter', () => {
  it('有 llm 服务时走宿主模型平面（不读环境变量）', () => {
    const ctx = llmContext([STOP])
    const router = buildRouter(ctx, {}, undefined, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(router.clientFor('classify').model).toBe('deepseek-v4-pro')
    expect(router.clientFor('designStrategy').model).toBe('deepseek-v4-pro')
  })

  it('显式配置优先于会话路由，无会话路由时用内置默认', () => {
    const ctx = llmContext([STOP])
    expect(buildRouter(ctx, { provider: 'p', model: 'm' }, undefined, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    }).clientFor('classify').model).toBe('m')
    expect(buildRouter(ctx, {}, undefined, undefined).clientFor('classify').model).toBe('deepseek-flash')
  })

  it('没有 llm 服务时回退自建 HTTP 客户端（远程/本地各一）', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const router = buildRouter(ctx, { localBaseUrl: 'http://127.0.0.1:11434/v1', localModel: 'qwen' })
    expect(router.clientFor('classify').model).toBe('deepseek-flash')
    // 本地槽在 buildRouter 里固定为 remote；这里只验证缺 llm 服务不抛错
    expect(typeof router.clientFor('designStrategy').complete).toBe('function')
  })
})

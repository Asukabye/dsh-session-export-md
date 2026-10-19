import { describe, expect, it } from 'vitest'
import {
  createOpenAiCompatibleClient,
  LlmClientError,
  LlmRouter,
  LocalLlmUnavailableError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '../src/llm/client.js'

function fakeFetch(reply: unknown, status = 200): typeof fetch {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'Content-Type': 'application/json' },
      statusText: init?.method ?? 'GET',
    })
  }
}

function mockClient(model: string, replies: readonly LlmResponse[]): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = []
  let i = 0
  return {
    model,
    calls,
    async complete(req) {
      calls.push(req)
      return replies[i++] ?? { text: '' }
    },
  }
}

describe('createOpenAiCompatibleClient', () => {
  it('组装 OpenAI 兼容请求并解析响应', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'flash',
      fetchFn: async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200 },
        )
      },
    })
    const resp = await client.complete({ messages: [{ role: 'user', content: 'hi' }], json: true })
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions')
    expect(capturedInit?.method).toBe('POST')
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(capturedInit?.body))
    expect(body.model).toBe('flash')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.temperature).toBe(0)
    expect(resp.text).toBe('{"ok":true}')
    expect(resp.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('HTTP 错误抛出 LlmClientError', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com',
      model: 'flash',
      fetchFn: fakeFetch({ error: 'bad' }, 500),
    })
    await expect(client.complete({ messages: [] })).rejects.toThrow(LlmClientError)
  })
})

describe('LlmRouter', () => {
  const remote = mockClient('remote', [])
  const local = mockClient('local', [])

  it('按模块路由到线上/本地', () => {
    const router = new LlmRouter(remote, local, {
      classify: { kind: 'remote', model: 'flash' },
      designStrategy: { kind: 'local', model: 'qwen' },
    })
    expect(router.clientFor('classify').model).toBe('remote')
    expect(router.clientFor('designStrategy').model).toBe('local')
  })

  it('本地未配置时抛 LocalLlmUnavailableError（不静默降级）', () => {
    const router = new LlmRouter(remote, undefined, {
      classify: { kind: 'remote', model: 'flash' },
      designStrategy: { kind: 'local', model: 'qwen' },
    })
    expect(() => router.clientFor('designStrategy')).toThrow(LocalLlmUnavailableError)
    expect(router.clientFor('classify').model).toBe('remote')
  })
})

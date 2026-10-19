/**
 * LLM 客户端适配层（阶段 4）：
 * - OpenAI 兼容端点客户端（线上 DeepSeek / 本地 Ollama 等共用，fetch 可注入，测试用 mock）；
 * - LlmRouter：按模块（classify / designStrategy）路由到线上或本地客户端，本地缺失时抛错不静默降级。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface LlmResponse {
  text: string
  usage?: LlmUsage
}

export interface LlmRequest {
  messages: readonly LlmMessage[]
  /** 要求 JSON 输出（response_format json_object）。 */
  json?: boolean
  maxTokens?: number
}

export interface LlmClient {
  readonly model: string
  complete(req: LlmRequest): Promise<LlmResponse>
}

export class LlmClientError extends Error {}

export interface OpenAiCompatibleOptions {
  baseUrl: string
  apiKey?: string
  model: string
  /** 测试注入用；默认 globalThis.fetch。 */
  fetchFn?: typeof fetch
}

export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  const fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const url = opts.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  return {
    model: opts.model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages,
        temperature: 0,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.json === true ? { response_format: { type: 'json_object' } } : {}),
      }
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.apiKey !== undefined && opts.apiKey !== '' ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new LlmClientError(`LLM 请求失败：HTTP ${res.status}`)
      const data = (await res.json()) as {
        choices?: { message?: { content?: unknown } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text =
        typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : ''
      const promptTokens = data.usage?.prompt_tokens
      const completionTokens = data.usage?.completion_tokens
      return {
        text,
        usage: {
          ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
          ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}),
        },
      }
    },
  }
}

export interface LlmTarget {
  kind: 'remote' | 'local'
  model: string
}

/** 按模块的 LLM 配置（标题生成已并入分类批处理，故只留 classify 与 designStrategy 两个槽）。 */
export interface LlmSlotConfig {
  classify: LlmTarget
  designStrategy: LlmTarget
}

export class LocalLlmUnavailableError extends Error {}

/** 按模块路由到线上/本地客户端；本地未配置时抛错（设计规则：不静默降级，由调用方提示用户）。 */
export class LlmRouter {
  constructor(
    private readonly remote: LlmClient,
    private readonly local: LlmClient | undefined,
    private readonly config: LlmSlotConfig,
  ) {}

  clientFor(slot: keyof LlmSlotConfig): LlmClient {
    const target = this.config[slot]
    if (target.kind === 'local') {
      if (this.local === undefined) {
        throw new LocalLlmUnavailableError(`模块 ${slot} 配置为本地模型，但未配置本地端点`)
      }
      return this.local
    }
    return this.remote
  }
}

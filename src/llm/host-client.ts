/**
 * 宿主模型平面客户端：把 DSH 的 `ctx.llm` 适配成插件核心的 {@link LlmClient}。
 *
 * 为什么不读 `process.env.DEEPSEEK_API_KEY`：GUI/设置页写入的凭据只落在受管文档
 * `$DSH_HOME/.credentials.yaml`，DSH 明确它「never materialized into the process
 * environment」，只有 `credentials` 服务能在每次请求时解析出它。自建 HTTP 客户端
 * 因此永远拿不到 key，请求不带 `Authorization` → 上游 401。
 * 走 `ctx.llm.stream()` 还能一并继承重试、计量、缓存与模型目录。
 */

import {
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmRuntime,
  type Message,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { LlmClient, LlmRequest, LlmResponse } from './client.js'

/** 插件在模型调用里的身份（用户消息 source.plugin）。 */
const PLUGIN_ID = 'session-export-md'

/** 单次辅助调用上限：分类/标题/策略设计都不该无限等待。 */
const DEFAULT_TIMEOUT_MS = 120_000

/** provider + model 路由（取自会话 request/header 或插件配置）。 */
export interface HostLlmRoute {
  readonly provider: string
  readonly model: string
}

/** 宿主模型平面里本插件用到的那一面（便于测试注入替身）。 */
export type HostLlmService = Pick<LlmRuntime, 'stream'>

/** 模型平面调用失败（含 DSH 的终态 failure.code，如 MISSING_CREDENTIAL）。 */
export class HostLlmError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'HostLlmError'
    this.code = code
  }
}

/** 凭据类失败的统一提示：直接告诉用户去哪里补配置，而不是丢一个 HTTP 码。 */
function describeFailure(failure: { message: string; code?: string; status?: number }): HostLlmError {
  const code = failure.code
  // 带上机器可路由的 code 与 HTTP 状态：TRANSPORT / TIMEOUT / RATE_LIMIT 的处理方式完全不同。
  const tag = [code, failure.status !== undefined ? `HTTP ${String(failure.status)}` : undefined]
    .filter((x): x is string => x !== undefined && x !== '')
    .join(' · ')
  const suffix = tag !== '' ? `（${tag}）` : ''
  if (code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') {
    return new HostLlmError(
      `模型凭据${code === 'MISSING_CREDENTIAL' ? '未配置' : '无效'}：${failure.message}（请在设置页的「模型」里配置 DeepSeek API Key）`,
      code,
    )
  }
  return new HostLlmError(`${failure.message}${suffix}`, code)
}

/** 终态 finish 里的失败（stop 之外的终态都视为本次调用失败）。 */
function finishFailure(finish: FinishReason): HostLlmError | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted':
      return describeFailure(finish.failure)
    case 'max-tokens':
      return new HostLlmError('模型输出达到 maxTokens 上限，未产生完整结果')
    case 'tool-calls':
      return new HostLlmError('模型意外发起了工具调用（本调用不需要工具）')
    default:
      return new HostLlmError(`未知的模型终态：${String((finish as { kind?: unknown }).kind)}`)
  }
}

/** 只取文本块（思考/工具载荷不进提示词）。 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * 构建一个走宿主模型平面的客户端。
 * @param llm - 宿主的 `llm` 服务（凭据、重试、计量都在它后面）。
 * @param route - 本次调用的 provider/model 路由。
 * @param sessionId - 会话身份（透传给适配器做请求归属，可省）。
 * @returns 与核心流水线同签名的 LlmClient。
 */
export function createHostLlmClient(
  llm: HostLlmService,
  route: HostLlmRoute,
  sessionId?: SessionId,
): LlmClient {
  return {
    model: route.model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const system = req.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const turns = req.messages.filter((m) => m.role !== 'system')
      const messages: Message[] = turns.map((m) =>
        m.role === 'assistant'
          ? createAssistantMessage({
              content: [{ type: 'text', text: m.content }],
              source: { provider: route.provider, model: route.model },
            })
          : createUserMessage({
              content: [{ type: 'text', text: m.content }],
              source: { kind: 'plugin', plugin: PLUGIN_ID },
            }),
      )
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        ...(system !== '' ? { system } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      }

      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      const failure = finishFailure(assembler.finish)
      if (failure !== undefined) throw failure

      const usage = assembler.usage
      return {
        text: textOf(assembler.blocks()),
        // TokenUsage 的 inputTokens 只是未命中缓存的输入；提示词总量 = 三段之和。
        ...(usage !== undefined
          ? {
              usage: {
                inputTokens:
                  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
                outputTokens: usage.outputTokens,
              },
            }
          : {}),
      }
    },
  }
}

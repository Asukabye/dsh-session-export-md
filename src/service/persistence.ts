/**
 * 服务层 KV 持久化适配（集成阶段对接 storageDomain KV；开发期用内存 KV 测试）。
 * 表：watermark（增量水位）、categorize（段→模块/标题/轮次 映射）、pref（路径/当前策略/LLM 槽位）。
 */

import type { Watermark } from '../core/types.js'
import type { KvTable } from '../core/strategies.js'
import type { LlmSlotConfig } from '../llm/client.js'

export const DEFAULT_MD_DIR = '.chat-exports'

export interface CategorizeEntry {
  /** 轮次标题（模型生成，动作式；落库后重建/重排复用，避免标题漂移）。 */
  title: string
  /** dimensionId → 该维度下的模块名。 */
  labels: Record<string, string>
  turnNo: number
}

export type CategorizeMap = Record<string, CategorizeEntry>

export interface SessionPref {
  mdPath: string
  currentStrategyId: string
  llmSlotConfig: LlmSlotConfig
}

export function defaultLlmSlotConfig(): LlmSlotConfig {
  return {
    classify: { kind: 'remote', model: 'deepseek-flash' },
    designStrategy: { kind: 'remote', model: 'deepseek-flash' },
  }
}

export function defaultSessionPref(mdPath: string): SessionPref {
  return {
    mdPath,
    // 空 = 尚未选择分类策略（内置默认策略兜底）
    currentStrategyId: '',
    llmSlotConfig: defaultLlmSlotConfig(),
  }
}

function safeParse<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export class WatermarkStore {
  constructor(private readonly table: KvTable, private readonly sessionId: string) {}

  private key(): string {
    return `watermark:${this.sessionId}`
  }

  async get(): Promise<Watermark | null> {
    return safeParse<Watermark>(await this.table.get(this.key()))
  }

  async set(w: Watermark): Promise<void> {
    await this.table.set(this.key(), JSON.stringify(w))
  }
}

export class CategorizeStore {
  constructor(private readonly table: KvTable, private readonly sessionId: string) {}

  private key(): string {
    return `categorize:${this.sessionId}`
  }

  async get(): Promise<CategorizeMap> {
    return safeParse<CategorizeMap>(await this.table.get(this.key())) ?? {}
  }

  async set(map: CategorizeMap): Promise<void> {
    await this.table.set(this.key(), JSON.stringify(map))
  }
}

export class SessionPrefStore {
  constructor(private readonly table: KvTable, private readonly sessionId: string) {}

  private key(): string {
    return `pref:${this.sessionId}`
  }

  /** 读取会话偏好，与默认值合并（容忍缺字段/坏 JSON）。 */
  async get(defaultMdPath: string): Promise<SessionPref> {
    const base = defaultSessionPref(defaultMdPath)
    const stored = safeParse<Partial<SessionPref>>(await this.table.get(this.key()))
    if (stored === null) return base
    return {
      mdPath:
        typeof stored.mdPath === 'string' && stored.mdPath !== '' ? stored.mdPath : base.mdPath,
      currentStrategyId:
        typeof stored.currentStrategyId === 'string' && stored.currentStrategyId !== ''
          ? stored.currentStrategyId
          : base.currentStrategyId,
      llmSlotConfig: stored.llmSlotConfig ?? base.llmSlotConfig,
    }
  }

  async set(pref: SessionPref): Promise<void> {
    await this.table.set(this.key(), JSON.stringify(pref))
  }
}

import type {
  AssistantMessage,
  ContentBlock,
  SessionEvent,
  ToolEvent,
  Turn,
  Watermark,
} from './types.js'

function contentOf(data: Record<string, unknown> | undefined): ContentBlock[] {
  if (data === undefined) return []
  const c = data.content
  return Array.isArray(c) ? (c as ContentBlock[]) : []
}

/** 拼接内容块中的纯文本（标题截断、分类输入等处使用）。 */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function numberFrom(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function toToolEvent(e: SessionEvent): ToolEvent {
  const d = e.data ?? {}
  const name = (d.name ?? d.tool ?? d.toolName) as string | undefined
  return {
    seq: e.seq ?? 0,
    time: e.time ?? 0,
    kind: e.type.includes('call') ? 'call' : e.type.includes('result') ? 'result' : 'other',
    ...(name !== undefined ? { name } : {}),
    payload: d,
  }
}

/**
 * 把事件流折叠为逻辑轮次：
 * - turn/start..turn/end 界定轮次边界；
 * - user/message：仅 source.kind === 'user' 且 surfaceOp === 'append'（排除压缩检查点等插件消息）；
 * - assistant/message：surfaceOp === 'append'；
 * - tool/call：额外记入轮次（仅用于「产物」提取）；
 * - deliverables/presented：记入所属轮次（仅用于「产物」提取）。
 * 内部事件（chunk、retry、title-llm-request、compaction 等）直接忽略。
 */
export function foldTurns(events: readonly SessionEvent[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const e of events) {
    if (e.type === 'turn/start' && e.seq !== undefined) {
      current = {
        turnNo: numberFrom(e.data?.turn),
        startSeq: e.seq,
        endSeq: e.seq,
        startTime: e.time ?? 0,
        endTime: e.time ?? 0,
        completed: false,
        user: [],
        assistant: [],
        tools: [],
        toolCalls: [],
        deliverables: [],
      }
      turns.push(current)
      continue
    }
    if (e.type === 'turn/end' && current !== null && e.seq !== undefined) {
      current.endSeq = e.seq
      current.endTime = e.time ?? current.endTime
      current.completed = true
      continue
    }
    if (current === null) continue

    if (e.type === 'user/message' && e.seq !== undefined) {
      const source = e.data?.source as { kind?: unknown } | undefined
      if (source?.kind === 'user' && e.surfaceOp === 'append') {
        const id = typeof e.data?.id === 'string' ? e.data.id : undefined
        current.user.push({
          seq: e.seq,
          time: e.time ?? 0,
          ...(id !== undefined ? { id } : {}),
          content: contentOf(e.data),
        })
      }
      continue
    }

    if (e.type === 'assistant/message' && e.seq !== undefined && e.surfaceOp === 'append') {
      const msg = e.data?.message as
        | { id?: string; content?: ContentBlock[]; source?: { model?: string } }
        | undefined
      const usage = e.data?.usage as AssistantMessage['usage'] | undefined
      const id = msg?.id
      const model = msg?.source?.model
      current.assistant.push({
        seq: e.seq,
        time: e.time ?? 0,
        ...(id !== undefined ? { id } : {}),
        content: msg?.content ?? contentOf(e.data),
        ...(model !== undefined ? { model } : {}),
        ...(usage !== undefined ? { usage } : {}),
      })
      continue
    }

    if (e.type === 'tool/call' && e.seq !== undefined) {
      const d = e.data ?? {}
      const name = typeof d.name === 'string' ? d.name : typeof d.tool === 'string' ? d.tool : ''
      const args = typeof d.arguments === 'string' ? d.arguments : ''
      if (name !== '') current.toolCalls.push({ name, arguments: args })
    }

    if (e.type === 'deliverables/presented' && e.seq !== undefined) {
      // 交付事件可能带 turn 号；找不到对应轮次时归入当前轮次。
      const turnNo = numberFrom(e.data?.turn)
      const target = turns.find((t) => t.turnNo === turnNo) ?? current
      const files = e.data?.files
      if (Array.isArray(files)) {
        for (const f of files) {
          const o = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>
          const path = typeof o.path === 'string' ? o.path : ''
          if (path === '') continue
          const description = typeof o.description === 'string' ? o.description : undefined
          target.deliverables.push({ path, ...(description !== undefined ? { description } : {}) })
        }
      }
    }

    if (e.type.startsWith('tool/') && e.seq !== undefined) {
      current.tools.push(toToolEvent(e))
    }
  }

  return turns
}

export interface IncrementResult {
  /** 存在可导出的完整新轮次。 */
  hasNew: boolean
  turns: Turn[]
  /** 存在进行中的轮次（未完成或缺少成对问答），提示用户但不算错误。 */
  inProgress: boolean
}

/**
 * 增量提取：只取「已完成、endSeq > 水位、且用户消息与助手回答成对」的轮次。
 * 进行中轮次单独标记（当前轮次尚未完成）。
 */
export function collectIncrement(turns: readonly Turn[], watermark: Watermark): IncrementResult {
  const inProgress = turns.some((t) => !t.completed && t.endSeq > watermark.lastTurnEndSeq)
  const selected = turns.filter(
    (t) =>
      t.completed &&
      t.endSeq > watermark.lastTurnEndSeq &&
      t.user.length > 0 &&
      t.assistant.length > 0,
  )
  return { hasNew: selected.length > 0, turns: selected, inProgress }
}

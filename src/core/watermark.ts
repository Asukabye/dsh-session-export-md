import type { SessionEvent, Turn, Watermark } from './types.js'

/** 事件流中最后一个 turn/end 的 seq 与 time；无则返回 undefined。 */
export function latestTurnEnd(
  events: readonly SessionEvent[],
): { seq: number; time: number } | undefined {
  let best: { seq: number; time: number } | undefined
  for (const e of events) {
    if (e.type === 'turn/end' && e.seq !== undefined) {
      if (best === undefined || e.seq > best.seq) {
        best = { seq: e.seq, time: e.time ?? 0 }
      }
    }
  }
  return best
}

/**
 * 无新对话判断：max(turn/end seq) ≤ 水位 seq。
 * 该判断在一切 LLM 调用之前执行（建议 3：无新对话短路）。
 */
export function hasNewConversation(
  events: readonly SessionEvent[],
  watermark: Watermark,
): boolean {
  const end = latestTurnEnd(events)
  return end !== undefined && end.seq > watermark.lastTurnEndSeq
}

/** 依据已导出轮次推进水位；段编号按追加段数累加。 */
export function advanceWatermark(
  watermark: Watermark,
  turns: readonly Pick<Turn, 'endSeq' | 'endTime'>[],
  appendedSegments: number,
): Watermark {
  const next: Watermark = { ...watermark }
  for (const t of turns) {
    if (t.endSeq > next.lastTurnEndSeq) {
      next.lastTurnEndSeq = t.endSeq
      next.lastTurnEndTime = t.endTime
    }
  }
  next.lastSegmentNo += appendedSegments
  return next
}

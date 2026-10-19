import type { ChangeRecord, ContentBlock, SessionEvent, Turn, Watermark } from './types.js'

function contentOf(data: Record<string, unknown> | undefined): ContentBlock[] {
  if (data === undefined) return []
  const msg = data.message as { content?: unknown } | undefined
  const c = Array.isArray(msg?.content) ? msg.content : data.content
  return Array.isArray(c) ? (c as ContentBlock[]) : []
}

/**
 * 检测「已导出内容被编辑/撤回」（规则：变更标记两处）。
 *
 * 判定：surfaceOp 为替换对象（op: replace|withdraw）、替换事件本身位于增量区
 * （seq > 水位），且替换范围与已导出区间相交（start ≤ 水位 seq）。
 * 完全位于未导出区的替换不产生标记（该内容从未导出过）。
 *
 * @param turns 用于把 seq 范围映射回轮次号（标题下标记需要）。
 */
export function detectChanges(
  events: readonly SessionEvent[],
  watermark: Watermark,
  turns: readonly Turn[] = [],
): ChangeRecord[] {
  const records: ChangeRecord[] = []
  for (const e of events) {
    if (e.seq === undefined || e.seq <= watermark.lastTurnEndSeq) continue
    const op = e.surfaceOp
    if (typeof op === 'string' || op === undefined) continue
    if (op.op !== 'replace' && op.op !== 'withdraw') continue
    const start = op.start ?? 0
    const end = op.end ?? start
    if (start > watermark.lastTurnEndSeq) continue

    const newContent = contentOf(e.data)
    const kind: ChangeRecord['kind'] =
      op.op === 'withdraw' || newContent.length === 0 ? 'withdraw' : 'edit'
    const turnNo = turns.find((t) => t.startSeq <= start && start <= t.endSeq)?.turnNo
    records.push({
      kind,
      seq: e.seq,
      time: e.time ?? 0,
      targetStart: start,
      targetEnd: end,
      ...(turnNo !== undefined ? { turnNo } : {}),
      ...(kind === 'edit' ? { newContent } : {}),
    })
  }
  return records
}

/** 取属于某个轮次的变更记录（turnNo 缺失时按 seq 范围回退匹配）。 */
export function changesForTurn(changes: readonly ChangeRecord[], turn: Turn): ChangeRecord[] {
  return changes.filter(
    (c) =>
      c.turnNo === turn.turnNo ||
      (c.turnNo === undefined && c.targetStart >= turn.startSeq && c.targetStart <= turn.endSeq),
  )
}

import { describe, expect, it } from 'vitest'
import { changesForTurn, detectChanges } from '../src/core/change-detector.js'
import { foldTurns } from '../src/core/reader.js'
import type { SessionEvent, Watermark } from '../src/core/types.js'

function mk(
  type: string,
  seq: number,
  time: number,
  data?: Record<string, unknown>,
  surfaceOp?: unknown,
): SessionEvent {
  return {
    type,
    seq,
    time,
    ...(data !== undefined ? { data } : {}),
    ...(surfaceOp !== undefined ? { surfaceOp: surfaceOp as SessionEvent['surfaceOp'] } : {}),
  } as SessionEvent
}

const w8: Watermark = { sessionId: 's', lastTurnEndSeq: 8, lastTurnEndTime: 9, lastSegmentNo: 2, mdPath: 'x.md' }

function baseEvents(): SessionEvent[] {
  return [
    mk('turn/start', 1, 2, { turn: 1 }),
    mk('user/message', 2, 3, { id: 'u1', role: 'user', content: [{ type: 'text', text: '原问题' }], source: { kind: 'user' } }, 'append'),
    mk('assistant/message', 3, 4, { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model', model: 'm' } } }, 'append'),
    mk('turn/end', 4, 5, { turn: 1, reason: { kind: 'completed' } }),
    mk('turn/start', 5, 6, { turn: 2 }),
    mk('user/message', 6, 7, { id: 'u2', role: 'user', content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } }, 'append'),
    mk('assistant/message', 7, 8, { message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '回答二' }], source: { kind: 'model', model: 'm' } } }, 'append'),
    mk('turn/end', 8, 9, { turn: 2, reason: { kind: 'completed' } }),
  ]
}

describe('detectChanges', () => {
  it('检测已导出问题被编辑（替换事件在增量区且范围触及已导出内容）', () => {
    const events = [
      ...baseEvents(),
      mk('user/message', 9, 10, { id: 'u1b', role: 'user', content: [{ type: 'text', text: '编辑后的问题' }], source: { kind: 'user' } }, { op: 'replace', start: 2, end: 2 }),
    ]
    const turns = foldTurns(events)
    const changes = detectChanges(events, w8, turns)
    expect(changes).toHaveLength(1)
    expect(changes[0]!).toMatchObject({ kind: 'edit', targetStart: 2, targetEnd: 2, turnNo: 1 })
    expect(changes[0]!.newContent).toEqual([{ type: 'text', text: '编辑后的问题' }])
    expect(changesForTurn(changes, turns[0]!)).toHaveLength(1)
    expect(changesForTurn(changes, turns[1]!)).toHaveLength(0)
  })

  it('撤回（withdraw）不携带新内容', () => {
    const events = [
      ...baseEvents(),
      mk('user/message', 9, 10, { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, { op: 'withdraw', start: 2, end: 2 }),
    ]
    const changes = detectChanges(events, w8, foldTurns(events))
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe('withdraw')
    expect(changes[0]!.newContent).toBeUndefined()
  })

  it('替换范围完全在未导出区时不产生标记', () => {
    const events = [
      ...baseEvents(),
      mk('user/message', 9, 10, { content: [{ type: 'text', text: 'x' }] }, { op: 'replace', start: 9, end: 9 }),
    ]
    expect(detectChanges(events, w8, foldTurns(events))).toHaveLength(0)
  })

  it('替换事件自身已在导出范围内（seq ≤ 水位）时不产生标记', () => {
    const events = [
      ...baseEvents(),
      mk('user/message', 7, 8, { content: [{ type: 'text', text: 'x' }] }, { op: 'replace', start: 2, end: 2 }),
    ]
    expect(detectChanges(events, w8, foldTurns(events))).toHaveLength(0)
  })
})

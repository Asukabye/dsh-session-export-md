import { describe, expect, it } from 'vitest'
import { collectIncrement, foldTurns } from '../src/core/reader.js'
import { advanceWatermark, hasNewConversation, latestTurnEnd } from '../src/core/watermark.js'
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

function fixture(): SessionEvent[] {
  return [
    { type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/work' },
    mk('turn/start', 1, 2, { turn: 1 }),
    mk('user/message', 2, 3, {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '问题一' }],
      source: { kind: 'user' },
    }, 'append'),
    mk('assistant/message', 3, 4, {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '回答一' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
      usage: { inputTokens: 10, outputTokens: 20 },
    }, 'append'),
    mk('turn/end', 4, 5, { turn: 1, reason: { kind: 'completed' } }),
    mk('turn/start', 5, 6, { turn: 2 }),
    mk('user/message', 6, 7, {
      id: 'u2',
      role: 'user',
      content: [{ type: 'text', text: '问题二' }],
      source: { kind: 'user' },
    }, 'append'),
    mk('assistant/message', 7, 8, {
      turn: 2,
      step: 1,
      message: {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: '回答二' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    }, 'append'),
    mk('turn/end', 8, 9, { turn: 2, reason: { kind: 'completed' } }),
    // 进行中轮次：有 start 与用户消息，尚无回答与 end
    mk('turn/start', 9, 10, { turn: 3 }),
    mk('user/message', 10, 11, {
      id: 'u3',
      role: 'user',
      content: [{ type: 'text', text: '问题三' }],
      source: { kind: 'user' },
    }, 'append'),
  ]
}

const w0: Watermark = { sessionId: 's1', lastTurnEndSeq: 0, lastTurnEndTime: 0, lastSegmentNo: 0, mdPath: 'x.md' }

describe('foldTurns', () => {
  it('折叠出轮次并提取用户问题与助手回答', () => {
    const turns = foldTurns(fixture())
    expect(turns).toHaveLength(3)
    const t1 = turns[0]!
    const t2 = turns[1]!
    const t3 = turns[2]!
    expect(t1.completed).toBe(true)
    expect(t1.turnNo).toBe(1)
    expect(t1.user).toHaveLength(1)
    expect(t1.user[0]!.content[0]).toEqual({ type: 'text', text: '问题一' })
    expect(t1.assistant).toHaveLength(1)
    expect(t1.assistant[0]!.content[0]).toEqual({ type: 'text', text: '回答一' })
    expect(t1.assistant[0]!.model).toBe('mock')
    expect(t1.assistant[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(t2.completed).toBe(true)
    expect(t3.completed).toBe(false)
    expect(t3.user).toHaveLength(1)
    expect(t3.assistant).toHaveLength(0)
  })

  it('插件来源的 user/message（压缩检查点）不算用户消息', () => {
    const events = [
      mk('turn/start', 0, 0, { turn: 1 }),
      mk('user/message', 1, 1, {
        id: 'cp',
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }, 'append'),
      mk('turn/end', 2, 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const turns = foldTurns(events)
    expect(turns[0]!.user).toHaveLength(0)
  })

  it('记录 tool/call 与 deliverables/presented（产物提取输入；工具载荷不进正文）', () => {
    const events = [
      mk('turn/start', 0, 0, { turn: 1 }),
      mk('user/message', 1, 1, { id: 'u', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, 'append'),
      mk('assistant/message', 2, 2, { message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'a' }], source: { kind: 'model', model: 'm' } } }, 'append'),
      mk('tool/call', 3, 3, { name: 'write', arguments: '{"file_path":"src/a.ts"}' }),
      mk('deliverables/presented', 4, 4, { turn: 1, files: [{ path: 'out/report.md', description: '报告' }, {}, { path: '' }] }),
      mk('turn/end', 5, 5, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const turns = foldTurns(events)
    expect(turns[0]!.toolCalls).toEqual([{ name: 'write', arguments: '{"file_path":"src/a.ts"}' }])
    expect(turns[0]!.deliverables).toEqual([{ path: 'out/report.md', description: '报告' }])
    // 工具事件仍只作内部记录，问答内容不受影响
    expect(turns[0]!.assistant).toHaveLength(1)
  })

  it('deliverables 带未知 turn 号时归入当前轮次', () => {
    const events = [
      mk('turn/start', 0, 0, { turn: 1 }),
      mk('user/message', 1, 1, { id: 'u', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, 'append'),
      mk('deliverables/presented', 2, 2, { turn: 99, files: [{ path: 'x.md' }] }),
      mk('turn/end', 3, 3, { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(foldTurns(events)[0]!.deliverables).toEqual([{ path: 'x.md' }])
  })

  it('忽略 assistant/chunk、llm/retry 等内部事件', () => {
    const events = [
      mk('turn/start', 0, 0, { turn: 1 }),
      mk('user/message', 1, 1, { id: 'u', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, 'append'),
      mk('assistant/chunk', 2, 2, { chunk: { type: 'text-delta', text: 'a' } }),
      mk('llm/retry', 3, 3, { retryId: 'r1', failure: {} }),
      mk('assistant/message', 4, 4, { message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'a' }], source: { kind: 'model', model: 'm' } } }, 'append'),
      mk('turn/end', 5, 5, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const turns = foldTurns(events)
    expect(turns[0]!.assistant).toHaveLength(1)
    expect(turns[0]!.assistant[0]!.content[0]).toEqual({ type: 'text', text: 'a' })
  })
})

describe('collectIncrement / watermark', () => {
  const turns = foldTurns(fixture())

  it('首次导出：全部已完成轮次为增量，进行中轮次被标记', () => {
    const inc = collectIncrement(turns, w0)
    expect(inc.hasNew).toBe(true)
    expect(inc.inProgress).toBe(true)
    expect(inc.turns.map(t => t.turnNo)).toEqual([1, 2])
  })

  it('水位推进后无新对话（短路判断）', () => {
    const w1 = advanceWatermark(w0, [{ endSeq: 8, endTime: 9 }], 2)
    expect(w1.lastTurnEndSeq).toBe(8)
    expect(w1.lastSegmentNo).toBe(2)
    expect(hasNewConversation(fixture(), w1)).toBe(false)
    expect(collectIncrement(turns, w1).hasNew).toBe(false)
  })

  it('只导过第一轮时，仅第二轮为增量', () => {
    const wMid: Watermark = { ...w0, lastTurnEndSeq: 4, lastTurnEndTime: 5, lastSegmentNo: 1 }
    const inc = collectIncrement(turns, wMid)
    expect(inc.turns.map(t => t.turnNo)).toEqual([2])
  })

  it('latestTurnEnd 返回最大 seq 的 turn/end', () => {
    expect(latestTurnEnd(fixture())).toEqual({ seq: 8, time: 9 })
    expect(latestTurnEnd([])).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { changesForTurn, detectChanges } from '../src/core/change-detector.js'
import { collectIncrement, foldTurns } from '../src/core/reader.js'
import {
  renderChangeLog,
  renderSegmentAnnotation,
  renderToc,
} from '../src/core/renderer.js'
import { appendExport, composeExport } from '../src/core/writer.js'
import { advanceWatermark } from '../src/core/watermark.js'
import { tocEntriesOf } from '../src/service/export-service.js'
import type { ExportSegment, SessionEvent, Strategy, Watermark } from '../src/core/types.js'

/** 双维度策略夹具。 */
const strategy: Strategy = {
  id: 'dev-phase',
  name: '常规开发规模',
  source: 'builtin',
  dimensions: [
    {
      id: 'phase',
      name: '开发阶段',
      modules: [{ name: '需求分析' }, { name: '其他' }],
      defaultModule: '其他',
    },
    {
      id: 'purpose',
      name: '对话功能/目的',
      modules: [{ name: '问答型' }, { name: '其他' }],
      defaultModule: '其他',
    },
  ],
}

const w0: Watermark = { sessionId: 's1', lastTurnEndSeq: 0, lastTurnEndTime: 0, lastSegmentNo: 0, mdPath: 'out.md' }

function mk(type: string, seq: number, time: number, data?: Record<string, unknown>, surfaceOp?: unknown): SessionEvent {
  return {
    type,
    seq,
    time,
    ...(data !== undefined ? { data } : {}),
    ...(surfaceOp !== undefined ? { surfaceOp: surfaceOp as SessionEvent['surfaceOp'] } : {}),
  } as SessionEvent
}

function turn(no: number, startSeq: number, userSeq: number, asstSeq: number, endSeq: number, q: string, a: string): SessionEvent[] {
  return [
    mk('turn/start', startSeq, startSeq, { turn: no }),
    mk('user/message', userSeq, userSeq, { id: `u${no}`, role: 'user', content: [{ type: 'text', text: q }], source: { kind: 'user' } }, 'append'),
    mk('assistant/message', asstSeq, asstSeq, { message: { id: `a${no}`, role: 'assistant', content: [{ type: 'text', text: a }], source: { kind: 'model', model: 'flash' } } }, 'append'),
    mk('turn/end', endSeq, endSeq, { turn: no, reason: { kind: 'completed' } }),
  ]
}

const meta = { sessionId: 's1', title: '对话导出：pipeline', exportedAtMs: 1000, model: 'flash' }

describe('端到端：两轮导出（增量 + 编辑标记两处 + 水位推进）', () => {
  it('第一次导出 → 编辑问题一 + 新增轮次三 → 第二次导出', () => {
    // 第一轮事件：两个完整轮次
    const round1: SessionEvent[] = [
      ...turn(1, 1, 2, 3, 4, '问题一', '回答一'),
      ...turn(2, 5, 6, 7, 8, '问题二', '回答二'),
    ]
    const turns1 = foldTurns(round1)
    const inc1 = collectIncrement(turns1, w0)
    expect(inc1.turns.map(t => t.turnNo)).toEqual([1, 2])
    const segs1: ExportSegment[] = inc1.turns.map((t, i) => ({
      no: i + 1,
      title: `标题${t.turnNo}`,
      labels: { phase: '需求分析', purpose: '问答型' },
      summary: '',
      artifacts: [],
      changes: [],
      turn: t,
    }))
    const doc1 = composeExport({ meta, strategy, segments: segs1, toc: tocEntriesOf(strategy, segs1) })
    expect(doc1.startsWith('---\nformat: 10\n')).toBe(true)
    expect(doc1).toContain('### 第 1 轮：标题1')
    expect(doc1).toContain('### 第 2 轮：标题2')
    // 轮次之间是 `---` 分隔线（format 10）
    expect(doc1).toContain('### 第 1 轮：标题1')
    const body1 = doc1.slice(doc1.indexOf('## 对话正文'), doc1.indexOf('## 备注'))
    expect(body1.split('\n---\n')).toHaveLength(2)
    expect(doc1).not.toContain('**分类**')
    expect(doc1).toContain('#开发阶段/需求分析 #对话功能-目的/问答型')
    // 目录：维度 `###` + 模块加粗计数 + wiki 链接，空模块只留一行加粗
    expect(doc1).toContain(
      '**1. 需求分析**（2 轮）\n' +
        '- [[#第 1 轮：标题1]]\n- [[#第 2 轮：标题2]]',
    )
    expect(doc1).toContain('\n**2. 其他**\n')
    expect(doc1).not.toContain('**2. 其他**（')
    expect(doc1).not.toContain('[!note]')
    expect(doc1).not.toContain('<!--')
    expect(doc1).not.toContain('#turn-')
    const w1 = advanceWatermark(w0, inc1.turns, segs1.length)
    expect(w1.lastTurnEndSeq).toBe(8)

    // 第二轮事件：替换问题一（seq 9）+ 新增轮次三（10..13）
    const round2: SessionEvent[] = [
      ...round1,
      mk('user/message', 9, 10, { id: 'u1b', role: 'user', content: [{ type: 'text', text: '问题一（编辑后）' }], source: { kind: 'user' } }, { op: 'replace', start: 2, end: 2 }),
      ...turn(3, 10, 11, 12, 13, '问题三', '回答三'),
    ]
    const turns2 = foldTurns(round2)
    const inc2 = collectIncrement(turns2, w1)
    expect(inc2.turns.map(t => t.turnNo)).toEqual([3])

    const changes = detectChanges(round2, w1, turns2)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe('edit')

    const turn1 = turns2.find(t => t.turnNo === 1)!
    const seg3: ExportSegment = {
      no: 3,
      title: '标题3',
      labels: { phase: '其他', purpose: '其他' },
      summary: '',
      artifacts: [],
      changes: [],
      turn: inc2.turns[0]!,
    }
    const allSegs = [segs1[0]!, segs1[1]!, seg3]
    const toc = renderToc(strategy, tocEntriesOf(strategy, allSegs))
    const annotation = renderSegmentAnnotation(changesForTurn(changes, turn1))
    const changeLog = renderChangeLog(changes, new Map([[1, 1]]), 2000)

    const res = appendExport({
      existing: doc1,
      meta: { ...meta, exportedAtMs: 2000 },
      strategy,
      segments: [seg3],
      toc,
      watermark: w1,
      appendedSegments: 1,
      appendedTurns: [inc2.turns[0]!],
      allSegments: allSegs,
      segmentAnnotations: [{ no: 1, annotation }],
      changeLog,
    })
    expect(res).not.toBeNull()
    const out = res!.newContent

    // 增量正文已追加（带模型标题）
    expect(out).toContain('### 第 3 轮：标题3')
    expect(out).toContain('#开发阶段/其他 #对话功能-目的/其他')
    expect(out).toContain('回答三')
    // 标记注入到第 1 轮标题之后
    const seg1Heading = out.indexOf('### 第 1 轮')
    const markerAt = out.indexOf('已被编辑')
    expect(markerAt).toBeGreaterThan(seg1Heading)
    expect(out).toContain('> 问题一（编辑后）')
    // 历史正文仍在且未被改写
    expect(out).toContain('回答一')
    // 增量末尾变更记录
    const logAt = out.indexOf('本次变更记录')
    expect(logAt).toBeGreaterThan(out.indexOf('### 第 3 轮'))
    expect(out).toContain('✏️ 编辑问题 `第 1 轮`')
    // 派生区只出现一次
    expect(out.split('## 对话正文')).toHaveLength(2)
    // 水位推进到轮次三
    expect(res!.newWatermark.lastTurnEndSeq).toBe(13)
    expect(res!.newWatermark.lastSegmentNo).toBe(3)

    // 第三轮：无新对话 → 短路
    const w2 = res!.newWatermark
    const inc3 = collectIncrement(foldTurns(round2), w2)
    expect(inc3.hasNew).toBe(false)
  })
})

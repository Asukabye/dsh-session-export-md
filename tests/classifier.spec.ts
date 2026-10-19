import { describe, expect, it } from 'vitest'
import {
  CLASSIFY_MAX_ATTEMPTS,
  DEFAULT_CLASSIFY_BATCH_SIZE,
  FALLBACK_TITLE_MAX_CHARS,
  TITLE_MAX_CHARS,
  buildClassificationPrompt,
  buildDesignStrategyPrompt,
  classifyIncrement,
  fallbackSegmentTitle,
  normalizeTitle,
  parseClassification,
  resolveLabel,
  summaryOfTurn,
  truncateText,
} from '../src/llm/classifier.js'
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm/client.js'
import type { Strategy, Turn, Watermark } from '../src/core/types.js'

/** 测试用双维度策略（每轮同时归入 phase 与 purpose）。 */
const strategy: Strategy = {
  id: 'test-dev',
  name: '测试双维策略',
  source: 'imported',
  dimensions: [
    {
      id: 'phase',
      name: '开发阶段',
      modules: [
        { name: '需求与调研' },
        { name: '方案设计' },
        { name: '编码实现' },
        { name: '调试排错' },
        { name: '其他' },
      ],
      defaultModule: '其他',
    },
    {
      id: 'purpose',
      name: '对话功能/目的',
      modules: [{ name: '问答型' }, { name: '生成型' }, { name: '其他' }],
      defaultModule: '其他',
    },
  ],
}

const phaseDim = strategy.dimensions[0]!

function mockClient(replies: readonly LlmResponse[]): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = []
  let i = 0
  return {
    model: 'flash',
    calls,
    async complete(req) {
      calls.push(req)
      return replies[i++] ?? { text: '' }
    },
  }
}

function turn(no: number, q: string, a: string): Turn {
  return {
    turnNo: no,
    startSeq: no * 10 + 1,
    endSeq: no * 10 + 4,
    startTime: 0,
    endTime: 0,
    completed: true,
    user: [{ seq: no * 10 + 2, time: 0, content: [{ type: 'text', text: q }] }],
    assistant: [{ seq: no * 10 + 3, time: 0, content: [{ type: 'text', text: a }] }],
    tools: [],
    toolCalls: [],
    deliverables: [],
  }
}

function labels(phase: number | string, purpose: number | string): Record<string, number | string> {
  return { phase, purpose }
}

function reply(
  items: readonly { key: string; title?: string; labels: Record<string, number | string> }[],
): string {
  return JSON.stringify({ items })
}

const w0: Watermark = { sessionId: 's', lastTurnEndSeq: 0, lastTurnEndTime: 0, lastSegmentNo: 0, mdPath: 'x.md' }

describe('truncateText / prompt', () => {
  it('按码点截断并加省略号', () => {
    expect(truncateText('abcdef', 3)).toBe('abc…')
    expect(truncateText('😀😀😀😀', 2)).toBe('😀😀…')
    expect(truncateText('短', 5)).toBe('短')
  })

  it('分类提示词按维度分段给出带序号的词表与 title/labels JSON 约定', () => {
    const msgs = buildClassificationPrompt(strategy, [{ key: '1', question: '问题' }])
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[0]!.content).toContain('【维度 phase：开发阶段】共 5 个模块')
    expect(msgs[0]!.content).toContain('1. 需求与调研')
    expect(msgs[0]!.content).toContain('【维度 purpose：对话功能/目的】共 3 个模块')
    // 输出约定同时要求 title 与每个维度的 labels
    expect(msgs[0]!.content).toContain(
      '{"items":[{"key":"1","title":"对话规则添加：回答前复述问题","labels":{"phase":1,"purpose":1}}]}',
    )
    // 标题规则：动作式、字数上限、单行、不加句号、信息不足时依据回答起标题
    expect(msgs[0]!.content).toContain(`不超过 ${String(TITLE_MAX_CHARS)} 个汉字，单行，结尾不加句号`)
    expect(msgs[0]!.content).toContain('动作 + 冒号 + 内容')
    expect(msgs[0]!.content).toContain('依据你的回答内容判断本次在做什么')
    expect(msgs[0]!.content).toContain('labels 的键必须与维度 id 完全一致（phase / purpose）')
    expect(msgs[0]!.content).toContain('兜底模块的序号')
    expect(msgs[1]!.content).toContain('条目 1（key=1）')
    expect(msgs[1]!.content).toContain('问题：问题')
  })

  it('标题上限常量为 20，降级标题与模型标题同一上限', () => {
    expect(TITLE_MAX_CHARS).toBe(20)
    expect(FALLBACK_TITLE_MAX_CHARS).toBe(TITLE_MAX_CHARS)
  })

  it('设计策略提示词要求输出双维度策略 JSON', () => {
    const msgs = buildDesignStrategyPrompt([{ question: 'q', answer: 'a' }])
    expect(msgs[0]!.content).toContain('defaultModule')
    expect(msgs[0]!.content).toContain('dimensions')
    expect(msgs[1]!.content).toContain('样本 1')
  })
})

describe('parseClassification', () => {
  it('解析围栏 JSON 的 title 与 labels（维度 → 序号）', () => {
    const v = parseClassification(
      '```json\n{"items":[{"key":"1","title":"编码实现：补登录测试","labels":{"phase":3,"purpose":2}}]}\n```',
    )
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.items).toEqual([
        { key: '1', title: '编码实现：补登录测试', labels: { phase: 3, purpose: 2 } },
      ])
    }
  })

  it('缺 title 时记为空串（由调用方退化为问题截断）', () => {
    const v = parseClassification('{"items":[{"key":"1","labels":{"phase":3,"purpose":2}}]}')
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.items[0]!.title).toBe('')
  })

  it('title 单行化 + 截断到 20 字（多行标题会破坏标题行与目录项）', () => {
    const v = parseClassification(
      JSON.stringify({
        items: [
          { key: '1', title: '第一行\n第二行', labels: { phase: 3, purpose: 2 } },
          { key: '2', title: '一'.repeat(30), labels: { phase: 3, purpose: 2 } },
          { key: '3', title: 123, labels: { phase: 3, purpose: 2 } },
        ],
      }),
    )
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.items[0]!.title).toBe('第一行 第二行')
      expect(v.items[1]!.title).toBe('一'.repeat(TITLE_MAX_CHARS))
      expect(Array.from(v.items[1]!.title)).toHaveLength(TITLE_MAX_CHARS)
      expect(v.items[2]!.title).toBe('')
    }
  })

  it('容忍字符串序号；无法识别的值记为 undefined（逐条容错，不整批失败）', () => {
    const v = parseClassification('{"items":[{"key":"1","labels":{"phase":"4","purpose":true}},{"key":"2","labels":{"phase":2,"purpose":1}}]}')
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.items[0]!.labels).toEqual({ phase: 4, purpose: undefined })
      expect(v.items[1]!.labels).toEqual({ phase: 2, purpose: 1 })
    }
  })

  it('缺 items 或非 JSON 时报错', () => {
    expect(parseClassification('{"x":1}').ok).toBe(false)
    expect(parseClassification('not json').ok).toBe(false)
    expect(parseClassification({} as unknown).ok).toBe(false)
  })
})

describe('resolveLabel（序号优先，其次同名，最后归一化同名）', () => {
  it('按序号、完全同名、归一化同名依次解析；对不上返回 null', () => {
    expect(resolveLabel(2, phaseDim)).toBe('方案设计')
    expect(resolveLabel('编码实现', phaseDim)).toBe('编码实现')
    expect(resolveLabel(' 编码实现 模块', phaseDim)).toBe('编码实现')
    expect(resolveLabel('调试、排错', phaseDim)).toBe('调试排错')
    expect(resolveLabel(99, phaseDim)).toBeNull()
    expect(resolveLabel(0, phaseDim)).toBeNull()
    expect(resolveLabel('不存在的模块', phaseDim)).toBeNull()
    expect(resolveLabel(undefined, phaseDim)).toBeNull()
  })
})

describe('fallbackSegmentTitle / summaryOfTurn', () => {
  it('标题 = 问题原文单行截断（空则用轮次号），同样受 20 字上限约束', () => {
    expect(fallbackSegmentTitle(turn(7, '第一行\n第二行', 'a'))).toBe('第一行 第二行')
    expect(fallbackSegmentTitle(turn(7, '', 'a'))).toBe('轮次 7')
    expect(normalizeTitle('很长的'.repeat(30), 4)).toBe('很长的很')
    const long = fallbackSegmentTitle(turn(7, '一'.repeat(50), 'a'))
    expect(Array.from(long)).toHaveLength(FALLBACK_TITLE_MAX_CHARS)
    expect(long).toBe('一'.repeat(20))
  })

  it('概要直接取自回答里的概述段，没有则空串', () => {
    expect(summaryOfTurn(turn(1, 'q', '概述：这是概要。\n\n正文。'))).toBe('这是概要。')
    expect(summaryOfTurn(turn(1, 'q', '**概述：**加粗前缀。\n\n正文。'))).toBe('加粗前缀。')
    expect(summaryOfTurn(turn(1, 'q', '没有概述标记的回答。'))).toBe('')
  })
})

describe('classifyIncrement（双维度）', () => {
  const turns = [turn(1, '帮我实现登录功能', '好的，先分析需求…'), turn(2, '为什么测试报错', '错误是端口被占用…')]

  it('批量一次调用，两个维度各自映射模块序号，标题取模型返回（报告 ok）', async () => {
    const client = mockClient([{ text: reply([
      { key: '1', title: '编码实现：登录功能', labels: labels(3, 2) },
      { key: '2', title: '调试排错：测试报错', labels: labels(4, 1) },
    ]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    expect(client.calls).toHaveLength(1) // 批量一次
    expect(segments.map(s => s.no)).toEqual([1, 2])
    expect(segments[0]!.labels).toEqual({ phase: '编码实现', purpose: '生成型' })
    expect(segments[1]!.labels).toEqual({ phase: '调试排错', purpose: '问答型' })
    // 轮次标题由模型生成（不再用问题原文）
    expect(segments.map(s => s.title)).toEqual(['编码实现：登录功能', '调试排错：测试报错'])
    expect(report).toMatchObject({ status: 'ok', batches: 1, failedBatches: 0, calls: 1 })
    expect(report.dimensions).toEqual([
      { id: 'phase', name: '开发阶段', missing: 0, unknown: 0, unmatched: [] },
      { id: 'purpose', name: '对话功能/目的', missing: 0, unknown: 0, unmatched: [] },
    ])
  })

  it('模型没给标题（空/缺字段）时退化为问题原文截断，仍受 20 字上限约束', async () => {
    const longTurn = turn(3, '一'.repeat(50), '回答三')
    const client = mockClient([{ text: reply([
      { key: '1', title: '', labels: labels(3, 2) },
      { key: '2', labels: labels(4, 1) },
      { key: '3', title: '   ', labels: labels(1, 1) },
    ]) }])
    const { segments } = await classifyIncrement(client, strategy, [...turns, longTurn], w0)
    expect(segments[0]!.title).toBe('帮我实现登录功能')
    expect(segments[1]!.title).toBe('为什么测试报错')
    expect(segments[2]!.title).toBe('一'.repeat(TITLE_MAX_CHARS))
  })

  it('模型标题超长时截断到 20 字（单行）', async () => {
    const client = mockClient([{ text: reply([
      { key: '1', title: `编码实现：${'很长的描述'.repeat(6)}`, labels: labels(3, 2) },
      { key: '2', title: '调试排错\n测试报错', labels: labels(4, 1) },
    ]) }])
    const { segments } = await classifyIncrement(client, strategy, turns, w0)
    expect(Array.from(segments[0]!.title)).toHaveLength(TITLE_MAX_CHARS)
    expect(segments[0]!.title).toBe(Array.from(`编码实现：${'很长的描述'.repeat(6)}`).slice(0, TITLE_MAX_CHARS).join(''))
    expect(segments[1]!.title).toBe('调试排错 测试报错')
  })

  it('某一维序号对不上时只降级该维，另一维照常归类（体检报告分维计数）', async () => {
    const client = mockClient([{ text: reply([
      { key: '1', labels: labels(99, 2) },
      { key: '2', labels: labels(4, 1) },
    ]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    expect(segments[0]!.labels).toEqual({ phase: '其他', purpose: '生成型' })
    expect(segments[1]!.labels).toEqual({ phase: '调试排错', purpose: '问答型' })
    expect(report.status).toBe('fallback')
    expect(report.dimensions[0]).toMatchObject({ id: 'phase', unknown: 1, missing: 0, unmatched: ['序号 99'] })
    expect(report.dimensions[1]).toMatchObject({ id: 'purpose', unknown: 0, missing: 0, unmatched: [] })
  })

  it('序号优先：数字与数字字符串都按序号落位', async () => {
    const client = mockClient([{ text: reply([
      { key: '1', labels: { phase: 3, purpose: '2' } },
      { key: '2', labels: { phase: 4, purpose: '1' } },
    ]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    // modules: 1 需求与调研 / 2 方案设计 / 3 编码实现 / 4 调试排错 / 5 其他
    expect(segments[0]!.labels).toEqual({ phase: '编码实现', purpose: '生成型' })
    expect(segments[1]!.labels).toEqual({ phase: '调试排错', purpose: '问答型' })
    expect(report).toMatchObject({ status: 'ok' })
  })

  it('模型改写成模块名也能匹配（精确 / 归一化 / 带序号前缀）', async () => {
    const client = mockClient([{ text: reply([
      { key: '1', labels: { phase: '需求与调研 模块', purpose: '生成型' } },
      { key: '2', labels: { phase: '4. 调试排错', purpose: '1' } },
    ]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    // 归一化（去「模块」后缀）与「序号. 名字」前缀都能落位，不再整维降级
    expect(segments[0]!.labels).toEqual({ phase: '需求与调研', purpose: '生成型' })
    expect(segments[1]!.labels).toEqual({ phase: '调试排错', purpose: '问答型' })
    expect(report).toMatchObject({ status: 'ok' })
    expect(report.dimensions[0]).toMatchObject({ missing: 0, unknown: 0 })
    expect(report.dimensions[1]).toMatchObject({ missing: 0, unknown: 0 })
  })

  it('返回无法识别的值时该维按 missing 降级（并保留原值无从匹配的语义）', async () => {
    const client = mockClient([{ text: reply([
      { key: '1', labels: { phase: '完全对不上的名字', purpose: true } },
      { key: '2', labels: { phase: 4, purpose: 1 } },
    ]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    expect(segments[0]!.labels).toEqual({ phase: '其他', purpose: '其他' })
    expect(segments[1]!.labels).toEqual({ phase: '调试排错', purpose: '问答型' })
    // 名字匹配失败计入 unknown（并把名字写进 unmatched）；非字符串值计入 missing
    expect(report.dimensions[0]).toMatchObject({ missing: 0, unknown: 1 })
    expect(report.dimensions[0]!.unmatched).toEqual(['完全对不上的名字'])
    expect(report.dimensions[1]).toMatchObject({ missing: 1, unknown: 0 })
  })

  it('序号越界且名字对不上时该条该维降级，并把序号写进报告', async () => {
    const client = mockClient([{ text: reply([{ key: '1', labels: labels(99, 99) }]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    expect(segments[0]!.labels).toEqual({ phase: '其他', purpose: '其他' })
    expect(report.dimensions[0]!.unmatched).toEqual(['序号 99'])
    expect(report.dimensions[1]!.unmatched).toEqual(['序号 99'])
  })

  it('缺少某个 key 时只降级该条（每维 missing 计数）', async () => {
    const client = mockClient([{ text: reply([{ key: '1', labels: labels(3, 2) }]) }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0)
    expect(segments[0]!.labels).toEqual({ phase: '编码实现', purpose: '生成型' })
    expect(segments[1]!.labels).toEqual({ phase: '其他', purpose: '其他' })
    expect(report).toMatchObject({ status: 'fallback' })
    expect(report.dimensions[0]).toMatchObject({ missing: 1, unknown: 0 })
    expect(report.dimensions[1]).toMatchObject({ missing: 1, unknown: 0 })
  })

  it('LLM 回复非 JSON 时带纠正提示重试，仍失败才降级并给出原因', async () => {
    const client = mockClient([{ text: '好的，我来分类：' }, { text: '还是不是 JSON' }])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0, { retryBackoffMs: 0 })
    expect(client.calls).toHaveLength(CLASSIFY_MAX_ATTEMPTS)
    expect(client.calls[1]!.messages.at(-1)?.content).toContain('上一次回复不是合法 JSON')
    // 纠正提示同样要求 title，且标注字数上限
    expect(client.calls[1]!.messages.at(-1)?.content).toContain('"title"')
    expect(client.calls[1]!.messages.at(-1)?.content).toContain(`${String(TITLE_MAX_CHARS)}字的动作式标题`)
    expect(segments[0]!.title).toBe('帮我实现登录功能')
    expect(segments[0]!.labels).toEqual({ phase: '其他', purpose: '其他' })
    expect(report.status).toBe('fallback')
    expect(report.reason).toContain('JSON')
    expect(report).toMatchObject({ batches: 1, failedBatches: 1, calls: CLASSIFY_MAX_ATTEMPTS })
  })

  it('重试后成功则报告 ok', async () => {
    const client = mockClient([
      { text: '先说说思路' },
      { text: reply([{ key: '1', labels: labels(3, 2) }, { key: '2', labels: labels(4, 1) }]) },
    ])
    const { segments, report } = await classifyIncrement(client, strategy, turns, w0, { retryBackoffMs: 0 })
    expect(client.calls).toHaveLength(2)
    expect(segments[0]!.labels).toEqual({ phase: '编码实现', purpose: '生成型' })
    expect(report).toMatchObject({ status: 'ok', calls: 2 })
  })

  it('客户端抛错时重试同一批，全失败才降级，原因写进报告', async () => {
    let attempts = 0
    const flaky: LlmClient = {
      model: 'flash',
      async complete() {
        attempts++
        throw new Error('DeepSeek Messages transport failed（TRANSPORT）')
      },
    }
    const { segments, report } = await classifyIncrement(flaky, strategy, turns, w0, { retryBackoffMs: 0 })
    expect(attempts).toBe(CLASSIFY_MAX_ATTEMPTS) // 传输类失败重试到上限
    expect(segments).toHaveLength(2)
    expect(segments.every(s => s.labels.phase === '其他' && s.labels.purpose === '其他')).toBe(true)
    expect(report.status).toBe('fallback')
    expect(report.reason).toContain('TRANSPORT')
    expect(report.reason).toContain('第 1/1 批')
    expect(report).toMatchObject({ batches: 1, failedBatches: 1, calls: CLASSIFY_MAX_ATTEMPTS })
  })

  it('传输抖动：重试后成功则不影响归类', async () => {
    let attempts = 0
    const flaky: LlmClient = {
      model: 'flash',
      async complete() {
        attempts++
        if (attempts === 1) throw new Error('DeepSeek Messages transport failed（TRANSPORT）')
        return { text: reply([{ key: '1', labels: labels(3, 2) }, { key: '2', labels: labels(4, 1) }]) }
      },
    }
    const { report } = await classifyIncrement(flaky, strategy, turns, w0, { retryBackoffMs: 0 })
    expect(attempts).toBe(2)
    expect(report).toMatchObject({ status: 'ok', failedBatches: 0, calls: 2 })
  })

  it(`分批调用：24 轮按 ${String(DEFAULT_CLASSIFY_BATCH_SIZE)} 轮一批共 3 次请求，某批失败只影响该批`, async () => {
    const many = Array.from({ length: 24 }, (_, i) => turn(i + 1, `问题${String(i + 1)}`, `回答${String(i + 1)}`))
    const replies = [0, 1, 2].map((batch) => {
      const base = batch * 8
      return {
        text: reply(
          Array.from({ length: 8 }, (_, i) => ({
            key: String(base + i + 1),
            // 第 2 批的 phase 序号对不上：只该批降级
            labels: labels(batch === 1 ? 99 : 3, 1),
          })),
        ),
      }
    })
    const client = mockClient(replies)
    const { segments, report } = await classifyIncrement(client, strategy, many, w0, { retryBackoffMs: 0 })
    expect(client.calls).toHaveLength(3)
    expect(report).toMatchObject({ status: 'fallback', batches: 3, failedBatches: 0 })
    expect(report.dimensions[0]).toMatchObject({ unknown: 8, missing: 0 })
    expect(report.dimensions[1]).toMatchObject({ unknown: 0, missing: 0 })
    // 第 1、3 批正常归类；第 2 批（序号越界）只影响它自己那 8 条
    expect(segments[0]!.labels.phase).toBe('编码实现')
    expect(segments[10]!.labels.phase).toBe('其他')
    expect(segments[10]!.labels.purpose).toBe('问答型')
    expect(segments[20]!.labels.phase).toBe('编码实现')
    expect(segments[0]!.no).toBe(1)
    expect(segments[23]!.no).toBe(24)
  })
})

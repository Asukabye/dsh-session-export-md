import { describe, expect, it } from 'vitest'
import {
  ExportService,
  type ExportDeps,
  type FsAdapter,
} from '../src/service/export-service.js'
import {
  DEFAULT_STRATEGY,
  StrategyStore,
  UNCLASSIFIED_STRATEGY_ID,
  type KvTable,
} from '../src/core/strategies.js'
import { CategorizeStore, SessionPrefStore, WatermarkStore } from '../src/service/persistence.js'
import { LlmRouter, type LlmClient, type LlmRequest } from '../src/llm/client.js'
import type { SessionEvent } from '../src/core/types.js'

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

function baseEvents(): SessionEvent[] {
  return [
    ...turn(1, 1, 2, 3, 4, '问题一', '回答一'),
    ...turn(2, 5, 6, 7, 8, '问题二', '回答二'),
  ]
}

/** 一轮 + 若干 tool/call（产物提取只认 write/pwsh/web_fetch 等工具事件）。 */
function turnWithCalls(
  no: number,
  startSeq: number,
  q: string,
  a: string,
  calls: readonly { name: string; arguments: Record<string, unknown> }[],
): SessionEvent[] {
  const events = turn(no, startSeq, startSeq + 1, startSeq + 2, startSeq + 10, q, a)
  const tools = calls.map((call, index) =>
    mk('tool/call', startSeq + 3 + index, startSeq + 3 + index, {
      turn: no,
      step: 1,
      callId: `call_${String(no)}_${String(index)}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    }))
  return [...events.slice(0, 3), ...tools, events[3]!]
}

/** 第一轮带三类产物（命令/文档/链接）的会话事件。 */
function artifactEvents(): SessionEvent[] {
  return [
    ...turnWithCalls(1, 1, '问题一（带产物）', '回答一', [
      { name: 'pwsh', arguments: { command: 'npx vitest run' } },
      { name: 'write', arguments: { file_path: 'notes/README.md' } },
      { name: 'web_fetch', arguments: { url: 'https://example.com/docs' } },
    ]),
    ...turnWithCalls(2, 20, '问题二（带产物）', '回答二', [
      { name: 'pwsh', arguments: { command: 'npx tsc --noEmit' } },
    ]),
  ]
}

/** makeDeps 里会话偏好记住的导出路径与它的附件目录。 */
const DEFAULT_PATH = '.chat-exports/x.md'
const ATTACH_DIR = '.chat-exports/x.artifacts'

function memoryKv(): KvTable & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async get(key) { return data.get(key) ?? null },
    async set(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
    async keys() { return [...data.keys()] },
  }
}

interface MemoryFs extends FsAdapter {
  files: Map<string, string>
  /** 写入顺序（含附件与正文，用于断言「先写附件再写正文」）。 */
  writes: string[]
}

function memoryFs(): MemoryFs {
  const files = new Map<string, string>()
  const writes: string[] = []
  return {
    files,
    writes,
    async readFile(path) { return files.get(path) ?? null },
    async writeFile(path, content) {
      writes.push(path)
      files.set(path, content)
    },
  }
}

function mockLlm(replies: string[]): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = []
  let i = 0
  return {
    model: 'flash',
    calls,
    async complete(req) {
      calls.push(req)
      return { text: replies[i++] ?? '' }
    },
  }
}

/** 双维度分类回复（title = 模型生成的轮次标题，可省；labels = 维度 id → 模块序号/模块名）。 */
function classifyReply(
  items: readonly { key: string; title?: string; labels: Record<string, number | string> }[],
): string {
  return JSON.stringify({ items })
}

/** 测试用已保存策略（双维度，词表比 DEFAULT_STRATEGY 短）。 */
const TEST_STRATEGY_ID = 'test-dev'
/** phase 序号：1 需求与调研 / 2 方案设计 / 3 编码实现 / 4 调试排错 / 5 其他。 */
const PHASE = { req: 1, design: 2, code: 3, debug: 4, other: 5 } as const
/** purpose 序号：1 问答型 / 2 生成型 / 3 其他。 */
const PURPOSE = { qa: 1, gen: 2, other: 3 } as const

async function seedTestStrategy(strategies: StrategyStore): Promise<void> {
  await strategies.put({
    id: TEST_STRATEGY_ID,
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
  })
}

async function seedAltStrategy(strategies: StrategyStore): Promise<void> {
  await strategies.put({
    id: 'alt',
    name: '替代策略',
    source: 'imported',
    dimensions: [
      {
        id: 'kind',
        name: '类别',
        modules: [{ name: 'Docs' }, { name: 'Code' }, { name: 'Misc' }],
        defaultModule: 'Misc',
      },
      {
        id: 'tone',
        name: '语气',
        modules: [{ name: '正式' }, { name: '随意' }],
        defaultModule: '随意',
      },
    ],
  })
}

async function makeDeps(
  state: { list: SessionEvent[] },
  llmReplies: string[],
  options: { withStrategy?: boolean } = {},
): Promise<ExportDeps> {
  const kv = memoryKv()
  const strategies = new StrategyStore(kv)
  if (options.withStrategy !== false) await seedTestStrategy(strategies)
  const sid = 's1'
  const prefs = new SessionPrefStore(kv, sid)
  if (options.withStrategy !== false) {
    const pref = await prefs.get('.chat-exports/x.md')
    await prefs.set({ ...pref, currentStrategyId: TEST_STRATEGY_ID })
  }
  const llm = mockLlm(llmReplies)
  return {
    events: { async events() { return state.list } },
    fs: memoryFs(),
    watermarks: new WatermarkStore(kv, sid),
    categorize: new CategorizeStore(kv, sid),
    prefs,
    strategies,
    router: new LlmRouter(llm, undefined, {
      classify: { kind: 'remote', model: 'flash' },
      designStrategy: { kind: 'remote', model: 'flash' },
    }),
    session: { id: sid, title: '测试会话', workspace: 'D:/w', model: 'flash', createdAtMs: 1000 },
    now: () => 2000,
    // 单测里不要真的等待退避
    classifyOptions: { retryBackoffMs: 0 },
  }
}

/** 两轮的标准双维度回复（含模型生成的轮次标题）。 */
function twoTurnReply(): string {
  return classifyReply([
    { key: '1', title: '需求提出：导出对话', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
    { key: '2', title: '方案设计：定导出格式', labels: { phase: PHASE.design, purpose: PURPOSE.qa } },
  ])
}

describe('ExportService.run（LLM 工具路径）', () => {
  it('首次导出：写 format=10 文件、按双维度入库归类与标题、更新水位', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    const res = await svc.run()
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.appendedSegments).toBe(2)
      // 展示用标题 = 模型生成的轮次标题
      expect(res.titles).toEqual(['需求提出：导出对话', '方案设计：定导出格式'])
    }
    const files = (deps.fs as MemoryFs).files
    const [path, content] = [...files.entries()][0]!
    expect(path).toContain('.chat-exports')
    expect(content.startsWith('---\nformat: 10\n')).toBe(true)
    expect(content).toContain('# 对话信息')
    expect(content).toContain('### 第 1 轮：需求提出：导出对话')
    expect(content).toContain('### 第 2 轮：方案设计：定导出格式')
    // 轮次之间是 `---` 分隔线
    expect(content).toContain('> 回答一\n\n---\n\n### 第 2 轮：方案设计：定导出格式')

    // 分类改为 Obsidian 原生标签行（不再有 `**分类**：…`）
    expect(content).not.toContain('**分类**')
    expect(content).toContain('#开发阶段/需求与调研 #对话功能-目的/生成型')
    expect(content).toContain('#开发阶段/方案设计 #对话功能-目的/问答型')
    expect(content).toContain('> [!question] 用户\n> 问题一')
    expect(content).toContain('> [!quote] 回答\n> 回答一')
    // 目录：维度 `###` + 有轮次的模块加粗计数 + wiki 链接（正文零标记，链接指向同名标题）
    expect(content).toContain('### 开发阶段')
    expect(content).toContain(
      '**1. 需求与调研**（1 轮）\n- [[#第 1 轮：需求提出：导出对话]]',
    )
    expect(content).toContain(
      '**2. 方案设计**（1 轮）\n- [[#第 2 轮：方案设计：定导出格式]]',
    )
    expect(content).not.toContain('[!note]')
    expect(content).not.toContain('<!--')
    expect(content).not.toContain('#turn-')
    const wm = await deps.watermarks.get()
    expect(wm?.lastTurnEndSeq).toBe(8)
    expect(wm?.lastSegmentNo).toBe(2)
    expect((await deps.categorize.get())['1']).toMatchObject({
      title: '需求提出：导出对话',
      labels: { phase: '需求与调研', purpose: '生成型' },
      turnNo: 1,
    })
  })

  it('二次导出：只追加 + 标题下标记 + 末尾变更记录 + 水位推进', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [
      twoTurnReply(),
      classifyReply([{ key: '3', title: '编码实现：新增第三轮', labels: { phase: PHASE.code, purpose: PURPOSE.gen } }]),
    ])
    const svc = new ExportService(deps)
    await svc.run()

    // 第二轮：编辑问题一（seq 9）+ 新轮次三（10..13）
    state.list = [
      ...baseEvents(),
      mk('user/message', 9, 10, { id: 'u1b', role: 'user', content: [{ type: 'text', text: '问题一（编辑后）' }], source: { kind: 'user' } }, { op: 'replace', start: 2, end: 2 }),
      ...turn(3, 10, 11, 12, 13, '问题三', '回答三'),
    ]
    const res = await svc.run()
    expect(res.status).toBe('ok')
    const content = [...(deps.fs as MemoryFs).files.values()][0]!

    expect(content).toContain('### 第 3 轮：编码实现：新增第三轮')
    expect(content).toContain('#开发阶段/编码实现 #对话功能-目的/生成型')
    expect(content).toContain('回答三')
    const seg1 = content.indexOf('### 第 1 轮')
    const seg3 = content.indexOf('### 第 3 轮')
    const marker = content.indexOf('已被编辑')
    // 标记必须紧跟第 1 轮锚点之后、且仍在第 1 轮区块内
    expect(marker).toBeGreaterThan(seg1)
    expect(marker).toBeLessThan(seg3)
    expect(content).toContain('> 问题一（编辑后）')
    expect(content.indexOf('本次变更记录')).toBeGreaterThan(seg3)
    expect(content).toContain('✏️ 编辑问题 `第 1 轮`')
    // 派生区整段重排，不残留旧片段
    expect(content.split('## 对话正文')).toHaveLength(2)

    const wm = await deps.watermarks.get()
    expect(wm?.lastTurnEndSeq).toBe(13)
    expect(wm?.lastSegmentNo).toBe(3)
  })

  it('无新对话短路：不写文件、不触发 LLM 分类', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    await svc.run()
    const fileCount = (deps.fs as MemoryFs).files.size
    const llm = deps.router.clientFor('classify') as LlmClient & { calls: LlmRequest[] }

    const res = await svc.run()
    expect(res.status).toBe('no_new')
    expect((deps.fs as MemoryFs).files.size).toBe(fileCount)
    expect(llm.calls).toHaveLength(1) // 仅首次导出触发一次分类
  })

  it('路径覆盖：持久化到会话偏好', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    const res = await svc.run('custom/out.md')
    expect(res.status).toBe('ok')
    expect((deps.fs as MemoryFs).files.has('custom/out.md')).toBe(true)
    expect((await deps.prefs.get('')).mdPath).toBe('custom/out.md')
  })

  it('技术栈移除：preview 只有 (path?, strategyId?) 两参，front matter 无 tech_stack、偏好无 techStack', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    const plan = await svc.preview()
    // PreviewPlan 不再带技术栈字段
    expect(Object.keys(plan)).not.toContain('techStack')

    const res = await svc.commit(plan)
    expect(res.status).toBe('ok')
    const content = [...(deps.fs as MemoryFs).files.values()][0]!
    expect(content).not.toContain('tech_stack')
    // 会话偏好只剩路径 / 当前策略 / LLM 槽位配置
    const pref = await deps.prefs.get('')
    expect(Object.keys(pref).sort()).toEqual(['currentStrategyId', 'llmSlotConfig', 'mdPath'])
    expect(pref).not.toHaveProperty('techStack')
  })
})

describe('ExportService.preview / commit（GUI 路径）', () => {
  it('preview 不写文件（含维度视图与目录）；commit 按维度应用归类编辑', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    const plan = await svc.preview()
    expect(plan.hasNew).toBe(true)
    expect(plan.segments).toHaveLength(2)
    expect(plan.dimensions.map(d => d.id)).toEqual(['phase', 'purpose'])
    expect(plan.dimensions[0]!.modules).toContain('需求与调研')
    expect(plan.toc).toContainEqual({ dimensionId: 'phase', moduleName: '编码实现', turns: [] })
    expect(
      plan.toc.find(e => e.dimensionId === 'phase' && e.moduleName === '需求与调研')?.turns,
    ).toEqual([{ no: 1, title: '需求提出：导出对话' }])
    expect((deps.fs as MemoryFs).files.size).toBe(0) // 预览无写入

    const res = await svc.commit(plan, [
      { no: 2, labels: { phase: '编码实现' } }, // 只改 phase 维
      { no: 1, labels: { phase: '' } }, // 撤销归类 → phase 兜底「其他」
    ])
    expect(res.status).toBe('ok')
    const content = [...(deps.fs as MemoryFs).files.values()][0]!
    const toc = content.slice(content.indexOf('## 目录'), content.indexOf('## 对话正文'))
    // 维度 `###` + 有轮次的模块加粗计数 + wiki 链接，空模块只留一行加粗（无计数）
    expect(toc).toContain('### 开发阶段')
    expect(toc).toContain(
      '**3. 编码实现**（1 轮）\n- [[#第 2 轮：方案设计：定导出格式]]',
    )
    expect(toc).toContain(
      '**5. 其他**（1 轮）\n- [[#第 1 轮：需求提出：导出对话]]',
    )
    expect(toc).toContain('\n**1. 需求与调研**\n')
    expect(toc).not.toContain('**1. 需求与调研**（')
    expect(toc).not.toContain('[!note]')
    expect(content).toContain('#开发阶段/编码实现 #对话功能-目的/问答型')
    expect(content).toContain('#开发阶段/其他 #对话功能-目的/生成型')
    // 正文标题同步带标题
    expect(content).toContain('### 第 2 轮：方案设计：定导出格式')
    // 归类映射已持久化（未编辑的维度保持原值）
    const cat = await deps.categorize.get()
    expect(cat['2']!.labels).toEqual({ phase: '编码实现', purpose: '问答型' })
    expect(cat['1']!.labels).toEqual({ phase: '其他', purpose: '生成型' })
    expect(cat['2']!.title).toBe('方案设计：定导出格式')
  })
})

describe('ExportService：导出文件被删除后的检测与重建', () => {
  it('文件完好且无新对话：仍判定 no_new，不误报重建', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    await svc.run()
    const plan = await svc.preview()
    expect(plan.hasNew).toBe(false)
    expect(plan.needsRebuild).toBe(false)
    expect(plan.rebuildReason).toBeNull()
  })

  it('文件被删除：preview 报 missing，rebuild 全量重写并按 1..N 重排编号', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [
      twoTurnReply(),
      classifyReply([
        { key: '1', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', labels: { phase: PHASE.design, purpose: PURPOSE.qa } },
        { key: '3', labels: { phase: PHASE.code, purpose: PURPOSE.other } },
      ]),
    ])
    const svc = new ExportService(deps)
    await svc.run()
    const files = (deps.fs as MemoryFs).files
    const path = [...files.keys()][0]!
    expect(files.has(path)).toBe(true)

    // 模拟用户删除导出文件，同时会话又多了一轮
    files.delete(path)
    state.list = [...baseEvents(), ...turn(3, 10, 11, 12, 13, '问题三', '回答三')]

    const plan = await svc.preview()
    expect(plan.hasNew).toBe(true)
    expect(plan.needsRebuild).toBe(true)
    expect(plan.rebuildReason).toBe('missing')
    expect(plan.rebuildTurns).toBe(3)
    // 重建前同样可预览/编辑：计划里给出全量段（编号 1..N、复用已有归类）
    expect(plan.segments.map(s => s.no)).toEqual([1, 2, 3])
    expect(plan.segments[0]!.title).toBe('需求提出：导出对话')
    expect(plan.segments[1]!.labels.phase).toBe('方案设计')
    expect(plan.strategies.map(s => s.id)).toContain(TEST_STRATEGY_ID)

    // 重建时可在预览里改维度（此处把第 3 段 phase 移入「调试排错」）
    const rebuilt = await svc.rebuild(plan, [{ no: 3, labels: { phase: '调试排错' } }])
    expect(rebuilt.status).toBe('ok')
    if (rebuilt.status === 'ok') {
      expect(rebuilt.rebuilt).toBe(true)
      expect(rebuilt.appendedSegments).toBe(3)
    }

    const content = files.get(path)!
    expect(content.startsWith('---\nformat: 10\n')).toBe(true)
    expect(content).toContain('turns: 3')
    expect(content).toContain('### 第 1 轮：需求提出：导出对话')
    expect(content).toContain('### 第 2 轮：方案设计：定导出格式')
    expect(content).toContain('### 第 3 轮')
    expect(content).toContain('#开发阶段/需求与调研 #对话功能-目的/生成型')
    expect(content).toContain('#开发阶段/调试排错 #对话功能-目的/其他') // 重建前的编辑生效

    // 归类映射随新编号全量重写，水位重置为全量范围
    const cat = await deps.categorize.get()
    expect(Object.keys(cat)).toHaveLength(3)
    expect(cat['1']!.turnNo).toBe(1)
    expect(cat['3']!.turnNo).toBe(3)
    const wm = await deps.watermarks.get()
    expect(wm?.lastSegmentNo).toBe(3)
    expect(wm?.lastTurnEndSeq).toBe(13)

    // 重建后再预览：文件已存在且无新对话 → 回到 no_new
    const after = await svc.preview()
    expect(after.needsRebuild).toBe(false)
    expect(after.hasNew).toBe(false)
  })

  it('工具路径 run 在文件缺失时走重建而非"只导新段"', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [
      twoTurnReply(),
      classifyReply([
        { key: '1', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', labels: { phase: PHASE.design, purpose: PURPOSE.qa } },
        { key: '3', labels: { phase: PHASE.code, purpose: PURPOSE.other } },
      ]),
    ])
    const svc = new ExportService(deps)
    await svc.run()
    const files = (deps.fs as MemoryFs).files
    const path = [...files.keys()][0]!
    files.delete(path)
    state.list = [...baseEvents(), ...turn(3, 10, 11, 12, 13, '问题三', '回答三')]

    const status = await svc.run()
    expect(status.status).toBe('ok')
    if (status.status === 'ok') {
      expect(status.rebuilt).toBe(true)
      expect(status.appendedSegments).toBe(3)
    }
    // 历史段仍在文件中（未静默丢弃）
    expect(files.get(path)).toContain('### 第 1 轮')
  })

  it('重建复用落库标题：本轮分类返回不同标题也不覆盖（标题不漂移）', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [
      classifyReply([
        { key: '1', title: '落库标题一', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', title: '落库标题二', labels: { phase: PHASE.design, purpose: PURPOSE.qa } },
      ]),
      // 重建时模型换了口径：落库标题与归类仍然胜出
      classifyReply([
        { key: '1', title: '漂移标题一', labels: { phase: PHASE.code, purpose: PURPOSE.other } },
        { key: '2', title: '漂移标题二', labels: { phase: PHASE.code, purpose: PURPOSE.other } },
      ]),
    ])
    const svc = new ExportService(deps)
    await svc.run()
    const files = (deps.fs as MemoryFs).files
    const path = [...files.keys()][0]!
    expect(files.get(path)).toContain('### 第 1 轮：落库标题一')

    files.delete(path)
    const plan = await svc.preview()
    expect(plan.needsRebuild).toBe(true)
    expect(plan.reclassify).toBe(false)
    expect(plan.segments.map(s => s.title)).toEqual(['落库标题一', '落库标题二'])
    expect(plan.segments.map(s => s.labels.phase)).toEqual(['需求与调研', '方案设计'])

    const res = await svc.rebuild(plan)
    expect(res.status).toBe('ok')
    const content = files.get(path)!
    expect(content).toContain('### 第 1 轮：落库标题一')
    expect(content).toContain('### 第 2 轮：落库标题二')
    expect(content).not.toContain('漂移标题')
    expect(content).toContain('- [[#第 1 轮：落库标题一]]')
    expect((await deps.categorize.get())['1']!.title).toBe('落库标题一')
  })

  it('format: 9 旧文件（结构齐全、仅版本号落后）：判为 broken 并重建为 format: 10', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply(), twoTurnReply()])
    const svc = new ExportService(deps)
    await svc.run()
    const files = (deps.fs as MemoryFs).files
    const path = [...files.keys()][0]!

    files.set(path, files.get(path)!.replace('---\nformat: 10\n', '---\nformat: 9\n'))
    const plan = await svc.preview()
    expect(plan.needsRebuild).toBe(true)
    expect(plan.rebuildReason).toBe('broken')
    expect(plan.hasNew).toBe(true)

    const res = await svc.rebuild(plan)
    expect(res.status).toBe('ok')
    const content = files.get(path)!
    expect(content.startsWith('---\nformat: 10\n')).toBe(true)
    expect(content).not.toContain('format: 9')
  })
})

describe('产物附件（format 10：先写附件再写正文）', () => {
  it('附件文件写出、正文链接与附件文件名同源、备注写附件目录', async () => {
    const state = { list: artifactEvents() }
    const deps = await makeDeps(state, [
      classifyReply([
        { key: '1', title: '导出附件', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', title: '补测试', labels: { phase: PHASE.code, purpose: PURPOSE.gen } },
      ]),
    ])
    const res = await new ExportService(deps).run()
    expect(res.status).toBe('ok')
    const fs = deps.fs as MemoryFs

    const attach1 = `${ATTACH_DIR}/第1轮-产物.md`
    const attach2 = `${ATTACH_DIR}/第2轮-产物.md`
    expect(fs.files.has(attach1)).toBe(true)
    expect(fs.files.has(attach2)).toBe(true)

    const content = fs.files.get(DEFAULT_PATH)!
    // 正文只留附件链接（wiki 链接目标 = 附件文件名去掉扩展名）
    expect(content).toContain('> [!example]- 产物（1 个文件 · 命令 1 / 文档 1 / 链接 1）')
    expect(content).toContain('> - 全部产物：[[第1轮-产物|第1轮-产物.md]]（命令 1 / 文档 1 / 链接 1）')
    expect(content).toContain('> - 全部产物：[[第2轮-产物|第2轮-产物.md]]（命令 1）')
    // 产物正文不再内联进轮次
    expect(content).not.toContain('notes/README.md')
    expect(content).not.toContain('https://example.com/docs')
    // 备注写附件目录（与附件文件实际所在目录一致）
    expect(content).toContain(
      '- 各轮产物存放在同目录的 `x.artifacts/` 下（每轮一个文件，正文按轮次给出链接）。',
    )
    // 先写附件、再写正文
    expect(fs.writes).toContain(attach1)
    expect(fs.writes.indexOf(attach1)).toBeLessThan(fs.writes.indexOf(DEFAULT_PATH))
    expect(fs.writes[fs.writes.length - 1]).toBe(DEFAULT_PATH)

    // 附件文件内容：页头（来源文档/轮次/时间/统计）→ 类型分组 → 命令逐条代码块
    const a1 = fs.files.get(attach1)!
    expect(a1.startsWith('# 第 1 轮产物\n')).toBe(true)
    expect(a1).toContain(`- 来源文档：\`${DEFAULT_PATH}\``)
    expect(a1).toContain('- 轮次：第 1 轮：导出附件')
    expect(a1).toContain('- 内容统计：命令 1 · 文档 1 · 链接 1')
    expect(a1).toContain('## 命令\n\n### 命令 1\n\n```powershell\nnpx vitest run\n```')
    expect(a1).toContain('## 文档\n\n- `notes/README.md`')
    expect(a1).toContain('## 链接\n\n- https://example.com/docs')

    // 正文标题与附件里的轮次标题一致（链接名/文件名同源）
    expect(content).toContain('### 第 1 轮：导出附件')
    expect(content).toContain('#开发阶段/需求与调研 #对话功能-目的/生成型')
  })

  it('增量导出只为新轮写附件：历史轮附件不重写', async () => {
    const state = { list: artifactEvents() }
    const deps = await makeDeps(state, [
      classifyReply([
        { key: '1', title: '导出附件', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', title: '补测试', labels: { phase: PHASE.code, purpose: PURPOSE.gen } },
      ]),
      classifyReply([{ key: '3', title: '第三轮', labels: { phase: PHASE.debug, purpose: PURPOSE.other } }]),
    ])
    const svc = new ExportService(deps)
    await svc.run()
    const fs = deps.fs as MemoryFs
    const attach1 = `${ATTACH_DIR}/第1轮-产物.md`
    expect(fs.files.has(attach1)).toBe(true)
    const before = fs.files.get(attach1)!

    state.list = [
      ...artifactEvents(),
      ...turnWithCalls(3, 40, '问题三（带产物）', '回答三', [
        { name: 'write', arguments: { file_path: 'docs/plan.md' } },
      ]),
    ]
    fs.writes.length = 0
    const res = await svc.run()
    expect(res.status).toBe('ok')
    // 只为新轮写附件（历史轮的附件不重写，内容不变）
    expect(fs.writes).toContain(`${ATTACH_DIR}/第3轮-产物.md`)
    expect(fs.writes.some(p => p.includes('第1轮-产物') || p.includes('第2轮-产物'))).toBe(false)
    expect(fs.files.get(attach1)).toBe(before)
    // 三轮的链接都在正文里
    const content = fs.files.get(DEFAULT_PATH)!
    expect(content).toContain('[[第1轮-产物|第1轮-产物.md]]')
    expect(content).toContain('[[第2轮-产物|第2轮-产物.md]]')
    expect(content).toContain('[[第3轮-产物|第3轮-产物.md]]')
  })

  it('附件写失败（附件目录不可写）：导出仍成功，正文降级为内联产物', async () => {
    const state = { list: artifactEvents() }
    const deps = await makeDeps(state, [
      classifyReply([
        { key: '1', title: '导出附件', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', title: '补测试', labels: { phase: PHASE.code, purpose: PURPOSE.gen } },
      ]),
    ])
    const fs = memoryFs()
    const inner = fs.writeFile.bind(fs)
    fs.writeFile = async (path, content) => {
      if (path.includes('.artifacts')) throw new Error('EACCES: 附件目录不可写')
      await inner(path, content)
    }
    deps.fs = fs

    const res = await new ExportService(deps).run()
    expect(res.status).toBe('ok')
    const content = fs.files.get(DEFAULT_PATH)!
    // 降级：产物退回按类别分组的内联展示
    expect(content).toContain('> [!example]- 产物（3 项）')
    expect(content).toContain('> - `npx vitest run`')
    expect(content).toContain('> - `notes/README.md`')
    expect(content).toContain('> - https://example.com/docs')
    // 没有附件文件、备注不写附件目录、正文不留附件链接
    expect([...fs.files.keys()].some(p => p.includes('.artifacts'))).toBe(false)
    expect(content).not.toContain('.artifacts/')
    expect(content).not.toContain('[[第1轮-产物')
  })

  it('增量导出本身没有产物时，备注仍保留附件目录行（历史附件链接仍在正文里）', async () => {
    const state = { list: artifactEvents() }
    const deps = await makeDeps(state, [
      classifyReply([
        { key: '1', title: '导出附件', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', title: '补测试', labels: { phase: PHASE.code, purpose: PURPOSE.gen } },
      ]),
      classifyReply([{ key: '3', title: '第三轮', labels: { phase: PHASE.debug, purpose: PURPOSE.other } }]),
    ])
    const svc = new ExportService(deps)
    await svc.run()
    const fs = deps.fs as MemoryFs

    // 第三轮没有任何产物 → 本次不写附件，但文档里仍有第 1/2 轮的附件链接
    state.list = [...artifactEvents(), ...turnWithCalls(3, 40, '问题三（无产物）', '回答三', [])]
    fs.writes.length = 0
    const res = await svc.run()
    expect(res.status).toBe('ok')

    const content = fs.files.get(DEFAULT_PATH)!
    expect(content).toContain('[[第1轮-产物|第1轮-产物.md]]')
    expect(content).toContain(
      '- 各轮产物存放在同目录的 `x.artifacts/` 下（每轮一个文件，正文按轮次给出链接）。',
    )
    expect(fs.writes.some(p => p.includes('第3轮-产物'))).toBe(false)
  })

  it('增量导出后备注覆盖度按全量条目统计（不是只算本次增量）', async () => {
    const state = { list: artifactEvents() }
    const deps = await makeDeps(state, [
      classifyReply([
        { key: '1', title: '导出附件', labels: { phase: PHASE.req, purpose: PURPOSE.gen } },
        { key: '2', title: '补测试', labels: { phase: PHASE.code, purpose: PURPOSE.gen } },
      ]),
      classifyReply([{ key: '3', title: '第三轮', labels: { phase: PHASE.debug, purpose: PURPOSE.other } }]),
    ])
    const svc = new ExportService(deps)
    await svc.run()
    const fs = deps.fs as MemoryFs
    expect(fs.files.get(DEFAULT_PATH)!).toContain('覆盖：开发阶段 2/5 类、对话功能/目的 1/3 类')

    state.list = [...artifactEvents(), ...turnWithCalls(3, 40, '问题三', '回答三', [])]
    await svc.run()
    const content = fs.files.get(DEFAULT_PATH)!
    // 全量口径：需求与调研 + 编码实现 + 调试排错 = 3/5（修复前只算增量 → 1/5）
    expect(content).toContain('覆盖：开发阶段 3/5 类、对话功能/目的 2/3 类')
  })
})

describe('分类降级可见性：不再静默全部落兜底模块', () => {
  it('LLM 调用失败：预览给出 fallback 报告（分维 + 原因），段仍可导出', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [])
    const failing: LlmClient = {
      model: 'flash',
      async complete() {
        throw new Error('LLM 请求失败：HTTP 401')
      },
    }
    deps.router = new LlmRouter(failing, undefined, {
      classify: { kind: 'remote', model: 'flash' },
      designStrategy: { kind: 'remote', model: 'flash' },
    })
    const svc = new ExportService(deps)
    const plan = await svc.preview()
    expect(plan.classification.status).toBe('fallback')
    expect(plan.classification.reason).toContain('401')
    expect(plan.classification.dimensions.map(d => d.id)).toEqual(['phase', 'purpose'])
    expect(plan.segments.every(s => s.labels.phase === '其他' && s.labels.purpose === '其他')).toBe(true)
    // 没有模型标题 → 退化为问题原文截断
    expect(plan.segments.map(s => s.title)).toEqual(['问题一', '问题二'])
  })

  it('未分类兜底策略：报告为 skipped（没发 LLM 请求）', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [], { withStrategy: false })
    const plan = await new ExportService(deps).preview(undefined, UNCLASSIFIED_STRATEGY_ID)
    expect(plan.strategy.id).toBe(UNCLASSIFIED_STRATEGY_ID)
    expect(plan.classification).toMatchObject({ status: 'skipped', calls: 0 })
    expect(plan.segments.every(s => s.labels.phase === '未分类' && s.labels.purpose === '未分类')).toBe(true)
    const llm = deps.router.clientFor('classify') as LlmClient & { calls: LlmRequest[] }
    expect(llm.calls).toHaveLength(0)
  })

  it('容器为空且未选策略：回落到内置 DEFAULT_STRATEGY', async () => {
    const deps = await makeDeps({ list: baseEvents() }, [], { withStrategy: false })
    const plan = await new ExportService(deps).preview()
    expect(plan.strategy.id).toBe(DEFAULT_STRATEGY.id)
    expect(plan.dimensions.map(d => d.id)).toEqual(['phase', 'purpose'])
  })
})

describe('换策略重排（reflow）与策略管理', () => {
  it('重建时显式选策略：全量段按新策略重新分类，不再复用旧归类', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [
      // 首次导出：当时的策略把两段都放进兜底
      classifyReply([
        { key: '1', labels: { phase: PHASE.other, purpose: PURPOSE.other } },
        { key: '2', labels: { phase: PHASE.other, purpose: PURPOSE.other } },
      ]),
      // 重建 + 新策略：必须重新问一次 LLM
      classifyReply([
        { key: '1', labels: { kind: 1, tone: 1 } },
        { key: '2', labels: { kind: 2, tone: 2 } },
      ]),
    ])
    await seedAltStrategy(deps.strategies)
    const svc = new ExportService(deps)
    await svc.run()

    // 删掉文件 → 走重建；显式带上策略 id
    const files = (deps.fs as MemoryFs).files
    const path = [...files.keys()][0]!
    files.delete(path)

    const plan = await svc.preview(undefined, 'alt')
    expect(plan.needsRebuild).toBe(true)
    expect(plan.reclassify).toBe(true)
    expect(plan.segments.map(s => s.labels.kind)).toEqual(['Docs', 'Code'])

    const res = await svc.rebuild(plan)
    expect(res.status).toBe('ok')
    const content = files.get(path)!
    expect(content).toContain('#类别/Docs #语气/正式')
    expect(content).toContain('#类别/Code #语气/随意')
    expect(content).not.toContain('开发阶段')
  })

  it('重建不带策略 id：仍复用已存归类（用户手工改过的模块不被覆盖）', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply(), twoTurnReply()])
    const svc = new ExportService(deps)
    await svc.run()
    const files = (deps.fs as MemoryFs).files
    const path = [...files.keys()][0]!
    files.delete(path)

    const plan = await svc.preview()
    expect(plan.reclassify).toBe(false)
    expect(plan.segments.map(s => s.labels.phase)).toEqual(['需求与调研', '方案设计'])
  })

  it('选择与文档不同的策略：预览给全量重排，提交后整份按新策略重写（标题也换新分类结果）', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [
      twoTurnReply(),
      classifyReply([
        { key: '1', title: '类别归档：文档整理', labels: { kind: 1, tone: 1 } },
        { key: '2', title: '类别归档：杂项处理', labels: { kind: 3, tone: 2 } },
      ]),
    ])
    await seedAltStrategy(deps.strategies)
    const svc = new ExportService(deps)
    await svc.run()

    const plan = await svc.preview(undefined, 'alt')
    expect(plan.reflow).toBe(true)
    expect(plan.strategy.id).toBe('alt')
    expect(plan.segments.map(s => s.no)).toEqual([1, 2])
    expect(plan.segments.map(s => s.labels.kind)).toEqual(['Docs', 'Misc'])
    // 显式选策略 = 重新分类：不复用落库标题
    expect(plan.segments.map(s => s.title)).toEqual(['类别归档：文档整理', '类别归档：杂项处理'])
    expect(plan.classification.status).toBe('ok')

    const res = await svc.commit(plan)
    expect(res.status).toBe('ok')
    if (res.status === 'ok') expect(res.reflowed).toBe(true)

    const content = [...(deps.fs as MemoryFs).files.values()][0]!
    expect(content).toContain('#类别/Docs #语气/正式')
    expect(content).toContain('#类别/Misc #语气/随意')
    expect(content).not.toContain('开发阶段')
    expect(content).toContain('### 第 1 轮：类别归档：文档整理')
    expect(content).not.toContain('需求提出：导出对话')
    // 归类映射与水位按全量重写
    const cat = await deps.categorize.get()
    expect(cat['1']).toMatchObject({
      title: '类别归档：文档整理',
      labels: { kind: 'Docs', tone: '正式' },
      turnNo: 1,
    })
    expect((await deps.watermarks.get())?.lastSegmentNo).toBe(2)
  })

  it('选中当前已用策略时不触发重排（仍是增量/无新对话语义）', async () => {
    const state = { list: baseEvents() }
    const deps = await makeDeps(state, [twoTurnReply()])
    const svc = new ExportService(deps)
    await svc.run()
    const plan = await svc.preview(undefined, TEST_STRATEGY_ID)
    expect(plan.reflow).toBe(false)
    expect(plan.hasNew).toBe(false)
  })

  it('手动新建/编辑策略：saveStrategy 接受对象并按同 id 覆盖（兼容旧单维结构）', async () => {
    const deps = await makeDeps({ list: baseEvents() }, [], { withStrategy: false })
    const svc = new ExportService(deps)

    const created = await svc.saveStrategy({
      id: 'flow',
      name: '开发流程',
      dimensions: [
        {
          id: 'stage',
          name: '阶段',
          modules: [{ name: '需求', description: '要做什么' }, { name: '其他' }],
          defaultModule: '其他',
        },
      ],
    })
    expect(created).toMatchObject({ ok: true, id: 'flow', name: '开发流程' })
    // 内置默认策略始终可选
    expect((await svc.listStrategies()).map(s => s.name)).toEqual(['标准研发流程', '开发流程'])

    // 旧单维结构仍可保存：自动迁移为第一个维度
    const legacy = await svc.saveStrategy({
      id: 'legacy',
      name: '旧结构',
      modules: [{ name: 'A' }, { name: '其他' }],
      defaultModule: '其他',
    })
    expect(legacy.ok).toBe(true)
    expect((await svc.readStrategy('legacy'))?.dimensions[0]!.id).toBe('phase')

    // 同 id 覆盖 + 校验失败返回逐条错误
    const edited = await svc.saveStrategy({
      id: 'flow',
      name: '开发流程 v2',
      dimensions: [
        { id: 'stage', name: '阶段', modules: [{ name: '需求' }], defaultModule: '需求' },
      ],
    })
    expect(edited.ok).toBe(true)
    expect((await svc.readStrategy('flow'))?.name).toBe('开发流程 v2')

    const bad = await svc.saveStrategy({ id: 'bad', name: '', dimensions: [] })
    expect(bad.ok).toBe(false)
    expect(bad.errors.length).toBeGreaterThan(0)
  })

  it('导入 JSON 文本：source 标 imported 并入库', async () => {
    const deps = await makeDeps({ list: baseEvents() }, [], { withStrategy: false })
    const svc = new ExportService(deps)
    const text = JSON.stringify({
      id: 'imported-one',
      name: '导入策略',
      dimensions: [
        { id: 'd', name: '维度', modules: [{ name: 'A' }, { name: '其他' }], defaultModule: '其他' },
      ],
    })
    const res = await svc.saveStrategy(text, { source: 'imported' })
    expect(res).toMatchObject({ ok: true, id: 'imported-one' })
    expect((await svc.readStrategy('imported-one'))?.source).toBe('imported')
  })

  it('删除策略：容器移除；删掉当前策略时清空会话指针；内置策略不可删', async () => {
    const deps = await makeDeps({ list: baseEvents() }, [], { withStrategy: false })
    await seedAltStrategy(deps.strategies)
    const svc = new ExportService(deps)
    await svc.selectStrategy('alt')

    const gone = await svc.deleteStrategy('alt')
    expect(gone).toEqual({ ok: true, deleted: true })
    expect((await svc.listStrategies()).map(s => s.id)).toEqual([DEFAULT_STRATEGY.id])
    const pref = await deps.prefs.get('.chat-exports/x.md')
    expect(pref.currentStrategyId).toBe('')

    // 未分类技术兜底与内置默认策略都不可删
    expect((await svc.deleteStrategy(UNCLASSIFIED_STRATEGY_ID)).ok).toBe(false)
    expect(await svc.deleteStrategy(DEFAULT_STRATEGY.id)).toEqual({ ok: true, deleted: false })
  })
})

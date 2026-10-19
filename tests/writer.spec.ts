import { describe, expect, it } from 'vitest'
import {
  appendExport,
  composeExport,
  FORMAT_MARKER,
  FORMAT_VERSION,
  injectSegmentAnnotation,
  isCurrentFormat,
  ROUND_SEPARATOR,
} from '../src/core/writer.js'
import { renderToc, type TocModuleEntries } from '../src/core/renderer.js'
import { parseDocument } from '../src/core/document.js'
import { advanceWatermark } from '../src/core/watermark.js'
import type {
  ExportSegment,
  Strategy,
  Turn,
  Watermark,
} from '../src/core/types.js'

/** 双维度策略夹具。 */
const strategy: Strategy = {
  id: 'dev-phase',
  name: '常规开发规模',
  source: 'builtin',
  dimensions: [
    {
      id: 'phase',
      name: '开发阶段',
      modules: [{ name: '需求分析' }, { name: '编码实现' }, { name: '其他' }],
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

const w0: Watermark = { sessionId: 's1', lastTurnEndSeq: 0, lastTurnEndTime: 0, lastSegmentNo: 0, mdPath: 'x.md' }

function mkTurn(no: number, startSeq: number, endSeq: number): Turn {
  return {
    turnNo: no,
    startSeq,
    endSeq,
    startTime: 0,
    endTime: 0,
    completed: true,
    user: [{ seq: startSeq + 1, time: 0, content: [{ type: 'text', text: `问题原文${no}` }] }],
    assistant: [
      {
        seq: startSeq + 2,
        time: 0,
        content: [{ type: 'text', text: `回答正文${no}` }],
        model: 'm',
      },
    ],
    tools: [],
    toolCalls: [],
    deliverables: [],
  }
}

function seg(
  no: number,
  labels: Record<string, string>,
  startSeq: number,
  endSeq: number,
  title?: string,
): ExportSegment {
  return {
    no,
    title: title ?? `段标题${no}`,
    labels,
    summary: '',
    artifacts: [],
    changes: [],
    turn: mkTurn(no, startSeq, endSeq),
  }
}

const meta = {
  sessionId: 's1',
  title: '对话导出：测试',
  workspace: 'D:/w',
  exportedAtMs: 1000,
  model: 'flash',
}

/** 目录条目夹具：`[轮次号, 标签, 标题?]`（标题缺省与 seg() 的标题一致）。 */
function tocOf(
  turns: readonly [number, Record<string, string>, string?][],
): TocModuleEntries[] {
  const entries: TocModuleEntries[] = []
  for (const d of strategy.dimensions) {
    for (const m of d.modules) {
      entries.push({
        dimensionId: d.id,
        moduleName: m.name,
        turns: turns
          .filter(([, labels]) => (labels[d.id] ?? d.defaultModule) === m.name)
          .map(([no, , title]) => ({ no, title: title ?? `段标题${no}` })),
      })
    }
  }
  return entries
}

describe('composeExport（首次导出）', () => {
  it('组装 format=10 文档：front matter + `###` 目录 + 标签行 + 带标题正文（轮次间 `---`）+ 备注（正文零标记）', () => {
    const segments = [
      seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4),
      seg(2, { phase: '编码实现', purpose: '问答型' }, 5, 8),
    ]
    const doc = composeExport({ meta, strategy, segments, toc: tocOf([[1, segments[0]!.labels], [2, segments[1]!.labels]]) })
    const lines = doc.split('\n')
    // front matter：首行 ---，第二行 format: 10；旧 format: 9 文件判为需重建
    expect(lines[0]).toBe('---')
    expect(lines[1]).toBe(FORMAT_MARKER)
    expect(FORMAT_MARKER).toBe('format: 10')
    expect(FORMAT_VERSION).toBe(10)
    // 技术栈已移除：front matter 不再有 tech_stack
    expect(doc.slice(0, doc.indexOf('\n# 对话信息'))).not.toContain('tech_stack')
    expect(doc).toContain("session_id: 's1'")
    expect(doc).toContain("workspace: 'D:/w'")
    expect(doc).toContain('turns: 2')
    expect(doc).toContain("generator: 'dsh-session-export-md'")
    expect(doc).toContain("strategy: '常规开发规模'")

    expect(doc).toContain('# 对话信息')
    expect(doc).toContain('## 目录')
    // 维度是 `###` 结构标题（不再是加粗行）
    expect(doc).toContain('### 开发阶段')
    expect(doc).toContain('### 对话功能/目的')
    // 有轮次的模块：加粗计数一行 + 轮次 wiki 链接（无 callout）
    expect(doc).toContain('**1. 需求分析**（1 轮）\n- [[#第 1 轮：段标题1]]')
    expect(doc).toContain('**2. 编码实现**（1 轮）\n- [[#第 2 轮：段标题2]]')
    expect(doc).toContain('**1. 问答型**（2 轮）\n- [[#第 1 轮：段标题1]]\n- [[#第 2 轮：段标题2]]')
    // 空模块：单行加粗，不写计数
    expect(doc).toContain('\n**3. 其他**\n\n### 对话功能/目的')
    expect(doc).toContain('\n**2. 其他**')
    expect(doc).not.toContain('[!note]')

    expect(doc).toContain('## 对话正文')
    // format 10 正文零标记：既没有 HTML 注释，也没有 turn-N 锚点
    expect(doc).not.toContain('<!--')
    expect(doc).not.toContain('<a id=')
    expect(doc).not.toContain('#turn-')
    // 折叠都用 Obsidian callout，文档里不再有 <details>/<summary>
    expect(doc).not.toContain('<details>')
    expect(doc).not.toContain('<summary>')
    expect(doc).toContain('### 第 1 轮：段标题1')
    expect(doc).toContain('### 第 2 轮：段标题2')
    // 分类改为 Obsidian 原生标签行（不再有 `**分类**：…`）
    expect(doc).not.toContain('**分类**')
    expect(doc).toContain('#开发阶段/需求分析 #对话功能-目的/问答型')
    expect(doc).toContain('#开发阶段/编码实现 #对话功能-目的/问答型')
    expect(doc).toContain('> [!question] 用户\n> 问题原文1')
    expect(doc).toContain('> [!quote] 回答\n> 回答正文1')
    // 标签改名：全文再无 `**AI**：`
    expect(doc).not.toContain('**AI**')
    expect(doc.indexOf('### 第 1 轮')).toBeLessThan(doc.indexOf('### 第 2 轮'))
    // 轮次之间用分隔线 `---`（视觉上区分轮次边界）
    expect(ROUND_SEPARATOR).toBe('---')
    expect(doc).toContain(
      '> 回答正文1\n\n---\n\n### 第 2 轮：段标题2',
    )
    const body = doc.slice(doc.indexOf('## 对话正文'), doc.indexOf('## 备注'))
    expect(body.split(`\n${ROUND_SEPARATOR}\n`)).toHaveLength(2)
    // 结构标题只出现一次（派生区整段重排，不残留旧片段）
    expect(doc.split('## 对话正文')).toHaveLength(2)
    expect(doc.split('## 目录')).toHaveLength(2)
    expect(doc).toContain('## 备注')
    expect(doc).toContain('format=10')
    expect(doc.endsWith('\n')).toBe(true)
  })

  it('概况为空时整行省略：正文里不出现空 `**概要**：` 标签', () => {
    const doc = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    expect(doc).not.toContain('**概要**')
  })

  it('产物附件：正文只留附件链接、备注写附件目录；降级（inlineArtifacts）时退回内联', () => {
    const withArtifacts: ExportSegment = {
      ...seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4),
      artifacts: [{ kind: '命令', value: 'npx vitest run' }],
    }
    const base = {
      meta,
      strategy,
      segments: [withArtifacts],
      toc: tocOf([[1, withArtifacts.labels]]),
    }
    const doc = composeExport({ ...base, attachmentsDir: '对话导出-测试.artifacts/' })
    expect(doc).toContain('> [!example]- 产物（1 个文件 · 命令 1）')
    expect(doc).toContain('> - 全部产物：[[第1轮-产物|第1轮-产物.md]]（命令 1）')
    expect(doc).toContain('- 各轮产物存放在同目录的 `对话导出-测试.artifacts/` 下')
    // 附件链接模式下正文不再内联产物正文
    expect(doc).not.toContain('npx vitest run')

    const degraded = composeExport({ ...base, inlineArtifacts: true })
    expect(degraded).toContain('> [!example]- 产物（1 项）')
    expect(degraded).toContain('> - `npx vitest run`')
    expect(degraded).not.toContain('第1轮-产物')
    expect(degraded).not.toContain('.artifacts/')
  })
})

describe('isCurrentFormat', () => {
  it('对当前格式返回 true，对旧格式/缺结构标题/顺序错乱返回 false', () => {
    const current = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    expect(isCurrentFormat(current)).toBe(true)

    // 没有 front matter 的旧文档
    expect(isCurrentFormat('# 对话导出：旧\n\n## 1. 旧段\n')).toBe(false)
    // 更早的旧版本号（format=4）
    expect(isCurrentFormat('---\nformat: 4\nturns: 1\n---\n\n# 对话信息\n')).toBe(false)
    // 有当前版本号但缺 `## 备注`（结构标题不全）
    expect(
      isCurrentFormat(
        '---\nformat: 10\nturns: 1\n---\n\n# 对话信息\n\n## 目录\n\n## 对话正文\n\n### 第 1 轮\n',
      ),
    ).toBe(false)
    // 结构标题齐全但顺序错（备注跑到正文之前）
    expect(
      isCurrentFormat(
        '---\nformat: 10\nturns: 1\n---\n\n# 对话信息\n\n## 备注\n\n## 目录\n\n## 对话正文\n',
      ),
    ).toBe(false)
  })

  it('format: 9 旧文件（结构齐全）判为需重建，appendExport 返回 null', () => {
    const format9 = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    }).replace('---\nformat: 10\n', '---\nformat: 9\n')
    // 只落后一个版本号，其余结构完全一致
    expect(format9.startsWith('---\nformat: 9\n')).toBe(true)
    expect(isCurrentFormat(format9)).toBe(false)
    expect(
      appendExport({
        existing: format9,
        meta,
        strategy,
        segments: [seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)],
        toc: renderToc(strategy, tocOf([[2, { phase: '编码实现', purpose: '其他' }]])),
        watermark: w0,
        appendedSegments: 1,
        appendedTurns: [{ endSeq: 8, endTime: 9 }],
      }),
    ).toBeNull()
  })

  it('format: 6 旧文件（结构齐全）仍判为需重建，appendExport 返回 null', () => {
    const legacy = [
      '---',
      'format: 6',
      'turns: 1',
      '---',
      '',
      '# 对话信息',
      '',
      '## 目录',
      '',
      '**开发阶段**',
      '',
      '> [!note]+ 1. 需求分析',
      '> - [[#第 1 轮]]',
      '',
      '## 对话正文',
      '',
      '### 第 1 轮',
      '',
      '**分类**：开发阶段·需求分析 ｜ 对话功能/目的·其他',
      '',
      '## 备注',
      '',
      '- 敏感信息已脱敏。',
      '',
    ].join('\n')
    expect(isCurrentFormat(legacy)).toBe(false)
    // 结构完全合法，仅版本号落后：不追加、走重建
    expect(
      appendExport({
        existing: legacy,
        meta,
        strategy,
        segments: [seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)],
        toc: renderToc(strategy, tocOf([[2, { phase: '编码实现', purpose: '其他' }]])),
        watermark: w0,
        appendedSegments: 1,
        appendedTurns: [{ endSeq: 8, endTime: 9 }],
      }),
    ).toBeNull()
  })

  it('正文里引用的 format: 10 示例不会把旧文件误判为当前格式（版本号只认 front matter 首部）', () => {
    const legacy = [
      '---',
      'format: 8',
      'turns: 1',
      '---',
      '',
      '# 对话信息',
      '',
      '## 目录',
      '',
      '### 开发阶段',
      '',
      '**1. 需求分析**（1 轮）',
      '- [[#第 1 轮]]',
      '',
      '## 对话正文',
      '',
      '### 第 1 轮：格式样例',
      '',
      '> [!question] 用户',
      '> 看看这个 front matter',
      '',
      '````markdown',
      '---',
      'format: 10',
      'turns: 1',
      '---',
      '````',
      '',
      '## 备注',
      '',
      '- 敏感信息已脱敏。',
    ].join('\n')
    // 文件里确实有 `format: 10` 这一行——但在代码围栏内部
    expect(legacy).toContain('\nformat: 10\n')
    expect(isCurrentFormat(legacy)).toBe(false)
    expect(
      appendExport({
        existing: legacy,
        meta,
        strategy,
        segments: [seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)],
        toc: renderToc(strategy, tocOf([[2, { phase: '编码实现', purpose: '其他' }]])),
        watermark: w0,
        appendedSegments: 1,
        appendedTurns: [{ endSeq: 8, endTime: 9 }],
      }),
    ).toBeNull()
  })

  it('CRLF 存盘的文档仍判为当前格式，追加后统一写回 LF', () => {
    const first = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    const crlf = first.split('\n').join('\r\n')
    expect(isCurrentFormat(crlf)).toBe(true)

    const res = appendExport({
      existing: crlf,
      meta,
      strategy,
      segments: [seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)],
      toc: renderToc(strategy, tocOf([
        [1, { phase: '需求分析', purpose: '问答型' }],
        [2, { phase: '编码实现', purpose: '其他' }],
      ])),
      watermark: w0,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
    })
    expect(res).not.toBeNull()
    expect(res!.newContent).not.toContain('\r')
    expect(isCurrentFormat(res!.newContent)).toBe(true)
  })
})

describe('injectSegmentAnnotation（标注注入）', () => {
  it('同一段标注文本出现在别处时仍会注入到本轮（幂等只看本轮区间）', () => {
    const segments = [
      seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4),
      seg(2, { phase: '编码实现', purpose: '问答型' }, 5, 8),
    ]
    const first = composeExport({
      meta,
      strategy,
      segments,
      toc: tocOf([
        [1, segments[0]!.labels],
        [2, segments[1]!.labels],
      ]),
    })
    const annotation = '> ⚠️ **变更标记**（2026-10-11 00:00:00 UTC 导出时检测）：本段已被编辑。'
    // 模拟「用户把上一次导出的标注粘进了第 1 轮正文」
    const withCopy = first.replace('回答正文1', `回答正文1\n\n${annotation}`)
    expect(withCopy.split(annotation)).toHaveLength(2)

    const out = injectSegmentAnnotation(withCopy, { no: 2, annotation })
    const lines = out.split('\n')
    const i = lines.findIndex(l => l.startsWith('### 第 2 轮'))
    expect(lines[i + 1]).toBe('')
    expect(lines[i + 2]).toBe(annotation)
    // 第 1 轮里那段引用不受影响，且本轮标注是新增的第二处
    expect(out.split(annotation)).toHaveLength(3)
    // 再注入一次：本轮区间内已有，幂等跳过
    expect(injectSegmentAnnotation(out, { no: 2, annotation })).toBe(out)
  })
})

describe('appendExport（增量追加）', () => {
  it('新轮次追加到正文区末尾、目录与 front matter 重建、水位推进、历史正文不动', () => {
    const first = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    const w1 = advanceWatermark(w0, [{ endSeq: 4, endTime: 5 }], 1)

    const newSeg = seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)
    const res = appendExport({
      existing: first,
      meta: { ...meta, exportedAtMs: 2000000 },
      strategy,
      segments: [newSeg],
      toc: renderToc(strategy, tocOf([
        [1, { phase: '需求分析', purpose: '问答型' }],
        [2, newSeg.labels],
      ])),
      watermark: w1,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
      allSegments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4), newSeg],
    })

    expect(res).not.toBeNull()
    const { newContent, newWatermark } = res!
    expect(newContent).toContain('### 第 2 轮：段标题2')
    expect(newContent).toContain('#开发阶段/编码实现 #对话功能-目的/其他')
    // 追加时用与 composeExport 相同的 `---` 分隔线连接新旧轮次
    expect(ROUND_SEPARATOR).toBe('---')
    expect(newContent).toContain('> 回答正文1\n\n---\n\n### 第 2 轮：段标题2')
    const appendedBody = newContent.slice(newContent.indexOf('## 对话正文'), newContent.indexOf('## 备注'))
    expect(appendedBody.split(`\n${ROUND_SEPARATOR}\n`)).toHaveLength(2)
    // 历史正文未被复制
    expect(newContent.split('回答正文1')).toHaveLength(2)
    expect(newContent.split('### 第 2 轮')).toHaveLength(2)
    // 派生区不重复：每个结构标题只出现一次
    expect(newContent.split('## 对话正文')).toHaveLength(2)
    expect(newContent.split('## 目录')).toHaveLength(2)
    expect(newContent.split('## 备注')).toHaveLength(2)
    expect(newContent.indexOf('### 第 1 轮')).toBeLessThan(newContent.indexOf('### 第 2 轮'))
    // 目录同步（维度 `###` + 模块加粗计数 + 带标题的 wiki 链接）
    expect(newContent).toContain('**2. 编码实现**（1 轮）\n- [[#第 2 轮：段标题2]]')
    // front matter 的 turns / exported_at 重建
    expect(newContent).toContain('\nturns: 2\n')
    expect(newContent).toContain("exported_at: '1970-01-01 00:33'")
    // 备注覆盖度按全量段重算
    expect(newContent).toContain('覆盖：开发阶段 2/3 类、对话功能/目的 2/2 类')
    expect(newWatermark.lastTurnEndSeq).toBe(8)
    expect(newWatermark.lastSegmentNo).toBe(2)
  })

  it('变更标记注入到该轮标题正下方（标题行 / 空行 / 标注 / 空行 / 原内容，幂等）', () => {
    const doc = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    const once = injectSegmentAnnotation(doc, { no: 1, annotation: '> ⚠️ **变更标记**（测试）' })
    expect(once).toContain(
      '### 第 1 轮：段标题1\n\n> ⚠️ **变更标记**（测试）\n\n#开发阶段/需求分析 #对话功能-目的/问答型',
    )
    // 注入的是标注行，不是 HTML 注释标记
    expect(once).not.toContain('<!--')
    const twice = injectSegmentAnnotation(once, { no: 1, annotation: '> ⚠️ **变更标记**（测试）' })
    expect(twice).toBe(once)
  })

  it('appendExport 把已导出轮的标注注入并与变更记录一起落盘', () => {
    const first = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    const res = appendExport({
      existing: first,
      meta: { ...meta, exportedAtMs: 2000000 },
      strategy,
      segments: [seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)],
      toc: renderToc(strategy, tocOf([
        [1, { phase: '需求分析', purpose: '问答型' }],
        [2, { phase: '编码实现', purpose: '其他' }],
      ])),
      watermark: w0,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
      segmentAnnotations: [{ no: 1, annotation: '> ⚠️ **变更标记**（测试）' }],
      changeLog: '本次变更记录（测试）：✏️ 编辑问题 `第 1 轮`。',
    })
    expect(res).not.toBeNull()
    const out = res!.newContent
    expect(out.indexOf('### 第 1 轮')).toBeLessThan(out.indexOf('⚠️ **变更标记**（测试）'))
    expect(out).toContain('- 本次变更记录（测试）：✏️ 编辑问题 `第 1 轮`。')
  })

  it('旧格式文件拒绝追加，交由重建处理', () => {
    const legacy = '# 对话导出：旧\n\n## 1. 旧段\n'
    const res = appendExport({
      existing: legacy,
      meta,
      strategy,
      segments: [seg(2, { phase: '需求分析', purpose: '问答型' }, 5, 8)],
      toc: renderToc(strategy, tocOf([[2, { phase: '需求分析', purpose: '问答型' }]])),
      watermark: w0,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
    })
    expect(res).toBeNull()
  })

  it('追加轮的标题写入正文标题行（md 方括号转义）；目录 wiki 链接用未转义标题（与正文渲染结果同源）', () => {
    const first = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    const title = '规则[1]：变更标记改为两处'
    const newSeg = seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8, title)
    const res = appendExport({
      existing: first,
      meta: { ...meta, exportedAtMs: 2000000 },
      strategy,
      segments: [newSeg],
      toc: renderToc(strategy, tocOf([
        [1, { phase: '需求分析', purpose: '问答型' }],
        [2, newSeg.labels, title],
      ])),
      watermark: w0,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
    })
    expect(res).not.toBeNull()
    const out = res!.newContent
    expect(out.split('\n')).toContain('### 第 2 轮：规则\\[1\\]：变更标记改为两处')
    expect(out).toContain('- [[#第 2 轮：规则[1]：变更标记改为两处]]')
  })

  it('标题为空的新轮次：正文标题退化为 `### 第 N 轮`，目录链接退化为 `[[#第 N 轮]]`', () => {
    const first = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    const newSeg = seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8, '')
    const res = appendExport({
      existing: first,
      meta: { ...meta, exportedAtMs: 2000000 },
      strategy,
      segments: [newSeg],
      toc: renderToc(strategy, tocOf([
        [1, { phase: '需求分析', purpose: '问答型' }],
        [2, newSeg.labels, ''],
      ])),
      watermark: w0,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
    })
    expect(res).not.toBeNull()
    const out = res!.newContent
    expect(out.split('\n')).toContain('### 第 2 轮')
    expect(out).not.toContain('### 第 2 轮：')
    expect(out).toContain('- [[#第 2 轮]]')
  })

  it('正文里被引用的旧标记/同名标题示例（代码围栏内）不会截断正文区，追加后一切仍在', () => {
    const first = composeExport({
      meta,
      strategy,
      segments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4)],
      toc: tocOf([[1, { phase: '需求分析', purpose: '问答型' }]]),
    })
    // 真实会话里引用示例很常见：4 反引号围栏包住旧标记、`## 备注` 与 `### 第 9 轮`。
    // 旧实现用 indexOf 找结束标记，会命中这里的示例（真实文件第 3301 行 vs 真实 6624 行）而截断丢内容。
    const quoted = [
      '````markdown',
      '<!-- dsh-export:rounds-end -->',
      '## 备注',
      '### 第 9 轮：引用示例',
      '````',
    ]
    // 示例必须落在正文区**内部**（真实备注之前），否则它本就属于可再生成的备注区
    const lines = first.split('\n')
    const notesAt = parseDocument(first).notesLine
    const existing = [
      ...lines.slice(0, notesAt),
      ...quoted,
      '',
      ...lines.slice(notesAt),
    ].join('\n')
    expect(isCurrentFormat(existing)).toBe(true)
    // 围栏内的 `## 备注` 不参与结构定位：结构标题仍是各一处，轮次只有引用的第 9 轮被排除
    expect(parseDocument(existing).rounds.map(r => r.no)).toEqual([1])
    expect(existing.split('## 备注')).toHaveLength(3)

    const newSeg = seg(2, { phase: '编码实现', purpose: '其他' }, 5, 8)
    const res = appendExport({
      existing,
      meta: { ...meta, exportedAtMs: 2000000 },
      strategy,
      segments: [newSeg],
      toc: renderToc(strategy, tocOf([
        [1, { phase: '需求分析', purpose: '问答型' }],
        [2, newSeg.labels],
      ])),
      watermark: w0,
      appendedSegments: 1,
      appendedTurns: [{ endSeq: 8, endTime: 9 }],
      allSegments: [seg(1, { phase: '需求分析', purpose: '问答型' }, 1, 4), newSeg],
      segmentAnnotations: [{ no: 1, annotation: '> ⚠️ **变更标记**（测试）' }],
    })
    // ① 结构合法 → 正常追加（不是走重建）
    expect(res).not.toBeNull()
    const out = res!.newContent
    // ② 追加后仍是当前格式（正文区没有因示例而丢半个围栏）
    expect(isCurrentFormat(out)).toBe(true)
    // ③ 引用示例原文完整保留（含围栏内的 `## 备注` 与 `### 第 9 轮`，闭合围栏没被吃掉）
    expect(out).toContain(
      '````markdown\n<!-- dsh-export:rounds-end -->\n## 备注\n### 第 9 轮：引用示例\n````',
    )
    // ④ `## 备注` 仍是 2 处（引用里的 + 真实的），真实备注按当前模板重排且在全文件最后
    expect(out.split('## 备注')).toHaveLength(3)
    const realNotes =
      '- 本文件由 dsh-session-export-md 生成（format=10）；分类策略：常规开发规模；覆盖：开发阶段 2/3 类、对话功能/目的 2/2 类。'
    expect(out).toContain(`- 敏感信息已脱敏。\n${realNotes}\n`)
    expect(out.indexOf('### 第 2 轮：段标题2')).toBeLessThan(out.indexOf(realNotes))
    // ⑤ front matter 的 turns 按重建后的轮次数更新（引用示例里的第 9 轮不算）
    expect(out).toContain('\nturns: 2\n')
    // ⑥ 标注插到第 1 轮标题正下方；新轮次追加在正文区末尾
    expect(out).toContain(
      '## 对话正文\n\n### 第 1 轮：段标题1\n\n> ⚠️ **变更标记**（测试）\n\n' +
        '#开发阶段/需求分析 #对话功能-目的/问答型',
    )
    expect(out.indexOf('### 第 9 轮：引用示例')).toBeLessThan(out.indexOf('### 第 2 轮：段标题2'))
  })
})

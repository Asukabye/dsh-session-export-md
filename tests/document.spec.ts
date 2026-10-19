import { describe, expect, it } from 'vitest'
import { anchorLine, bodyRange, parseDocument } from '../src/core/document.js'

/** 用行数组拼文档：避免在模板串里写反引号围栏。 */
function doc(lines: readonly string[]): string {
  return lines.join('\n') + '\n'
}

/** 含「正文引用示例」的文档（format 10 结构）：引用的示例里带旧标记、`## 备注` 与 `### 第 9 轮`。 */
const withQuotedSample = doc([
  '---',
  'format: 10',
  '---',
  '',
  '# 对话信息',
  '',
  '## 目录',
  '',
  '### 开发阶段',
  '',
  '**1. 需求分析**（1 轮）',
  '- [[#第 1 轮：示例标题]]',
  '',
  '## 对话正文',
  '',
  '### 第 1 轮：示例标题',
  '',
  '**用户**：第一个问题',
  '',
  '````markdown',
  '<!-- dsh-export:rounds-end -->',
  '## 备注',
  '### 第 9 轮：引用里的示例',
  '````',
  '',
  '### 第 2 轮',
  '',
  '**用户**：第二个问题',
  '',
  '## 备注',
  '',
  '- 敏感信息已脱敏。',
])

describe('parseDocument：围栏感知的结构定位', () => {
  it('识别结构标题与正文区轮次', () => {
    const layout = parseDocument(withQuotedSample)
    expect(layout.lines[layout.infoLine]).toBe('# 对话信息')
    expect(layout.lines[layout.tocLine]).toBe('## 目录')
    expect(layout.lines[layout.bodyLine]).toBe('## 对话正文')
    expect(layout.lines[layout.notesLine]).toBe('## 备注')
    expect(layout.rounds.map(r => r.no)).toEqual([1, 2])
    expect(layout.rounds.map(r => r.line)).toEqual([15, 25])
    expect(layout.rounds[0]?.title).toBe('示例标题')
    expect(layout.rounds[1]?.title).toBe('')
  })

  it('代码围栏里被引用的示例（旧标记 / ## 备注 / ### 第 9 轮）一律不参与解析', () => {
    const layout = parseDocument(withQuotedSample)
    expect(layout.rounds.some(r => r.no === 9)).toBe(false)
    // 备注行号只认围栏之外的那一个
    expect(layout.notesLine).toBe(29)
    expect(layout.lines.filter(l => l === '## 备注')).toHaveLength(2)
  })

  it('四反引号围栏包住三反引号代码块时，围栏在正确位置闭合', () => {
    const layout = parseDocument(doc([
      '# 对话信息',
      '',
      '## 对话正文',
      '',
      '````markdown',
      '```ts',
      'const a = 1',
      '```',
      '````',
      '',
      '### 第 1 轮',
      '',
      '## 备注',
    ]))
    // 围栏关闭后 `### 第 1 轮` 仍能被识别：说明没有提前退出围栏状态
    expect(layout.rounds.map(r => r.no)).toEqual([1])
    expect(layout.lines[layout.notesLine]).toBe('## 备注')
  })

  it('波浪号围栏同样生效', () => {
    const layout = parseDocument(doc([
      '# 对话信息',
      '',
      '## 对话正文',
      '',
      '~~~markdown',
      '## 备注',
      '~~~',
      '',
      '### 第 1 轮',
      '',
      '## 备注',
    ]))
    expect(layout.lines[layout.notesLine]).toBe('## 备注')
    expect(layout.notesLine).toBe(10)
    expect(layout.rounds.map(r => r.no)).toEqual([1])
  })

  it('围栏未闭合时其后的标题不再被识别（宁可不定位，也不误判）', () => {
    const layout = parseDocument(doc([
      '# 对话信息',
      '',
      '## 对话正文',
      '',
      '```markdown',
      '## 备注',
      '',
      '### 第 1 轮',
    ]))
    expect(layout.notesLine).toBe(-1)
    expect(layout.rounds).toEqual([])
  })

  it('轮次标题只在正文区内计数（标题行之前的同名标题不算）', () => {
    const layout = parseDocument(doc([
      '# 对话信息',
      '',
      '## 目录',
      '',
      '### 第 8 轮：目录区的异常标题',
      '',
      '## 对话正文',
      '',
      '### 第 1 轮',
      '',
      '## 备注',
    ]))
    expect(layout.rounds.map(r => r.no)).toEqual([1])
  })

  it('轮次标题里的 Markdown 转义会被还原', () => {
    const layout = parseDocument(doc([
      '# 对话信息',
      '',
      '## 对话正文',
      '',
      '### 第 1 轮：规则\\[1\\]：变更标记',
      '',
      '## 备注',
    ]))
    expect(layout.rounds[0]?.title).toBe('规则[1]：变更标记')
  })

  it('bodyRange 给出正文区行号区间（不含 `## 对话正文` 行与备注行）', () => {
    const layout = parseDocument(withQuotedSample)
    const range = bodyRange(layout)
    expect(range).toEqual({ start: layout.bodyLine + 1, end: layout.notesLine })
    expect(layout.lines[range!.start]).toBe('')
    expect(layout.lines[range!.end]).toBe('## 备注')
  })

  it('缺少结构标题时返回 -1 / null，交由调用方判定重建', () => {
    const layout = parseDocument(doc(['# 别的文档', '', '正文']))
    expect(layout.tocLine).toBe(-1)
    expect(layout.bodyLine).toBe(-1)
    expect(layout.notesLine).toBe(-1)
    expect(bodyRange(layout)).toBeNull()
  })
})

describe('anchorLine：需要文件内定位点时的唯一形式（E2）', () => {
  it('生成不可见锚点，而不是会被编辑器高亮的 HTML 注释', () => {
    expect(anchorLine('toc-begin')).toBe('<a id="dsh-export-toc-begin"></a>')
    expect(anchorLine('body-begin')).toBe('<a id="dsh-export-body-begin"></a>')
    expect(anchorLine('body-end')).toBe('<a id="dsh-export-body-end"></a>')
    for (const name of ['toc-begin', 'body-begin', 'body-end'] as const) {
      expect(anchorLine(name)).not.toContain('<!--')
    }
  })
})

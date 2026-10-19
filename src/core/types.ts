/**
 * 导出流水线的公共类型。
 *
 * 事件形状参照 DSH session JSONL 的 canonical 事件（released-v0-real-shapes 夹具与
 * session.v3 格式），采用宽容解析：只声明导出关心的字段，容忍未知事件类型与字段漂移。
 * 集成阶段接入 ctx.sessions 读取后，若 v3 存在字段差异，仅需在本文件对齐。
 */

/** DSH 会话事件记录（宽容解析：容忍未知顶层字段，如 session 头的 version/id/createdAt/cwd）。 */
export interface SessionEvent {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
  /** 'append' 或替换对象 { op, start, end }。 */
  surfaceOp?: string | SurfaceReplace
  sourceEventSeqs?: number[]
  [key: string]: unknown
}

export interface SurfaceReplace {
  op: string
  start?: number
  end?: number
}

/** 消息内容块（文本为主，容忍其他类型）。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: string; [key: string]: unknown }

export interface UserMessage {
  seq: number
  time: number
  id?: string
  content: ContentBlock[]
}

export interface AssistantMessage {
  seq: number
  time: number
  id?: string
  content: ContentBlock[]
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ToolEvent {
  seq: number
  time: number
  kind: 'call' | 'result' | 'other'
  name?: string
  payload?: Record<string, unknown>
}

/** 折叠后的逻辑轮次。 */
export interface Turn {
  turnNo: number
  startSeq: number
  endSeq: number
  startTime: number
  endTime: number
  /** 是否已收到 turn/end。 */
  completed: boolean
  user: UserMessage[]
  assistant: AssistantMessage[]
  tools: ToolEvent[]
  /** 本轮的模型工具调用（仅用于「产物」提取，正文不导出）。 */
  toolCalls: ToolCallRecord[]
  /** 本轮的交付事件（present / deliverables，用于「产物」）。 */
  deliverables: { path: string; description?: string }[]
}

/** 增量水位（按会话存 storageDomain KV 的 exportWatermark 表）。 */
export interface Watermark {
  sessionId: string
  /** 上次导出覆盖到的最后一个 turn/end seq（技术比较，单调）。 */
  lastTurnEndSeq: number
  /** 上次导出覆盖到的最后一个 turn/end time（展示用）。 */
  lastTurnEndTime: number
  /** 已导出的最大段编号，保证编号连续。 */
  lastSegmentNo: number
  mdPath: string
}

export interface StrategyModule {
  name: string
  description?: string
  examples?: string[]
}

/**
 * 一个分类维度（如「开发阶段」「对话功能/目的」）：自带模块词表与兜底模块。
 * 双维度是 format=5 起的核心：每轮同时归入每个维度的一个模块。
 */
export interface StrategyDimension {
  /** 维度 id（如 phase / purpose），文档内不显示，仅作映射键。 */
  id: string
  /** 维度显示名（目录里的粗体小标题）。 */
  name: string
  modules: StrategyModule[]
  /** 该维度归类失败或无法归类时的兜底模块。 */
  defaultModule: string
}

/** 分类策略（容器存 storageDomain KV 的 exportStrategies 表）。 */
export interface Strategy {
  id: string
  name: string
  /** 维度顺序即目录顺序。 */
  dimensions: StrategyDimension[]
  source: 'builtin' | 'llm' | 'imported'
}

/** 产物的类别（文档「#### 产物」的固定顺序）。 */
export type ArtifactKind =
  | '代码'
  | '测试'
  | '命令'
  | '文档'
  | '图表'
  | '决策'
  | '提示词'
  | '数据'
  | '报告'
  | '链接'
  | '附件'

/** 一条产物：kind 决定归属分类，value 是路径/命令/URL 原文。 */
export interface ArtifactItem {
  kind: ArtifactKind
  value: string
}

/** 一次工具调用（只留名称与参数原文，正文仍不导出工具载荷）。 */
export interface ToolCallRecord {
  name: string
  /** 参数 JSON 原文（解析失败时按原样保留）。 */
  arguments: string
}

/** 编辑/撤回检测结果。 */
export interface ChangeRecord {
  kind: 'edit' | 'withdraw'
  seq: number
  time: number
  /** 被替换/撤回的 seq 范围（可能落在已导出范围）。 */
  targetStart: number
  targetEnd: number
  turnNo?: number
  /** 编辑后的新内容（withdraw 时为空）。 */
  newContent?: ContentBlock[]
}

/** 待渲染的一轮（format=8：按轮次时间序，标题由模型生成）。 */
export interface ExportSegment {
  /** 轮次序号（1..N，按 turn 顺序）。 */
  no: number
  /** 轮次标题（模型生成的动作式标题；写入正文标题行与目录）。 */
  title: string
  /** dimensionId → 该维度下的模块名。 */
  labels: Record<string, string>
  /** 从回答里提取的概要（空 = 文档对应位置留空）。 */
  summary: string
  /** 本轮产物（本地规则提取；空 = 文档省略「产物」小节）。 */
  artifacts: ArtifactItem[]
  turn: Turn
  changes: ChangeRecord[]
}

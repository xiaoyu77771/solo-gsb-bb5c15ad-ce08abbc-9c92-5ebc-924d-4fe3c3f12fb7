// 共享数据模型：前端状态、分析结果、导入导出均使用这些类型

export type NodeKind = 'article' | 'paragraph' | 'item';

export interface ClauseNode {
  id: string;
  kind: NodeKind;
  /** 结构序号（从 1 开始，始终等于其在同级中的位置） */
  ordinal: number;
  /** 条序号后缀原文，如 “之一”“之二” */
  suffix?: string;
  /** 条标题行中编号之后的文字，如【立法目的】 */
  title?: string;
  /** 正文（不含“第X条”“（一）”等编号前缀） */
  text: string;
  children: ClauseNode[];
}

export interface ClauseDocument {
  id: string;
  title: string;
  /** 顶层节点：条 */
  root: ClauseNode[];
  updatedAt: number;
}

export type NumStyle = 'arabic' | 'chinese';
export type RefKind =
  | 'absolute' // 第X条[之Y][第N款][第M项 / （M）]
  | 'this' // 本条[第N款][第M项]
  | 'prevArticle' // 前条 / 上条[链]
  | 'nextArticle' // 后条 / 下条[链]
  | 'prevParagraph' // 前款[第M项]
  | 'prevItem' // 前项
  | 'thisParagraph' // 本款[第M项]
  | 'thisItem' // 本项
  | 'bareItem'; // （M）

export interface RefSpan {
  start: number;
  end: number;
  raw: string;
  kind: RefKind;
  articleNum?: number;
  articleSuffix?: string;
  paragraphNum?: number;
  itemNum?: number;
  /** 项编号的书写形式 */
  itemParenForm?: boolean;
  articleStyle?: NumStyle;
  paragraphStyle?: NumStyle;
  itemStyle?: NumStyle;
}

export type RefStatus = 'ok' | 'broken' | 'ambiguous';

export interface RefResolution {
  status: RefStatus;
  /** 唯一定位时的目标节点 id */
  targetId?: string;
  /** 歧义时的候选节点 id 列表 */
  candidates?: string[];
  /** 唯一定位时的规范引用文字 */
  canonical?: string;
  /** 不可解析原因 / 歧义说明 */
  reason?: string;
  /** 已由用户确认的歧义引用：保留原始候选与原因，便于复核或撤销 */
  ambiguity?: {
    candidates: string[];
    reason?: string;
  };
}

export interface RefOccurrence {
  /** nodeId + 偏移构成的稳定 id */
  key: string;
  nodeId: string;
  span: RefSpan;
  resolution: RefResolution;
  /** 同节点内同原文的第几次出现（用于确认签名） */
  occurrenceIndex: number;
  /** 确认映射使用的签名 */
  signature: string;
}

export type IssueType = 'broken' | 'self' | 'cycle' | 'ambiguous';

export interface Issue {
  key: string;
  type: IssueType;
  sourceNodeId: string;
  /** 源句在正文中的字符区间 */
  sentenceStart: number;
  sentenceEnd: number;
  /** 引用 span 区间（cycle 类问题可能没有单一 span） */
  refStart?: number;
  refEnd?: number;
  refKey?: string;
  targetNodeId?: string;
  message: string;
  /** 循环路径上的节点 id */
  cycleNodeIds?: string[];
  /** 歧义已被用户确认时的目标 id（问题转为“已确认”状态，仍可撤销） */
  confirmedTargetId?: string;
}

export interface Analysis {
  nodes: Record<string, ClauseNode>;
  articles: ClauseNode[];
  /** nodeId -> 结构位置信息 */
  placement: Record<string, NodePlacement>;
  occurrences: RefOccurrence[];
  byNode: Record<string, RefOccurrence[]>;
  issues: Issue[];
  /** 条级引用边（用于关系视图） */
  edges: ArticleEdge[];
}

export interface NodePlacement {
  article: ClauseNode;
  articleIndex: number;
  paragraph?: ClauseNode;
  paragraphIndex: number; // 该条下第几段（条头为第 0 段，正文段从 1 开始）
  item?: ClauseNode;
  itemIndex: number; // 该段下第几项（从 1 开始）
}

export interface ArticleEdge {
  sourceArticleId: string;
  targetArticleId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: RefKind;
  status: RefStatus;
  refKey: string;
}

/** 命名版本快照：保存时刻的文档与歧义确认（只读，不随后续编辑变化） */
export interface DocSnapshot {
  id: string;
  name: string;
  createdAt: number;
  doc: ClauseDocument;
  /** 保存时刻的歧义确认记录 */
  confirmed: Record<string, string>;
}

/** 持久化状态（同时用于本地文件与浏览器缓存） */
export interface PersistedState {
  doc: ClauseDocument;
  /** 歧义引用确认：signature -> targetId */
  confirmed: Record<string, string>;
  /** 命名版本快照；旧数据缺少该字段时按空列表加载 */
  snapshots?: DocSnapshot[];
}

export interface ExportBundle {
  app: 'clause-reference-validator';
  version: 1;
  document: ClauseDocument;
  confirmed: Record<string, string>;
  /** 命名版本快照随 JSON 一并导出，导入时恢复 */
  snapshots?: DocSnapshot[];
  exportedAt: string;
}

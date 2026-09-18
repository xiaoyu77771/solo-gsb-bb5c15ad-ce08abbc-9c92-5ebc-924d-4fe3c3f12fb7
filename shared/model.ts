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

/** 命名版本快照：保存时刻的文档与歧义确认、批注（只读，不随后续编辑变化） */
export interface DocSnapshot {
  id: string;
  name: string;
  createdAt: number;
  doc: ClauseDocument;
  /** 保存时刻的歧义确认记录 */
  confirmed: Record<string, string>;
  /** 保存时刻的审阅批注（重定位记录随快照一并冻结）；旧数据缺少该字段时按空列表加载 */
  annotations?: Annotation[];
}

// ---------- 审阅批注 ----------

/**
 * anchored：引用片段在目标节点中唯一定位（raw.offset 有效）；
 * review：节点已删除、片段缺失或存在多处匹配，须人工复核，候选保留在 candidates 中。
 */
export type AnnotationStatus = 'anchored' | 'review';

/** 片段重定位候选（片段在某节点文本中多处匹配时全部保留，供人工选择） */
export interface AnnotationCandidate {
  /** 候选所在节点 id */
  nodeId: string;
  /** 候选片段起点 */
  start: number;
  /** 候选片段终点 */
  end: number;
  /** 重定位途径：exact 原文精确匹配 / context 前后文锚点匹配 / position 结构位置推断 */
  via: 'exact' | 'context' | 'position';
}

export interface Annotation {
  /** 稳定批注 ID */
  id: string;
  /** 创建时所在节点 ID；重定位后更新为候选节点（待复核时保留创建时/最后确认的节点） */
  nodeId: string;
  /** 批注正文 */
  note: string;
  /** 创建时间 */
  createdAt: number;
  /** 最近一次编辑批注正文的时间 */
  updatedAt: number;
  /** 引用片段原文 */
  quote: string;
  /** 创建时的片段区间（用于与 quote 共同构成稳定锚点，不随自动重定位改写） */
  origStart: number;
  origEnd: number;
  /** 前文锚点（片段前若干字，用于编辑后的重定位） */
  prefix: string;
  /** 后文锚点（片段后若干字，用于编辑后的重定位） */
  suffix: string;
  /** 当前重定位状态（由 annotations 引擎依据当前文档推导后写回） */
  status: AnnotationStatus;
  /** anchored 时当前片段区间 */
  offset?: { start: number; end: number };
  /** review 时的原因说明 */
  reason?: string;
  /** review 时保留的候选列表 */
  candidates?: AnnotationCandidate[];
  /** 最近一次成功重定位的途径（界面提示“自动重定位”来源） */
  resolvedVia?: AnnotationCandidate['via'];
  /** 用户已在候选中人工选定位置：之后以该节点为准，不因他处另有相同片段而退回待复核 */
  anchoredByUser?: boolean;
}

/** 持久化状态（同时用于本地文件与浏览器缓存） */
export interface PersistedState {
  doc: ClauseDocument;
  /** 歧义引用确认：signature -> targetId */
  confirmed: Record<string, string>;
  /** 命名版本快照；旧数据缺少该字段时按空列表加载 */
  snapshots?: DocSnapshot[];
  /** 审阅批注；旧数据缺少该字段时按空列表加载 */
  annotations?: Annotation[];
}

export interface ExportBundle {
  app: 'clause-reference-validator';
  version: 1;
  document: ClauseDocument;
  confirmed: Record<string, string>;
  /** 命名版本快照随 JSON 一并导出，导入时恢复 */
  snapshots?: DocSnapshot[];
  /** 审阅批注随 JSON 一并导出，导入时按当前文档重新定位 */
  annotations?: Annotation[];
  exportedAt: string;
}

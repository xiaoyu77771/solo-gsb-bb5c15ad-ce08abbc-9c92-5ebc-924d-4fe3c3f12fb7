import type {
  Annotation,
  AnnotationCandidate,
  ClauseDocument,
  ClauseNode,
} from '../../shared/model';
import { uid } from './uid';

/** 前后文锚点长度（取片段前后各 N 个字符） */
const ANCHOR_CHARS = 12;
/** 候选保留上限（按相关度排序后截断） */
const MAX_CANDIDATES = 10;

/** 从正文截取前后文锚点 */
export function extractAnchors(
  text: string,
  start: number,
  end: number,
): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, start - ANCHOR_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + ANCHOR_CHARS)),
  };
}

/** 创建批注：以节点正文与选取区间生成引用片段及前后文锚点 */
export function createAnnotation(
  nodeId: string,
  nodeText: string,
  start: number,
  end: number,
  note: string,
  now = Date.now(),
): Annotation {
  const quote = nodeText.slice(start, end);
  const { prefix, suffix } = extractAnchors(nodeText, start, end);
  return {
    id: uid('ann'),
    nodeId,
    note,
    createdAt: now,
    updatedAt: now,
    quote,
    origStart: start,
    origEnd: end,
    prefix,
    suffix,
    status: 'anchored',
    offset: { start, end },
  };
}

/** 列出 quote 在 text 中的全部出现位置（重叠不重复） */
function occurrencesOf(text: string, quote: string): number[] {
  if (!quote) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    out.push(i);
    from = i + quote.length;
  }
  return out;
}

/** 前后文锚点评分：前缀/后缀与锚点的最长公共后缀/前缀长度之和 */
function contextScore(text: string, start: number, end: number, a: Annotation): number {
  const before = text.slice(Math.max(0, start - ANCHOR_CHARS), start);
  const after = text.slice(end, Math.min(text.length, end + ANCHOR_CHARS));
  return commonSuffixLen(before, a.prefix) + commonPrefixLen(after, a.suffix);
}

function commonSuffixLen(x: string, y: string): number {
  let n = 0;
  const max = Math.min(x.length, y.length);
  while (n < max && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(x: string, y: string): number {
  let n = 0;
  const max = Math.min(x.length, y.length);
  while (n < max && x[n] === y[n]) n++;
  return n;
}

function allNodes(doc: ClauseDocument): { node: ClauseNode }[] {
  const out: { node: ClauseNode }[] = [];
  const walk = (nodes: ClauseNode[]) => {
    for (const n of nodes) {
      out.push({ node: n });
      walk(n.children);
    }
  };
  walk(doc.root);
  return out;
}

/**
 * 依据当前文档重定位单条批注。返回的对象复用原批注字段并更新定位字段；
 * 定位成功（anchored）时按新位置重写前后文锚点，原始区间 origStart/origEnd 永不改写。
 *
 * 判定规则（引用片段在全文范围内）：
 * - 全局唯一匹配：自动锚定（位于原节点为 exact，移动到其它节点也自动跟随）；
 * - 全局多处匹配：待复核，保留全部候选（前后文锚点相关度仅用于候选排序，不自动选定）；
 * - 全局无匹配：待复核（不依据锚点猜测等长的其它文字）。
 */
function relocateOne(
  ann: Annotation,
  doc: ClauseDocument,
  byId: Map<string, ClauseNode>,
): Annotation {
  const self = byId.get(ann.nodeId);

  interface Hit {
    node: ClauseNode;
    start: number;
    end: number;
    score: number;
  }
  const hits: Hit[] = [];
  for (const { node } of allNodes(doc)) {
    // 用户已人工选定位置：只在其选定的节点内跟踪，忽略他处的相同片段
    if (ann.anchoredByUser && node.id !== ann.nodeId) continue;
    for (const start of occurrencesOf(node.text, ann.quote)) {
      const end = start + ann.quote.length;
      hits.push({ node, start, end, score: contextScore(node.text, start, end, ann) });
    }
  }

  if (hits.length === 1) {
    const hit = hits[0];
    const anchors = extractAnchors(hit.node.text, hit.start, hit.end);
    return {
      ...ann,
      nodeId: hit.node.id,
      status: 'anchored',
      offset: { start: hit.start, end: hit.end },
      candidates: undefined,
      reason: undefined,
      resolvedVia: 'exact',
      prefix: anchors.prefix,
      suffix: anchors.suffix,
    };
  }

  if (hits.length > 1) {
    // 原位置上的匹配优先排在候选最前，其次按前后文锚点相关度
    hits.sort((a, b) => {
      const ao = a.node.id === ann.nodeId ? 1 : 0;
      const bo = b.node.id === ann.nodeId ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return b.score - a.score;
    });
    const selfCount = hits.filter((h) => h.node.id === ann.nodeId).length;
    const reason = self
      ? selfCount > 0
        ? `片段「${truncate(ann.quote)}」在全文出现 ${hits.length} 处（本节点 ${selfCount} 处），需人工确认`
        : `本节点片段已改动，且「${truncate(ann.quote)}」在其它节点匹配 ${hits.length} 处，需人工确认`
      : `原节点已删除，片段「${truncate(ann.quote)}」在 ${hits.length} 个位置匹配，需人工确认`;
    return {
      ...ann,
      status: 'review',
      offset: undefined,
      candidates: hits.slice(0, MAX_CANDIDATES).map<AnnotationCandidate>((h) => ({
        nodeId: h.node.id,
        start: h.start,
        end: h.end,
        via: 'exact',
      })),
      reason,
    };
  }

  // 全局无匹配：无法可靠定位，标为待复核（原节点仍在 / 已删除分别提示）
  if (self) {
    return {
      ...ann,
      status: 'review',
      offset: undefined,
      candidates: [],
      reason: `片段「${truncate(ann.quote)}」在本节点正文中已不存在，且全文无相同片段`,
    };
  }
  return {
    ...ann,
    status: 'review',
    offset: undefined,
    candidates: [],
    reason: `原节点已删除，片段「${truncate(ann.quote)}」在全文中均未找到`,
  };
}

/**
 * 仅当引用片段在原节点已不存在时，才进入全文精确匹配 / 缺失流程。
 * 说明：插入或删除导致的偏移，由“原节点唯一精确匹配”自然覆盖；
 * 若片段文字本身被改写，则不再依据锚点猜测其它等长文字，一律标为待复核。
 */

function truncate(s: string, n = 18): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 正文或结构调整后，对全部批注执行自动重定位。
 * 每次都在全文范围重新评估：即便原区间仍命中，也可能因新增了另一处相同片段而变为多处匹配。
 */
export function relocateAnnotations(
  annotations: Annotation[],
  doc: ClauseDocument,
): Annotation[] {
  const byId = new Map<string, ClauseNode>();
  for (const { node } of allNodes(doc)) byId.set(node.id, node);
  return annotations.map((ann) => relocateOne(ann, doc, byId));
}

/** 人工采纳候选：锚定到指定候选位置，并重写前后文锚点 */
export function resolveAnnotation(
  annotations: Annotation[],
  annotationId: string,
  candidate: AnnotationCandidate,
  doc: ClauseDocument,
  now = Date.now(),
): Annotation[] {
  const node = findNodeById(doc, candidate.nodeId);
  if (!node) return annotations;
  const quote = node.text.slice(candidate.start, candidate.end);
  const anchors = extractAnchors(node.text, candidate.start, candidate.end);
  return annotations.map((ann) =>
    ann.id === annotationId
      ? {
          ...ann,
          nodeId: candidate.nodeId,
          quote,
          prefix: anchors.prefix,
          suffix: anchors.suffix,
          status: 'anchored' as const,
          offset: { start: candidate.start, end: candidate.end },
          candidates: undefined,
          reason: undefined,
          resolvedVia: candidate.via,
          anchoredByUser: true,
          updatedAt: now,
        }
      : ann,
  );
}

function findNodeById(doc: ClauseDocument, id: string): ClauseNode | null {
  const walk = (nodes: ClauseNode[]): ClauseNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const inner = walk(n.children);
      if (inner) return inner;
    }
    return null;
  };
  return walk(doc.root);
}

/** 校验并规整外部数据中的批注列表（旧数据 / 导入文件缺省时返回空列表） */
export function sanitizeAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) return [];
  const out: Annotation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Partial<Annotation>;
    if (typeof a.nodeId !== 'string' || typeof a.quote !== 'string' || !a.quote) continue;
    const note = typeof a.note === 'string' ? a.note : '';
    const ann: Annotation = {
      id: typeof a.id === 'string' && a.id ? a.id : uid('ann'),
      nodeId: a.nodeId,
      note,
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
      updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0,
      quote: a.quote,
      origStart: typeof a.origStart === 'number' ? a.origStart : 0,
      origEnd: typeof a.origEnd === 'number' ? a.origEnd : a.quote.length,
      prefix: typeof a.prefix === 'string' ? a.prefix : '',
      suffix: typeof a.suffix === 'string' ? a.suffix : '',
      status: a.status === 'anchored' ? 'anchored' : 'review',
    };
    if (a.offset && typeof a.offset.start === 'number' && typeof a.offset.end === 'number') {
      ann.offset = { start: a.offset.start, end: a.offset.end };
    }
    if (typeof a.reason === 'string') ann.reason = a.reason;
    if (Array.isArray(a.candidates)) {
      const candidates: AnnotationCandidate[] = [];
      for (const c of a.candidates) {
        if (
          !c ||
          typeof c !== 'object' ||
          typeof c.nodeId !== 'string' ||
          typeof c.start !== 'number' ||
          typeof c.end !== 'number'
        ) {
          continue;
        }
        const via: AnnotationCandidate['via'] =
          c.via === 'context' || c.via === 'position' ? c.via : 'exact';
        candidates.push({ nodeId: c.nodeId, start: c.start, end: c.end, via });
      }
      if (candidates.length) ann.candidates = candidates.slice(0, MAX_CANDIDATES);
    }
    if (a.resolvedVia === 'exact' || a.resolvedVia === 'context' || a.resolvedVia === 'position') {
      ann.resolvedVia = a.resolvedVia;
    }
    if (a.anchoredByUser === true) ann.anchoredByUser = true;
    out.push(ann);
  }
  return out;
}

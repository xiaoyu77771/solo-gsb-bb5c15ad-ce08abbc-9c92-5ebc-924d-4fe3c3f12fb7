import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClauseNode, RefOccurrence } from '../../shared/model';
import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import { RefInline } from './RefInline';

/** 节点正文中的一条批注装饰（已定位批注或待复核候选位置） */
export interface AnnMark {
  annotationId: string;
  start: number;
  end: number;
  /** candidate：待复核批注保留的候选位置；anchor：已定位批注 */
  kind: 'anchor' | 'candidate';
}

interface PendingSelection {
  start: number;
  end: number;
  top: number;
  left: number;
}

export function NodeEditor({
  node,
  occurrences,
  annMarks,
  isHead = false,
}: {
  node: ClauseNode;
  occurrences: RefOccurrence[];
  annMarks: AnnMark[];
  isHead?: boolean;
}) {
  const { store, highlighter, sidebar } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.text);
  const hl = useHighlighter(highlighter);
  const bodyRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);

  useEffect(() => {
    if (!editing) setDraft(node.text);
  }, [node.text, editing]);

  // 问题跳转 / 批注跳转：滚动到节点
  useEffect(() => {
    if (hl.focusNonce === 0) return;
    const focusNode = hl.activeNodeId === node.id || hl.focusAnnotation?.nodeId === node.id;
    if (!focusNode) return;
    const el = bodyRef.current?.closest('[data-node-id]') as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [hl.activeNodeId, hl.focusAnnotation, hl.focusNonce, node.id]);

  const save = () => {
    store.updateNodeText(node.id, draft);
    setEditing(false);
  };

  const isFocused = hl.activeNodeId === node.id;
  const sentence =
    hl.focusSentence && hl.focusSentence.nodeId === node.id ? hl.focusSentence : null;
  const focusRange =
    hl.focusAnnotation && hl.focusAnnotation.nodeId === node.id ? hl.focusAnnotation : null;

  // 选区变化后：若选区离开正文容器或折叠，收起“＋批注”按钮
  useEffect(() => {
    if (!pending) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !renderedRef.current) return;
      if (!sel.anchorNode || !renderedRef.current.contains(sel.anchorNode)) {
        setPending(null);
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [pending]);

  const captureSelection = () => {
    const container = renderedRef.current;
    if (!container) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer) ||
      !sel.toString().trim()
    ) {
      return;
    }
    const offsets = selectionOffsets(container, range);
    if (!offsets || offsets.start >= offsets.end) return;
    const rect = range.getBoundingClientRect();
    setPending({
      start: offsets.start,
      end: offsets.end,
      top: rect.top,
      left: rect.left + rect.width / 2,
    });
  };

  const annCount = annMarks.filter((m) => m.kind === 'anchor').length;

  return (
    <div
      ref={bodyRef}
      className={`node-text ${isHead ? 'head-text' : ''} ${isFocused ? 'focused' : ''}`}
    >
      {editing ? (
        <div className="text-edit-wrap">
          <textarea
            className="text-edit"
            value={draft}
            autoFocus
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') {
                setDraft(node.text);
                setEditing(false);
              }
            }}
          />
          <div className="edit-hint">Ctrl+Enter 保存 · Esc 取消</div>
        </div>
      ) : (
        <div
          ref={renderedRef}
          className="rendered-text"
          onMouseUp={captureSelection}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('.ref-chip, .ann-mark')) return;
            setEditing(true);
          }}
          title="点击编辑正文 · 选取文字可加批注"
        >
          {node.text ? (
            <DecoratedText
              text={node.text}
              occurrences={occurrences}
              annMarks={annMarks}
              sentence={sentence}
              focusRange={focusRange}
              onOpenAnnotation={(annotationId, start, end) => {
                sidebar.setTab('annotations');
                highlighter.jumpToAnnotation(annotationId, node.id, { start, end });
              }}
            />
          ) : (
            <span className="placeholder-text">（空，点击添加正文）</span>
          )}
        </div>
      )}

      {annCount > 0 && !editing && (
        <button
          type="button"
          className="ann-count-badge"
          title="列出本节点批注"
          onClick={(e) => {
            e.stopPropagation();
            sidebar.setTab('annotations');
          }}
        >
          📝 {annCount} 条批注
        </button>
      )}

      {pending && (
        <AnnotationComposer
          pending={pending}
          onClose={() => setPending(null)}
          onSave={(note) => {
            const id = store.addAnnotation(node.id, pending.start, pending.end, note);
            setPending(null);
            if (id) {
              sidebar.setTab('annotations');
              highlighter.jumpToAnnotation(id, node.id, { start: pending.start, end: pending.end });
            }
          }}
        />
      )}
    </div>
  );
}

function AnnotationComposer({
  pending,
  onSave,
  onClose,
}: {
  pending: PendingSelection;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  if (!open) {
    return (
      <div
        className="ann-pop"
        style={{ position: 'fixed', top: Math.max(8, pending.top - 38), left: pending.left }}
      >
        <button
          type="button"
          className="ann-pop-btn"
          // 按下时不移动焦点，避免选区被折叠
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen(true)}
        >
          ＋ 批注
        </button>
        <button
          type="button"
          className="ann-pop-cancel"
          title="取消"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div
      className="ann-composer"
      style={{ position: 'fixed', top: Math.max(8, pending.top - 168), left: pending.left }}
    >
      <textarea
        className="ann-composer-input"
        placeholder="填写审阅批注（Ctrl+Enter 保存，Esc 取消）"
        value={note}
        autoFocus
        rows={4}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (note.trim()) onSave(note);
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="ann-composer-actions">
        <button className="primary small" onClick={() => note.trim() && onSave(note)}>
          保存批注
        </button>
        <button className="small" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------- 引用 chip + 批注标记 + 源句高亮的统一装饰渲染 ----------

type Decoration =
  | { kind: 'ref'; key: string; start: number; end: number; occurrence: RefOccurrence }
  | { kind: 'ann'; key: string; start: number; end: number; mark: AnnMark; active: boolean };

interface Frame {
  dec: Decoration;
  children: React.ReactNode[];
}

function DecoratedText({
  text,
  occurrences,
  annMarks,
  sentence,
  focusRange,
  onOpenAnnotation,
}: {
  text: string;
  occurrences: RefOccurrence[];
  annMarks: AnnMark[];
  sentence: { start: number; end: number } | null;
  focusRange: { annotationId: string; start: number; end: number } | null;
  onOpenAnnotation: (annotationId: string, start: number, end: number) => void;
}) {
  const decorations = useMemo<Decoration[]>(() => {
    const decs: Decoration[] = [];
    for (const occ of occurrences) {
      if (occ.span.start < 0 || occ.span.end > text.length) continue;
      decs.push({
        kind: 'ref',
        key: occ.key,
        start: occ.span.start,
        end: occ.span.end,
        occurrence: occ,
      });
    }
    for (const mark of annMarks) {
      if (mark.start < 0 || mark.end > text.length || mark.start >= mark.end) continue;
      decs.push({
        kind: 'ann',
        key: `${mark.kind}:${mark.annotationId}:${mark.start}`,
        start: mark.start,
        end: mark.end,
        mark,
        active:
          !!focusRange &&
          focusRange.annotationId === mark.annotationId &&
          focusRange.start === mark.start &&
          focusRange.end === mark.end,
      });
    }
    return decs;
  }, [occurrences, annMarks, text.length, focusRange]);

  const inSentence = (start: number, end: number) =>
    sentence ? start >= sentence.start && end <= sentence.end : false;

  // 构造边界事件：同位置先退出后进入，保证相邻区间不误嵌套
  type Event = { at: number; type: 'enter' | 'exit'; dec: Decoration };
  const events: Event[] = [];
  for (const dec of decorations) {
    events.push({ at: dec.start, type: 'enter', dec });
    events.push({ at: dec.end, type: 'exit', dec });
  }
  events.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.type !== b.type) return a.type === 'exit' ? -1 : 1;
    return a.dec.kind === 'ann' ? -1 : 1;
  });

  const root: React.ReactNode[] = [];
  const stack: Frame[] = [];
  let cursor = 0;

  const pushLeaf = (value: string) => {
    if (!value) return;
    const base = cursor - value.length;
    const leaf = sentence ? splitSentence(value, base, sentence) : value;
    const top = stack[stack.length - 1];
    (top ? top.children : root).push(leaf);
  };

  const renderFrame = (frame: Frame): React.ReactNode => {
    const { dec, children } = frame;
    if (dec.kind === 'ref') {
      return (
        <RefInline
          key={dec.key}
          occurrence={dec.occurrence}
          highlight={inSentence(dec.start, dec.end)}
        >
          {children}
        </RefInline>
      );
    }
    const cls =
      dec.mark.kind === 'candidate'
        ? `ann-mark ann-mark-candidate ${dec.active ? 'ann-mark-active' : ''}`
        : `ann-mark ${dec.active ? 'ann-mark-active' : ''}`;
    return (
      <mark
        key={dec.key}
        className={cls}
        data-ann-id={dec.mark.annotationId}
        title={dec.mark.kind === 'candidate' ? '待复核批注的候选位置，点击处理' : '点击查看批注'}
        onClick={(e) => {
          e.stopPropagation();
          onOpenAnnotation(dec.mark.annotationId, dec.start, dec.end);
        }}
      >
        {children}
      </mark>
    );
  };

  for (const ev of events) {
    if (ev.at > text.length) break;
    pushLeaf(text.slice(cursor, ev.at));
    cursor = ev.at;
    if (ev.type === 'enter') {
      stack.push({ dec: ev.dec, children: [] });
    } else {
      // 找到对应帧（嵌套情况下从栈顶弹出到该帧为止）
      const idx = stack.findIndex((f) => f.dec.key === ev.dec.key);
      if (idx >= 0) {
        while (stack.length > idx) {
          const frame = stack.pop()!;
          const el = renderFrame(frame);
          const parent = stack[stack.length - 1];
          (parent ? parent.children : root).push(el);
        }
      }
    }
  }
  pushLeaf(text.slice(cursor));

  // 未闭合（防御性）：把残留帧拍平到根
  while (stack.length) {
    const frame = stack.pop()!;
    root.push(...frame.children);
  }

  return <>{root}</>;
}

function splitSentence(
  value: string,
  base: number,
  sentence: { start: number; end: number },
): React.ReactNode {
  const s = Math.max(0, sentence.start - base);
  const e = Math.min(value.length, sentence.end - base);
  if (e <= s) return value;
  return (
    <>
      {value.slice(0, s)}
      <mark className="sentence-mark">{value.slice(s, e)}</mark>
      {value.slice(e)}
    </>
  );
}

/**
 * 把 DOM Range 的起止位置换算为相对容器全部文本的字符偏移。
 * 正文容器的 textContent 与节点文本逐字一致（引用 chip 的可见文字即其原文）。
 */
function selectionOffsets(
  container: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  let n = walker.nextNode();
  while (n) {
    const tn = n as Text;
    textNodes.push(tn);
    const len = tn.length;
    if (tn === range.startContainer) start = total + range.startOffset;
    if (tn === range.endContainer) end = total + range.endOffset;
    total += len;
    n = walker.nextNode();
  }
  if (start === null || end === null) return null;
  return { start, end };
}

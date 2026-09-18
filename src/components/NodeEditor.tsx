import { useEffect, useRef, useState } from 'react';
import type { ClauseNode, RefOccurrence } from '../../shared/model';
import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import { RefInline } from './RefInline';

export function NodeEditor({
  node,
  occurrences,
  isHead = false,
}: {
  node: ClauseNode;
  occurrences: RefOccurrence[];
  isHead?: boolean;
}) {
  const { store, highlighter } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.text);
  const hl = useHighlighter(highlighter);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) setDraft(node.text);
  }, [node.text, editing]);

  // 问题跳转：滚动到节点并高亮源句
  useEffect(() => {
    if (hl.activeNodeId !== node.id || hl.focusNonce === 0) return;
    const el = bodyRef.current?.closest('[data-node-id]') as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [hl.activeNodeId, hl.focusNonce, node.id]);

  const save = () => {
    store.updateNodeText(node.id, draft);
    setEditing(false);
  };

  const isFocused = hl.activeNodeId === node.id;
  const sentence =
    hl.focusSentence && hl.focusSentence.nodeId === node.id ? hl.focusSentence : null;

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
          className="rendered-text"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('.ref-chip')) return;
            setEditing(true);
          }}
          title="点击编辑正文"
        >
          <HighlightedText
            text={node.text}
            occurrences={occurrences}
            sentence={sentence}
          />
        </div>
      )}
    </div>
  );
}

function HighlightedText({
  text,
  occurrences,
  sentence,
}: {
  text: string;
  occurrences: RefOccurrence[];
  sentence: { start: number; end: number } | null;
}) {
  if (!text) return <span className="placeholder-text">（空，点击添加正文）</span>;

  const sorted = [...occurrences].sort((a, b) => a.span.start - b.span.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  const inSentence = (start: number, end: number) =>
    sentence ? start >= sentence.start && end <= sentence.end : false;

  sorted.forEach((occ, i) => {
    const { start, end } = occ.span;
    if (start < cursor) return; // 防御重叠
    if (start > cursor) {
      parts.push(
        <SentenceText
          key={`t${i}`}
          text={text.slice(cursor, start)}
          base={cursor}
          sentence={sentence}
        />,
      );
    }
    parts.push(
      <RefInline
        key={occ.key}
        occurrence={occ}
        highlight={inSentence(start, end)}
      />,
    );
    cursor = end;
  });
  if (cursor < text.length) {
    parts.push(
      <SentenceText
        key="tail"
        text={text.slice(cursor)}
        base={cursor}
        sentence={sentence}
      />,
    );
  }
  return <>{parts}</>;
}

function SentenceText({
  text,
  base,
  sentence,
}: {
  text: string;
  base: number;
  sentence: { start: number; end: number } | null;
}) {
  if (!sentence) return <>{text}</>;
  const s = Math.max(0, sentence.start - base);
  const e = Math.min(text.length, sentence.end - base);
  if (e <= s) return <>{text}</>;
  return (
    <>
      {text.slice(0, s)}
      <mark className="sentence-mark">{text.slice(s, e)}</mark>
      {text.slice(e)}
    </>
  );
}

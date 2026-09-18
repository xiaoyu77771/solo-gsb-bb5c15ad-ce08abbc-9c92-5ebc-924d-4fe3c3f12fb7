import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import type { Annotation, AnnotationCandidate } from '../../shared/model';
import { labelOfNode } from '../lib/labels';

type StatusFilter = 'all' | 'review' | 'anchored';

export function AnnotationPanel() {
  const { store } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { annotations } = store.getSnapshot();
  const [filter, setFilter] = useState<StatusFilter>('all');

  const groups = useMemo(() => {
    let review = 0;
    let anchored = 0;
    for (const a of annotations) (a.status === 'review' ? (review += 1) : (anchored += 1));
    return { review, anchored };
  }, [annotations]);

  const visible =
    filter === 'all' ? annotations : annotations.filter((a) => a.status === filter);
  // 待复核优先，其次按创建时间倒序
  const sorted = [...visible].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'review' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  return (
    <div className="annotation-panel">
      <div className="issue-filters">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          全部 {annotations.length}
        </button>
        <button
          className={`ann-filter-review ${filter === 'review' ? 'active' : ''}`}
          disabled={groups.review === 0}
          onClick={() => setFilter('review')}
        >
          ⚠ 待复核 {groups.review}
        </button>
        <button
          className={filter === 'anchored' ? 'active' : ''}
          disabled={groups.anchored === 0}
          onClick={() => setFilter('anchored')}
        >
          ✓ 已定位 {groups.anchored}
        </button>
      </div>

      <div className="issue-list">
        {sorted.length === 0 ? (
          <div className="empty-hint">
            {annotations.length === 0
              ? '在左侧正文中选取一段文字（鼠标拖选后点击「＋ 批注」）即可创建审阅批注。'
              : '该状态下暂无批注。'}
          </div>
        ) : (
          sorted.map((ann) => <AnnotationRow key={ann.id} ann={ann} />)
        )}
      </div>

      <div className="panel-footer">
        批注以节点 ID、引用片段与前后文锚点持久化；正文或结构调整后自动重定位，片段缺失或多处匹配时进入待复核。
      </div>
    </div>
  );
}

function AnnotationRow({ ann }: { ann: Annotation }) {
  const { store, highlighter } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ann.note);
  const { analysis } = store.getSnapshot();

  const nodeExists = Boolean(analysis.nodes[ann.nodeId]);
  const nodeLabel = nodeExists ? labelOfNode(analysis, ann.nodeId) : '（原节点已删除）';

  const jump = () => {
    if (ann.status === 'anchored' && ann.offset) {
      highlighter.jumpToAnnotation(ann.id, ann.nodeId, ann.offset);
    } else {
      // 待复核：若有候选则跳到首个候选，否则跳到原节点
      const c = ann.candidates?.[0];
      if (c) highlighter.jumpToAnnotation(ann.id, c.nodeId, { start: c.start, end: c.end });
      else if (nodeExists) highlighter.jumpToAnnotation(ann.id, ann.nodeId, { start: 0, end: 0 });
    }
  };

  const saveNote = () => {
    store.updateAnnotationNote(ann.id, draft);
    setEditing(false);
  };

  return (
    <div className={`annotation-row ${ann.status === 'review' ? 'is-review' : 'is-anchored'}`}>
      <div className="issue-row-head">
        <span className={`ann-status-tag ${ann.status === 'review' ? 'review' : 'anchored'}`}>
          {ann.status === 'review' ? '⚠ 待复核' : '✓ 已定位'}
        </span>
        <span className="issue-source-label">{nodeLabel}</span>
      </div>

      <button className="ann-quote" onClick={jump} title="跳到正文并高亮片段">
        “{ann.quote.length > 60 ? ann.quote.slice(0, 60) + '…' : ann.quote}”
      </button>

      {ann.status === 'review' && <div className="ann-reason">{ann.reason}</div>}

      {editing ? (
        <div className="ann-edit">
          <textarea
            className="ann-note-edit"
            value={draft}
            autoFocus
            rows={Math.min(6, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveNote();
              }
              if (e.key === 'Escape') {
                setDraft(ann.note);
                setEditing(false);
              }
            }}
          />
          <div className="ann-edit-actions">
            <button className="primary small" onClick={saveNote}>
              保存
            </button>
            <button
              className="small"
              onClick={() => {
                setDraft(ann.note);
                setEditing(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="ann-note">{ann.note || <span className="placeholder-text">（无批注内容）</span>}</div>
      )}

      {ann.status === 'review' && ann.candidates && ann.candidates.length > 0 && (
        <CandidateList ann={ann} candidates={ann.candidates} />
      )}

      <div className="ann-row-actions">
        <button
          className="link-btn"
          onClick={() => {
            setDraft(ann.note);
            setEditing(true);
          }}
        >
          编辑
        </button>
        <button
          className="link-btn subtle-danger"
          onClick={() => {
            if (confirm('确定删除该批注？')) store.deleteAnnotation(ann.id);
          }}
        >
          删除
        </button>
        <span className="ann-time" title={formatTime(ann.createdAt)}>
          {formatTime(ann.updatedAt || ann.createdAt)}
        </span>
      </div>
    </div>
  );
}

function CandidateList({
  ann,
  candidates,
}: {
  ann: Annotation;
  candidates: AnnotationCandidate[];
}) {
  const { store, highlighter } = useApp();
  const { analysis } = store.getSnapshot();

  return (
    <div className="ann-candidates">
      <div className="candidate-title">保留 {candidates.length} 个候选位置：</div>
      {candidates.map((c) => {
        const node = analysis.nodes[c.nodeId];
        const ctx = node ? node.text.slice(Math.max(0, c.start - 8), c.end + 8) : '';
        return (
          <div className="ann-candidate" key={`${c.nodeId}:${c.start}:${c.end}`}>
            <label className="candidate-item">
              <input
                type="radio"
                name={`anncand-${ann.id}`}
                onChange={() => store.resolveAnnotation(ann.id, c)}
              />
              <button
                type="button"
                className="link-btn"
                onClick={(e) => {
                  e.preventDefault();
                  highlighter.jumpToAnnotation(ann.id, c.nodeId, { start: c.start, end: c.end });
                }}
              >
                {labelOfNode(analysis, c.nodeId)} · …{ctx}…
              </button>
            </label>
            <span className="ann-via">{viaLabel(c.via)}</span>
          </div>
        );
      })}
    </div>
  );
}

function viaLabel(via: AnnotationCandidate['via']): string {
  if (via === 'context') return '前后文锚点';
  if (via === 'position') return '结构位置';
  return '原文匹配';
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

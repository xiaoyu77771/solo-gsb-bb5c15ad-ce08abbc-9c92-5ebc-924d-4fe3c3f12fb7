import { useSyncExternalStore } from 'react';
import type {
  ClauseDocument,
  ClauseNode,
  DocSnapshot,
  ExportBundle,
  PersistedState,
} from '../../shared/model';
import { analyze } from './analyzer';
import type { Analysis } from '../../shared/model';
import { parseDocument } from './parser';
import {
  cloneTree,
  findArticleOf,
  findNode,
  newArticle,
  newItem,
  newParagraph,
  renumberAll,
  touch,
} from './tree';

import { applyStructuralChange } from './rewriter';
import { localStore, serverStore } from './storage';
import { createSnapshot, sanitizeSnapshots } from './snapshot';
import { uid } from './uid';

/** 撤销/重做历史只承载正文与确认记录；快照独立于历史，不参与撤销 */
interface DocState {
  doc: ClauseDocument;
  confirmed: Record<string, string>;
}

interface Snapshot {
  doc: ClauseDocument;
  confirmed: Record<string, string>;
  snapshots: DocSnapshot[];
  analysis: Analysis;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 100;

export class AppStore {
  private past: DocState[] = [];
  private future: DocState[] = [];
  private docState: DocState;
  private snapshots: DocSnapshot[] = [];
  private analysis: Analysis;
  /** 当前连续文本编辑突发的起始状态（用于合并撤销） */
  private coalesceBaseline: DocState | null = null;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  lastRewriteInfo: { rewritten: number; skipped: number } | null = null;

  constructor(initial: PersistedState) {
    this.snapshots = sanitizeSnapshots(initial.snapshots);
    this.docState = { doc: initial.doc, confirmed: initial.confirmed };
    this.analysis = analyze(initial.doc, { confirmed: initial.confirmed });
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  getSnapshot = (): Snapshot => ({
    doc: this.docState.doc,
    confirmed: this.docState.confirmed,
    snapshots: this.snapshots,
    analysis: this.analysis,
    canUndo: this.past.length > 0,
    canRedo: this.future.length > 0,
  });

  /** 当前完整持久化状态（正文 + 确认 + 快照） */
  private currentPersisted(): PersistedState {
    return { ...this.docState, snapshots: this.snapshots };
  }

  /** 提交新状态：重新分析、裁剪过期确认、压入历史、持久化 */
  private commit(next: DocState, options: { coalesce?: boolean } = {}): void {
    const analysis = analyze(next.doc, { confirmed: next.confirmed });
    // 裁剪：确认记录必须仍对应一个“歧义已消失/仍歧义”的 occurrence，且目标存在
    const valid = new Set(
      analysis.occurrences
        .filter((o) => o.signature && next.confirmed[o.signature])
        .map((o) => o.signature),
    );
    const confirmed: Record<string, string> = {};
    for (const [sig, target] of Object.entries(next.confirmed)) {
      if (valid.has(sig) && analysis.nodes[target]) confirmed[sig] = target;
    }
    next = { confirmed, doc: touch(next.doc) };

    if (options.coalesce) {
      if (this.coalesceBaseline) {
        // 同一编辑突发内：不压栈，栈顶保持为突发前基线
      } else {
        this.coalesceBaseline = this.docState;
        this.past.push(this.docState);
      }
    } else {
      this.coalesceBaseline = null;
      this.editCoalesceUntil = 0;
      this.past.push(this.docState);
      if (this.past.length > MAX_HISTORY) this.past.shift();
    }
    this.future = [];
    this.docState = next;
    this.analysis = analysis;
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave(): void {
    localStore.save(this.currentPersisted());
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void serverStore.save(this.currentPersisted());
    }, 600);
  }

  // ---------- 历史 ----------

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.docState);
    this.docState = prev;
    this.analysis = analyze(prev.doc, { confirmed: prev.confirmed });
    this.coalesceBaseline = null;
    this.editCoalesceUntil = 0;
    this.scheduleSave();
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.docState);
    this.docState = next;
    this.analysis = analyze(next.doc, { confirmed: next.confirmed });
    this.coalesceBaseline = null;
    this.editCoalesceUntil = 0;
    this.scheduleSave();
    this.emit();
  }

  // ---------- 文档内容编辑（带 600ms 合并窗口） ----------

  private editCoalesceUntil = 0;

  updateNodeText(nodeId: string, text: string): void {
    const root = cloneTree(this.docState.doc.root);
    const found = findNode(root, nodeId);
    if (!found) return;
    found.node.text = text;
    const now = Date.now();
    const coalesce = now < this.editCoalesceUntil;
    this.editCoalesceUntil = now + 800;
    this.commit({ ...this.docState, doc: { ...this.docState.doc, root } }, { coalesce });
  }

  updateArticleMeta(articleId: string, patch: { title?: string; suffix?: string }): void {
    const root = cloneTree(this.docState.doc.root);
    const found = findNode(root, articleId);
    if (!found || found.node.kind !== 'article') return;
    if ('title' in patch) found.node.title = patch.title?.trim() || undefined;
    if ('suffix' in patch) found.node.suffix = patch.suffix?.trim() || undefined;
    this.commit({ ...this.docState, doc: { ...this.docState.doc, root } });
  }

  renameTitle(title: string): void {
    this.commit({ ...this.docState, doc: { ...this.docState.doc, title } }, { coalesce: false });
  }

  // ---------- 结构操作（触发原子引用改写） ----------

  private structural(label: string, mutator: (root: ClauseNode[]) => void): void {
    void label;
    const result = applyStructuralChange(this.docState.doc, this.analysis, mutator);
    this.lastRewriteInfo = {
      rewritten: result.rewritten,
      skipped: result.skipped.length,
    };
    this.commit({ ...this.docState, doc: result.doc });
  }

  /** 同级内移动（拖拽排序）。toIndex 为删除源节点后的目标下标 */
  reorderSibling(nodeId: string, toIndex: number): void {
    this.structural('reorder', (root) => {
      const found = findNode(root, nodeId);
      if (!found) return;
      const [node] = found.parent.splice(found.index, 1);
      const clamped = Math.max(0, Math.min(toIndex, found.parent.length));
      found.parent.splice(clamped, 0, node);
    });
  }

  /** 跨父级移动（拖拽到另一条/款） */
  moveNode(nodeId: string, targetParentId: string, toIndex: number): void {
    this.structural('move', (root) => {
      const src = findNode(root, nodeId);
      let targetParent: ClauseNode[];
      if (targetParentId === '__root__') {
        targetParent = root;
      } else {
        const tp = findNode(root, targetParentId);
        if (!tp) return;
        targetParent = tp.node.kind === 'article' ? tp.node.children : tp.node.children;
      }
      if (!src) return;
      // 不允许把节点移动进自身后代
      if (findNode(src.node.children, targetParentId)) return;
      const node = src.node;
      // 层级兼容：只允许同 kind 平级移动
      const sample = targetParent[0];
      if (sample && sample.kind !== node.kind) return;
      src.parent.splice(src.index, 1);
      const clamped = Math.max(0, Math.min(toIndex, targetParent.length));
      targetParent.splice(clamped, 0, node);
    });
  }

  /** 手动改编号（仅条）：与同序号条交换位置 */
  renumberArticle(articleId: string, newOrdinal: number): void {
    if (!Number.isInteger(newOrdinal) || newOrdinal < 1) return;
    this.structural('renumber', (root) => {
      const found = findNode(root, articleId);
      if (!found) return;
      const target = root[newOrdinal - 1];
      if (!target || target.id === articleId) return;
      const [node] = root.splice(found.index, 1);
      root.splice(newOrdinal - 1, 0, node);
    });
  }

  deleteNode(nodeId: string): void {
    this.structural('delete', (root) => {
      const found = findNode(root, nodeId);
      if (!found) return;
      found.parent.splice(found.index, 1);
    });
  }

  addArticle(afterId?: string): string {
    const id = uid('art');
    this.structural('add-article', (root) => {
      const node = newArticle('');
      node.id = id;
      const idx = afterId ? root.findIndex((a) => a.id === afterId) + 1 : root.length;
      root.splice(idx, 0, node);
    });
    return id;
  }

  addParagraph(articleId: string): void {
    this.structural('add-paragraph', (root) => {
      const a = findNode(root, articleId);
      if (!a) return;
      a.node.children.push(newParagraph(''));
    });
  }

  addItem(paragraphNodeId: string): void {
    this.structural('add-item', (root) => {
      const p = findNode(root, paragraphNodeId);
      if (!p) return;
      p.node.children.push(newItem(''));
    });
  }

  // ---------- 粘贴导入 / JSON 导入导出 ----------

  importPastedText(raw: string): void {
    const { doc } = parseDocument(raw, this.docState.doc.title);
    // 粘贴替换正文是全新文档，旧快照不再有对齐意义
    this.snapshots = [];
    this.commit({ doc, confirmed: {} });
  }

  importJson(bundle: ExportBundle | PersistedState): void {
    const rawDoc = 'document' in bundle ? bundle.document : bundle.doc;
    const doc: ClauseDocument = {
      id: rawDoc.id || uid('doc'),
      title: typeof rawDoc.title === 'string' ? rawDoc.title : '未命名条款集',
      root: Array.isArray(rawDoc.root) ? rawDoc.root : [],
      updatedAt: Date.now(),
    };
    const confirmed = bundle.confirmed ?? {};
    // 快照随 JSON 导入；旧文件缺少 snapshots 时按空列表加载
    this.snapshots = sanitizeSnapshots(bundle.snapshots);
    renumberAll(doc.root);
    this.commit({ doc: touch(doc), confirmed });
  }

  exportJson(): ExportBundle {
    return {
      app: 'clause-reference-validator',
      version: 1,
      document: this.docState.doc,
      confirmed: this.docState.confirmed,
      snapshots: this.snapshots,
      exportedAt: new Date().toISOString(),
    };
  }

  replaceWithSample(doc: ClauseDocument): void {
    this.snapshots = [];
    this.commit({ doc, confirmed: {} });
  }

  // ---------- 版本快照（只读；创建/删除不进入正文撤销历史） ----------

  /** 保存当前文档为命名快照，返回新快照 id */
  saveSnapshot(name: string): string {
    const trimmed = name.trim();
    const snapshot = createSnapshot(
      this.docState.doc,
      this.docState.confirmed,
      trimmed || defaultSnapshotName(this.snapshots.length),
    );
    this.snapshots = [...this.snapshots, snapshot];
    this.scheduleSave();
    this.emit();
    return snapshot.id;
  }

  /** 删除快照：不影响正文、确认记录与撤销历史 */
  deleteSnapshot(snapshotId: string): void {
    if (!this.snapshots.some((s) => s.id === snapshotId)) return;
    this.snapshots = this.snapshots.filter((s) => s.id !== snapshotId);
    this.scheduleSave();
    this.emit();
  }

  // ---------- 歧义确认 ----------

  confirmAmbiguous(signature: string, targetId: string): void {
    this.commit({
      ...this.docState,
      confirmed: { ...this.docState.confirmed, [signature]: targetId },
    });
  }

  clearConfirmation(signature: string): void {
    const confirmed = { ...this.docState.confirmed };
    delete confirmed[signature];
    this.commit({ ...this.docState, confirmed });
  }

  // ---------- 派生查询 ----------

  targetOfRef(refKey: string): string | null {
    const occ = this.analysis.occurrences.find((o) => o.key === refKey);
    return occ?.resolution.targetId ?? null;
  }

  articleOf(nodeId: string): ClauseNode | null {
    return findArticleOf(this.docState.doc.root, nodeId);
  }
}

function defaultSnapshotName(existing: number): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `快照 ${existing + 1}（${stamp}）`;
}

import.meta.hot?.accept();

export function useStore(store: AppStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export async function bootstrapStore(): Promise<AppStore> {
  // 优先本地浏览器存储；首次使用时尝试加载服务器端文件（跨浏览器共享）
  const local = localStore.load();
  if (local) return new AppStore(local);
  const remote = await serverStore.load();
  if (remote) return new AppStore(remote);
  const { sampleDocument } = await import('./sample');
  return new AppStore({ doc: sampleDocument(), confirmed: {} });
}

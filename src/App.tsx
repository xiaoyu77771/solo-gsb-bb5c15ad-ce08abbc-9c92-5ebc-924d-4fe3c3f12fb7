import { useEffect, useState } from 'react';
import type { AppStore } from './lib/store';
import type { Highlighter } from './lib/highlighter';
import { StoreContext } from './lib/context';
import { Toolbar } from './components/Toolbar';
import { DocumentTree } from './components/DocumentTree';
import { IssuePanel } from './components/IssuePanel';
import { RelationView } from './components/RelationView';
import { CompareView } from './components/CompareView';
import { ImportDialog } from './components/ImportDialog';
import { ToastHost } from './components/Toast';

type ViewMode = 'edit' | 'compare';

export default function App({
  store,
  highlighter,
}: {
  store: AppStore;
  highlighter: Highlighter;
}) {
  const [view, setView] = useState<ViewMode>('edit');
  const [rightTab, setRightTab] = useState<'issues' | 'graph'>('issues');
  const [importOpen, setImportOpen] = useState(false);

  // 全局撤销/重做快捷键（输入框内同样生效，文本组件用 Esc / Ctrl+Enter 处理自身逻辑）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (!(e.ctrlKey || e.metaKey) || !typing) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        store.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  return (
    <StoreContext.Provider value={{ store, highlighter }}>
      <div className="app-shell">
        <Toolbar
          view={view}
          onSwitchView={setView}
          onOpenImport={() => setImportOpen(true)}
        />
        {view === 'compare' ? (
          <main className="app-main app-main-compare">
            <section className="pane pane-compare" aria-label="版本对比">
              <CompareView onExit={() => setView('edit')} />
            </section>
          </main>
        ) : (
          <main className="app-main">
            <section className="pane pane-doc" aria-label="条款文档">
              <DocumentTree />
            </section>
            <aside className="pane pane-side" aria-label="校验面板">
              <div className="side-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={rightTab === 'issues'}
                  className={rightTab === 'issues' ? 'active' : ''}
                  onClick={() => setRightTab('issues')}
                >
                  问题与引用
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === 'graph'}
                  className={rightTab === 'graph' ? 'active' : ''}
                  onClick={() => setRightTab('graph')}
                >
                  关系视图
                </button>
              </div>
              {rightTab === 'issues' ? <IssuePanel /> : <RelationView />}
            </aside>
          </main>
        )}
        {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
        <ToastHost />
      </div>
    </StoreContext.Provider>
  );
}

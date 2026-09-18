import { useEffect, useState } from 'react';
import type { AppStore } from './lib/store';
import type { Highlighter } from './lib/highlighter';
import { StoreContext, useApp } from './lib/context';
import { SidebarBus, useSidebarTab } from './lib/sidebar';
import { Toolbar } from './components/Toolbar';
import { DocumentTree } from './components/DocumentTree';
import { IssuePanel } from './components/IssuePanel';
import { RelationView } from './components/RelationView';
import { AnnotationPanel } from './components/AnnotationPanel';
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
  const [sidebar] = useState(() => new SidebarBus());
  const [view, setView] = useState<ViewMode>('edit');
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
    <StoreContext.Provider value={{ store, highlighter, sidebar }}>
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
            <SidePane />
          </main>
        )}
        {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
        <ToastHost />
      </div>
    </StoreContext.Provider>
  );
}

function SidePane() {
  const { store, sidebar } = useApp();
  const rightTab = useSidebarTab(sidebar);

  // 订阅批注数量用于标签计数与待复核红点
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { annotations } = store.getSnapshot();
  const reviewCount = annotations.filter((a) => a.status === 'review').length;

  return (
    <aside className="pane pane-side" aria-label="校验面板">
      <div className="side-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={rightTab === 'issues'}
          className={rightTab === 'issues' ? 'active' : ''}
          onClick={() => sidebar.setTab('issues')}
        >
          问题与引用
        </button>
        <button
          role="tab"
          aria-selected={rightTab === 'graph'}
          className={rightTab === 'graph' ? 'active' : ''}
          onClick={() => sidebar.setTab('graph')}
        >
          关系视图
        </button>
        <button
          role="tab"
          aria-selected={rightTab === 'annotations'}
          className={rightTab === 'annotations' ? 'active' : ''}
          onClick={() => sidebar.setTab('annotations')}
        >
          审阅批注{annotations.length ? `（${annotations.length}）` : ''}
          {reviewCount > 0 && <span className="tab-dot" title={`${reviewCount} 条待复核`} />}
        </button>
      </div>
      {rightTab === 'issues' ? (
        <IssuePanel />
      ) : rightTab === 'graph' ? (
        <RelationView />
      ) : (
        <AnnotationPanel />
      )}
    </aside>
  );
}

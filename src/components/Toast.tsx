import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/context';

interface ToastData {
  id: number;
  text: string;
  kind: 'info' | 'warn';
}

let seq = 0;

/** 监听结构操作后的原子改写结果，弹出提示（文本编辑不提示） */
export function ToastHost() {
  const { store } = useApp();
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const lastInfo = useRef<{ rewritten: number; skipped: number; doc: unknown } | null>(null);

  useEffect(() => {
    return store.subscribe(() => {
      const snap = store.getSnapshot();
      const info = store.lastRewriteInfo;
      if (!info) return;
      const prev = lastInfo.current;
      // 仅在结构操作真正产生改写信息且文档引用身份变化时提示，避免文本编辑刷屏
      const isNewStructuralOp =
        !prev ||
        prev.rewritten !== info.rewritten ||
        prev.skipped !== info.skipped;
      if (!isNewStructuralOp || (info.rewritten === 0 && info.skipped === 0)) {
        lastInfo.current = { ...info, doc: snap.doc };
        return;
      }
      lastInfo.current = { ...info, doc: snap.doc };
      const id = ++seq;
      const text =
        info.rewritten > 0
          ? `已原子更新 ${info.rewritten} 处可唯一定位的引用` +
            (info.skipped ? `；${info.skipped} 处歧义/断链未自动改写` : '')
          : `${info.skipped} 处引用无法唯一定位，未自动改写（见右侧问题列表）`;
      setToasts((t) => [...t.slice(-2), { id, text, kind: info.skipped ? 'warn' : 'info' }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    });
  }, [store]);

  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'warn' ? 'toast-warn' : ''}`}>
          {t.text}
        </div>
      ))}
    </>
  );
}

import { createContext, useContext } from 'react';
import type { AppStore } from './store';
import type { Highlighter } from './highlighter';

export const StoreContext = createContext<{ store: AppStore; highlighter: Highlighter } | null>(
  null,
);

export function useApp(): { store: AppStore; highlighter: Highlighter } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreContext 未初始化');
  return ctx;
}

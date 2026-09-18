import { createContext, useContext } from 'react';
import type { AppStore } from './store';
import type { Highlighter } from './highlighter';
import { SidebarBus } from './sidebar';

export const StoreContext = createContext<{
  store: AppStore;
  highlighter: Highlighter;
  sidebar: SidebarBus;
} | null>(null);

export function useApp(): {
  store: AppStore;
  highlighter: Highlighter;
  sidebar: SidebarBus;
} {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreContext 未初始化');
  return ctx;
}

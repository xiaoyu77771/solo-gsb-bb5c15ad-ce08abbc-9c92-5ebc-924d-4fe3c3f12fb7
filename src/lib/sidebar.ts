import { useSyncExternalStore } from 'react';

export type SidebarTab = 'issues' | 'graph' | 'annotations';

/** 侧栏标签页的跨组件切换（正文内新建批注后自动切到“审阅批注”） */
export class SidebarBus {
  private tab: SidebarTab = 'issues';
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): SidebarTab => this.tab;

  setTab(tab: SidebarTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.listeners.forEach((l) => l());
  }
}

export function useSidebarTab(bus: SidebarBus): SidebarTab {
  return useSyncExternalStore(bus.subscribe, bus.getSnapshot);
}

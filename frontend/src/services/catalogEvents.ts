/**
 * 跨标签页档案变更通知。
 * 纯前端单 IndexedDB 库：两个浏览器标签相当于「两个人同时操作同一档案库」。
 * 后提交的一方在提交时由 catalogVersion / 指纹闸门拦截；
 * 通道负责让仍停留在预览页的另一方立即看到「批次已变」。
 */

export interface CatalogChangedEvent {
  type: 'renumber-committed' | 'catalog-updated';
  catalogVersion: number;
  batchId?: string;
  reason?: string;
  at: number;
}

const CHANNEL_NAME = 'gbmeteorite-catalog';

class CatalogEvents {
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(e: CatalogChangedEvent) => void>();

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (ev: MessageEvent<CatalogChangedEvent>) => {
        this.listeners.forEach((fn) => fn(ev.data));
      };
    }
    // storage 兜底：不支持 BroadcastChannel 的环境用 localStorage 信号
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (ev) => {
        if (ev.key === STORAGE_KEY && ev.newValue) {
          try {
            const data = JSON.parse(ev.newValue) as CatalogChangedEvent;
            this.listeners.forEach((fn) => fn(data));
          } catch {
            /* 忽略损坏信号 */
          }
        }
      });
    }
  }

  post(event: CatalogChangedEvent): void {
    this.channel?.postMessage(event);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(event));
    }
  }

  subscribe(fn: (e: CatalogChangedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const STORAGE_KEY = 'gbmeteorite:catalog-event';

export const catalogEvents = new CatalogEvents();

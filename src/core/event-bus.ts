import type { RawWorkItem } from './types.js';

type Listener = (item: RawWorkItem) => void | Promise<void>;

export interface EventBus {
  emit(item: RawWorkItem): void;
  on(listener: Listener): () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Set<Listener>();

  return {
    emit(item: RawWorkItem): void {
      for (const fn of listeners) {
        try {
          const result = fn(item);
          // Handle async listeners — catch unhandled rejections
          if (result && typeof (result as any).catch === 'function') {
            (result as any).catch((err: any) => console.error('EventBus async listener error:', err.message));
          }
        } catch (err) {
          console.error('EventBus listener error:', err);
        }
      }
    },
    on(listener: Listener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

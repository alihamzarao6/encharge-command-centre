/**
 * The shared conversation store, reachable from any surface under the shell (Milestone 4
 * part 2). The store itself is framework-free (web/src/lib/thread.ts); this is the React
 * end of it: one context carrying the store, and one hook that subscribes a component to
 * its state through `useSyncExternalStore`, so the Assistant page and the docked panel
 * re-render from the same snapshot.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { ThreadState, ThreadStore } from '../lib/thread.js';

export const ThreadContext = createContext<ThreadStore | null>(null);

export function useThreadStore(): ThreadStore {
  const store = useContext(ThreadContext);
  if (store === null) {
    throw new Error('useThreadStore must be used under the shell, which provides the store.');
  }
  return store;
}

export function useThreadState(): ThreadState {
  const store = useThreadStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

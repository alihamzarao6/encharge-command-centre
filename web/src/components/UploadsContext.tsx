/**
 * The files of the conversation on screen, reachable from both surfaces that show it
 * (Milestone 5 part 1). The store is framework-free (web/src/lib/uploads.ts); this is the
 * React end: one context, created by the shell beside the thread's, and one hook that gives
 * a surface everything it needs to offer "attach", show progress, and list what is attached.
 *
 * Dropping a file onto the conversation works, and so does the button: nothing here is
 * drag-and-drop only.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from 'react';

import type { MemoryActor } from '../../../src/lib/memory/access.js';
import { busyNote } from '../lib/filesView.js';
import { isBusy, type BrowserFile, type UploadsState, type UploadsStore } from '../lib/uploads.js';

export interface UploadsContextValue {
  readonly store: UploadsStore;
  /** Who is looking: decides where "Remove" is offered. The server decides again. */
  readonly actor: MemoryActor;
}

export const UploadsContext = createContext<UploadsContextValue | null>(null);

/** A browser `File` as the store wants it: nothing is read until the file's turn comes. */
export function toBrowserFiles(files: Iterable<File>): BrowserFile[] {
  return Array.from(files, (file) => ({
    name: file.name,
    size: file.size,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  }));
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export interface Attachments {
  readonly state: UploadsState;
  readonly store: UploadsStore;
  readonly actor: MemoryActor;
  readonly attach: (files: Iterable<File>) => void;
  /** Why a message cannot be sent yet, or null. */
  readonly sendBlockedNote: string | null;
  /** A file is being dragged over the conversation. */
  readonly dragging: boolean;
  readonly dropHandlers: {
    readonly onDragEnter: (event: DragEvent) => void;
    readonly onDragOver: (event: DragEvent) => void;
    readonly onDragLeave: (event: DragEvent) => void;
    readonly onDrop: (event: DragEvent) => void;
  };
}

export function useAttachments(): Attachments {
  const value = useContext(UploadsContext);
  if (value === null) {
    throw new Error('useAttachments must be used under the shell, which provides the store.');
  }
  const { store, actor } = value;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [dragging, setDragging] = useState(false);

  const attach = useCallback(
    (files: Iterable<File>): void => {
      store.add(toBrowserFiles(files));
    },
    [store],
  );

  const dropHandlers = useMemo(
    () => ({
      onDragEnter: (event: DragEvent): void => {
        if (carriesFiles(event)) setDragging(true);
      },
      onDragOver: (event: DragEvent): void => {
        // Without this the browser opens the file instead of handing it over.
        if (carriesFiles(event)) event.preventDefault();
      },
      onDragLeave: (event: DragEvent): void => {
        if (event.currentTarget === event.target) setDragging(false);
      },
      onDrop: (event: DragEvent): void => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        attach(event.dataTransfer.files);
      },
    }),
    [attach],
  );

  return {
    state,
    store,
    actor,
    attach,
    sendBlockedNote: isBusy(state) ? busyNote(state.uploads) : null,
    dragging,
    dropHandlers,
  };
}

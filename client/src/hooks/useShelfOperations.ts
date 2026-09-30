import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryMutationOptions, LibraryMutations, MutationOutcome } from './useLibraryMutations.js';
import type { Folder, FolderBook, ShelfItem } from '../types/library.js';
import { toShelfOrderItem } from '../utils/libraryItems.js';
import type { ShelfProjection } from './useShelfData.js';
import { LANDING_SETTLE_MS, SAVE_FAILURE_FEEDBACK_MS } from '../utils/dragMotion.js';
import { useShelfUndo } from './useShelfUndo.js';
import type { ShelfToastNotice } from './useShelfUndo.js';
import { useLibraryMutations } from './useLibraryMutations.js';

/** Which bookshelf operation a card is currently carrying persistence feedback for. */
export type ShelfMutationIntent = 'sort' | 'merge' | 'absorb' | 'move-out';
/**
 * Honest persistence feedback for the cards taking part in the newest mutation.
 *
 * A card stays `pending` until the server confirms; nothing shows a settled result early.
 * `failed` is transient and the hook clears it itself.
 */
export type ShelfMutationFeedback =
  | { status: 'idle' }
  | { status: 'pending' | 'failed'; intent: ShelfMutationIntent; keys: readonly string[] };

export interface ShelfOperationsOptions extends LibraryMutationOptions {
  folderBooksByFolderId?: Map<number, FolderBook[]>;
  shelfItems: ShelfItem[];
  folderBooks: FolderBook[];
  openFolder: Folder | null;
  beginShelfProjection?: () => ShelfProjection;
}

export interface ShelfOperations {
  toast: ShelfToastNotice | null;
  undoEntry: { token: number } | null;
  runUndo(): Promise<void>;
  dismissToast(): void;
  moveShelfBookToFolder(item: Extract<ShelfItem, { type: 'book' }>, folder: Folder): Promise<void>;
  moveFolderBookToShelf(book: FolderBook, folder: Folder): Promise<void>;
  mutations: LibraryMutations;
  mutationFeedback: ShelfMutationFeedback;
  landingKey: string | null;
  beginMutationFeedback(intent: ShelfMutationIntent, keys: readonly string[]): (outcome: MutationOutcome) => void;
  markLanding(key: string): void;
  acquireShelfProjection(): void;
  takeShelfProjection(): ShelfProjection | null;
  releaseShelfProjection(): void;
}

const idleMutationFeedback: ShelfMutationFeedback = { status: 'idle' };

/** One mutation scope and visual lifetime shared by every operation on this shelf. */
export function useShelfOperations({
  beginShelfProjection,
  folderBooksByFolderId,
  shelfItems,
  folderBooks,
  openFolder,
  ...mutationOptions
}: ShelfOperationsOptions): ShelfOperations {
  const feedbackTokenRef = useRef(0);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shelfProjectionRef = useRef<ShelfProjection | null>(null);
  const [mutationFeedback, setMutationFeedback] = useState<ShelfMutationFeedback>(idleMutationFeedback);
  /** Key of a card that has just arrived from a Folder and is settling into the shelf. */
  const [landingKey, setLandingKey] = useState<string | null>(null);
  const dismissUndoRef = useRef<() => void>(() => {});
  const getMutationSession = useCallback(() => feedbackTokenRef.current, []);
  const rawMutations = useLibraryMutations({ ...mutationOptions, getMutationSession });
  const { setIsSavingOrder, setIsSavingFolderOrder } = mutationOptions;

  const clearFailureTimer = useCallback(() => {
    if (failureTimerRef.current !== null) {
      clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    }
  }, []);

  /**
   * Marks the cards of a new mutation as pending and takes ownership of their feedback.
   * The returned reporter only publishes while it is still the newest mutation, so a stale
   * completion can neither clear a newer pending state nor surface an obsolete failure.
   */
  const beginMutationFeedback = useCallback(
    (intent: ShelfMutationIntent, keys: readonly string[]) => {
      clearFailureTimer();
      dismissUndoRef.current();
      feedbackTokenRef.current += 1;
      const token = feedbackTokenRef.current;

      // The newest operation owns both saving flags: a request it supersedes no longer clears
      // one in `finally`. Its own scope's flag is left alone because drag callers set it first;
      // a Folder-panel sort is the only Folder-scope operation.
      if (intent === 'sort' && keys.length > 0 && keys.every(key => key.startsWith('folder-book:'))) {
        setIsSavingOrder(false);
      } else {
        setIsSavingFolderOrder(false);
      }

      setMutationFeedback({ status: 'pending', intent, keys });

      return (outcome: MutationOutcome) => {
        if (feedbackTokenRef.current !== token) {
          return;
        }

        if (outcome !== 'failed') {
          setMutationFeedback(idleMutationFeedback);
          return;
        }

        setMutationFeedback({ status: 'failed', intent, keys });
        failureTimerRef.current = setTimeout(() => {
          failureTimerRef.current = null;

          if (feedbackTokenRef.current !== token) {
            return;
          }

          setMutationFeedback(idleMutationFeedback);
        }, SAVE_FAILURE_FEEDBACK_MS);
      };
    },
    [clearFailureTimer, setIsSavingFolderOrder, setIsSavingOrder],
  );

  const { mutations, undoEntry, toast, dismissToast, runUndo } = useShelfUndo(rawMutations, {
    ...mutationOptions, shelfItems, folderBooks, openFolder, folderBooksByFolderId, beginShelfProjection,
  }, getMutationSession, beginMutationFeedback);
  dismissUndoRef.current = dismissToast;

  /** A card that replaced the temporary Folder item settles in place instead of appearing abruptly. */
  const markLanding = useCallback((key: string) => {
    if (landingTimerRef.current !== null) {
      clearTimeout(landingTimerRef.current);
    }

    setLandingKey(key);
    landingTimerRef.current = setTimeout(() => {
      landingTimerRef.current = null;
      setLandingKey(null);
    }, LANDING_SETTLE_MS);
  }, []);

  const releaseShelfProjection = useCallback(() => {
    shelfProjectionRef.current?.release();
    shelfProjectionRef.current = null;
  }, []);

  const acquireShelfProjection = useCallback(() => {
    dismissUndoRef.current();
    releaseShelfProjection();
    shelfProjectionRef.current = beginShelfProjection?.() ?? null;
  }, [beginShelfProjection, releaseShelfProjection]);

  /** Hands the projection to the drag-end path that must decide when to publish or release it. */
  const takeShelfProjection = useCallback(() => {
    const projection = shelfProjectionRef.current;
    shelfProjectionRef.current = null;
    return projection;
  }, []);

  useEffect(
    () => () => {
      feedbackTokenRef.current += 1;
      // Feedback deadlines never outlive the host; a stale failure cannot reappear.
      clearFailureTimer();

      if (landingTimerRef.current !== null) {
        clearTimeout(landingTimerRef.current);
        landingTimerRef.current = null;
      }

      // Never leave a projection held after unmount; a background refresh must not stay suppressed.
      releaseShelfProjection();
    },
    [clearFailureTimer, releaseShelfProjection],
  );

  const { setError, setFolderError } = mutationOptions;
  const moveShelfBookToFolder = useCallback(async (item: Extract<ShelfItem, { type: 'book' }>, folder: Folder) => {
    const projection = beginShelfProjection?.() ?? null;
    setIsSavingOrder(true);
    setError('');
    await mutations.moveShelfBookToFolder({
      bookId: item.id, folderId: folder.id, projection, previousShelfItems: shelfItems,
      onOutcome: beginMutationFeedback('absorb', [item.key, `folder:${folder.id}`]),
    });
  }, [beginShelfProjection, beginMutationFeedback, mutations, setError, setIsSavingOrder, shelfItems]);

  const moveFolderBookToShelf = useCallback(async (book: FolderBook, folder: Folder) => {
    const projection = beginShelfProjection?.() ?? null;
    const folderIndex = shelfItems.findIndex(item => item.type === 'folder' && item.id === folder.id);
    // The book lands right after its Folder. A Folder this shelf does not show cannot anchor a
    // client order, so the server's own placement (also right after the Folder) is used instead.
    const orderItems = folderIndex < 0 ? undefined : [
      ...shelfItems.slice(0, folderIndex + 1).map(toShelfOrderItem),
      { type: 'book' as const, id: book.id },
      ...shelfItems.slice(folderIndex + 1).map(toShelfOrderItem),
    ];
    const report = beginMutationFeedback('move-out', [book.key]);
    setIsSavingOrder(true);
    setError('');
    setFolderError('');
    await mutations.moveFolderBookToShelf({
      book, folder, orderItems, projection, previousShelfItems: shelfItems, previousFolderBooks: folderBooks,
      restoreFolderOnFailure: openFolder?.id === folder.id,
      onOutcome(outcome) {
        report(outcome);
        if (outcome === 'published') markLanding(`book:${book.id}`);
      },
    });
  }, [beginShelfProjection, beginMutationFeedback, folderBooks, markLanding, mutations, openFolder?.id,
    setError, setFolderError, setIsSavingOrder, shelfItems]);

  // Stable identity between feedback changes, so consumers can list it as a dependency.
  return useMemo(
    () => ({
      toast, undoEntry, runUndo, dismissToast,
      moveShelfBookToFolder,
      moveFolderBookToShelf,
      mutations,
      mutationFeedback,
      landingKey,
      beginMutationFeedback,
      markLanding,
      acquireShelfProjection,
      takeShelfProjection,
      releaseShelfProjection,
    }),
    [
      toast, undoEntry, runUndo, dismissToast,
      moveShelfBookToFolder,
      moveFolderBookToShelf,
      acquireShelfProjection,
      beginMutationFeedback,
      landingKey,
      markLanding,
      mutationFeedback,
      mutations,
      releaseShelfProjection,
      takeShelfProjection,
    ],
  );
}

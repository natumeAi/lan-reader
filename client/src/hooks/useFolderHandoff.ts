import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { DragEndEvent, DragMoveEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { Folder, FolderBook, ShelfItem } from '../types/library.js';
import type { Point } from '../utils/dragGeometry.js';
import { pointerCenterFromDragEvent, pointInRect } from '../utils/dragGeometry.js';
import { normalizeShelfBookFromFolderBook, normalizeShelfItem, toShelfOrderItem } from '../utils/libraryItems.js';
import type { DragSession } from './useDragSession.js';
import type { DragIntent, DragPreviewItem } from './useLibraryDrag.js';
import type { ShelfProjection } from './useShelfData.js';
import type { ShelfOperations } from './useShelfOperations.js';
import type { SortDwell } from './useSortDwell.js';

interface FolderBookShelfDrag {
  book: FolderBook;
  folder: Folder;
  previousFolderBooks: FolderBook[];
  previousShelfItems: ShelfItem[];
}
interface FolderHandoffOptions {
  activeDragPreview: DragPreviewItem | null;
  clearDragIntent: () => void;
  clearFolderDragIntent: () => void;
  dragSession: DragSession;
  folderBooks: FolderBook[];
  folderCloseVersion: number;
  folderExitDwell: SortDwell;
  folderSession: number;
  folderSortDwell: SortDwell;
  openFolder: Folder | null;
  operations: ShelfOperations;
  publishDragIntent: (intent: DragIntent | null) => void;
  setActiveDragPreview: Dispatch<SetStateAction<DragPreviewItem | null>>;
  setError: (message: string) => void;
  setFolderBooks: Dispatch<SetStateAction<FolderBook[]>>;
  setFolderError: (message: string) => void;
  setIsFolderLoading: (value: boolean) => void;
  setIsRenamingFolder: (value: boolean) => void;
  setIsSavingOrder: (value: boolean) => void;
  setOpenFolder: Dispatch<SetStateAction<Folder | null>>;
  setShelfItems: Dispatch<SetStateAction<ShelfItem[]>>;
  shelfIntentDwell: SortDwell;
  shelfItems: ShelfItem[];
  shelfSortDwell: SortDwell;
}

/** Existing Folder-to-shelf handoff, sharing the host's drag and mutation sessions. */
export function useFolderHandoff({
  activeDragPreview,
  clearDragIntent,
  clearFolderDragIntent,
  dragSession,
  folderBooks,
  folderCloseVersion,
  folderExitDwell,
  folderSession,
  folderSortDwell,
  openFolder,
  operations,
  publishDragIntent,
  setActiveDragPreview,
  setError,
  setFolderBooks,
  setFolderError,
  setIsFolderLoading,
  setIsRenamingFolder,
  setIsSavingOrder,
  setOpenFolder,
  setShelfItems,
  shelfIntentDwell,
  shelfItems,
  shelfSortDwell,
}: FolderHandoffOptions) {
  const folderBookShelfDragRef = useRef<FolderBookShelfDrag | null>(null);
  const [isFolderExitPending, setIsFolderExitPending] = useState(false);
  const folderExitRef = useRef<{
    book: FolderBook;
    center: Point;
    generation: number;
    folderSession: number;
  } | null>(null);
  /** Only the start and end of a folder-to-shelf handoff re-render; coordinates never do. */
  const [isFixedDragPreviewActive, setIsFixedDragPreviewActive] = useState(false);
  const { mutations, beginMutationFeedback, markLanding } = operations;

  const resetFolderExit = useCallback(() => {
    if (folderExitRef.current) setIsFolderExitPending(false);
    folderExitRef.current = null;
    folderExitDwell.reset();
  }, [folderExitDwell]);

  const resetSortDwell = useCallback(() => {
    resetFolderExit();
    shelfSortDwell.reset();
    shelfIntentDwell.reset();
    folderSortDwell.reset();
  }, [folderSortDwell, shelfSortDwell, shelfIntentDwell, resetFolderExit]);

  const deactivateFixedDragPreview = useCallback(() => {
    dragSession.setPreviewActive(false);
    setIsFixedDragPreviewActive(false);
  }, [dragSession]);

  const clearFolderBookShelfDrag = useCallback(() => {
    folderBookShelfDragRef.current = null;
  }, []);

  const restoreFolderBookShelfDrag = useCallback(() => {
    const dragState = folderBookShelfDragRef.current;

    if (!dragState) {
      return;
    }

    clearFolderBookShelfDrag();
    setShelfItems(dragState.previousShelfItems);
    setOpenFolder(dragState.folder);
    setFolderBooks(dragState.previousFolderBooks);
    setFolderError('');
    setIsFolderLoading(false);
    setIsRenamingFolder(false);
    clearFolderDragIntent();
    clearDragIntent();
    deactivateFixedDragPreview();
  }, [
    clearDragIntent,
    clearFolderBookShelfDrag,
    clearFolderDragIntent,
    deactivateFixedDragPreview,
    setFolderBooks,
    setFolderError,
    setIsFolderLoading,
    setIsRenamingFolder,
    setOpenFolder,
    setShelfItems,
  ]);

  const beginFolderBookShelfDrag = useCallback(
    (book: FolderBook) => {
      if (!openFolder || !book || folderBookShelfDragRef.current) {
        return;
      }

      const previousShelfItems = shelfItems;
      const previousFolderBooks = folderBooks;
      const remainingFolderBooks = folderBooks.filter((folderBook) => folderBook.id !== book.id);
      const folderIndex = shelfItems.findIndex(
        (item) => item.type === 'folder' && item.id === openFolder.id,
      );
      const tempShelfBook = normalizeShelfBookFromFolderBook(book);
      const baseShelfItems =
        remainingFolderBooks.length === 0
          ? shelfItems.filter((item) => item.type !== 'folder' || item.id !== openFolder.id)
          : shelfItems.map((item) => {
              if (item.type !== 'folder' || item.id !== openFolder.id) {
                return item;
              }

              return normalizeShelfItem({
                ...item,
                folder: {
                  ...item.folder,
                  bookCount: Math.max(0, (item.folder?.bookCount ?? previousFolderBooks.length) - 1),
                  previewBooks: (item.folder?.previewBooks || []).filter(
                    (previewBook) => previewBook.id !== book.id,
                  ),
                },
              });
            });
      const insertIndex =
        folderIndex < 0
          ? baseShelfItems.length
          : remainingFolderBooks.length === 0
            ? folderIndex
            : folderIndex + 1;
      const nextShelfItems = [
        ...baseShelfItems.slice(0, insertIndex),
        tempShelfBook,
        ...baseShelfItems.slice(insertIndex),
      ];

      folderBookShelfDragRef.current = {
        book,
        folder: openFolder,
        previousFolderBooks,
        previousShelfItems,
      };
      setActiveDragPreview({
        type: 'folder-book',
        book,
      });
      setShelfItems(nextShelfItems);
      setOpenFolder(null);
      setFolderBooks([]);
      setFolderError('');
      setIsFolderLoading(false);
      setIsRenamingFolder(false);
      // The active collision detector changes here, so no dwell candidate survives the handoff.
      resetSortDwell();
      publishDragIntent({ type: 'sort', targetKey: null, sortTargetKey: null });
    },
    [
      folderBooks,
      openFolder,
      publishDragIntent,
      resetSortDwell,
      setFolderBooks,
      setFolderError,
      setIsFolderLoading,
      setIsRenamingFolder,
      setOpenFolder,
      setShelfItems,
      shelfItems,
    ],
  );

  // A Folder opening owns the exit deadline, including reopening the same id. Reset before
  // the maturity check so a render for a new opening can never hand off the old book.
  useLayoutEffect(() => {
    clearFolderDragIntent();
    resetSortDwell();
  }, [clearFolderDragIntent, folderCloseVersion, folderSession, openFolder?.id, resetSortDwell]);

  // Keep mounted delete-zone geometry refreshed before checking exit maturity.
  useLayoutEffect(() => {
    dragSession.refreshDeleteZone();
  }, [activeDragPreview, dragSession]);

  // useSortDwell re-renders this host when a stationary pointer's deadline matures.
  // The existing handoff still owns the projection, card measurement and grab offset.
  useLayoutEffect(() => {
    const pending = folderExitRef.current;
    if (!pending) return;
    const panel = document.querySelector('.folder-panel');
    if (!openFolder || pending.folderSession !== folderSession ||
        pending.generation !== dragSession.generation() ||
        !panel || pointInRect(pending.center, panel.getBoundingClientRect())) {
      resetFolderExit();
      return;
    }
    if (!folderExitDwell.evaluate({
      generation: pending.generation, targetKey: `exit:${pending.book.key}`,
    })) return;

    dragSession.setPreviewActive(true);
    dragSession.movePreview(dragSession.pointerPoint(), pending.center);
    setIsFixedDragPreviewActive(true);
    beginFolderBookShelfDrag(pending.book);
  });

  const handleFolderBookDragMove = useCallback(
    (event: DragMoveEvent, book: FolderBook) => {
      const activeCenter = pointerCenterFromDragEvent(event);

      if (!activeCenter) {
        return;
      }

      if (folderBookShelfDragRef.current) {
        dragSession.movePreview(dragSession.pointerPoint(), activeCenter);
        return;
      }

      if (!openFolder) {
        return;
      }

      const folderPanel = document.querySelector('.folder-panel');

      if (!folderPanel) {
        return;
      }

      if (pointInRect(activeCenter, folderPanel.getBoundingClientRect())) {
        resetFolderExit();
        return;
      }

      const generation = dragSession.generation();
      if (!folderExitRef.current) setIsFolderExitPending(true);
      folderExitRef.current = { book, center: activeCenter, generation, folderSession };
      folderExitDwell.evaluate({ generation, targetKey: `exit:${book.key}` });
    },
    [dragSession, folderExitDwell, folderSession, openFolder, resetFolderExit],
  );

  const handleFolderBookShelfDragEnd = useCallback(
    async (event: DragEndEvent, projection: ShelfProjection | null) => {
      const dragState = folderBookShelfDragRef.current;

      if (!dragState) {
        projection?.release();
        return;
      }

      const { active, over } = event;
      const oldIndex = shelfItems.findIndex((item) => item.key === String(active.id));
      const newIndex = over
        ? shelfItems.findIndex((item) => item.key === String(over.id))
        : oldIndex;
      const orderedShelfItems =
        oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex
          ? arrayMove(shelfItems, oldIndex, newIndex)
          : shelfItems;
      const orderItems = orderedShelfItems.map((item) =>
        item.key === dragState.book.key
          ? { type: 'book' as const, id: dragState.book.id }
          : toShelfOrderItem(item),
      );

      const reportOutcome = beginMutationFeedback('move-out', [dragState.book.key]);

      setShelfItems(orderedShelfItems);
      setIsSavingOrder(true);
      setError('');
      clearDragIntent();

      await mutations.moveFolderBookToShelf({
        book: dragState.book,
        folder: dragState.folder,
        onOutcome(outcome) {
          reportOutcome(outcome);

          if (outcome === 'published') {
            // The temporary `folder-book:<id>` card becomes `book:<id>` in the same commit;
            // the settle marks the arrival rather than letting the swap read as a flash.
            markLanding(`book:${dragState.book.id}`);
          }
        },
        onSettled: clearFolderBookShelfDrag,
        orderItems,
        previousFolderBooks: dragState.previousFolderBooks,
        previousShelfItems: dragState.previousShelfItems,
        projection,
      });
    },
    [
      beginMutationFeedback,
      clearDragIntent,
      clearFolderBookShelfDrag,
      markLanding,
      mutations,
      setError,
      setIsSavingOrder,
      setShelfItems,
      shelfItems,
    ],
  );

  useEffect(() => () => {
    folderExitRef.current = null;
    folderExitDwell.reset();
  }, [folderExitDwell]);

  return {
    deactivateFixedDragPreview,
    folderBookShelfDragRef,
    handleFolderBookDragMove,
    handleFolderBookShelfDragEnd,
    isFixedDragPreviewActive,
    isFolderExitPending,
    resetSortDwell,
    restoreFolderBookShelfDrag,
  };
}

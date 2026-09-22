import type { Dispatch, SetStateAction } from 'react';
import type { Active, CollisionDetection, DragCancelEvent, DragEndEvent, DragMoveEvent, DragStartEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import type { Book, Folder, FolderBook, ShelfItem } from '../types/library.js';
import type { DragTarget } from '../utils/dragCollision.js';
import type { Point } from '../utils/dragGeometry.js';
import type { MutationOutcome } from './useLibraryMutations.js';
import type { SortDwell } from './useSortDwell.js';
import type { LoadShelfOptions, ShelfProjection } from './useShelfData.js';

/**
 * One published drag intent.
 *
 * `targetKey` still means "the card the drop would consume" and therefore only exists for
 * merge and absorb. Sorting has a different relationship to its target — the drop inserts
 * *before* it — so it carries its own `sortTargetKey`, which is only set once the hover
 * dwell has matured and the target has actually been adopted.
 */
export type DragIntent =
  | { type: 'idle' | 'delete'; targetKey: null; sortTargetKey: null }
  | { type: 'sort'; targetKey: null; sortTargetKey: string | null }
  | { type: 'merge' | 'absorb'; targetKey: string; sortTargetKey: null };
/** Which bookshelf operation a card is currently carrying persistence feedback for. */
export type ShelfMutationIntent = 'sort' | 'merge' | 'absorb' | 'move-out';
/**
 * Honest persistence feedback for the cards taking part in the newest drag mutation.
 *
 * A card stays `pending` until the server confirms; nothing shows a settled result early.
 * `failed` is transient and the hook clears it itself.
 */
export type ShelfMutationFeedback =
  | { status: 'idle' }
  | { status: 'pending' | 'failed'; intent: ShelfMutationIntent; keys: readonly string[] };
export type DragPreviewItem = ShelfItem | { type: 'folder-book'; book: FolderBook };
type DragData =
  | { type: 'book'; item: Extract<ShelfItem, { type: 'book' }> }
  | { type: 'folder'; item: Extract<ShelfItem, { type: 'folder' }> }
  | { type: 'folder-book'; book: FolderBook };
interface FolderBookShelfDrag {
  book: FolderBook;
  folder: Folder;
  previousFolderBooks: FolderBook[];
  previousShelfItems: ShelfItem[];
}
interface LibraryDragOptions {
  /** Takes ownership of the visible shelf while a drag and its mutation are in flight. */
  beginShelfProjection?: () => ShelfProjection;
  folderBooks: FolderBook[];
  folderCloseVersion: number;
  getFolderSession?: () => number;
  isFolderSessionCurrent?: (session: number) => boolean;
  isSavingFolderOrder: boolean;
  isSavingOrder: boolean;
  loadShelf: (options?: LoadShelfOptions) => unknown;
  onDropOnDelete?: (book: Book) => void;
  openFolder: Folder | null;
  setError: (message: string) => void;
  setFolderBooks: Dispatch<SetStateAction<FolderBook[]>>;
  setFolderError: (message: string) => void;
  setIsFolderLoading: (value: boolean) => void;
  setIsRenamingFolder: (value: boolean) => void;
  setIsSavingFolderOrder: (value: boolean) => void;
  setIsSavingOrder: (value: boolean) => void;
  setOpenFolder: Dispatch<SetStateAction<Folder | null>>;
  setShelfItems: Dispatch<SetStateAction<ShelfItem[]>>;
  shelfItems: ShelfItem[];
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { DELETE_DROPZONE_ID } from '../components/bookshelf/DeleteDropZone.js';
import { resolveFolderDragTarget, resolveShelfDragTarget } from '../utils/dragCollision.js';
import {
  activeCollision,
  collisionForKey,
  pointFromInputEvent,
  pointerCenterFromDragEvent,
  pointInRect,
} from '../utils/dragGeometry.js';
import { LANDING_SETTLE_MS, SAVE_FAILURE_FEEDBACK_MS } from '../utils/dragMotion.js';
import {
  normalizeShelfBookFromFolderBook,
  normalizeShelfItem,
  toShelfOrderItem,
} from '../utils/libraryItems.js';
import { useDragSession } from './useDragSession.js';
import { useLibraryMutations } from './useLibraryMutations.js';
import { useSortDwell } from './useSortDwell.js';

const sortIntentDelayMs = 450;
const idleIntent: DragIntent = { type: 'idle', targetKey: null, sortTargetKey: null };
const idleMutationFeedback: ShelfMutationFeedback = { status: 'idle' };

/** The shelf shows one intent per resolved target; the Folder panel shows none. */
function shelfIntentForTarget(target: DragTarget, adoptedSortKey: string | null): DragIntent {
  if (target.kind === 'delete') {
    return { type: 'delete', targetKey: null, sortTargetKey: null };
  }

  if (target.kind === 'merge' || target.kind === 'absorb') {
    return { type: target.kind, targetKey: target.targetKey, sortTargetKey: null };
  }

  return { type: 'sort', targetKey: null, sortTargetKey: adoptedSortKey };
}

interface ResolvedCollisions {
  collisions: ReturnType<CollisionDetection>;
  /** The sort target actually adopted this evaluation, or null while its dwell is pending. */
  sortTargetKey: string | null;
}

/** Maps a resolved target onto dnd-kit collisions, letting the dwell own sort adoption. */
function collisionsForTarget<T extends { id: UniqueIdentifier }>({
  activeId,
  droppableContainers,
  dwell,
  generation,
  target,
}: {
  activeId: UniqueIdentifier;
  droppableContainers: T[];
  dwell: SortDwell;
  generation: number;
  target: DragTarget;
}): ResolvedCollisions {
  if (target.kind === 'delete') {
    dwell.evaluate(null);
    return {
      collisions: collisionForKey(DELETE_DROPZONE_ID, droppableContainers),
      sortTargetKey: null,
    };
  }

  if (target.kind !== 'sort' || !target.targetKey) {
    dwell.evaluate(null);
    return { collisions: activeCollision(activeId, droppableContainers), sortTargetKey: null };
  }

  if (!target.dwell) {
    // Free shelf whitespace has no hovered card, so there is nothing to wait for.
    dwell.evaluate(null);
    return {
      collisions: collisionForKey(target.targetKey, droppableContainers),
      sortTargetKey: target.targetKey,
    };
  }

  if (!dwell.evaluate({ generation, targetKey: target.targetKey })) {
    return { collisions: activeCollision(activeId, droppableContainers), sortTargetKey: null };
  }

  return {
    collisions: collisionForKey(target.targetKey, droppableContainers),
    sortTargetKey: target.targetKey,
  };
}

/**
 * Pointer offset from the dragged item's centre at pickup. Keyboard dragging and fixtures
 * whose activator event carries no coordinates fall back to no offset.
 */
function grabOffsetFromDragStart(event: DragStartEvent): Point {
  const pointerPoint = pointFromInputEvent(event.activatorEvent);
  const initialRect = event.active.rect.current.initial;

  if (!pointerPoint || !initialRect) {
    return { x: 0, y: 0 };
  }

  return {
    x: pointerPoint.x - (initialRect.left + initialRect.width / 2),
    y: pointerPoint.y - (initialRect.top + initialRect.height / 2),
  };
}

function bookFromDragData(data: DragData | null) {
  if (data?.type === 'book') {
    return data.item?.book || null;
  }

  if (data?.type === 'folder-book') {
    return data.book || null;
  }

  return null;
}

export function useLibraryDrag({
  beginShelfProjection,
  folderBooks,
  folderCloseVersion,
  getFolderSession,
  isFolderSessionCurrent,
  isSavingFolderOrder,
  isSavingOrder,
  loadShelf,
  onDropOnDelete,
  openFolder,
  setError,
  setFolderBooks,
  setFolderError,
  setIsFolderLoading,
  setIsRenamingFolder,
  setIsSavingFolderOrder,
  setIsSavingOrder,
  setOpenFolder,
  setShelfItems,
  shelfItems,
}: LibraryDragOptions) {
  const dragIntentFrameRef = useRef<number | null>(null);
  const dragIntentRef = useRef<DragIntent>(idleIntent);
  const feedbackTokenRef = useRef(0);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderBookShelfDragRef = useRef<FolderBookShelfDrag | null>(null);
  const ignoreFolderClickUntilRef = useRef(0);
  const shelfProjectionRef = useRef<ShelfProjection | null>(null);
  const dragSession = useDragSession();
  const [activeDragPreview, setActiveDragPreview] = useState<DragPreviewItem | null>(null);
  /** Only the start and end of a folder-to-shelf handoff re-render; coordinates never do. */
  const [isFixedDragPreviewActive, setIsFixedDragPreviewActive] = useState(false);
  const [dragIntent, setDragIntent] = useState<DragIntent>(idleIntent);
  const [mutationFeedback, setMutationFeedback] = useState<ShelfMutationFeedback>(idleMutationFeedback);
  /** Key of a card that has just arrived from a Folder and is settling into the shelf. */
  const [landingKey, setLandingKey] = useState<string | null>(null);
  const shelfSortDwell = useSortDwell(sortIntentDelayMs);
  const folderSortDwell = useSortDwell(sortIntentDelayMs);
  const mutations = useLibraryMutations({
    getFolderSession,
    isFolderSessionCurrent,
    loadShelf,
    setError,
    setFolderBooks,
    setFolderError,
    setIsFolderLoading,
    setIsRenamingFolder,
    setIsSavingFolderOrder,
    setIsSavingOrder,
    setOpenFolder,
    setShelfItems,
  });
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 500,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const readDragData = useCallback((active: Active): DragData | null => {
    const key = String(active.id);
    const type: unknown = active.data.current?.type;
    if (type === 'folder-book') {
      const book = folderBookShelfDragRef.current?.book.key === key
        ? folderBookShelfDragRef.current.book
        : folderBooks.find((candidate) => candidate.key === key);
      return book ? { type, book } : null;
    }
    const item = shelfItems.find((candidate) => candidate.key === key);
    if (type === 'book' && item?.type === 'book') return { type, item };
    if (type === 'folder' && item?.type === 'folder') return { type, item };
    return null;
  }, [folderBooks, shelfItems]);

  const clearDragIntent = useCallback(() => {
    dragIntentRef.current = idleIntent;
    shelfSortDwell.reset();
    setDragIntent(dragIntentRef.current);
  }, [shelfSortDwell]);

  const clearFolderDragIntent = useCallback(() => {
    folderSortDwell.reset();
  }, [folderSortDwell]);

  const resetSortDwell = useCallback(() => {
    shelfSortDwell.reset();
    folderSortDwell.reset();
  }, [folderSortDwell, shelfSortDwell]);

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
      feedbackTokenRef.current += 1;
      const token = feedbackTokenRef.current;

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
    [clearFailureTimer],
  );

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
    releaseShelfProjection();
    shelfProjectionRef.current = beginShelfProjection?.() ?? null;
  }, [beginShelfProjection, releaseShelfProjection]);

  /** Hands the projection to the drag-end path that must decide when to publish or release it. */
  const takeShelfProjection = useCallback(() => {
    const projection = shelfProjectionRef.current;
    shelfProjectionRef.current = null;
    return projection;
  }, []);

  const deactivateFixedDragPreview = useCallback(() => {
    dragSession.setPreviewActive(false);
    setIsFixedDragPreviewActive(false);
  }, [dragSession]);

  const publishDragIntent = useCallback((intent: DragIntent | null) => {
    const nextIntent: DragIntent = intent || idleIntent;
    const currentIntent = dragIntentRef.current;

    if (
      currentIntent.type === nextIntent.type &&
      currentIntent.targetKey === nextIntent.targetKey &&
      currentIntent.sortTargetKey === nextIntent.sortTargetKey
    ) {
      return;
    }

    dragIntentRef.current = nextIntent;

    if (dragIntentFrameRef.current) {
      return;
    }

    dragIntentFrameRef.current = requestAnimationFrame(() => {
      dragIntentFrameRef.current = null;
      setDragIntent(dragIntentRef.current);
    });
  }, []);

  const shelfCollisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const { active, collisionRect, droppableContainers, droppableRects } = args;
      const activeCenter = {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      const target = resolveShelfDragTarget({
        activeCenter,
        activeId: String(active.id),
        activeType: active.data.current?.type,
        deletePoint: dragSession.pointerPoint() || activeCenter,
        droppableEntries: droppableContainers,
        droppableRects,
        items: shelfItems,
        shelfSortArea: dragSession.shelfSortArea(),
      });

      const resolved = collisionsForTarget({
        activeId: active.id,
        droppableContainers,
        dwell: shelfSortDwell,
        generation: dragSession.generation(),
        target,
      });

      // Published after resolution so the sort affordance only appears on a target the
      // dwell has actually adopted, never on one that is still maturing.
      publishDragIntent(shelfIntentForTarget(target, resolved.sortTargetKey));

      return resolved.collisions;
    },
    [dragSession, publishDragIntent, shelfItems, shelfSortDwell],
  );

  const folderCollisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const { active, collisionRect, droppableContainers, droppableRects } = args;
      const activeCenter = {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      const target = resolveFolderDragTarget({
        activeCenter,
        activeId: String(active.id),
        activeType: active.data.current?.type,
        deletePoint: dragSession.pointerPoint() || activeCenter,
        droppableEntries: droppableContainers,
        droppableRects,
        items: folderBooks,
        shelfSortArea: null,
      });

      // A folder book dragged onto the delete zone without leaving the panel must arm the
      // zone exactly as the shelf path does; sorting inside a folder targets no card, so
      // every other outcome is idle.
      publishDragIntent(
        target.kind === 'delete'
          ? { type: 'delete', targetKey: null, sortTargetKey: null }
          : { type: 'idle', targetKey: null, sortTargetKey: null },
      );

      return collisionsForTarget({
        activeId: active.id,
        droppableContainers,
        dwell: folderSortDwell,
        generation: dragSession.generation(),
        target,
      }).collisions;
    },
    [dragSession, folderBooks, folderSortDwell, publishDragIntent],
  );

  const activeDragModifier = useCallback<Modifier>((args) => args.transform, []);

  const appCollisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const activeType = args.active.data.current?.type;

      if (activeType === 'folder-book' && !folderBookShelfDragRef.current) {
        return folderCollisionDetection(args);
      }

      return shelfCollisionDetection(args);
    },
    [folderCollisionDetection, shelfCollisionDetection],
  );

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

  const handleDropOnDelete = useCallback(
    (event: DragEndEvent) => {
      const activeData = readDragData(event.active);
      let book: Book | null;

      if (folderBookShelfDragRef.current) {
        book = folderBookShelfDragRef.current.book;
        restoreFolderBookShelfDrag();
      } else {
        book = bookFromDragData(activeData);

        if (activeData?.type === 'folder-book') {
          clearFolderDragIntent();
        } else {
          clearDragIntent();
        }
      }

      if (!book) {
        return false;
      }

      onDropOnDelete?.(book);
      return true;
    },
    [clearDragIntent, clearFolderDragIntent, onDropOnDelete, readDragData, restoreFolderBookShelfDrag],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeData = readDragData(event.active);

      resetSortDwell();
      // Every drag starts from idle, so an intent published by the drag that just ended
      // can never arm an affordance at the start of this one.
      clearDragIntent();
      deactivateFixedDragPreview();
      // The preview must sit where DragOverlay had the item, not centred under the pointer,
      // so the folder-to-shelf handoff does not make the cover jump.
      dragSession.start(grabOffsetFromDragStart(event));
      acquireShelfProjection();

      if (activeData?.type === 'folder-book') {
        setActiveDragPreview({
          type: 'folder-book',
          book: activeData.book,
        });
        return;
      }

      setActiveDragPreview(activeData?.item ?? null);
    },
    [
      acquireShelfProjection,
      clearDragIntent,
      deactivateFixedDragPreview,
      dragSession,
      readDragData,
      resetSortDwell,
    ],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const activeData = readDragData(event.active);

      if (activeData?.type !== 'folder-book') {
        return;
      }

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

      if (!pointInRect(activeCenter, folderPanel.getBoundingClientRect())) {
        dragSession.setPreviewActive(true);
        dragSession.movePreview(dragSession.pointerPoint(), activeCenter);
        setIsFixedDragPreviewActive(true);
        beginFolderBookShelfDrag(activeData.book);
      }
    },
    [beginFolderBookShelfDrag, dragSession, openFolder, readDragData],
  );

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      setActiveDragPreview(null);
      deactivateFixedDragPreview();
      dragSession.end();
      resetSortDwell();

      if (folderBookShelfDragRef.current) {
        restoreFolderBookShelfDrag();
      } else if (event.active.data.current?.type === 'folder-book') {
        clearFolderDragIntent();
      } else {
        clearDragIntent();
      }

      // Released last so a still-valid queued snapshot replaces the rollback rather than the reverse.
      releaseShelfProjection();
    },
    [
      clearDragIntent,
      clearFolderDragIntent,
      deactivateFixedDragPreview,
      dragSession,
      releaseShelfProjection,
      resetSortDwell,
      restoreFolderBookShelfDrag,
    ],
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

  const handleShelfDragEnd = useCallback(
    async (event: DragEndEvent, projection: ShelfProjection | null) => {
      const { active, over } = event;
      const finalDragIntent = dragIntentRef.current;

      ignoreFolderClickUntilRef.current = performance.now() + 300;
      clearDragIntent();

      if (isSavingOrder) {
        projection?.release();
        return;
      }

      const activeItem = shelfItems.find((item) => item.key === String(active.id));
      const targetItem = shelfItems.find((item) => item.key === finalDragIntent.targetKey);

      if (
        finalDragIntent.type === 'merge' &&
        activeItem?.type === 'book' &&
        targetItem?.type === 'book' &&
        activeItem.key !== targetItem.key
      ) {
        setIsSavingOrder(true);
        setError('');

        await mutations.createFolder({
          // Both covers stay pending; the new Folder only appears once the server commits.
          onOutcome: beginMutationFeedback('merge', [activeItem.key, targetItem.key]),
          previousShelfItems: shelfItems,
          projection,
          sourceBookId: activeItem.id,
          targetBookId: targetItem.id,
        });

        return;
      }

      if (
        finalDragIntent.type === 'absorb' &&
        activeItem?.type === 'book' &&
        targetItem?.type === 'folder'
      ) {
        setIsSavingOrder(true);
        setError('');

        await mutations.moveShelfBookToFolder({
          bookId: activeItem.id,
          folderId: targetItem.id,
          onOutcome: beginMutationFeedback('absorb', [activeItem.key, targetItem.key]),
          previousShelfItems: shelfItems,
          projection,
        });

        return;
      }

      if (!over || active.id === over.id) {
        projection?.release();
        return;
      }

      const oldIndex = shelfItems.findIndex((item) => item.key === String(active.id));
      const newIndex = shelfItems.findIndex((item) => item.key === String(over.id));

      if (oldIndex < 0 || newIndex < 0) {
        projection?.release();
        return;
      }

      const previousShelfItems = shelfItems;
      const reorderedShelfItems = arrayMove(shelfItems, oldIndex, newIndex);

      setShelfItems(reorderedShelfItems);
      setIsSavingOrder(true);
      setError('');

      await mutations.saveShelfItemOrder({
        onOutcome: beginMutationFeedback('sort', [String(active.id)]),
        orderedShelfItems: reorderedShelfItems,
        previousShelfItems,
        projection,
      });
    },
    [
      beginMutationFeedback,
      clearDragIntent,
      isSavingOrder,
      mutations,
      setError,
      setIsSavingOrder,
      setShelfItems,
      shelfItems,
    ],
  );

  const handleFolderDragEnd = useCallback(
    async (event: DragEndEvent, projection: ShelfProjection | null) => {
      const { active, over } = event;

      clearFolderDragIntent();

      if (!openFolder || isSavingFolderOrder || !over || active.id === over.id) {
        projection?.release();
        return;
      }

      const oldIndex = folderBooks.findIndex((book) => book.key === String(active.id));
      const newIndex = folderBooks.findIndex((book) => book.key === String(over.id));

      if (oldIndex < 0 || newIndex < 0) {
        projection?.release();
        return;
      }

      const previousFolderBooks = folderBooks;
      const reorderedFolderBooks = arrayMove(folderBooks, oldIndex, newIndex);

      setFolderBooks(reorderedFolderBooks);
      setIsSavingFolderOrder(true);
      setFolderError('');

      await mutations.saveFolderBookOrder({
        folderId: openFolder.id,
        onOutcome: beginMutationFeedback('sort', [String(active.id)]),
        previousFolderBooks,
        projection,
        reorderedFolderBooks,
      });
    },
    [
      beginMutationFeedback,
      clearFolderDragIntent,
      folderBooks,
      isSavingFolderOrder,
      mutations,
      openFolder,
      setFolderBooks,
      setFolderError,
      setIsSavingFolderOrder,
    ],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragPreview(null);
      deactivateFixedDragPreview();
      dragSession.end();
      resetSortDwell();

      const projection = takeShelfProjection();

      if (event.over?.id === DELETE_DROPZONE_ID && handleDropOnDelete(event)) {
        projection?.release();
        return;
      }

      if (folderBookShelfDragRef.current) {
        await handleFolderBookShelfDragEnd(event, projection);
        return;
      }

      if (event.active.data.current?.type === 'folder-book') {
        await handleFolderDragEnd(event, projection);
        return;
      }

      await handleShelfDragEnd(event, projection);
    },
    [
      deactivateFixedDragPreview,
      dragSession,
      handleDropOnDelete,
      handleFolderBookShelfDragEnd,
      handleFolderDragEnd,
      handleShelfDragEnd,
      resetSortDwell,
      takeShelfProjection,
    ],
  );

  const getFolderOpenIgnoreUntil = useCallback(() => ignoreFolderClickUntilRef.current, []);

  useEffect(() => {
    clearFolderDragIntent();
    resetSortDwell();
  }, [clearFolderDragIntent, folderCloseVersion, resetSortDwell]);

  useEffect(
    () => () => {
      if (dragIntentFrameRef.current) {
        cancelAnimationFrame(dragIntentFrameRef.current);
      }

      // Feedback deadlines never outlive the host; a stale failure cannot reappear.
      clearFailureTimer();

      if (landingTimerRef.current !== null) {
        clearTimeout(landingTimerRef.current);
        landingTimerRef.current = null;
      }

      // The session owns its own listener/frame cleanup; this only drops the projection.
      // Never leave a projection held after unmount; a background refresh must not stay suppressed.
      releaseShelfProjection();
    },
    [clearFailureTimer, releaseShelfProjection],
  );

  return {
    activeDragModifier,
    activeDragPreview,
    appCollisionDetection,
    dragIntent,
    dragPreviewMotion: dragSession.previewMotion,
    getFolderOpenIgnoreUntil,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    isFixedDragPreviewActive,
    landingKey,
    mutationFeedback,
    sensors,
  };
}

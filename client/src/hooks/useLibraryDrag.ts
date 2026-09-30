import type { ItemMenuRequest } from './useShelfItemMenu.js';
import type { Dispatch, SetStateAction } from 'react';
import type { Active, CollisionDetection, DragCancelEvent, DragEndEvent, DragMoveEvent, DragStartEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import type { Book, CatalogBook, Folder, FolderBook, ShelfItem } from '../types/library.js';
import type { DragTarget } from '../utils/dragCollision.js';
import type { Point, Rect } from '../utils/dragGeometry.js';
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
  | { type: 'merge' | 'absorb'; targetKey: string; sortTargetKey: null; armed: boolean };
export type { ShelfMutationIntent, ShelfMutationFeedback } from './useShelfOperations.js';
export type DragPreviewItem = ShelfItem | { type: 'folder-book'; book: FolderBook };
type DragData =
  | { type: 'book'; item: Extract<ShelfItem, { type: 'book' }> }
  | { type: 'folder'; item: Extract<ShelfItem, { type: 'folder' }> }
  | { type: 'folder-book'; book: FolderBook };
interface LibraryDragOptions {
  catalogBooks?: CatalogBook[];
  setCatalogBooks?: Dispatch<SetStateAction<CatalogBook[]>>;
  setFolderBooksByFolderId?: Dispatch<SetStateAction<Map<number, FolderBook[]>>>;
  /** Takes ownership of the visible shelf while a drag and its mutation are in flight. */
  beginShelfProjection?: () => ShelfProjection;
  folderBooksByFolderId?: Map<number, FolderBook[]>;
  folderBooks: FolderBook[];
  folderCloseVersion: number;
  getFolderSession?: () => number;
  isFolderSessionCurrent?: (session: number) => boolean;
  isSavingFolderOrder: boolean;
  isSavingOrder: boolean;
  loadShelf: (options?: LoadShelfOptions) => unknown;
  onRequestItemMenu?: (request: ItemMenuRequest) => void;
  onDropOnDelete?: (book: Book) => void;
  openFolderForDrag?: (folder: Folder, books: FolderBook[], originRect: DOMRect | null) => boolean;
  closeFolderForDrag?: () => void;
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardCode,
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
} from '../utils/dragGeometry.js';
import { FOLDER_EXIT_DWELL_MS, INTENT_DWELL_MS, SPRING_OPEN_DWELL_MS, SORT_DWELL_MS, TOUCH_ACTIVATION_DELAY_MS, STILL_RELEASE_TOLERANCE_PX } from '../utils/dragMotion.js';
import { createDragAnnouncements, DRAG_SCREEN_READER_INSTRUCTIONS, dragIntentAnnouncement } from '../utils/dragAnnouncements.js';
import { useDragSession } from './useDragSession.js';
import { useFolderHandoff } from './useFolderHandoff.js';
import { useShelfOperations } from './useShelfOperations.js';
import { useSortDwell } from './useSortDwell.js';

const idleIntent: DragIntent = { type: 'idle', targetKey: null, sortTargetKey: null };

/** The shelf shows one intent per resolved target; the Folder panel shows none. */
function shelfIntentForTarget(target: DragTarget, adoptedSortKey: string | null, armed: boolean): DragIntent {
  if (target.kind === 'delete') {
    return { type: 'delete', targetKey: null, sortTargetKey: null };
  }

  if (target.kind === 'merge' || target.kind === 'absorb') {
    return { type: target.kind, targetKey: target.targetKey, sortTargetKey: null, armed };
  }

  return { type: 'sort', targetKey: null, sortTargetKey: adoptedSortKey };
}

interface ResolvedCollisions {
  collisions: ReturnType<CollisionDetection>;
  /** The sort target actually adopted this evaluation, or null while its dwell is pending. */
  sortTargetKey: string | null;
  /** Merge/absorb only: whether the centre-zone dwell has matured for this target. */
  armed?: boolean;
}

/** Maps a resolved target onto dnd-kit collisions, letting the dwell own sort adoption. */
function collisionsForTarget<T extends { id: UniqueIdentifier }>({
  activeId,
  droppableContainers,
  dwell,
  intentDwell,
  generation,
  target,
}: {
  activeId: UniqueIdentifier;
  droppableContainers: T[];
  dwell: SortDwell;
  intentDwell?: SortDwell;
  generation: number;
  target: DragTarget;
}): ResolvedCollisions {
  // The two dwells are mutually exclusive: a centre zone cancels any pending sort, and every
  // other target cancels a pending merge/absorb. Neither pending nor armed intent displaces a
  // card, so an unarmed release resolves through `over` (the active item) and stays in its gap.
  if (target.kind === 'merge' || target.kind === 'absorb') {
    dwell.evaluate(null);
    const armed = intentDwell?.evaluate({ generation, targetKey: `${target.kind}:${target.targetKey}` }) ?? false;
    return { collisions: activeCollision(activeId, droppableContainers), sortTargetKey: null, armed };
  }

  intentDwell?.evaluate(null);
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

  if (!dwell.evaluate({ generation, targetKey: target.targetKey })) {
    return { collisions: activeCollision(activeId, droppableContainers), sortTargetKey: null };
  }

  return {
    collisions: collisionForKey(target.targetKey, droppableContainers),
    sortTargetKey: target.targetKey,
  };
}

/** The element each draggable registers with dnd-kit: a shelf card or a Folder-panel card. */
const draggableItemSelector = '.book-shell, .folder-book-shell';

type DragStartRect = Pick<Rect, 'left' | 'top' | 'width' | 'height'>;

/**
 * Box of the picked-up item at drag start, measured once for the grab offset and the size of
 * the fixed preview.
 *
 * dnd-kit calls `onDragStart` before it has measured the active node: it fills
 * `active.rect.current.initial` in a layout effect after the drag-start render, so in a browser
 * that field is still null here. A populated rect is used as is; otherwise the item is measured
 * from the activator event's target, which is the pressed element for the pointer sensors and
 * the focused card button for the keyboard sensor.
 */
function measureDragStartRect(event: DragStartEvent): DragStartRect | null {
  const initialRect = event.active.rect.current.initial;

  if (initialRect) {
    return initialRect;
  }

  const target = event.activatorEvent?.target;
  const item = typeof Element !== 'undefined' && target instanceof Element
    ? target.closest(draggableItemSelector)
    : null;

  if (!item) {
    return null;
  }

  const rect = item.getBoundingClientRect();

  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/**
 * Pointer offset from the dragged item's centre at pickup. Keyboard dragging, an activator
 * event without coordinates, or an item that could not be measured fall back to no offset.
 */
function grabOffsetFromDragStart(event: DragStartEvent, startRect: DragStartRect | null): Point {
  const pointerPoint = pointFromInputEvent(event.activatorEvent);

  if (!pointerPoint || !startRect) {
    return { x: 0, y: 0 };
  }

  return {
    x: pointerPoint.x - (startRect.left + startRect.width / 2),
    y: pointerPoint.y - (startRect.top + startRect.height / 2),
  };
}

function isTouchActivator(event: Event | null | undefined) {
  if (!event) return false;
  return (typeof window.TouchEvent !== 'undefined' && event instanceof window.TouchEvent)
    || ('pointerType' in event && event.pointerType === 'touch');
}

/**
 * A touch pickup that never travelled `STILL_RELEASE_TOLERANCE_PX` and ends without an adopted
 * target. A Folder-panel sort target is adopted through `over` while its visible intent stays
 * idle, and a folder-to-shelf handoff has already changed the shelf, so both keep the drag path.
 */
function isStillTouchRelease(event: DragEndEvent, travel: number, intent: DragIntent, isShelfHandoff: boolean) {
  if (!isTouchActivator(event.activatorEvent) || travel >= STILL_RELEASE_TOLERANCE_PX || isShelfHandoff) {
    return false;
  }

  if (intent.type !== 'idle' && !(intent.type === 'sort' && !intent.sortTargetKey)) {
    return false;
  }

  return !(event.active.data.current?.type === 'folder-book' && event.over && event.over.id !== event.active.id);
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
  catalogBooks,
  setCatalogBooks,
  setFolderBooksByFolderId,
  folderBooksByFolderId,
  folderBooks,
  folderCloseVersion,
  getFolderSession,
  isFolderSessionCurrent,
  isSavingFolderOrder,
  isSavingOrder,
  loadShelf,
  onDropOnDelete,
  openFolderForDrag,
  closeFolderForDrag,
  onRequestItemMenu,
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
  /** Largest pointer displacement of the current drag, so leaving and returning is not "still". */
  const dragTravelRef = useRef(0);
  const ignoreFolderClickUntilRef = useRef(0);
  const dragSession = useDragSession();
  const [nearDeleteZone, setNearDeleteZone] = useState(false);
  const folderSession = getFolderSession?.() ?? folderCloseVersion;

  useLayoutEffect(() => {
    dragSession.onNearDeleteZoneChange(setNearDeleteZone);
    return () => dragSession.onNearDeleteZoneChange(null);
  }, [dragSession]);
  const [activeDragPreview, setActiveDragPreview] = useState<DragPreviewItem | null>(null);
  /**
   * Size of the picked-up card, for the fixed preview that replaces DragOverlay when a Folder
   * book leaves its panel. The box is measured once at drag start; like the
   * preview item it changes only when a drag begins or ends, never while the pointer moves.
   */
  const [activeDragSize, setActiveDragSize] = useState<Pick<Rect, 'width' | 'height'> | null>(null);
  const [dragIntent, setDragIntent] = useState<DragIntent>(idleIntent);
  const shelfSortDwell = useSortDwell(SORT_DWELL_MS);
  const shelfIntentDwell = useSortDwell(INTENT_DWELL_MS);
  const folderSortDwell = useSortDwell(SORT_DWELL_MS);
  const folderExitDwell = useSortDwell(FOLDER_EXIT_DWELL_MS);
  const springDwell = useSortDwell(SPRING_OPEN_DWELL_MS);
  const sensorPointerRef = useRef<Point | null>(null);
  const operations = useShelfOperations({
    catalogBooks,
    setCatalogBooks,
    setFolderBooksByFolderId,
    folderBooksByFolderId,
    shelfItems,
    folderBooks,
    openFolder,
    beginShelfProjection,
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
  const {
    mutations,
    mutationFeedback,
    landingKey,
    beginMutationFeedback,
    acquireShelfProjection,
    takeShelfProjection,
    releaseShelfProjection,
  } = operations;
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_ACTIVATION_DELAY_MS,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Space picks up; Enter stays the button's own action (open), as the spoken
      // instructions say. Shelf cards already intercept Enter; this keeps Folder-panel
      // cards from starting a drag on Enter instead of opening the book.
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
      },
    }),
  );

  const clearDragIntent = useCallback(() => {
    dragIntentRef.current = idleIntent;
    shelfSortDwell.reset();
    shelfIntentDwell.reset();
    springDwell.reset();
    setDragIntent(dragIntentRef.current);
  }, [shelfSortDwell, shelfIntentDwell, springDwell]);

  const clearFolderDragIntent = useCallback(() => {
    folderSortDwell.reset();
  }, [folderSortDwell]);

  const publishDragIntent = useCallback((intent: DragIntent | null) => {
    const nextIntent: DragIntent = intent || idleIntent;
    const currentIntent = dragIntentRef.current;

    if (
      currentIntent.type === nextIntent.type &&
      currentIntent.targetKey === nextIntent.targetKey &&
      currentIntent.sortTargetKey === nextIntent.sortTargetKey &&
      ('armed' in currentIntent ? currentIntent.armed : false) === ('armed' in nextIntent ? nextIntent.armed : false)
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

  const {
    clearFolderExitHandoff,
    getFolderExitPending,
    hasFolderExitHandoff,
    deactivateFixedDragPreview,
    evaluateSpringTarget,
    shelfBookFolderDragRef,
    handleShelfBookFolderDragEnd,
    moveShelfBookFolderPreview,
    restoreShelfBookFolderDrag,
    folderBookShelfDragRef,
    handleFolderBookDragMove,
    handleFolderBookShelfDragEnd,
    isFixedDragPreviewActive,
    isFolderExitPending,
    resetSortDwell,
    restoreFolderBookShelfDrag,
  } = useFolderHandoff({
    activeDragPreview,
    folderBooksByFolderId,
    openFolderForDrag,
    closeFolderForDrag,
    springDwell,
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
  });

  useEffect(() => {
    if (hasFolderExitHandoff && (dragIntent.type === 'merge' || dragIntent.type === 'absorb')) {
      clearFolderExitHandoff();
    }
  }, [clearFolderExitHandoff, dragIntent.type, hasFolderExitHandoff]);

  const announcementItemsRef = useRef({ shelfItems, folderBooks });
  announcementItemsRef.current = { shelfItems, folderBooks };
  /** Spoken names use the same untitled fallbacks as the visible cards. */
  const lookupDragName = useCallback((key: string): string | null => {
    const latest = announcementItemsRef.current;
    const item = latest.shelfItems.find((candidate) => candidate.key === key);
    if (item?.type === 'book') return `《${item.book.title || '未命名书籍'}》`;
    if (item?.type === 'folder') return `「${item.folder.name || '文件夹'}」`;
    const book = latest.folderBooks.find((candidate) => candidate.key === key)
      ?? (folderBookShelfDragRef.current?.book.key === key ? folderBookShelfDragRef.current.book : null);
    return book ? `《${book.title || '未命名书籍'}》` : null;
  }, []);
  // dnd-kit can announce over before the pending state render; read the synchronous exit ref.
  const readAnnouncementContext = useCallback(() => ({
    isFolderExitPending: getFolderExitPending(),
    hasFolderExitHandoff: folderBookShelfDragRef.current !== null,
  }), [folderBookShelfDragRef, getFolderExitPending]);
  const accessibility = useMemo(() => ({
    announcements: createDragAnnouncements(lookupDragName, readAnnouncementContext),
    screenReaderInstructions: DRAG_SCREEN_READER_INSTRUCTIONS,
  }), [lookupDragName, readAnnouncementContext]);
  const readDragData = useCallback((active: Active): DragData | null => {
    const key = String(active.id);
    const spring = shelfBookFolderDragRef.current;
    if (spring?.item.key === key) {
      const book = folderBooks.find(candidate => candidate.key === key);
      return book ? { type: 'folder-book', book } : null;
    }
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
        intentDwell: shelfIntentDwell,
        generation: dragSession.generation(),
        target,
      });

      // Published after resolution so the sort affordance only appears on a target the
      // dwell has actually adopted, never on one that is still maturing.
      publishDragIntent(shelfIntentForTarget(target, resolved.sortTargetKey, resolved.armed ?? false));
      evaluateSpringTarget(String(active.id), target, resolved.armed ?? false, activeCenter);

      return resolved.collisions;
    },
    [dragSession, evaluateSpringTarget, publishDragIntent, shelfItems, shelfSortDwell, shelfIntentDwell],
  );

  const folderCollisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const { active, collisionRect, droppableContainers, droppableRects } = args;
      const activeCenter = {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      moveShelfBookFolderPreview(args.pointerCoordinates, activeCenter);
      // Spring reparenting can leave dnd-kit's active rect at the old geometry.
      // The fixed preview already owns the pointer's grab-offset-aware centre.
      const folderCenter = shelfBookFolderDragRef.current?.center ?? activeCenter;
      const target = resolveFolderDragTarget({
        activeCenter: folderCenter,
        activeId: String(active.id),
        activeType: shelfBookFolderDragRef.current ? 'folder-book' : active.data.current?.type,
        deletePoint: (shelfBookFolderDragRef.current ? args.pointerCoordinates : dragSession.pointerPoint()) || activeCenter,
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
    [dragSession, folderBooks, folderSortDwell, moveShelfBookFolderPreview, publishDragIntent],
  );

  const activeDragModifier = useCallback<Modifier>((args) => args.transform, []);

  const appCollisionDetection = useCallback<CollisionDetection>(
    (args) => {
      // Ref only during collision rendering; handleDragMove publishes proximity afterwards.
      sensorPointerRef.current = args.pointerCoordinates;
      const activeType = args.active.data.current?.type;

      if (shelfBookFolderDragRef.current || (activeType === 'folder-book' && !folderBookShelfDragRef.current)) {
        return folderCollisionDetection(args);
      }

      return shelfCollisionDetection(args);
    },
    [folderCollisionDetection, shelfCollisionDetection],
  );

  const handleDropOnDelete = useCallback(
    (event: DragEndEvent) => {
      const activeData = readDragData(event.active);
      let book: Book | null;

      if (shelfBookFolderDragRef.current) {
        book = shelfBookFolderDragRef.current.item.book;
        restoreShelfBookFolderDrag(false);
      } else if (folderBookShelfDragRef.current) {
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
    [clearDragIntent, clearFolderDragIntent, onDropOnDelete, readDragData, restoreFolderBookShelfDrag, restoreShelfBookFolderDrag],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      sensorPointerRef.current = null;
      clearFolderExitHandoff();
      const activeData = readDragData(event.active);

      resetSortDwell();
      // Every drag starts from idle, so an intent published by the drag that just ended
      // can never arm an affordance at the start of this one.
      clearDragIntent();
      deactivateFixedDragPreview();
      // One measurement of the picked-up item: the preview must sit where DragOverlay had the
      // item, not centred under the pointer, so the folder-to-shelf handoff does not make the
      // cover jump; and it must use the same box as the fluid card it came from.
      const startRect = measureDragStartRect(event);
      dragTravelRef.current = 0;
      dragSession.start(grabOffsetFromDragStart(event, startRect), {
        canDelete: activeData?.type === 'book' || activeData?.type === 'folder-book',
        pointerPoint: pointFromInputEvent(event.activatorEvent),
      });
      if (isTouchActivator(event.activatorEvent) && typeof navigator.vibrate === 'function') {
        navigator.vibrate(10);
      }
      acquireShelfProjection();
      setActiveDragSize(startRect ? { width: startRect.width, height: startRect.height } : null);

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
      clearFolderExitHandoff,
      clearDragIntent,
      deactivateFixedDragPreview,
      dragSession,
      readDragData,
      resetSortDwell,
    ],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      // Detached touch events no longer bubble to window after either handoff. Reuse
      // the sensor's raw point in the same session, including after returning to the shelf.
      if (sensorPointerRef.current) dragSession.movePointer(sensorPointerRef.current);
      // Ref only: coordinate updates must never render the host.
      dragTravelRef.current = Math.max(dragTravelRef.current, Math.hypot(event.delta.x, event.delta.y));
      const activeData = readDragData(event.active);

      if (activeData?.type !== 'folder-book') {
        return;
      }

      handleFolderBookDragMove(event, activeData.book);
    },
    [dragSession, handleFolderBookDragMove, readDragData],
  );

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      sensorPointerRef.current = null;
      clearFolderExitHandoff();
      setActiveDragPreview(null);
      setActiveDragSize(null);
      deactivateFixedDragPreview();
      dragSession.end();
      resetSortDwell();

      if (shelfBookFolderDragRef.current) {
        restoreShelfBookFolderDrag(false);
      } else if (folderBookShelfDragRef.current) {
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
      clearFolderExitHandoff,
      deactivateFixedDragPreview,
      dragSession,
      releaseShelfProjection,
      resetSortDwell,
      restoreFolderBookShelfDrag,
      restoreShelfBookFolderDrag,
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
        finalDragIntent.armed &&
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
        finalDragIntent.armed &&
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
      const activatorPoint = pointFromInputEvent(event.activatorEvent);
      const releasePoint = dragSession.releasePoint();
      const releaseTravel = activatorPoint && releasePoint
        ? Math.hypot(releasePoint.x - activatorPoint.x, releasePoint.y - activatorPoint.y) : 0;
      sensorPointerRef.current = null;
      clearFolderExitHandoff();
      setActiveDragPreview(null);
      setActiveDragSize(null);
      deactivateFixedDragPreview();
      dragSession.end();
      resetSortDwell();

      const projection = takeShelfProjection();
      const travel = Math.max(dragTravelRef.current, Math.hypot(event.delta.x, event.delta.y), releaseTravel);
      dragTravelRef.current = 0;

      // A touch pickup held still and released without an adopted target is a long press:
      // it opens the item menu instead of ending as an empty drag, and mutates nothing.
      if (onRequestItemMenu && isStillTouchRelease(event, travel, dragIntentRef.current, folderBookShelfDragRef.current !== null || shelfBookFolderDragRef.current !== null)) {
        const target = event.activatorEvent?.target;
        const card = target instanceof Element ? target.closest(draggableItemSelector) : null;
        const cover = card?.querySelector('.book-cover, .folder-cover');
        const opener = card instanceof window.HTMLButtonElement ? card : card?.querySelector('button');
        opener?.focus({ preventScroll: true });
        clearDragIntent();
        clearFolderDragIntent();
        projection?.release();
        onRequestItemMenu({ key: String(event.active.id), anchorRect: cover?.getBoundingClientRect() ?? null });
        return;
      }

      if (event.over?.id === DELETE_DROPZONE_ID && handleDropOnDelete(event)) {
        projection?.release();
        return;
      }

      if (shelfBookFolderDragRef.current) {
        ignoreFolderClickUntilRef.current = performance.now() + 300;
        await handleShelfBookFolderDragEnd(event, projection);
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
      clearFolderExitHandoff,
      deactivateFixedDragPreview,
      dragSession,
      handleDropOnDelete,
      handleFolderBookShelfDragEnd,
      handleShelfBookFolderDragEnd,
      handleFolderDragEnd,
      handleShelfDragEnd,
      clearDragIntent,
      clearFolderDragIntent,
      onRequestItemMenu,
      resetSortDwell,
      takeShelfProjection,
    ],
  );

  const getFolderOpenIgnoreUntil = useCallback(() => ignoreFolderClickUntilRef.current, []);

  useEffect(
    () => () => {
      if (dragIntentFrameRef.current) {
        cancelAnimationFrame(dragIntentFrameRef.current);
      }
    },
    [],
  );

  return {
    accessibility,
    activeDragModifier,
    activeDragPreview,
    activeDragSize,
    appCollisionDetection,
    dragIntent,
    dragIntentAnnouncement: dragIntentAnnouncement(dragIntent, lookupDragName, hasFolderExitHandoff),
    dragPreviewMotion: dragSession.previewMotion,
    getFolderOpenIgnoreUntil,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    isFixedDragPreviewActive,
    isFolderExitPending,
    nearDeleteZone,
    landingKey,
    mutationFeedback,
    operations,
    sensors,
  };
}

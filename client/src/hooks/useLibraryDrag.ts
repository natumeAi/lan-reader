import type { Dispatch, SetStateAction } from 'react';
import type { Active, CollisionDetection, DragCancelEvent, DragEndEvent, DragMoveEvent, DragStartEvent, Modifier } from '@dnd-kit/core';
import type { Book, Folder, FolderBook, ShelfItem } from '../types/library.js';
import type { Point, Rect } from '../utils/dragGeometry.js';
import type { LoadShelfOptions } from './useShelfData.js';
import { errorMessage } from '../api/transport.js';

export type DragIntent =
  | { type: 'idle' | 'sort' | 'delete'; targetKey: null }
  | { type: 'merge' | 'absorb'; targetKey: string };
export type DragPreviewItem = ShelfItem | { type: 'folder-book'; book: FolderBook };
type DragData =
  | { type: 'book'; item: Extract<ShelfItem, { type: 'book' }> }
  | { type: 'folder'; item: Extract<ShelfItem, { type: 'folder' }> }
  | { type: 'folder-book'; book: FolderBook };
interface SortIntent { startedAt: number; targetKey: string | null }
interface FolderBookShelfDrag {
  book: FolderBook;
  folder: Folder;
  previousFolderBooks: FolderBook[];
  previousShelfItems: ShelfItem[];
}
interface LibraryDragOptions {
  folderBooks: FolderBook[];
  folderCloseVersion: number;
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
import {
  createFolderFromBooks,
  moveFolderBookToShelf,
  moveShelfBookToFolder,
  updateFolderBookOrder,
  updateShelfItemOrder,
} from '../api/foldersApi.js';
import { DELETE_DROPZONE_ID } from '../components/bookshelf/DeleteDropZone.js';
import {
  activeCollision,
  centerRect,
  collisionForKey,
  distanceToRectCenter,
  expandRect,
  pointFromInputEvent,
  pointerCenterFromDragEvent,
  pointInRect,
  shelfSortAreaRect,
  sortTargetKeyFromPoint,
} from '../utils/dragGeometry.js';
import {
  normalizeFolderBook,
  normalizeShelfBookFromFolderBook,
  normalizeShelfItem,
  toShelfOrderItem,
} from '../utils/libraryItems.js';

const sortIntentDelayMs = 450;

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
  folderBooks,
  folderCloseVersion,
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
  const dragIntentRef = useRef<DragIntent>({ type: 'idle', targetKey: null });
  const folderBookShelfDragRef = useRef<FolderBookShelfDrag | null>(null);
  const folderSortIntentRef = useRef<SortIntent>({ startedAt: 0, targetKey: null });
  const ignoreFolderClickUntilRef = useRef(0);
  const latestPointerPointRef = useRef<Point | null>(null);
  const pointerTrackingCleanupRef = useRef<(() => void) | null>(null);
  const sortIntentRef = useRef<SortIntent>({ startedAt: 0, targetKey: null });
  const [activeDragPreview, setActiveDragPreview] = useState<DragPreviewItem | null>(null);
  const [fixedDragPreviewPoint, setFixedDragPreviewPoint] = useState<Point | null>(null);
  const [dragIntent, setDragIntent] = useState<DragIntent>({ type: 'idle', targetKey: null });
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
    dragIntentRef.current = { type: 'idle', targetKey: null };
    sortIntentRef.current = { startedAt: 0, targetKey: null };
    setDragIntent(dragIntentRef.current);
  }, []);

  const clearFolderDragIntent = useCallback(() => {
    folderSortIntentRef.current = { startedAt: 0, targetKey: null };
  }, []);

  const stopPointerTracking = useCallback(() => {
    pointerTrackingCleanupRef.current?.();
    pointerTrackingCleanupRef.current = null;
    latestPointerPointRef.current = null;
  }, []);

  const startPointerTracking = useCallback(() => {
    stopPointerTracking();

    const updatePointerPoint = (event: PointerEvent | MouseEvent | TouchEvent) => {
      const point = pointFromInputEvent(event);

      if (!point) {
        return;
      }

      latestPointerPointRef.current = point;

      if (folderBookShelfDragRef.current) {
        setFixedDragPreviewPoint(point);
      }
    };

    window.addEventListener('pointermove', updatePointerPoint, { passive: true });
    window.addEventListener('mousemove', updatePointerPoint, { passive: true });
    window.addEventListener('touchmove', updatePointerPoint, { passive: true });
    pointerTrackingCleanupRef.current = () => {
      window.removeEventListener('pointermove', updatePointerPoint);
      window.removeEventListener('mousemove', updatePointerPoint);
      window.removeEventListener('touchmove', updatePointerPoint);
    };
  }, [stopPointerTracking]);

  const publishDragIntent = useCallback((intent: DragIntent | null) => {
    const nextIntent: DragIntent = intent || { type: 'idle', targetKey: null };
    const currentIntent = dragIntentRef.current;

    if (currentIntent.type === nextIntent.type && currentIntent.targetKey === nextIntent.targetKey) {
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
      const activeType = active.data.current?.type;
      const activeCenter = {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      const deletePoint = latestPointerPointRef.current || activeCenter;
      let lockedTarget: { distance: number; key: string; rect: Rect & { right: number; bottom: number }; type: unknown } | null = null;

      for (const droppableContainer of droppableContainers) {
        const targetKey = String(droppableContainer.id);

        if (targetKey === String(active.id)) {
          continue;
        }

        const rect = droppableRects.get(droppableContainer.id);
        const targetType = droppableContainer.data.current?.type;

        if (!rect) {
          continue;
        }

        if (
          targetType === 'delete-zone' &&
          (activeType === 'book' || activeType === 'folder-book') &&
          (pointInRect(deletePoint, expandRect(rect, 24)) ||
            pointInRect(activeCenter, expandRect(rect, 54)))
        ) {
          publishDragIntent({ type: 'delete', targetKey: null });
          return collisionForKey(DELETE_DROPZONE_ID, droppableContainers);
        }

        if (targetType === 'delete-zone' || !pointInRect(activeCenter, rect)) {
          continue;
        }

        const distance = distanceToRectCenter(activeCenter, rect);

        if (!lockedTarget || distance < lockedTarget.distance) {
          lockedTarget = {
            distance,
            key: targetKey,
            rect,
            type: targetType,
          };
        }
      }

      if (lockedTarget) {
        const canCreateFolder = activeType === 'book' && lockedTarget.type === 'book';
        const canMoveIntoFolder = activeType === 'book' && lockedTarget.type === 'folder';
        const isCenterTarget = pointInRect(activeCenter, centerRect(lockedTarget.rect));

        if (canCreateFolder && isCenterTarget) {
          publishDragIntent({
            type: 'merge',
            targetKey: lockedTarget.key,
          });

          return activeCollision(active.id, droppableContainers);
        }

        if (canMoveIntoFolder && isCenterTarget) {
          publishDragIntent({
            type: 'absorb',
            targetKey: lockedTarget.key,
          });

          return activeCollision(active.id, droppableContainers);
        }

        publishDragIntent({ type: 'sort', targetKey: null });
        const sortTargetKey = sortTargetKeyFromPoint({
          activeKey: String(active.id),
          point: activeCenter,
          items: shelfItems,
          droppableRects,
        });

        if (sortTargetKey === String(active.id)) {
          sortIntentRef.current = { startedAt: 0, targetKey: null };
          return activeCollision(active.id, droppableContainers);
        }

        const now = performance.now();

        if (sortIntentRef.current.targetKey !== sortTargetKey) {
          sortIntentRef.current = {
            startedAt: now,
            targetKey: sortTargetKey,
          };

          return activeCollision(active.id, droppableContainers);
        }

        if (now - sortIntentRef.current.startedAt < sortIntentDelayMs) {
          return activeCollision(active.id, droppableContainers);
        }

        return collisionForKey(sortTargetKey, droppableContainers);
      }

      publishDragIntent({ type: 'sort', targetKey: null });
      const shelfElement = document.querySelector('.shelf-grid');
      const viewportBottom = window.visualViewport
        ? window.visualViewport.offsetTop + window.visualViewport.height
        : window.innerHeight;
      const shelfSortArea = shelfElement
        ? shelfSortAreaRect(
            shelfElement.getBoundingClientRect(),
            viewportBottom,
          )
        : null;

      if (shelfSortArea && !pointInRect(activeCenter, shelfSortArea)) {
        sortIntentRef.current = { startedAt: 0, targetKey: null };
        return activeCollision(active.id, droppableContainers);
      }

      const sortTargetKey = sortTargetKeyFromPoint({
        activeKey: String(active.id),
        point: activeCenter,
        items: shelfItems,
        droppableRects,
      });

      if (!sortTargetKey || sortTargetKey === String(active.id)) {
        sortIntentRef.current = { startedAt: 0, targetKey: null };
        return activeCollision(active.id, droppableContainers);
      }

      sortIntentRef.current = { startedAt: 0, targetKey: null };
      return collisionForKey(sortTargetKey, droppableContainers);
    },
    [publishDragIntent, shelfItems],
  );

  const folderCollisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const { active, collisionRect, droppableContainers, droppableRects } = args;
      const activeType = active.data.current?.type;
      const activeCenter = {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      const deletePoint = latestPointerPointRef.current || activeCenter;

      for (const droppableContainer of droppableContainers) {
        const rect = droppableRects.get(droppableContainer.id);

        if (
          rect &&
          (pointInRect(deletePoint, expandRect(rect, 24)) ||
            pointInRect(activeCenter, expandRect(rect, 54))) &&
          droppableContainer.data.current?.type === 'delete-zone' &&
          activeType === 'folder-book'
        ) {
          return collisionForKey(DELETE_DROPZONE_ID, droppableContainers);
        }
      }

      const sortTargetKey = sortTargetKeyFromPoint({
        activeKey: String(active.id),
        point: activeCenter,
        items: folderBooks,
        droppableRects,
      });

      if (!sortTargetKey || sortTargetKey === String(active.id)) {
        folderSortIntentRef.current = { startedAt: 0, targetKey: null };
        return activeCollision(active.id, droppableContainers);
      }

      const now = performance.now();

      if (folderSortIntentRef.current.targetKey !== sortTargetKey) {
        folderSortIntentRef.current = {
          startedAt: now,
          targetKey: sortTargetKey,
        };

        return activeCollision(active.id, droppableContainers);
      }

      if (now - folderSortIntentRef.current.startedAt < sortIntentDelayMs) {
        return activeCollision(active.id, droppableContainers);
      }

      return collisionForKey(sortTargetKey, droppableContainers);
    },
    [folderBooks],
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
    setFixedDragPreviewPoint(null);
  }, [
    clearDragIntent,
    clearFolderBookShelfDrag,
    clearFolderDragIntent,
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
      clearFolderDragIntent();
      publishDragIntent({ type: 'sort', targetKey: null });
    },
    [
      clearFolderDragIntent,
      folderBooks,
      openFolder,
      publishDragIntent,
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

      setFixedDragPreviewPoint(null);
      startPointerTracking();

      if (activeData?.type === 'folder-book') {
        setActiveDragPreview({
          type: 'folder-book',
          book: activeData.book,
        });
        return;
      }

      setActiveDragPreview(activeData?.item ?? null);
    },
    [readDragData, startPointerTracking],
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
        setFixedDragPreviewPoint(latestPointerPointRef.current || activeCenter);
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
        setFixedDragPreviewPoint(latestPointerPointRef.current || activeCenter);
        beginFolderBookShelfDrag(activeData.book);
      }
    },
    [beginFolderBookShelfDrag, openFolder, readDragData],
  );

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      setActiveDragPreview(null);
      setFixedDragPreviewPoint(null);
      stopPointerTracking();

      if (folderBookShelfDragRef.current) {
        restoreFolderBookShelfDrag();
        return;
      }

      if (event.active.data.current?.type === 'folder-book') {
        clearFolderDragIntent();
        return;
      }

      clearDragIntent();
    },
    [clearDragIntent, clearFolderDragIntent, restoreFolderBookShelfDrag, stopPointerTracking],
  );

  const handleFolderBookShelfDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const dragState = folderBookShelfDragRef.current;

      if (!dragState) {
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

      setShelfItems(orderedShelfItems);
      setIsSavingOrder(true);
      setError('');
      clearDragIntent();

      try {
        const data = await moveFolderBookToShelf(
          dragState.folder.id,
          dragState.book.id,
          orderItems,
        );
        clearFolderBookShelfDrag();
        setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
        await loadShelf({ background: true, allowCached: false });
      } catch (err) {
        const previousShelfItems = dragState.previousShelfItems;
        const previousFolderBooks = dragState.previousFolderBooks;
        const previousFolder = dragState.folder;

        clearFolderBookShelfDrag();
        setShelfItems(previousShelfItems);
        setOpenFolder(previousFolder);
        setFolderBooks(previousFolderBooks);
        setFolderError(errorMessage(err, '无法移出书籍'));
      } finally {
        setIsSavingOrder(false);
      }
    },
    [
      clearDragIntent,
      clearFolderBookShelfDrag,
      loadShelf,
      setError,
      setFolderBooks,
      setFolderError,
      setIsSavingOrder,
      setOpenFolder,
      setShelfItems,
      shelfItems,
    ],
  );

  const handleShelfDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      const finalDragIntent = dragIntentRef.current;

      ignoreFolderClickUntilRef.current = performance.now() + 300;
      clearDragIntent();

      if (isSavingOrder) {
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
        const previousShelfItems = shelfItems;

        setIsSavingOrder(true);
        setError('');

        try {
          const data = await createFolderFromBooks(activeItem.id, targetItem.id);
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
          await loadShelf({ background: true, allowCached: false });
        } catch (err) {
          setShelfItems(previousShelfItems);
          setError(errorMessage(err, '无法创建文件夹'));
        } finally {
          setIsSavingOrder(false);
        }

        return;
      }

      if (
        finalDragIntent.type === 'absorb' &&
        activeItem?.type === 'book' &&
        targetItem?.type === 'folder'
      ) {
        const previousShelfItems = shelfItems;

        setIsSavingOrder(true);
        setError('');

        try {
          const data = await moveShelfBookToFolder(targetItem.id, activeItem.id);
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
          await loadShelf({ background: true, allowCached: false });
        } catch (err) {
          setShelfItems(previousShelfItems);
          setError(errorMessage(err, '无法移入文件夹'));
        } finally {
          setIsSavingOrder(false);
        }

        return;
      }

      if (!over || active.id === over.id) {
        return;
      }

      const oldIndex = shelfItems.findIndex((item) => item.key === String(active.id));
      const newIndex = shelfItems.findIndex((item) => item.key === String(over.id));

      if (oldIndex < 0 || newIndex < 0) {
        return;
      }

      const previousShelfItems = shelfItems;
      const reorderedShelfItems = arrayMove(shelfItems, oldIndex, newIndex);

      setShelfItems(reorderedShelfItems);
      setIsSavingOrder(true);
      setError('');

      try {
        const data = await updateShelfItemOrder(reorderedShelfItems.map(toShelfOrderItem));
        setShelfItems((data.items || reorderedShelfItems).map(normalizeShelfItem));
        await loadShelf({ background: true, allowCached: false });
      } catch (err) {
        setShelfItems(previousShelfItems);
        setError(errorMessage(err, '无法保存书架顺序'));
      } finally {
        setIsSavingOrder(false);
      }
    },
    [
      clearDragIntent,
      isSavingOrder,
      loadShelf,
      setError,
      setIsSavingOrder,
      setShelfItems,
      shelfItems,
    ],
  );

  const handleFolderDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;

      clearFolderDragIntent();

      if (!openFolder || isSavingFolderOrder || !over || active.id === over.id) {
        return;
      }

      const oldIndex = folderBooks.findIndex((book) => book.key === String(active.id));
      const newIndex = folderBooks.findIndex((book) => book.key === String(over.id));

      if (oldIndex < 0 || newIndex < 0) {
        return;
      }

      const previousFolderBooks = folderBooks;
      const reorderedFolderBooks = arrayMove(folderBooks, oldIndex, newIndex);

      setFolderBooks(reorderedFolderBooks);
      setIsSavingFolderOrder(true);
      setFolderError('');

      try {
        const data = await updateFolderBookOrder(
          openFolder.id,
          reorderedFolderBooks.map((book) => book.id),
        );
        setFolderBooks((data.books || reorderedFolderBooks).map(normalizeFolderBook));
        await loadShelf({ background: true, allowCached: false });
      } catch (err) {
        setFolderBooks(previousFolderBooks);
        setFolderError(errorMessage(err, '无法保存文件夹顺序'));
      } finally {
        setIsSavingFolderOrder(false);
      }
    },
    [
      clearFolderDragIntent,
      folderBooks,
      isSavingFolderOrder,
      loadShelf,
      openFolder,
      setFolderBooks,
      setFolderError,
      setIsSavingFolderOrder,
    ],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragPreview(null);
      setFixedDragPreviewPoint(null);
      stopPointerTracking();

      if (event.over?.id === DELETE_DROPZONE_ID && handleDropOnDelete(event)) {
        return;
      }

      if (folderBookShelfDragRef.current) {
        await handleFolderBookShelfDragEnd(event);
        return;
      }

      if (event.active.data.current?.type === 'folder-book') {
        await handleFolderDragEnd(event);
        return;
      }

      await handleShelfDragEnd(event);
    },
    [
      handleDropOnDelete,
      handleFolderBookShelfDragEnd,
      handleFolderDragEnd,
      handleShelfDragEnd,
      stopPointerTracking,
    ],
  );

  const getFolderOpenIgnoreUntil = useCallback(() => ignoreFolderClickUntilRef.current, []);

  useEffect(() => {
    clearFolderDragIntent();
  }, [clearFolderDragIntent, folderCloseVersion]);

  useEffect(
    () => () => {
      if (dragIntentFrameRef.current) {
        cancelAnimationFrame(dragIntentFrameRef.current);
      }

      stopPointerTracking();
    },
    [stopPointerTracking],
  );

  return {
    activeDragModifier,
    activeDragPreview,
    appCollisionDetection,
    dragIntent,
    fixedDragPreviewPoint,
    getFolderOpenIgnoreUntil,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    sensors,
  };
}

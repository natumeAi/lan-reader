/**
 * Pure target resolution for bookshelf and folder dragging.
 *
 * The hook owns dnd-kit wiring, dwell scheduling and intent publication; everything that
 * only depends on geometry lives here so it can be reasoned about and tested directly.
 * Hit zones, the centre-zone ratio and the delete expansions are the reviewed behaviour
 * and must stay identical.
 */
import type { UniqueIdentifier } from '@dnd-kit/core';
import type { Point, Rect } from './dragGeometry.js';
import {
  centerRect,
  distanceToRectCenter,
  expandRect,
  pointInRect,
  sortTargetKeyFromPoint,
} from './dragGeometry.js';

/** Minimal shape of a dnd-kit droppable container used by target resolution. */
export interface DragDroppableEntry {
  id: UniqueIdentifier;
  data: { current?: { type?: unknown } | null };
}
export interface DragTargetInput {
  activeCenter: Point;
  activeId: string;
  activeType: unknown;
  /** Pointer position when known; the active centre is the fallback for keyboard dragging. */
  deletePoint: Point;
  droppableEntries: Iterable<DragDroppableEntry>;
  droppableRects: ReadonlyMap<UniqueIdentifier, Rect>;
  items: readonly { key: string }[];
  /** Cached sortable area of the shelf grid, or null when it cannot be measured. */
  shelfSortArea: Rect | null;
}
export type DragTarget =
  | { kind: 'delete' }
  | { kind: 'merge'; targetKey: string }
  | { kind: 'absorb'; targetKey: string }
  /** `dwell` marks a target that may only be adopted after the hover delay matures. */
  | { kind: 'sort'; targetKey: string | null; dwell: boolean }
  /** The pointer is outside every sortable area, so no target may be adopted. */
  | { kind: 'none' };

const deletePointExpansion = 24;
const deleteCenterExpansion = 54;

function readType(entry: DragDroppableEntry) {
  return entry.data.current?.type;
}

function isDeleteHit(rect: Rect, deletePoint: Point, activeCenter: Point) {
  return (
    pointInRect(deletePoint, expandRect(rect, deletePointExpansion)) ||
    pointInRect(activeCenter, expandRect(rect, deleteCenterExpansion))
  );
}

function sortTarget(input: DragTargetInput, dwell: boolean): DragTarget {
  const targetKey = sortTargetKeyFromPoint({
    activeKey: input.activeId,
    point: input.activeCenter,
    items: input.items,
    droppableRects: input.droppableRects,
  });

  if (!targetKey || targetKey === input.activeId) {
    return { kind: 'sort', targetKey: null, dwell: false };
  }

  return { kind: 'sort', targetKey, dwell };
}

/**
 * Shelf resolution: delete zone first, then the nearest container whose rect contains the
 * active centre (merge/absorb inside its centre zone, sorting otherwise), then free shelf
 * whitespace, which sorts immediately because no card is being hovered.
 */
export function resolveShelfDragTarget(input: DragTargetInput): DragTarget {
  const { activeCenter, activeId, activeType, deletePoint, droppableEntries, droppableRects } = input;
  let lockedTarget: { distance: number; key: string; rect: Rect; type: unknown } | null = null;

  for (const entry of droppableEntries) {
    const targetKey = String(entry.id);

    if (targetKey === activeId) {
      continue;
    }

    const rect = droppableRects.get(entry.id);
    const targetType = readType(entry);

    if (!rect) {
      continue;
    }

    if (
      targetType === 'delete-zone' &&
      (activeType === 'book' || activeType === 'folder-book') &&
      isDeleteHit(rect, deletePoint, activeCenter)
    ) {
      return { kind: 'delete' };
    }

    if (targetType === 'delete-zone' || !pointInRect(activeCenter, rect)) {
      continue;
    }

    const distance = distanceToRectCenter(activeCenter, rect);

    if (!lockedTarget || distance < lockedTarget.distance) {
      lockedTarget = { distance, key: targetKey, rect, type: targetType };
    }
  }

  if (lockedTarget) {
    const canCreateFolder = activeType === 'book' && lockedTarget.type === 'book';
    const canMoveIntoFolder = activeType === 'book' && lockedTarget.type === 'folder';
    const isCenterTarget = pointInRect(activeCenter, centerRect(lockedTarget.rect));

    if (canCreateFolder && isCenterTarget) {
      return { kind: 'merge', targetKey: lockedTarget.key };
    }

    if (canMoveIntoFolder && isCenterTarget) {
      return { kind: 'absorb', targetKey: lockedTarget.key };
    }

    return sortTarget(input, true);
  }

  if (input.shelfSortArea && !pointInRect(activeCenter, input.shelfSortArea)) {
    return { kind: 'none' };
  }

  return sortTarget(input, false);
}

/** Folder resolution: only deleting a folder book and sorting within the open folder. */
export function resolveFolderDragTarget(input: DragTargetInput): DragTarget {
  const { activeCenter, activeType, deletePoint, droppableEntries, droppableRects } = input;

  for (const entry of droppableEntries) {
    const rect = droppableRects.get(entry.id);

    if (
      rect &&
      isDeleteHit(rect, deletePoint, activeCenter) &&
      readType(entry) === 'delete-zone' &&
      activeType === 'folder-book'
    ) {
      return { kind: 'delete' };
    }
  }

  return sortTarget(input, true);
}

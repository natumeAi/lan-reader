import type { DragMoveEvent, UniqueIdentifier } from '@dnd-kit/core';
export interface Point { x: number; y: number }
export interface RectEdges { left: number; right: number; top: number; bottom: number }
export interface Rect extends RectEdges { width: number; height: number }
interface InputCoordinates { clientX?: number; clientY?: number; touches?: ArrayLike<{ clientX: number; clientY: number }>; changedTouches?: ArrayLike<{ clientX: number; clientY: number }> }
const centerZoneRatio = 0.46;

export function pointInRect(point: Point, rect: RectEdges) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

export function centerRect(rect: Rect) {
  const xInset = (rect.width * (1 - centerZoneRatio)) / 2;
  const yInset = (rect.height * (1 - centerZoneRatio)) / 2;

  return {
    left: rect.left + xInset,
    right: rect.right - xInset,
    top: rect.top + yInset,
    bottom: rect.bottom - yInset,
  };
}

export function expandRect(rect: RectEdges, amount: number) {
  return {
    left: rect.left - amount,
    right: rect.right + amount,
    top: rect.top - amount,
    bottom: rect.bottom + amount,
  };
}

export function distanceToRectCenter(point: Point, rect: Rect) {
  const x = rect.left + rect.width / 2 - point.x;
  const y = rect.top + rect.height / 2 - point.y;

  return Math.hypot(x, y);
}

export function activeCollision<T extends { id: UniqueIdentifier }>(activeId: UniqueIdentifier, droppableContainers: T[]) {
  const activeContainer = droppableContainers.find(
    (droppableContainer) => String(droppableContainer.id) === String(activeId),
  );

  return activeContainer
    ? [
        {
          id: activeContainer.id,
          data: {
            droppableContainer: activeContainer,
            value: 0,
          },
        },
      ]
    : [];
}

export function collisionForKey<T extends { id: UniqueIdentifier }>(targetKey: UniqueIdentifier | null, droppableContainers: T[]) {
  const targetContainer = droppableContainers.find(
    (droppableContainer) => String(droppableContainer.id) === String(targetKey),
  );

  return targetContainer
    ? [
        {
          id: targetContainer.id,
          data: {
            droppableContainer: targetContainer,
            value: 0,
          },
        },
      ]
    : [];
}

function isPointBeforeSortRect(point: Point, rect: Rect) {
  const centerX = rect.left + rect.width / 2;

  if (point.y < rect.top) {
    return true;
  }

  if (point.y > rect.bottom) {
    return false;
  }

  return point.x < centerX;
}

export function sortTargetKeyFromPoint({ activeKey, point, items, droppableRects }: { activeKey: string; point: Point; items: { key: string }[]; droppableRects: ReadonlyMap<UniqueIdentifier, Rect> }) {
  const orderedKeys = items.map((item) => item.key);
  const oldIndex = orderedKeys.indexOf(activeKey);

  if (oldIndex < 0) {
    return null;
  }

  const sortableKeys = orderedKeys.filter(
    (key) => key !== activeKey && droppableRects.get(key),
  );
  let insertionIndex = sortableKeys.length;

  for (let index = 0; index < sortableKeys.length; index += 1) {
    const key = sortableKeys[index];
    const rect = key === undefined ? undefined : droppableRects.get(key);

    if (rect && isPointBeforeSortRect(point, rect)) {
      insertionIndex = index;
      break;
    }
  }

  const clampedIndex = Math.max(0, Math.min(orderedKeys.length - 1, insertionIndex));

  return orderedKeys[clampedIndex] ?? null;
}

export function shelfSortAreaRect(shelfRect: Rect, viewportBottom: number) {
  const bottom = Math.max(shelfRect.bottom, viewportBottom);

  return {
    left: shelfRect.left,
    right: shelfRect.right,
    top: shelfRect.top,
    bottom,
    width: shelfRect.width,
    height: bottom - shelfRect.top,
  };
}

export function pointerCenterFromDragEvent(event: Pick<DragMoveEvent, 'active' | 'delta'>) {
  const initialRect = event.active.rect.current.initial;

  if (!initialRect) {
    return null;
  }

  return {
    x: initialRect.left + event.delta.x + initialRect.width / 2,
    y: initialRect.top + event.delta.y + initialRect.height / 2,
  };
}

export function pointFromInputEvent(event: Event | InputCoordinates | null | undefined) {
  if (!event) {
    return null;
  }

  const touch = ('touches' in event ? event.touches?.[0] : undefined) || ('changedTouches' in event ? event.changedTouches?.[0] : undefined);

  if (touch) {
    return {
      x: touch.clientX,
      y: touch.clientY,
    };
  }

  if ('clientX' in event && 'clientY' in event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
    return {
      x: event.clientX,
      y: event.clientY,
    };
  }

  return null;
}

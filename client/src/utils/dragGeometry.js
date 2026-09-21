const centerZoneRatio = 0.46;

export function pointInRect(point, rect) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

export function centerRect(rect) {
  const xInset = (rect.width * (1 - centerZoneRatio)) / 2;
  const yInset = (rect.height * (1 - centerZoneRatio)) / 2;

  return {
    left: rect.left + xInset,
    right: rect.right - xInset,
    top: rect.top + yInset,
    bottom: rect.bottom - yInset,
  };
}

export function expandRect(rect, amount) {
  return {
    left: rect.left - amount,
    right: rect.right + amount,
    top: rect.top - amount,
    bottom: rect.bottom + amount,
  };
}

export function distanceToRectCenter(point, rect) {
  const x = rect.left + rect.width / 2 - point.x;
  const y = rect.top + rect.height / 2 - point.y;

  return Math.hypot(x, y);
}

export function activeCollision(activeId, droppableContainers) {
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

export function collisionForKey(targetKey, droppableContainers) {
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

function isPointBeforeSortRect(point, rect) {
  const centerX = rect.left + rect.width / 2;

  if (point.y < rect.top) {
    return true;
  }

  if (point.y > rect.bottom) {
    return false;
  }

  return point.x < centerX;
}

export function sortTargetKeyFromPoint({ activeKey, point, items, droppableRects }) {
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
    const rect = droppableRects.get(sortableKeys[index]);

    if (isPointBeforeSortRect(point, rect)) {
      insertionIndex = index;
      break;
    }
  }

  const clampedIndex = Math.max(0, Math.min(orderedKeys.length - 1, insertionIndex));

  return orderedKeys[clampedIndex];
}

export function shelfSortAreaRect(shelfRect, viewportBottom) {
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

export function pointerCenterFromDragEvent(event) {
  const initialRect = event.active.rect.current.initial;

  if (!initialRect) {
    return null;
  }

  return {
    x: initialRect.left + event.delta.x + initialRect.width / 2,
    y: initialRect.top + event.delta.y + initialRect.height / 2,
  };
}

export function pointFromInputEvent(event) {
  if (!event) {
    return null;
  }

  const touch = event.touches?.[0] || event.changedTouches?.[0];

  if (touch) {
    return {
      x: touch.clientX,
      y: touch.clientY,
    };
  }

  if (typeof event.clientX === 'number' && typeof event.clientY === 'number') {
    return {
      x: event.clientX,
      y: event.clientY,
    };
  }

  return null;
}

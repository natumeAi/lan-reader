import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shelfSortAreaRect,
  sortTargetKeyFromPoint,
} from '../src/utils/dragGeometry.js';

function rect(left, top, width, height) {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

test('extends the shelf sort area through visible whitespace below the last row', () => {
  assert.deepEqual(
    shelfSortAreaRect(rect(10, 200, 360, 220), 780),
    rect(10, 200, 360, 580),
  );
});

test('does not shrink a shelf that already continues beyond the viewport', () => {
  const shelfRect = rect(10, -80, 360, 960);

  assert.deepEqual(shelfSortAreaRect(shelfRect, 780), shelfRect);
});

test('blank shelf space after the last row resolves to the final compact position', () => {
  const items = [
    { key: 'folder:1' },
    { key: 'book:2' },
    { key: 'book:3' },
  ];
  const droppableRects = new Map([
    ['folder:1', rect(0, 0, 100, 160)],
    ['book:2', rect(120, 0, 100, 160)],
    ['book:3', rect(240, 0, 100, 160)],
  ]);

  assert.equal(
    sortTargetKeyFromPoint({
      activeKey: 'folder:1',
      point: { x: 300, y: 640 },
      items,
      droppableRects,
    }),
    'book:3',
  );
});

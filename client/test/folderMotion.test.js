import test from 'node:test';
import assert from 'node:assert/strict';
import {
  folderPanelMotion,
  rectIntersectsViewport,
  snapshotRect,
} from '../src/utils/folderMotion.js';

test('snapshots only usable source rectangles', () => {
  assert.deepEqual(
    snapshotRect({ left: 12, top: 24, width: 110, height: 165, right: 122, bottom: 189 }),
    { left: 12, top: 24, width: 110, height: 165 },
  );
  assert.equal(snapshotRect({ left: 0, top: 0, width: 0, height: 100 }), null);
});

test('maps the panel center and size back to the selected folder cover', () => {
  assert.deepEqual(
    folderPanelMotion(
      { left: 20, top: 40, width: 100, height: 150 },
      { left: 100, top: 80, width: 500, height: 600 },
    ),
    {
      translateX: -280,
      translateY: -265,
      scaleX: 0.2,
      scaleY: 0.25,
    },
  );
});

test('rejects missing geometry and clamps tiny sources to a visible scale', () => {
  assert.equal(folderPanelMotion(null, { left: 0, top: 0, width: 500, height: 500 }), null);
  assert.deepEqual(
    folderPanelMotion(
      { left: 0, top: 0, width: 1, height: 1 },
      { left: 0, top: 0, width: 500, height: 500 },
    ),
    {
      translateX: -249.5,
      translateY: -249.5,
      scaleX: 0.08,
      scaleY: 0.08,
    },
  );
});

test('only reuses a close target that still intersects the viewport', () => {
  const viewport = { width: 390, height: 844 };

  assert.equal(
    rectIntersectsViewport({ left: 20, top: 700, width: 110, height: 165 }, viewport),
    true,
  );
  assert.equal(
    rectIntersectsViewport({ left: 20, top: 900, width: 110, height: 165 }, viewport),
    false,
  );
});

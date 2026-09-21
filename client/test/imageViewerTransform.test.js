import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageViewerTransform,
  panImageViewerBy,
  resizeImageViewerTransform,
  settleImageViewerTransform,
  zoomImageViewerAt,
} from '../src/utils/imageViewerTransform.js';

test('fits a Content Image without cropping or upscaling a small source', () => {
  const large = createImageViewerTransform({
    imageHeight: 1200,
    imageWidth: 1600,
    viewportHeight: 640,
    viewportWidth: 360,
  });
  const small = createImageViewerTransform({
    imageHeight: 80,
    imageWidth: 120,
    viewportHeight: 640,
    viewportWidth: 360,
  });

  assert.deepEqual(
    { height: large.baseHeight, scale: large.scale, width: large.baseWidth },
    { height: 270, scale: 1, width: 360 },
  );
  assert.deepEqual(
    { height: small.baseHeight, scale: small.scale, width: small.baseWidth },
    { height: 80, scale: 1, width: 120 },
  );
});

test('keeps the tapped image detail under the pointer while zooming', () => {
  const initial = createImageViewerTransform({
    imageHeight: 400,
    imageWidth: 400,
    viewportHeight: 600,
    viewportWidth: 400,
  });

  const zoomed = zoomImageViewerAt(initial, 2.5, { x: 300, y: 300 });

  assert.deepEqual(
    { offsetX: zoomed.offsetX, offsetY: zoomed.offsetY, scale: zoomed.scale },
    { offsetX: -150, offsetY: 0, scale: 2.5 },
  );
});

test('constrains viewer zoom to the agreed 1x through 5x range', () => {
  const initial = createImageViewerTransform({
    imageHeight: 800,
    imageWidth: 800,
    viewportHeight: 400,
    viewportWidth: 400,
  });
  const maximum = zoomImageViewerAt(initial, 20, { x: 200, y: 200 });
  const minimum = zoomImageViewerAt(maximum, 0.2, { x: 200, y: 200 });

  assert.equal(maximum.scale, 5);
  assert.deepEqual(
    { offsetX: minimum.offsetX, offsetY: minimum.offsetY, scale: minimum.scale },
    { offsetX: 0, offsetY: 0, scale: 1 },
  );
});

test('resists an out-of-bounds pan and settles back to the image edge', () => {
  const initial = zoomImageViewerAt(createImageViewerTransform({
    imageHeight: 400,
    imageWidth: 400,
    viewportHeight: 400,
    viewportWidth: 400,
  }), 2, { x: 200, y: 200 });

  const dragged = panImageViewerBy(initial, 400, 0, { resist: true });
  const settled = settleImageViewerTransform(dragged);

  assert.equal(dragged.offsetX, 250);
  assert.equal(settled.offsetX, 200);
});

test('resists and rebounds on an axis where the zoomed image still fits', () => {
  const initial = zoomImageViewerAt(createImageViewerTransform({
    imageHeight: 200,
    imageWidth: 800,
    viewportHeight: 400,
    viewportWidth: 400,
  }), 2, { x: 200, y: 200 });

  const dragged = panImageViewerBy(initial, 0, 100, { resist: true });
  const settled = settleImageViewerTransform(dragged);

  assert.equal(dragged.offsetY, 25);
  assert.equal(settled.offsetY, 0);
});

test('preserves the viewed image position when the viewport rotates', () => {
  const initial = zoomImageViewerAt(createImageViewerTransform({
    imageHeight: 1200,
    imageWidth: 1600,
    viewportHeight: 600,
    viewportWidth: 400,
  }), 2.5, { x: 300, y: 300 });

  const resized = resizeImageViewerTransform(initial, {
    viewportHeight: 400,
    viewportWidth: 600,
  });

  assert.equal(resized.scale, 2.5);
  assert.ok(Math.abs(resized.offsetX - (-200)) < 0.000001);
  assert.equal(resized.offsetY, 0);
  assert.ok(Math.abs(resized.baseWidth - (1600 / 3)) < 0.000001);
  assert.equal(resized.baseHeight, 400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpubPageTurnAdapter } from '../src/utils/epubPageTurnAdapter.js';

function createViewElement({ height = 600, width = 1000 } = {}) {
  return {
    animate: () => ({
      cancel() {},
      finished: Promise.resolve(),
      startTime: 0,
    }),
    classList: {
      contains: (name) => name === 'epub-view',
    },
    getAnimations: () => [],
    getBoundingClientRect: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
    }),
    isConnected: true,
    style: {
      transform: '',
      willChange: '',
    },
  };
}

function createAdapter({ viewHeight = 600, viewWidth = 1000 } = {}) {
  const viewElement = createViewElement({
    height: viewHeight,
    width: viewWidth,
  });
  const scroller = {
    clientHeight: 600,
    clientWidth: 1000,
    offsetHeight: 600,
    offsetWidth: 1000,
    scrollHeight: 600,
    scrollLeft: 0,
    scrollWidth: Math.max(2000, viewWidth),
    style: {
      transform: '',
    },
  };
  const manager = {
    container: scroller,
    isPaginated: true,
    layout: {
      divisor: 1,
      pageWidth: 1000,
    },
    name: 'continuous',
    settings: {
      axis: 'horizontal',
      direction: 'ltr',
      snap: true,
    },
    snapper: {},
    views: {
      container: {},
      displayed: () => [{ element: viewElement }],
    },
  };
  const diagnostics = {
    begin: () => null,
    cancel() {},
    destroy() {},
    finish() {},
    frame() {},
    markAnimationStart() {},
    markVisualUpdate() {},
  };
  const adapter = createEpubPageTurnAdapter({ manager }, {
    cancelAnimationFrame() {},
    debugConfig: { enabled: false, forceBackend: null },
    diagnostics,
    now: () => 0,
    requestAnimationFrame: () => 1,
  });

  return { adapter, scroller, viewElement };
}

test('uses the scroll backend instead of promoting an oversized EPUB section', () => {
  const { adapter, viewElement } = createAdapter({ viewWidth: 10000 });

  const session = adapter.begin('epubcfi(/6/2)');

  assert.equal(session?.backend, 'scroll');
  assert.equal(viewElement.style.willChange, '');
});

test('does not promote a safe compositor view until the page moves', () => {
  const { adapter, viewElement } = createAdapter();

  const session = adapter.begin('epubcfi(/6/2)');

  assert.equal(session?.backend, 'compositor');
  assert.equal(viewElement.style.willChange, '');

  adapter.dragBy(-20);

  assert.equal(viewElement.style.willChange, 'transform');
  adapter.cancel({ restoreOrigin: true });
  assert.equal(viewElement.style.willChange, '');
});

test('keeps oversized EPUB sections finger-tracking on the scroll backend', () => {
  const { adapter, scroller, viewElement } = createAdapter({ viewWidth: 10000 });
  const session = adapter.begin('epubcfi(/6/2)');

  const drag = adapter.dragBy(-250);

  assert.equal(session?.backend, 'scroll');
  assert.equal(drag?.effectiveDistanceX, -250);
  assert.equal(scroller.scrollLeft, 250);
  assert.equal(viewElement.style.transform, '');
  assert.equal(viewElement.style.willChange, '');

  adapter.cancel({ restoreOrigin: true });
  assert.equal(scroller.scrollLeft, 0);
});

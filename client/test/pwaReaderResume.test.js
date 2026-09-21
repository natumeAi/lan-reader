import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useEffect, useState } from 'react';
import { JSDOM } from 'jsdom';
import { useEpubRendition } from '../src/hooks/useEpubRendition.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SAVED_CFI = 'epubcfi(/6/4!/4/2/6:24)';
const HIDDEN_LAYOUT_CFI = 'epubcfi(/6/2!/4/2/2:0)';

function locationAt(cfi) {
  return {
    start: {
      cfi,
      displayed: { page: cfi === SAVED_CFI ? 7 : 1, total: 12 },
      href: 'chapter.xhtml',
      index: 0,
    },
  };
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.fail(message);
}

test('uses three-level recovery when a PWA returns from the background', async () => {
  const previousGlobals = new Map();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
  });
  const installGlobal = (name, value) => {
    previousGlobals.set(name, globalThis[name]);
    globalThis[name] = value;
  };

  installGlobal('window', dom.window);
  installGlobal('document', dom.window.document);
  installGlobal('Node', dom.window.Node);
  installGlobal('Element', dom.window.Element);
  installGlobal('HTMLElement', dom.window.HTMLElement);
  installGlobal('MutationObserver', dom.window.MutationObserver);
  installGlobal('localStorage', dom.window.localStorage);
  installGlobal('requestAnimationFrame', (callback) => setTimeout(
    () => callback(globalThis.performance.now()),
    0,
  ));
  installGlobal('cancelAnimationFrame', clearTimeout);

  let visibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });

  const displayCalls = [];
  const clearCalls = [];
  const enqueuedProgress = [];
  const handlers = new Map();
  const resizeCalls = [];
  let bookFileRequestCount = 0;
  let currentLocation = locationAt(SAVED_CFI);
  let rendition;
  let restoreFrameOnDisplay = true;

  const createEpub = () => ({
    destroy() {},
    loaded: {
      navigation: Promise.resolve({ toc: [] }),
    },
    locations: {
      epubcfi: { compare: () => 0 },
      generate: async () => {},
      percentageFromCfi: (cfi) => (cfi === SAVED_CFI ? 0.58 : 0.02),
      save: () => '[]',
    },
    packaging: {},
    renderTo(container) {
      const frame = document.createElement('iframe');
      frame.getBoundingClientRect = () => ({
        bottom: 800,
        height: 800,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
      });
      container.append(frame);
      frame.contentDocument.body.textContent = 'Rendered book page';

      rendition = {
        clear() {
          clearCalls.push(true);
          frame.contentDocument.body.textContent = '';
        },
        currentLocation: () => currentLocation,
        destroy() {
          frame.remove();
        },
        display: async (cfi) => {
          const target = cfi || HIDDEN_LAYOUT_CFI;
          displayCalls.push(target);
          currentLocation = locationAt(target);
          if (restoreFrameOnDisplay) {
            frame.contentDocument.body.textContent = 'Rendered book page';
          }
          handlers.get('relocated')?.(currentLocation);
        },
        getContents: () => [],
        hooks: { content: { register() {} } },
        manager: {
          container,
          settings: {},
          views: { displayed: () => [] },
          visible: () => [],
        },
        off(event, handler) {
          if (handlers.get(event) === handler) handlers.delete(event);
        },
        on(event, handler) {
          handlers.set(event, handler);
        },
        reportLocation() {},
        resize() {
          resizeCalls.push(true);
        },
      };
      return rendition;
    },
    spine: {
      get: () => null,
      spineItems: [],
    },
  });

  installGlobal('fetch', async (url) => {
    if (url === '/api/books/1/file') {
      bookFileRequestCount += 1;
      return {
        arrayBuffer: async () => new ArrayBuffer(8),
        ok: true,
        status: 200,
      };
    }
    if (url === '/api/reading/1') {
      return {
        json: async () => ({
          progress: {
            bookId: 1,
            cfi: SAVED_CFI,
            progress: 0.58,
            chapterHref: 'chapter.xhtml',
            chapterLabel: null,
          },
        }),
        ok: true,
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const bookRef = { current: null };
  const containerRef = { current: null };
  const currentCfiRef = { current: null };
  const isClosingRef = { current: false };
  const readerSettingsRef = { current: { horizontalMargin: 24 } };
  const renditionRef = { current: null };
  const loadingTransitions = [];
  const applyReaderHorizontalMargin = async () => {};
  const applyReaderSettings = () => {};
  const applyReaderSettingsToContents = () => {};
  const enqueueProgress = (progress) => {
    enqueuedProgress.push(progress);
    return true;
  };
  const flushPendingReaderSettings = () => {};
  const loadReaderSettings = async () => readerSettingsRef.current;
  const markReaderSettingsLoaded = () => {};
  const resetReaderSettingsLoad = () => {};
  const pageProgressController = {
    beginBookPageProgress() {},
    failReadingSectionPageRanges() {},
    invalidateReadingSectionPages() {},
    setReadingSectionPageRanges() {},
    setReadingSections() {},
    updatePageProgressFromLocation() {},
  };
  const setContainer = (node) => {
    containerRef.current = node;
    if (node) {
      node.getBoundingClientRect = () => ({
        bottom: 800,
        height: 800,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
      });
    }
  };

  function Harness() {
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    useEffect(() => {
      loadingTransitions.push(isLoading);
    }, [isLoading]);

    useEpubRendition({
      applyReaderHorizontalMargin,
      applyReaderSettings,
      applyReaderSettingsToContents,
      book: { id: 1 },
      bookRef,
      containerRef,
      createEpub,
      currentCfiRef,
      enqueueProgress,
      error,
      flushPendingReaderSettings,
      isClosingRef,
      isLayoutReady: true,
      isLoading,
      loadReaderSettings,
      markReaderSettingsLoaded,
      pageProgressController,
      readerSettingsRef,
      renditionRef,
      resetReaderSettingsLoad,
      setError,
      setIsLoading,
    });

    return createElement('div', null,
      createElement('output', { 'data-loading': String(isLoading) }, error),
      createElement('div', { ref: setContainer }),
    );
  }

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));

  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    await waitUntil(
      () => document.querySelector('output')?.dataset.loading === 'false',
      'the initial rendition did not finish loading',
    );
    assert.equal(currentCfiRef.current, SAVED_CFI);
    await act(async () => {
      handlers.get('relocated')?.(locationAt(SAVED_CFI));
    });
    assert.equal(enqueuedProgress.at(-1)?.cfi, SAVED_CFI);
    const initialDisplayCallCount = displayCalls.length;
    const initialLoadingTransitionCount = loadingTransitions.length;

    await act(async () => {
      window.dispatchEvent(new window.Event('blur'));
      currentLocation = locationAt(HIDDEN_LAYOUT_CFI);
      handlers.get('relocated')?.(currentLocation);
    });
    assert.equal(
      currentCfiRef.current,
      SAVED_CFI,
      'a background-transition relocation must not replace the last visible page',
    );

    visibilityState = 'hidden';
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
      handlers.get('relocated')?.(currentLocation);
    });

    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    await waitUntil(
      () => resizeCalls.length > 0 &&
        document.querySelector('output')?.dataset.loading === 'false',
      'the visible reader did not finish its healthy-view recovery',
    );

    assert.equal(clearCalls.length, 0);
    assert.equal(
      loadingTransitions.slice(initialLoadingTransitionCount).includes(true),
      false,
    );
    assert.equal(displayCalls.length, initialDisplayCallCount + 1);
    assert.equal(displayCalls.at(-1), SAVED_CFI);
    assert.equal(enqueuedProgress.at(-1)?.cfi, SAVED_CFI);

    const rebuildLoadingTransitionCount = loadingTransitions.length;
    containerRef.current.querySelector('iframe').contentDocument.body.textContent = '';
    visibilityState = 'hidden';
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    await waitUntil(
      () => clearCalls.length === 1 &&
        document.querySelector('output')?.dataset.loading === 'false',
      'the unhealthy view did not finish its rendition rebuild',
    );

    assert.equal(
      loadingTransitions.slice(rebuildLoadingTransitionCount).includes(true),
      true,
    );
    assert.equal(bookFileRequestCount, 1);
    assert.equal(currentCfiRef.current, SAVED_CFI);

    restoreFrameOnDisplay = false;
    containerRef.current.querySelector('iframe').contentDocument.body.textContent = '';
    visibilityState = 'hidden';
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    await waitUntil(
      () => bookFileRequestCount === 2 &&
        document.querySelector('output')?.dataset.loading === 'false',
      'the failed rendition rebuild did not fall back to a full reload',
    );

    assert.equal(clearCalls.length, 2);
    assert.equal(currentCfiRef.current, SAVED_CFI);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, value] of previousGlobals) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

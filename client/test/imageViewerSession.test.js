import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { useImageViewerSession } from '../src/hooks/useImageViewerSession.js';
import {
  hasImageViewerHistoryState,
  readerBookIdFromHistoryState,
  withImageViewerHistoryState,
  withReaderHistoryState,
} from '../src/utils/readerHistoryState.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const contentImage = {
  alt: '',
  intrinsicHeight: 1200,
  intrinsicWidth: 1600,
  kind: 'url',
  source: 'https://reader.test/books/plate.jpg',
};

function installDom() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://reader.test/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  window.history.replaceState(withReaderHistoryState({}, 7), '', window.location.href);
  return {
    cleanup() {
      dom.window.close();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.fail(message);
}

async function mountSession({ reducedMotion }) {
  const { createRoot } = await import('react-dom/client');
  let session;
  function Harness() {
    session = useImageViewerSession({ bookId: 7, reducedMotion });
    return createElement('output', {
      'data-closing': String(session.isClosing),
      'data-open': String(Boolean(session.contentImage)),
    });
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(createElement(Harness));
  });
  return { root, session: () => session };
}

test('uses Back to close the Image Viewer while keeping the current Book open', async () => {
  const environment = installDom();
  let root;
  try {
    const mounted = await mountSession({ reducedMotion: true });
    root = mounted.root;
    const initialHistoryLength = window.history.length;

    await act(async () => {
      assert.equal(mounted.session().openImage(contentImage), true);
    });

    assert.equal(document.querySelector('output').dataset.open, 'true');
    assert.equal(window.history.length, initialHistoryLength + 1);
    assert.equal(hasImageViewerHistoryState(window.history.state), true);

    await act(async () => {
      window.history.back();
    });
    await waitUntil(
      () => document.querySelector('output').dataset.open === 'false',
      'Back did not close the Image Viewer',
    );

    assert.equal(readerBookIdFromHistoryState(window.history.state), 7);
    assert.equal(hasImageViewerHistoryState(window.history.state), false);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('requests only one history traversal when the Image Viewer close is requested twice', async () => {
  const environment = installDom();
  let root;
  const originalBack = window.history.back;
  let backCount = 0;
  try {
    window.history.back = () => {
      backCount += 1;
    };
    const mounted = await mountSession({ reducedMotion: false });
    root = mounted.root;

    await act(async () => {
      mounted.session().openImage(contentImage);
    });
    await act(async () => {
      mounted.session().requestClose();
      mounted.session().requestClose();
    });

    assert.equal(backCount, 1);
  } finally {
    window.history.back = originalBack;
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('enters the closing transition before an explicit Image Viewer close completes', async () => {
  const environment = installDom();
  let root;
  try {
    const mounted = await mountSession({ reducedMotion: false });
    root = mounted.root;
    await act(async () => {
      mounted.session().openImage(contentImage);
    });

    await act(async () => {
      mounted.session().requestClose();
    });

    assert.equal(document.querySelector('output').dataset.open, 'true');
    assert.equal(document.querySelector('output').dataset.closing, 'true');
    await waitUntil(
      () => document.querySelector('output').dataset.open === 'false',
      'the Image Viewer close transition did not complete',
    );
    assert.equal(hasImageViewerHistoryState(window.history.state), false);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('starts a fresh Image Viewer instance when history quickly reopens a closing image', async () => {
  const environment = installDom();
  let root;
  try {
    const mounted = await mountSession({ reducedMotion: false });
    root = mounted.root;
    await act(async () => {
      mounted.session().openImage(contentImage);
    });
    const firstViewerKey = mounted.session().viewerKey;

    await act(async () => {
      window.dispatchEvent(new window.PopStateEvent('popstate', {
        state: withReaderHistoryState({}, 7),
      }));
      window.dispatchEvent(new window.PopStateEvent('popstate', {
        state: withImageViewerHistoryState(withReaderHistoryState({}, 7)),
      }));
    });

    assert.equal(mounted.session().isClosing, false);
    assert.notEqual(mounted.session().viewerKey, firstViewerKey);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';
import type { LibrarySnapshot, SnapshotBookDto } from '@lan-reader/shared';
import { useShelfData } from '../src/hooks/useShelfData.js';
import { useFolderState } from '../src/hooks/useFolderState.js';
import { useLibraryDrag } from '../src/hooks/useLibraryDrag.js';
import type { DragMoveEvent } from '@dnd-kit/core';
import type { Folder, FolderBook, ShelfItem } from '../src/types/library.js';

function book(id: number): SnapshotBookDto {
  return {
    id, folderId: null, title: `Book ${id}`, author: null, identifier: null,
    fileName: `${id}.epub`, fileSize: 1, coverPath: null, coverUrl: null,
    coverThumbnailUrl: null, coverThumbnail2xUrl: null, coverThumbnailVersion: null,
    sortOrder: 0, createdAt: '2026-09-21', updatedAt: '2026-09-21',
    readingProgress: null, readingUpdatedAt: null,
  };
}

function snapshot(id: number): LibrarySnapshot {
  return {
    schemaVersion: 1, version: id, books: [book(id)], folders: [],
    shelf: [{ type: 'book', id, sortOrder: 0 }], recent: [],
  };
}

function response(id: number) {
  return Response.json({ snapshot: snapshot(id) }, { headers: { ETag: `"library-${id}"` } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mountHook<T>(useHook: () => T) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let latest: T | undefined;
  function Harness() { latest = useHook(); return null; }
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
  return {
    get current() { assert.ok(latest); return latest; },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('snapshot requests abort their predecessor and ignore late success', async (t) => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const signals: (AbortSignal | null | undefined)[] = [];
  let count = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, options?: RequestInit) => {
    signals.push(options?.signal);
    return ++count === 1 ? first.promise : second.promise;
  });
  const hook = await mountHook(() => useShelfData());
  try {
    assert.equal(count, 1, 'cache unavailable still starts exactly one network request');
    let reload: Promise<unknown> | undefined;
    await act(async () => { reload = hook.current.loadShelf(); });
    assert.equal(signals[0]?.aborted, true);
    await act(async () => { second.resolve(response(2)); await reload; });
    assert.equal(hook.current.shelfItems[0]?.id, 2);
    await act(async () => { first.resolve(response(1)); await first.promise; });
    assert.equal(hook.current.shelfItems[0]?.id, 2, 'late old data never overwrites newest data');
    assert.equal(hook.current.shelfError, '');
  } finally { await hook.close(); }
});

test('snapshot revalidation keeps usable state on network failure and skips the 304 body', async (t) => {
  let count = 0;
  let conditionalHeader: string | null = null;
  const notModified = new Response(null, { status: 304 });
  const bodyRead = t.mock.method(notModified, 'json', () => { throw new Error('304 body read'); });
  t.mock.method(globalThis, 'fetch', (_url: unknown, options?: RequestInit) => {
    count += 1;
    if (count === 1) return Promise.resolve(response(3));
    conditionalHeader = new Headers(options?.headers).get('If-None-Match');
    if (count === 2) return Promise.resolve(notModified);
    return Promise.reject(new TypeError('offline'));
  });
  const hook = await mountHook(() => useShelfData());
  try {
    assert.equal(hook.current.shelfItems[0]?.id, 3);
    await act(async () => { await hook.current.loadShelf({ background: true, allowCached: false }); });
    assert.equal(conditionalHeader, '"library-3"');
    assert.equal(bodyRead.mock.callCount(), 0);
    await act(async () => { await hook.current.loadShelf({ background: true, allowCached: false }); });
    assert.equal(hook.current.shelfItems[0]?.id, 3);
    assert.equal(hook.current.shelfError, '');
    assert.equal(hook.current.isLoading, false);
  } finally { await hook.close(); }
});

test('Folder opens immediately from snapshot books and ignores refresh after another Folder opens', async (t) => {
  const refresh = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const fetchMock = t.mock.method(globalThis, 'fetch', (_url: unknown, options?: RequestInit) => {
    signal = options?.signal;
    return refresh.promise;
  });
  const folder = (id: number): Folder => ({
    id, name: `Folder ${id}`, sortOrder: 0, bookCount: 1, previewBooks: [book(id)],
    createdAt: '2026-09-21', updatedAt: '2026-09-21',
  });
  const hook = await mountHook(() => useFolderState());
  try {
    await act(async () => { hook.current.handleOpenFolder(folder(1), { books: [book(1)] }); });
    assert.equal(fetchMock.mock.callCount(), 0, 'opening does not wait for a folder endpoint');
    assert.equal(hook.current.folderBooks[0]?.key, 'folder-book:1');
    assert.equal(hook.current.isFolderLoading, false);
    let pending: Promise<void> | undefined;
    await act(async () => { pending = hook.current.refreshOpenFolderBooksOrClose(); });
    await act(async () => { hook.current.handleOpenFolder(folder(2), { books: [book(2)] }); });
    assert.equal(signal?.aborted, true);
    await act(async () => { refresh.reject(new Error('late failure')); await pending; });
    assert.equal(hook.current.openFolder?.id, 2, 'failed stale request cannot close the new Folder');
    assert.equal(hook.current.folderBooks[0]?.id, 2);
  } finally { await hook.close(); }
});

test('dragging a Folder book onto the shelf then cancelling restores both collections', async (t) => {
  const folderBooks: FolderBook[] = [1, 2].map(id => ({ ...book(id), key: `folder-book:${id}` }));
  const folder: Folder = {
    id: 10, name: 'Folder', sortOrder: 0, bookCount: 2, previewBooks: folderBooks,
    createdAt: '2026-09-21', updatedAt: '2026-09-21',
  };
  const shelfItems: ShelfItem[] = [
    { type: 'folder', id: 10, key: 'folder:10', folder },
    { type: 'book', id: 3, key: 'book:3', book: book(3) },
  ];
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('cancel must not persist'); });
  const hook = await mountHook(() => {
    const [items, setShelfItems] = useState(shelfItems);
    const [books, setFolderBooks] = useState(folderBooks);
    const [openFolder, setOpenFolder] = useState<Folder | null>(folder);
    const drag = useLibraryDrag({
      folderBooks: books, folderCloseVersion: 0, isSavingFolderOrder: false, isSavingOrder: false,
      loadShelf() {}, openFolder, setError() {}, setFolderBooks, setFolderError() {},
      setIsFolderLoading() {}, setIsRenamingFolder() {}, setIsSavingFolderOrder() {},
      setIsSavingOrder() {}, setOpenFolder, setShelfItems, shelfItems: items,
    });
    return { drag, items, books, openFolder };
  });
  try {
    const panel = document.createElement('div');
    panel.className = 'folder-panel';
    panel.getBoundingClientRect = () => new window.DOMRect(0, 0, 200, 200);
    document.body.append(panel);
    const event: DragMoveEvent = {
      activatorEvent: new window.Event('pointerdown'), collisions: null, delta: { x: 500, y: 0 }, over: null,
      active: {
        id: 'folder-book:1', data: { current: { type: 'folder-book', book: folderBooks[0] } },
        rect: { current: { initial: new window.DOMRect(0, 0, 100, 100), translated: null } },
      },
    };
    await act(async () => { hook.current.drag.handleDragStart(event); });
    assert.equal(hook.current.drag.activeDragPreview?.type, 'folder-book');
    await act(async () => { hook.current.drag.handleDragMove(event); });
    assert.equal(hook.current.openFolder, null);
    assert.deepEqual(hook.current.items.map(item => item.key), ['folder:10', 'folder-book:1', 'book:3']);
    const previewFolder = hook.current.items[0];
    assert.ok(previewFolder?.type === 'folder');
    assert.equal(previewFolder.folder.bookCount, 1);
    assert.deepEqual(previewFolder.folder.previewBooks.map(item => item.id), [2]);
    await act(async () => { hook.current.drag.handleDragMove({ ...event, delta: { x: 600, y: 0 } }); });
    assert.equal(hook.current.drag.fixedDragPreviewPoint?.x, 650, 'drag remains typed after Folder closes');
    await act(async () => { hook.current.drag.handleDragCancel(event); });
    assert.equal(hook.current.items, shelfItems);
    assert.equal(hook.current.books, folderBooks);
    assert.equal(hook.current.openFolder, folder);
    assert.equal(hook.current.drag.activeDragPreview, null);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { await hook.close(); }
});

test('warm cache renders before a pending network response and corrupt cache falls back to network', async (t) => {
  let cached: unknown = { etag: '"library-7"', snapshot: snapshot(7) };
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  // Only model the IndexedDB events used by the cache, without claiming this is
  // a complete IDBDatabase. Installation is the browser boundary of this test.
  const database = {
    transaction() {
      const transaction: { oncomplete?: () => void; objectStore: () => object } = {
        objectStore: () => ({
          get() {
            const request: { result: unknown; onsuccess?: () => void } = { result: cached };
            queueMicrotask(() => { request.onsuccess?.(); transaction.oncomplete?.(); });
            return request;
          },
          put(value: unknown) {
            cached = value;
            const request: { result: string; onsuccess?: () => void } = { result: 'latest' };
            queueMicrotask(() => { request.onsuccess?.(); transaction.oncomplete?.(); });
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      const request: { result: typeof database; onsuccess?: () => void } = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  } });
  t.after(() => {
    if (previousIndexedDB) Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  const network = deferred<Response>();
  let etag: string | null = null;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, options?: RequestInit) => {
    requests += 1;
    etag = new Headers(options?.headers).get('If-None-Match');
    return requests === 1 ? network.promise : Promise.resolve(response(9));
  });
  const warm = await mountHook(() => useShelfData());
  try {
    assert.equal(warm.current.shelfItems[0]?.id, 7);
    assert.equal(warm.current.isLoading, false, 'cached books are usable while network is pending');
    assert.equal(etag, '"library-7"');
    await act(async () => { network.resolve(response(8)); await network.promise; });
    assert.equal(warm.current.shelfItems[0]?.id, 8);
  } finally { await warm.close(); }
  cached = { etag: '"bad"', snapshot: { schemaVersion: 999 } };
  const corrupt = await mountHook(() => useShelfData());
  try {
    assert.equal(corrupt.current.shelfItems[0]?.id, 9);
    assert.equal(corrupt.current.shelfError, '');
    assert.equal(etag, null, 'invalid cache must not supply a conditional request validator');
  } finally { await corrupt.close(); }
});

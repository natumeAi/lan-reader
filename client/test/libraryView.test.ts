import { decodeSnapshotBook } from '../src/api/decoders.js';
import type { ShelfItem } from '../src/types/library.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { useLibraryView } from '../src/hooks/useLibraryView.js';
import {
  deriveVisibleLibraryItems,
  LIBRARY_SORT,
  LIBRARY_VIEW,
  sortLibraryItems,
} from '../src/utils/libraryView.js';
import {
  LIBRARY_SORT_PREFERENCES_STORAGE_KEY,
  loadLibrarySortPreferences,
  rememberLibrarySortPreference,
} from '../src/utils/libraryViewPreferences.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(initialValues: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialValues));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

function itemKeys(items: { type: string; id: number }[]) {
  return items.map((item) => `${item.type}:${item.id}`);
}

test('title sort groups Folders before Books and sorts each group naturally', () => {
  const items: ShelfItem[] = [
    { type: 'book', id: 1, key: 'book:1', book: decodeSnapshotBook({ id: 1, title: 'A Book' }) },
    { type: 'folder', id: 2, key: 'folder:2', folder: { id: 2, name: 'Shelf 10', sortOrder: 0, bookCount: 0, previewBooks: [], createdAt: '', updatedAt: '' } },
    { type: 'book', id: 4, key: 'book:4', book: decodeSnapshotBook({ id: 4, title: 'B Book' }) },
    { type: 'folder', id: 3, key: 'folder:3', folder: { id: 3, name: 'Shelf 2', sortOrder: 0, bookCount: 0, previewBooks: [], createdAt: '', updatedAt: '' } },
  ];

  assert.deepEqual(
    itemKeys(sortLibraryItems(items, { sort: LIBRARY_SORT.TITLE })),
    ['folder:3', 'folder:2', 'book:1', 'book:4'],
  );
});

test('title-sorted search results use the same Folder-first grouping', () => {
  const shelfItems: ShelfItem[] = [
    { type: 'folder', id: 8, key: 'folder:8', folder: { id: 8, name: 'Zulu match', sortOrder: 0, bookCount: 0, previewBooks: [], createdAt: '', updatedAt: '' } },
    { type: 'folder', id: 7, key: 'folder:7', folder: { id: 7, name: 'Alpha match', sortOrder: 0, bookCount: 0, previewBooks: [], createdAt: '', updatedAt: '' } },
  ];
  const catalogBooks = [
    { ...decodeSnapshotBook({ id: 1, title: 'Able match' }), folderName: null },
    { ...decodeSnapshotBook({ id: 2, title: 'Beta match' }), folderName: null },
  ];

  assert.deepEqual(
    itemKeys(deriveVisibleLibraryItems({
      shelfItems,
      catalogBooks,
      query: 'match',
      sort: LIBRARY_SORT.TITLE,
      view: LIBRARY_VIEW.ALL,
    })),
    ['folder:7', 'folder:8', 'book:1', 'book:2'],
  );
});

test('sort preferences use safe per-view defaults and persist independently', () => {
  const storage = memoryStorage({
    [LIBRARY_SORT_PREFERENCES_STORAGE_KEY]: JSON.stringify({
      [LIBRARY_VIEW.ALL]: LIBRARY_SORT.TITLE,
      [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.MANUAL,
    }),
  });

  const preferences = loadLibrarySortPreferences(storage);
  assert.deepEqual(preferences, {
    [LIBRARY_VIEW.ALL]: LIBRARY_SORT.TITLE,
    [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.RECENT_ADDED,
  });

  rememberLibrarySortPreference(
    preferences,
    LIBRARY_VIEW.RECENT_ADDED,
    LIBRARY_SORT.AUTHOR,
    storage,
  );

  assert.deepEqual(loadLibrarySortPreferences(storage), {
    [LIBRARY_VIEW.ALL]: LIBRARY_SORT.TITLE,
    [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.AUTHOR,
  });

  storage.setItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY, '{invalid json');
  assert.deepEqual(loadLibrarySortPreferences(storage), {
    [LIBRARY_VIEW.ALL]: LIBRARY_SORT.MANUAL,
    [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.RECENT_ADDED,
  });
});

test('the library hook remembers normal view sorts but restores transient search sorts', async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
  });
  const installGlobal = (name: string, value: unknown) => {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  installGlobal('window', dom.window);
  installGlobal('document', dom.window.document);
  installGlobal('Node', dom.window.Node);
  installGlobal('Element', dom.window.Element);
  installGlobal('HTMLElement', dom.window.HTMLElement);

  const { createRoot } = await import('react-dom/client');
  let currentView: ReturnType<typeof useLibraryView> | undefined;
  function libraryView() { assert.ok(currentView); return currentView; }
  const container = document.getElementById('root');
  assert.ok(container);
  let root = createRoot(container);

  function Harness() {
    currentView = useLibraryView({ shelfItems: [], catalogBooks: [] });
    return createElement('div');
  }

  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    assert.equal(libraryView().sort, LIBRARY_SORT.MANUAL);

    await act(async () => libraryView().focusSearch());
    assert.equal(libraryView().sort, LIBRARY_SORT.TITLE);
    assert.equal(
      window.localStorage.getItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY),
      null,
    );

    await act(async () => libraryView().selectSort(LIBRARY_SORT.AUTHOR));
    await act(async () => libraryView().cancelSearch());
    assert.equal(libraryView().sort, LIBRARY_SORT.MANUAL);
    assert.equal(
      window.localStorage.getItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY),
      null,
    );

    await act(async () => libraryView().selectSort(LIBRARY_SORT.TITLE));
    await act(async () => libraryView().selectView(LIBRARY_VIEW.RECENT_ADDED));
    assert.equal(libraryView().sort, LIBRARY_SORT.RECENT_ADDED);
    await act(async () => libraryView().selectSort(LIBRARY_SORT.AUTHOR));

    await act(async () => libraryView().selectView(LIBRARY_VIEW.ALL));
    assert.equal(libraryView().sort, LIBRARY_SORT.TITLE);
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY) ?? 'null'),
      {
        [LIBRARY_VIEW.ALL]: LIBRARY_SORT.TITLE,
        [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.AUTHOR,
      },
    );

    await act(async () => libraryView().focusSearch());
    await act(async () => libraryView().selectSort(LIBRARY_SORT.RECENT_READING));
    await act(async () => libraryView().cancelSearch());
    assert.equal(libraryView().sort, LIBRARY_SORT.TITLE);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
    assert.equal(libraryView().sort, LIBRARY_SORT.TITLE);
    await act(async () => libraryView().selectView(LIBRARY_VIEW.RECENT_ADDED));
    assert.equal(libraryView().sort, LIBRARY_SORT.AUTHOR);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, value] of previousGlobals) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, value);
    }
  }
});

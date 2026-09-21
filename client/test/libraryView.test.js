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

function memoryStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function itemKeys(items) {
  return items.map((item) => `${item.type}:${item.id}`);
}

test('title sort groups Folders before Books and sorts each group naturally', () => {
  const items = [
    { type: 'book', id: 1, book: { title: 'A Book' } },
    { type: 'folder', id: 2, folder: { name: 'Shelf 10' } },
    { type: 'book', id: 4, book: { title: 'B Book' } },
    { type: 'folder', id: 3, folder: { name: 'Shelf 2' } },
  ];

  assert.deepEqual(
    itemKeys(sortLibraryItems(items, { sort: LIBRARY_SORT.TITLE })),
    ['folder:3', 'folder:2', 'book:1', 'book:4'],
  );
});

test('title-sorted search results use the same Folder-first grouping', () => {
  const shelfItems = [
    { type: 'folder', id: 8, folder: { name: 'Zulu match' } },
    { type: 'folder', id: 7, folder: { name: 'Alpha match' } },
  ];
  const catalogBooks = [
    { id: 1, title: 'Able match' },
    { id: 2, title: 'Beta match' },
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

  let preferences = loadLibrarySortPreferences(storage);
  assert.deepEqual(preferences, {
    [LIBRARY_VIEW.ALL]: LIBRARY_SORT.TITLE,
    [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.RECENT_ADDED,
  });

  preferences = rememberLibrarySortPreference(
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

  const { createRoot } = await import('react-dom/client');
  let libraryView;
  let root = createRoot(document.getElementById('root'));

  function Harness() {
    libraryView = useLibraryView({ shelfItems: [], catalogBooks: [] });
    return createElement('div');
  }

  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    assert.equal(libraryView.sort, LIBRARY_SORT.MANUAL);

    await act(async () => libraryView.focusSearch());
    assert.equal(libraryView.sort, LIBRARY_SORT.TITLE);
    assert.equal(
      window.localStorage.getItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY),
      null,
    );

    await act(async () => libraryView.selectSort(LIBRARY_SORT.AUTHOR));
    await act(async () => libraryView.cancelSearch());
    assert.equal(libraryView.sort, LIBRARY_SORT.MANUAL);
    assert.equal(
      window.localStorage.getItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY),
      null,
    );

    await act(async () => libraryView.selectSort(LIBRARY_SORT.TITLE));
    await act(async () => libraryView.selectView(LIBRARY_VIEW.RECENT_ADDED));
    assert.equal(libraryView.sort, LIBRARY_SORT.RECENT_ADDED);
    await act(async () => libraryView.selectSort(LIBRARY_SORT.AUTHOR));

    await act(async () => libraryView.selectView(LIBRARY_VIEW.ALL));
    assert.equal(libraryView.sort, LIBRARY_SORT.TITLE);
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem(LIBRARY_SORT_PREFERENCES_STORAGE_KEY)),
      {
        [LIBRARY_VIEW.ALL]: LIBRARY_SORT.TITLE,
        [LIBRARY_VIEW.RECENT_ADDED]: LIBRARY_SORT.AUTHOR,
      },
    );

    await act(async () => libraryView.focusSearch());
    await act(async () => libraryView.selectSort(LIBRARY_SORT.RECENT_READING));
    await act(async () => libraryView.cancelSearch());
    assert.equal(libraryView.sort, LIBRARY_SORT.TITLE);

    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(createElement(Harness)));
    assert.equal(libraryView.sort, LIBRARY_SORT.TITLE);
    await act(async () => libraryView.selectView(LIBRARY_VIEW.RECENT_ADDED));
    assert.equal(libraryView.sort, LIBRARY_SORT.AUTHOR);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, value] of previousGlobals) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

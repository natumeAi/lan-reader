export const LIBRARY_VIEW = Object.freeze({
  ALL: 'all',
  RECENT_ADDED: 'recent-added',
  FOLDERS: 'folders',
});

export const LIBRARY_SORT = Object.freeze({
  MANUAL: 'manual',
  RECENT_READING: 'recent-reading',
  RECENT_ADDED: 'recent-added',
  TITLE: 'title',
  AUTHOR: 'author',
});

const collator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

const automaticSortOptions = Object.freeze([
  { value: LIBRARY_SORT.RECENT_READING, label: '最近阅读' },
  { value: LIBRARY_SORT.RECENT_ADDED, label: '最近添加' },
  { value: LIBRARY_SORT.TITLE, label: '书名' },
  { value: LIBRARY_SORT.AUTHOR, label: '作者' },
]);

export function normalizeLibrarySearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

export function catalogBookToLibraryItem(book) {
  return {
    type: 'book',
    id: book.id,
    key: `book:${book.id}`,
    book,
    folderName: book.folderName ?? null,
  };
}

export function buildLibraryDataset({
  shelfItems = [],
  catalogBooks = [],
  query = '',
  view = LIBRARY_VIEW.ALL,
}) {
  const normalizedQuery = normalizeLibrarySearchText(query);

  if (normalizedQuery) {
    const matchingBooks = catalogBooks
      .filter((book) => [book.title, book.author].some((value) =>
        normalizeLibrarySearchText(value).includes(normalizedQuery),
      ))
      .map(catalogBookToLibraryItem);
    const matchingFolders = shelfItems.filter((item) =>
      item.type === 'folder' &&
      normalizeLibrarySearchText(item.folder?.name).includes(normalizedQuery),
    );
    return [...matchingBooks, ...matchingFolders];
  }

  if (view === LIBRARY_VIEW.RECENT_ADDED) {
    return catalogBooks.map(catalogBookToLibraryItem);
  }
  if (view === LIBRARY_VIEW.FOLDERS) {
    return shelfItems.filter((item) => item.type === 'folder');
  }
  return shelfItems;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildFolderStats(catalogBooks) {
  const stats = new Map();
  for (const book of catalogBooks) {
    if (book.folderId == null) continue;
    const current = stats.get(book.folderId) || {
      latestAdded: null,
      latestRead: null,
    };
    const added = parseTimestamp(book.createdAt);
    const read = parseTimestamp(book.readingUpdatedAt);
    if (added !== null && (current.latestAdded === null || added > current.latestAdded)) {
      current.latestAdded = added;
    }
    if (read !== null && (current.latestRead === null || read > current.latestRead)) {
      current.latestRead = read;
    }
    stats.set(book.folderId, current);
  }
  return stats;
}

function itemName(item) {
  return item.type === 'folder'
    ? item.folder?.name || ''
    : item.book?.title || '';
}

function compareNameAndId(first, second) {
  const byName = collator.compare(itemName(first), itemName(second));
  return byName || Number(first.id) - Number(second.id);
}

function compareNullableDescending(first, second) {
  if (first === null && second === null) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  return second - first;
}

function itemTimestamp(item, sort, folderStats, catalogBooksById) {
  if (item.type === 'folder') {
    const stats = folderStats.get(item.id);
    return sort === LIBRARY_SORT.RECENT_ADDED
      ? stats?.latestAdded ?? null
      : stats?.latestRead ?? null;
  }
  const book = catalogBooksById.get(item.id) || item.book;
  return parseTimestamp(sort === LIBRARY_SORT.RECENT_ADDED
    ? book?.createdAt
    : book?.readingUpdatedAt);
}

function authorGroup(item) {
  if (item.type === 'folder') return 2;
  return String(item.book?.author ?? '').trim() ? 0 : 1;
}

function titleGroup(item) {
  return item.type === 'folder' ? 0 : 1;
}

export function sortLibraryItems(
  items,
  { sort = LIBRARY_SORT.MANUAL, catalogBooks = [] } = {},
) {
  if (sort === LIBRARY_SORT.MANUAL) return items;

  const folderStats = buildFolderStats(catalogBooks);
  const catalogBooksById = new Map(catalogBooks.map((book) => [book.id, book]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((firstEntry, secondEntry) => {
      const first = firstEntry.item;
      const second = secondEntry.item;
      let result = 0;

      if (sort === LIBRARY_SORT.TITLE) {
        result = titleGroup(first) - titleGroup(second);
      } else if (sort === LIBRARY_SORT.RECENT_ADDED || sort === LIBRARY_SORT.RECENT_READING) {
        result = compareNullableDescending(
          itemTimestamp(first, sort, folderStats, catalogBooksById),
          itemTimestamp(second, sort, folderStats, catalogBooksById),
        );
      } else if (sort === LIBRARY_SORT.AUTHOR) {
        result = authorGroup(first) - authorGroup(second);
        if (!result) {
          result = collator.compare(
            String(first.book?.author ?? ''),
            String(second.book?.author ?? ''),
          );
        }
      }

      return result || compareNameAndId(first, second) || firstEntry.index - secondEntry.index;
    })
    .map(({ item }) => item);
}

export function deriveVisibleLibraryItems(options) {
  const items = buildLibraryDataset(options);
  const normalizedQuery = normalizeLibrarySearchText(options.query);
  const effectiveSort = normalizedQuery && options.sort === LIBRARY_SORT.MANUAL
    ? LIBRARY_SORT.TITLE
    : options.sort;
  return sortLibraryItems(items, {
    sort: effectiveSort,
    catalogBooks: options.catalogBooks,
  });
}

export function getLibrarySortOptions({ view, searchMode }) {
  if (searchMode) return automaticSortOptions;
  if (view === LIBRARY_VIEW.FOLDERS) return [];
  if (view === LIBRARY_VIEW.RECENT_ADDED) return automaticSortOptions;
  return [
    { value: LIBRARY_SORT.MANUAL, label: '手动顺序' },
    ...automaticSortOptions,
  ];
}

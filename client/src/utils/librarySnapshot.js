import {
  normalizeFolderBook,
  normalizeShelfItem,
} from './libraryItems.js';

export const LIBRARY_SNAPSHOT_SCHEMA_VERSION = 1;

function requireSnapshotArray(snapshot, property) {
  if (!Array.isArray(snapshot?.[property])) {
    throw new Error(`Library snapshot is missing ${property}`);
  }
  return snapshot[property];
}

export function hydrateLibrarySnapshot(snapshot, options = {}) {
  if (snapshot?.schemaVersion !== LIBRARY_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Library snapshot version is not supported');
  }

  const pendingProgressRecords = options.pendingProgressRecords || {};
  const books = requireSnapshotArray(snapshot, 'books').map((book) => {
    const pendingProgress = pendingProgressRecords[book.id];
    return pendingProgress
      ? { ...book, readingProgress: pendingProgress.progress }
      : book;
  });
  const folders = requireSnapshotArray(snapshot, 'folders');
  const shelf = requireSnapshotArray(snapshot, 'shelf');
  const recent = requireSnapshotArray(snapshot, 'recent');
  const booksById = new Map(books.map((book) => [book.id, book]));
  const folderRecordsById = new Map(folders.map((folder) => [folder.id, folder]));
  const folderBooksByFolderId = new Map();
  const hydratedFoldersById = new Map();

  for (const folder of folders) {
    const folderBooks = (folder.bookIds || [])
      .map((bookId) => booksById.get(bookId))
      .filter(Boolean)
      .map(normalizeFolderBook);
    const previewBooks = (folder.previewBookIds || [])
      .map((bookId) => booksById.get(bookId))
      .filter(Boolean);

    folderBooksByFolderId.set(folder.id, folderBooks);
    hydratedFoldersById.set(folder.id, {
      ...folder,
      previewBooks,
    });
  }

  const catalogBooks = books.map((book) => ({
    ...book,
    folderName: book.folderId == null
      ? null
      : folderRecordsById.get(book.folderId)?.name ?? null,
  }));
  const shelfItems = shelf
    .map((item) => {
      if (item.type === 'book') {
        const book = booksById.get(item.id);
        return book
          ? normalizeShelfItem({
              ...item,
              book,
            })
          : null;
      }

      if (item.type === 'folder') {
        const folder = hydratedFoldersById.get(item.id);
        return folder
          ? normalizeShelfItem({
              ...item,
              folder,
            })
          : null;
      }

      return null;
    })
    .filter(Boolean);
  const recentReadingItems = recent
    .map((entry) => {
      const book = booksById.get(entry.bookId);
      return book
        ? {
            book,
            progress: entry.progress,
          }
        : null;
    })
    .filter(Boolean);

  return {
    catalogData: {
      books: catalogBooks,
    },
    folderBooksByFolderId,
    recentData: {
      items: recentReadingItems,
    },
    shelfData: {
      items: shelfItems,
    },
  };
}

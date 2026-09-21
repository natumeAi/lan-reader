import { decodeLibrarySnapshot } from '../api/decoders.js';
import type { LibrarySnapshot } from '@lan-reader/shared';
import type { HydratedLibrarySnapshot, FolderBook, Folder, ShelfItem } from '../types/library.js';
function isPresent<T>(value: T | null | undefined): value is T { return value != null; }
import {
  normalizeFolderBook,
  normalizeShelfItem,
} from './libraryItems.js';

export { LIBRARY_SNAPSHOT_SCHEMA_VERSION } from '@lan-reader/shared';


interface HydrationOptions {
  pendingProgressRecords?: Record<number, { bookId?: number; progress: number }>;
}

/** Compatibility entry for callers receiving an untrusted snapshot. */
export function hydrateLibrarySnapshot(value: unknown, options: HydrationOptions = {}): HydratedLibrarySnapshot {
  return hydrateDecodedLibrarySnapshot(decodeLibrarySnapshot(value), options);
}

/** Network and cache owners have already decoded the snapshot before state uses it. */
export function hydrateDecodedLibrarySnapshot(snapshot: LibrarySnapshot, options: HydrationOptions = {}): HydratedLibrarySnapshot {
  const pendingProgressRecords = options.pendingProgressRecords || {};
  const books = snapshot.books.map((book) => {
    const pendingProgress = pendingProgressRecords[book.id];
    return pendingProgress
      ? { ...book, readingProgress: pendingProgress.progress }
      : book;
  });
  const folders = snapshot.folders;
  const shelf = snapshot.shelf;
  const recent = snapshot.recent;
  const booksById = new Map(books.map((book) => [book.id, book]));
  const folderRecordsById = new Map(folders.map((folder) => [folder.id, folder]));
  const folderBooksByFolderId = new Map<number, FolderBook[]>();
  const hydratedFoldersById = new Map<number, Folder>();

  for (const folder of folders) {
    const folderBooks = (folder.bookIds || [])
      .map((bookId) => booksById.get(bookId))
      .filter(isPresent)
      .map(normalizeFolderBook);
    const previewBooks = (folder.previewBookIds || [])
      .map((bookId) => booksById.get(bookId))
      .filter(isPresent);

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
    .map((item): ShelfItem | null => {
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
    .filter(isPresent);
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
    .filter(isPresent);

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

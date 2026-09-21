/**
 * The library snapshot (ADR-0003): one normalized payload for the whole startup
 * view, built inside a single transaction so books, folders, shelf and recent
 * entries all describe the same library revision.
 */
import type {
  LibrarySnapshot,
  ShelfItemRef,
  SnapshotBookDto,
  SnapshotFolderDto,
  SnapshotRecentEntry,
} from '@lan-reader/shared';
import { LIBRARY_SNAPSHOT_SCHEMA_VERSION } from '@lan-reader/shared';
import { requireQueryResult } from '../db/queryResult.js';
import type { DatabaseHandle, FolderRow, RevisionRow, SnapshotBookRow } from '../db/rows.js';
import { formatBook } from './bookLibrary.js';
import { listRecentReadingEntries } from './readingLibrary.js';

// The version lives in `@lan-reader/shared` so a cached client snapshot and a
// served one cannot disagree; it is re-exported because
// `server/test/sharedContracts.test.ts` asserts the two values against each
// other through this module.
export { LIBRARY_SNAPSHOT_SCHEMA_VERSION };

export function getLibraryRevision(db: DatabaseHandle): number {
  const row = db
    .prepare<[], RevisionRow>('SELECT revision FROM library_revision WHERE id = 1')
    .get();

  return requireQueryResult(row, 'library revision').revision;
}

export function librarySnapshotEtag(revision: number): string {
  return `"library-${revision}"`;
}

function formatSnapshotBook(row: SnapshotBookRow): SnapshotBookDto {
  const book = formatBook(row);

  return {
    id: book.id,
    folderId: book.folderId,
    title: book.title,
    author: book.author,
    identifier: book.identifier,
    fileName: book.fileName,
    fileSize: book.fileSize,
    coverPath: book.coverPath,
    coverUrl: book.coverUrl,
    coverThumbnailUrl: book.coverThumbnailUrl,
    coverThumbnail2xUrl: book.coverThumbnail2xUrl,
    coverThumbnailVersion: book.coverThumbnailVersion,
    sortOrder: book.sortOrder,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    readingProgress: row.reading_progress ?? null,
    readingUpdatedAt: row.reading_updated_at ?? null,
  };
}

// Same rule as `listShelfItems`: sort order, then kind, then id.
function compareShelfItems(first: ShelfItemRef, second: ShelfItemRef): number {
  if (first.sortOrder !== second.sortOrder) {
    return first.sortOrder - second.sortOrder;
  }
  if (first.type !== second.type) {
    return first.type.localeCompare(second.type);
  }
  return first.id - second.id;
}

export function buildLibrarySnapshot(db: DatabaseHandle): LibrarySnapshot {
  return db.transaction((): LibrarySnapshot => {
    const revision = getLibraryRevision(db);
    const bookRows = db.prepare<[], SnapshotBookRow>(`
      SELECT b.*,
             rp.progress AS reading_progress,
             rp.updated_at AS reading_updated_at
      FROM books b
      LEFT JOIN reading_progress rp ON rp.book_id = b.id
      ORDER BY b.id ASC
    `).all();
    const books = bookRows.map(formatSnapshotBook);
    const booksByFolderId = new Map<number, SnapshotBookDto[]>();

    for (const book of books) {
      if (book.folderId == null) continue;
      const folderBooks = booksByFolderId.get(book.folderId) || [];
      folderBooks.push(book);
      booksByFolderId.set(book.folderId, folderBooks);
    }

    for (const folderBooks of booksByFolderId.values()) {
      folderBooks.sort((first, second) =>
        first.sortOrder - second.sortOrder || first.id - second.id);
    }

    const folderRows = db.prepare<[], FolderRow>(`
      SELECT *
      FROM folders
      ORDER BY sort_order ASC, id ASC
    `).all();
    const folders = folderRows.map((row): SnapshotFolderDto => {
      const folderBooks = booksByFolderId.get(row.id) || [];
      const bookIds = folderBooks.map((book) => book.id);

      return {
        id: row.id,
        name: row.name,
        sortOrder: row.sort_order,
        bookCount: bookIds.length,
        bookIds,
        previewBookIds: bookIds.slice(0, 4),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    const shelf = [
      ...books
        .filter((book) => book.folderId == null)
        .map((book): ShelfItemRef => ({
          type: 'book',
          id: book.id,
          sortOrder: book.sortOrder,
        })),
      ...folders.map((folder): ShelfItemRef => ({
        type: 'folder',
        id: folder.id,
        sortOrder: folder.sortOrder,
      })),
    ].sort(compareShelfItems);
    const recent = listRecentReadingEntries(db).map((entry): SnapshotRecentEntry => ({
      bookId: entry.book.id,
      progress: entry.progress,
    }));

    return {
      schemaVersion: LIBRARY_SNAPSHOT_SCHEMA_VERSION,
      version: revision,
      books,
      folders,
      shelf,
      recent,
    };
  })();
}

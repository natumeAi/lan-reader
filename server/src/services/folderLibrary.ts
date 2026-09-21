/**
 * The Folder service and the Bookshelf arrangement.
 *
 * A Bookshelf position holds either a Book that is in no Folder, or a Folder;
 * `listShelfItems` is the single ordering of those two kinds, and the snapshot
 * builder sorts by the same rule. Emptying a Folder deletes it.
 */
import type {
  BookDto,
  FolderDto,
  FolderMutationResponse,
  MoveFolderBookToShelfResponse,
  ShelfItemDto,
  ShelfOrderItem,
} from '@lan-reader/shared';
import { MAX_FOLDER_NAME_LENGTH } from '@lan-reader/shared';
import { requireQueryResult } from '../db/queryResult.js';
import type {
  BookRow,
  CountRow,
  DatabaseHandle,
  FolderCountRow,
  FolderPreviewRow,
} from '../db/rows.js';
import { badRequest, conflict, notFound } from '../http/httpError.js';
import { formatBook, listBooks } from './bookLibrary.js';

const defaultFolderName = '\u65b0\u5efa\u6587\u4ef6\u5939';

// The limit lives in `@lan-reader/shared` so the rename input and this check
// cannot drift; it is re-exported because `server/test/sharedContracts.test.ts`
// asserts the two values against each other through this module.
export { MAX_FOLDER_NAME_LENGTH };

export interface CreateFolderFromBooksOptions {
  sourceBookId: number;
  targetBookId: number;
  /** Straight from the request body, so anything at all. */
  name?: unknown;
}

export interface MoveFolderBookToShelfOptions {
  /** The Bookshelf order the client wants; the default inserts after the Folder. */
  items?: ShelfOrderItem[];
}

export function normalizeFolderName(name: unknown): string {
  if (typeof name !== 'string') return defaultFolderName;
  const normalizedName = name.trim() || defaultFolderName;

  if (normalizedName.length > MAX_FOLDER_NAME_LENGTH) {
    throw badRequest('Folder name must be 80 characters or fewer', 'INVALID_FOLDER_NAME');
  }

  return normalizedName;
}

function folderPreviewBooks(db: DatabaseHandle, folderId: number): BookDto[] {
  return db
    .prepare<[number], BookRow>(
      `SELECT *
       FROM books
       WHERE folder_id = ?
       ORDER BY sort_order ASC, id ASC
       LIMIT 4`,
    )
    .all(folderId)
    .map(formatBook);
}

export function formatFolder(row: FolderCountRow, previewBooks: BookDto[] = []): FolderDto {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    bookCount: row.book_count ?? 0,
    previewBooks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getFolder(db: DatabaseHandle, folderId: number): FolderDto | null {
  const row = db
    .prepare<[number], FolderCountRow>(
      `SELECT f.*,
              COUNT(b.id) AS book_count
       FROM folders f
       LEFT JOIN books b ON b.folder_id = f.id
       WHERE f.id = ?
       GROUP BY f.id`,
    )
    .get(folderId);

  return row ? formatFolder(row, folderPreviewBooks(db, row.id)) : null;
}

export function listFolders(db: DatabaseHandle): FolderDto[] {
  const folderRows = db.prepare<[], FolderCountRow>(`
    SELECT f.*,
           COUNT(b.id) AS book_count
    FROM folders f
    LEFT JOIN books b ON b.folder_id = f.id
    GROUP BY f.id
    ORDER BY f.sort_order ASC, f.id ASC
  `).all();

  const previewRows = db.prepare<[], FolderPreviewRow>(`
    SELECT *
    FROM (
      SELECT b.*,
             ROW_NUMBER() OVER (
               PARTITION BY b.folder_id
               ORDER BY b.sort_order ASC, b.id ASC
             ) AS preview_rank
      FROM books b
      WHERE b.folder_id IS NOT NULL
    ) ranked_books
    WHERE preview_rank <= 4
    ORDER BY folder_id ASC, sort_order ASC, id ASC
  `).all();

  // Keyed by the raw `folder_id`, which the row type still types as nullable
  // even though the query filters the nulls out.
  const previewsByFolderId = new Map<number | null, BookDto[]>();
  for (const row of previewRows) {
    const previews = previewsByFolderId.get(row.folder_id) || [];
    previews.push(formatBook(row));
    previewsByFolderId.set(row.folder_id, previews);
  }

  return folderRows.map((row) => formatFolder(
    row,
    previewsByFolderId.get(row.id) || [],
  ));
}

export function listShelfItems(db: DatabaseHandle): ShelfItemDto[] {
  const bookItems = listBooks(db).map((book): ShelfItemDto => ({
    type: 'book',
    id: book.id,
    sortOrder: book.sortOrder,
    book,
  }));

  const folderItems = listFolders(db).map((folder): ShelfItemDto => ({
    type: 'folder',
    id: folder.id,
    sortOrder: folder.sortOrder,
    folder,
  }));

  return [...bookItems, ...folderItems].sort((firstItem, secondItem) => {
    if (firstItem.sortOrder !== secondItem.sortOrder) {
      return firstItem.sortOrder - secondItem.sortOrder;
    }

    if (firstItem.type !== secondItem.type) {
      return firstItem.type.localeCompare(secondItem.type);
    }

    return firstItem.id - secondItem.id;
  });
}

export function createFolderFromBooks(
  db: DatabaseHandle,
  options: CreateFolderFromBooksOptions,
): FolderMutationResponse {
  const sourceBookId = options.sourceBookId;
  const targetBookId = options.targetBookId;

  if (sourceBookId === targetBookId) {
    throw badRequest('sourceBookId and targetBookId must be different');
  }

  return db.transaction((): FolderMutationResponse => {
    const sourceBook = db
      .prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?')
      .get(sourceBookId);
    const targetBook = db
      .prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?')
      .get(targetBookId);

    if (!sourceBook || !targetBook) {
      throw notFound('Book not found');
    }

    if (sourceBook.folder_id !== null || targetBook.folder_id !== null) {
      throw conflict('Folder creation requires two root shelf books');
    }

    const folderResult = db
      .prepare<[string, number]>(
        `INSERT INTO folders (name, sort_order)
         VALUES (?, ?)`,
      )
      .run(normalizeFolderName(options.name), targetBook.sort_order);

    // `lastInsertRowid` is typed `number | bigint`; this connection never turns
    // on safe integers, so SQLite always hands back a number here.
    const folderId = Number(folderResult.lastInsertRowid);
    const moveBookIntoFolder = db.prepare<[number, number, number]>(
      `UPDATE books
       SET folder_id = ?,
           sort_order = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );

    moveBookIntoFolder.run(folderId, 1000, sourceBookId);
    moveBookIntoFolder.run(folderId, 2000, targetBookId);

    return {
      folder: requireQueryResult(getFolder(db, folderId), 'created folder'),
      books: listBooks(db, { folderId }),
      shelfItems: listShelfItems(db),
    };
  })();
}

export function renameFolder(
  db: DatabaseHandle,
  folderId: number,
  name: unknown,
): FolderDto | null {
  const normalizedName = normalizeFolderName(name);
  const result = db
    .prepare<[string, number]>(
      `UPDATE folders
       SET name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(normalizedName, folderId);

  return result.changes ? getFolder(db, folderId) : null;
}

export function moveShelfBookToFolder(
  db: DatabaseHandle,
  folderId: number,
  bookId: number,
): FolderMutationResponse {
  return db.transaction((): FolderMutationResponse => {
    const folder = getFolder(db, folderId);

    if (!folder) {
      throw notFound('Folder not found');
    }

    const book = db.prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?').get(bookId);

    if (!book) {
      throw notFound('Book not found');
    }

    if (book.folder_id !== null) {
      throw conflict('Only root shelf books can move into folders');
    }

    const nextSortOrderRow = db
      .prepare<[number], CountRow>(
        `SELECT COALESCE(MAX(sort_order), 0) + 1000 AS value
         FROM books
         WHERE folder_id = ?`,
      )
      .get(folderId);
    const nextSortOrder = requireQueryResult(nextSortOrderRow, 'next folder sort order').value;

    db.prepare<[number, number, number]>(
      `UPDATE books
       SET folder_id = ?,
           sort_order = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND folder_id IS NULL`,
    ).run(folderId, nextSortOrder, bookId);

    return {
      folder: requireQueryResult(getFolder(db, folderId), 'folder'),
      books: listBooks(db, { folderId }),
      shelfItems: listShelfItems(db),
    };
  })();
}

export function updateFolderBookOrder(
  db: DatabaseHandle,
  folderId: number,
  bookIds: number[],
): BookDto[] {
  const folder = getFolder(db, folderId);

  if (!folder) {
    throw notFound('Folder not found');
  }

  const currentBookIds = db
    .prepare<[number], Pick<BookRow, 'id'>>(
      `SELECT id
       FROM books
       WHERE folder_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .all(folderId)
    .map((book) => book.id);

  const requestedBookIds = new Set(bookIds);
  const hasCurrentFolderBooks =
    currentBookIds.length === requestedBookIds.size &&
    currentBookIds.every((bookId) => requestedBookIds.has(bookId));

  if (!hasCurrentFolderBooks) {
    throw conflict('Folder book order is out of date');
  }

  const updateBookOrder = db.prepare<[number, number, number]>(
    `UPDATE books
     SET sort_order = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND folder_id = ?`,
  );

  db.transaction(() => {
    bookIds.forEach((bookId, index) => {
      updateBookOrder.run((index + 1) * 1000, bookId, folderId);
    });
  })();

  return listBooks(db, { folderId });
}

export function moveFolderBookToShelf(
  db: DatabaseHandle,
  folderId: number,
  bookId: number,
  options: MoveFolderBookToShelfOptions = {},
): MoveFolderBookToShelfResponse {
  return db.transaction((): MoveFolderBookToShelfResponse => {
    const folder = getFolder(db, folderId);

    if (!folder) {
      throw notFound('Folder not found');
    }

    const book = db.prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?').get(bookId);

    if (!book) {
      throw notFound('Book not found');
    }

    if (book.folder_id !== folderId) {
      throw conflict('Book is not in this folder');
    }

    const currentShelfItems = listShelfItems(db);
    const folderIndex = currentShelfItems.findIndex((item) => item.type === 'folder' && item.id === folderId);

    if (folderIndex < 0) {
      throw conflict('Folder is not on the shelf');
    }

    const shelfItemsWithBook: ShelfOrderItem[] =
      options.items ||
      [
        ...currentShelfItems.slice(0, folderIndex + 1),
        { type: 'book', id: bookId },
        ...currentShelfItems.slice(folderIndex + 1),
      ];

    db.prepare<[number, number]>(
      `UPDATE books
       SET folder_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND folder_id = ?`,
    ).run(bookId, folderId);

    const remainingBookCountRow = db
      .prepare<[number], CountRow>('SELECT COUNT(*) AS value FROM books WHERE folder_id = ?')
      .get(folderId);
    const remainingBookCount = requireQueryResult(remainingBookCountRow, 'folder book count').value;

    if (remainingBookCount === 0) {
      db.prepare<[number]>('DELETE FROM folders WHERE id = ?').run(folderId);
    }

    const orderedShelfItems = remainingBookCount === 0
      ? shelfItemsWithBook.filter((item) => item.type !== 'folder' || item.id !== folderId)
      : shelfItemsWithBook;
    const currentItemKeys = currentShelfItems
      .filter((item) => remainingBookCount > 0 || item.type !== 'folder' || item.id !== folderId)
      .map((item) => `${item.type}:${item.id}`);
    const expectedItemKeys = new Set([...currentItemKeys, `book:${bookId}`]);
    const orderedItemKeys = orderedShelfItems.map((item) => `${item.type}:${item.id}`);
    const hasExpectedShelf =
      expectedItemKeys.size === orderedItemKeys.length &&
      orderedItemKeys.every((itemKey) => expectedItemKeys.has(itemKey));

    if (!hasExpectedShelf) {
      throw conflict('Shelf order is out of date');
    }

    const updateBookOrder = db.prepare<[number, number]>(
      `UPDATE books
       SET sort_order = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND folder_id IS NULL`,
    );
    const updateFolderOrder = db.prepare<[number, number]>(
      `UPDATE folders
       SET sort_order = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );

    orderedShelfItems.forEach((item, index) => {
      const sortOrder = (index + 1) * 1000;

      if (item.type === 'book') {
        updateBookOrder.run(sortOrder, item.id);
        return;
      }

      updateFolderOrder.run(sortOrder, item.id);
    });

    const movedBook = db.prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?').get(bookId);

    return {
      book: formatBook(requireQueryResult(movedBook, 'moved book')),
      folder: remainingBookCount === 0 ? null : getFolder(db, folderId),
      books: remainingBookCount === 0 ? [] : listBooks(db, { folderId }),
      shelfItems: listShelfItems(db),
      removedFolderId: remainingBookCount === 0 ? folderId : null,
    };
  })();
}

export function updateShelfItemOrder(
  db: DatabaseHandle,
  items: ShelfOrderItem[],
): ShelfItemDto[] {
  const currentItemKeys = listShelfItems(db).map((item) => `${item.type}:${item.id}`);
  const requestedItemKeys = new Set(items.map((item) => `${item.type}:${item.id}`));
  const hasCurrentShelf =
    currentItemKeys.length === requestedItemKeys.size &&
    currentItemKeys.every((itemKey) => requestedItemKeys.has(itemKey));

  if (!hasCurrentShelf) {
    throw conflict('Shelf order is out of date');
  }

  const updateBookOrder = db.prepare<[number, number]>(
    `UPDATE books
     SET sort_order = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND folder_id IS NULL`,
  );
  const updateFolderOrder = db.prepare<[number, number]>(
    `UPDATE folders
     SET sort_order = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );

  db.transaction(() => {
    items.forEach((item, index) => {
      const sortOrder = (index + 1) * 1000;

      if (item.type === 'book') {
        updateBookOrder.run(sortOrder, item.id);
        return;
      }

      updateFolderOrder.run(sortOrder, item.id);
    });
  })();

  return listShelfItems(db);
}

/**
 * The Book service: the Catalog of every Book, the Bookshelf order, and the
 * synchronisation between the books directory and the database.
 *
 * Rows enter here as snake_case `BookRow`s and leave as the camelCase DTOs of
 * `@lan-reader/shared`. `addBookFileToLibrary` is the one exception: the
 * pre-migration code handed its row straight to `POST /api/books`, so it still
 * returns a row and the return type says so.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { BookDto, CatalogBookDto } from '@lan-reader/shared';
import { requireQueryResult } from '../db/queryResult.js';
import type { BookRow, CatalogBookRow, CountRow, DatabaseHandle } from '../db/rows.js';
import { conflict, internalError } from '../http/httpError.js';
import {
  booksDir,
  ensureBookDirectory,
  isEpubFileName,
  titleFromFileName,
  toAbsoluteStoragePath,
  toStoredPath,
} from './fileStorage.js';
import { deleteBookCoverFiles, saveBookCoverAssets } from './coverStorage.js';
import type { EpubDetails } from './epubService.js';
import { parseEpubDetails } from './epubService.js';
import type { EpubValidationLimitOptions } from './epubValidation.js';
import { InvalidEpubError, validateEpubArchive } from './epubValidation.js';

const booksStoragePrefix = 'data/books/';
const coversStoragePrefix = 'data/covers/';

/** Replaces the EPUB parser, so a sync can be driven without real files. */
export type ParseEpubDetails = (filePath: string) => Promise<EpubDetails>;

export interface ListBooksOptions {
  /** Absent lists the Bookshelf; present lists that one Folder. */
  folderId?: number;
}

export interface InspectEpubFileOptions {
  archiveValidated?: boolean;
  validationLimits?: EpubValidationLimitOptions;
  epubDetails?: EpubDetails;
  parseDetails?: ParseEpubDetails;
}

export interface AddBookFileOptions extends InspectEpubFileOptions {
  fileName?: string;
  title?: string;
  forceRefresh?: boolean;
}

export interface SyncBookDirectoryOptions {
  parseDetails?: ParseEpubDetails;
}

/** Named parameters of the Book `UPDATE`, one per `@name` placeholder. */
interface UpdateBookParams {
  id: number;
  title: string;
  author: string | null;
  description: string | null;
  publisher: string | null;
  language: string | null;
  identifier: string | null;
  fileName: string;
  fileSize: number;
  fileMtimeMs: number;
  coverPath: string;
  coverThumbnailSmallPath: string;
  coverThumbnailLargePath: string;
  coverThumbnailVersion: string;
}

/** Named parameters of the Book `INSERT`, one per `@name` placeholder. */
interface InsertBookParams extends Omit<UpdateBookParams, 'id'> {
  filePath: string;
  sortOrder: number;
}

function nextShelfSortOrder(db: DatabaseHandle): number {
  const row = db
    .prepare<[], CountRow>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1000 AS value
       FROM (
         SELECT sort_order FROM books WHERE folder_id IS NULL
         UNION ALL
         SELECT sort_order FROM folders
       )`,
    )
    .get();

  return requireQueryResult(row, 'next shelf sort order').value;
}

function storagePathToUrl(
  storedPath: string | null | undefined,
  storagePrefix: string,
  urlPrefix: string,
): string | null {
  if (!storedPath || !storedPath.startsWith(storagePrefix)) {
    return null;
  }

  return `${urlPrefix}/${storedPath.slice(storagePrefix.length).split('/').map(encodeURIComponent).join('/')}`;
}

function managedBookFilePath(storedPath: string): string {
  const bookFilePath = path.resolve(toAbsoluteStoragePath(storedPath));
  const bookRoot = path.resolve(booksDir);
  const relativePath = path.relative(bookRoot, bookFilePath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath) || !isEpubFileName(bookFilePath)) {
    throw internalError('Stored book file is not managed by the library');
  }

  return bookFilePath;
}

export function formatBook(row: BookRow): BookDto {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    author: row.author,
    description: row.description,
    publisher: row.publisher,
    language: row.language,
    identifier: row.identifier,
    fileName: row.file_name,
    fileSize: row.file_size,
    coverPath: row.cover_path,
    coverUrl: storagePathToUrl(row.cover_path, coversStoragePrefix, '/covers'),
    coverThumbnailSmallPath: row.cover_thumbnail_small_path ?? null,
    coverThumbnailLargePath: row.cover_thumbnail_large_path ?? null,
    coverThumbnailUrl: storagePathToUrl(
      row.cover_thumbnail_small_path,
      coversStoragePrefix,
      '/covers',
    ),
    coverThumbnail2xUrl: storagePathToUrl(
      row.cover_thumbnail_large_path,
      coversStoragePrefix,
      '/covers',
    ),
    coverThumbnailVersion: row.cover_thumbnail_version ?? null,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBooks(db: DatabaseHandle, options: ListBooksOptions = {}): BookDto[] {
  // `hasOwn`, not a truthiness test: the caller picks the Bookshelf or one
  // Folder by passing the key at all.
  const hasFolderId = Object.hasOwn(options, 'folderId');

  const rows = hasFolderId
    ? db
        .prepare<[number | undefined], BookRow>(
          `SELECT *
           FROM books
           WHERE folder_id = ?
           ORDER BY sort_order ASC, id ASC`,
        )
        .all(options.folderId)
    : db
        .prepare<[], BookRow>(
          `SELECT *
           FROM books
           WHERE folder_id IS NULL
           ORDER BY sort_order ASC, id ASC`,
        )
        .all();

  return rows.map(formatBook);
}

export function listCatalogBooks(db: DatabaseHandle): CatalogBookDto[] {
  const rows = db.prepare<[], CatalogBookRow>(`
    SELECT b.*,
           f.name AS folder_name,
           rp.progress AS reading_progress,
           rp.updated_at AS reading_updated_at
    FROM books b
    LEFT JOIN folders f ON f.id = b.folder_id
    LEFT JOIN reading_progress rp ON rp.book_id = b.id
    ORDER BY b.id ASC
  `).all();

  return rows.map((row) => ({
    ...formatBook(row),
    folderName: row.folder_name ?? null,
    readingProgress: row.reading_progress ?? null,
    readingUpdatedAt: row.reading_updated_at ?? null,
  }));
}

export function updateShelfBookOrder(db: DatabaseHandle, bookIds: number[]): BookDto[] {
  const currentBookIds = db
    .prepare<[], Pick<BookRow, 'id'>>(
      `SELECT id
       FROM books
       WHERE folder_id IS NULL
       ORDER BY sort_order ASC, id ASC`,
    )
    .all()
    .map((book) => book.id);

  const requestedBookIds = new Set(bookIds);
  const hasCurrentShelf =
    currentBookIds.length === requestedBookIds.size &&
    currentBookIds.every((bookId) => requestedBookIds.has(bookId));

  if (!hasCurrentShelf) {
    throw conflict('Book order is out of date');
  }

  const updateBookOrder = db.prepare<[number, number]>(
    `UPDATE books
     SET sort_order = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND folder_id IS NULL`,
  );

  db.transaction(() => {
    bookIds.forEach((bookId, index) => {
      updateBookOrder.run((index + 1) * 1000, bookId);
    });
  })();

  return listBooks(db);
}

export async function inspectEpubFile(
  filePath: string,
  options: InspectEpubFileOptions = {},
): Promise<EpubDetails> {
  if (!options.archiveValidated) validateEpubArchive(filePath, options.validationLimits);
  if (options.epubDetails) return options.epubDetails;

  try {
    return await (options.parseDetails || parseEpubDetails)(filePath);
  } catch (error) {
    throw new InvalidEpubError('EPUB_PARSE', { cause: error });
  }
}

/**
 * Imports or refreshes one EPUB file.
 *
 * Returns the stored `BookRow`, not a `BookDto`: `POST /api/books` serialises
 * this value straight into its 201 body, so the row shape is the response shape
 * and narrowing it here would change the API.
 */
export async function addBookFileToLibrary(
  db: DatabaseHandle,
  filePath: string,
  options: AddBookFileOptions = {},
): Promise<BookRow | null> {
  if (!isEpubFileName(filePath)) {
    return null;
  }

  let fileStat;

  try {
    fileStat = statSync(filePath);
  } catch {
    return null;
  }

  if (!fileStat.isFile()) {
    return null;
  }

  const fileName = options.fileName || path.basename(filePath);
  const storedPath = toStoredPath(filePath);
  const fallbackTitle = options.title ?? titleFromFileName(fileName);
  const existing = db
    .prepare<[string], BookRow>('SELECT * FROM books WHERE file_path = ?')
    .get(storedPath);
  const fileMtimeMs = Math.trunc(fileStat.mtimeMs);
  const fileIsUnchanged = Boolean(
    existing &&
    existing.file_size === fileStat.size &&
    existing.file_mtime_ms === fileMtimeMs,
  );

  if (fileIsUnchanged && !options.forceRefresh) {
    // `fileIsUnchanged` is only true when `existing` is set; the guard is what
    // tells the type checker so.
    return requireQueryResult(existing, 'unchanged book');
  }

  const epubDetails = await inspectEpubFile(filePath, options);
  const metadata = epubDetails.metadata;
  const coverImage = epubDetails.coverImage;
  const title = metadata.title || options.title || existing?.title || fallbackTitle;
  const author = metadata.author;
  const coverAssets = await saveBookCoverAssets({
    bookFilePath: filePath,
    coverImage,
    title,
    author,
  });
  const {
    coverPath,
    coverThumbnailSmallPath,
    coverThumbnailLargePath,
    coverThumbnailVersion,
  } = coverAssets;

  return db.transaction((): BookRow => {
    if (existing) {
      const displayFileName = options.fileName || existing.file_name;

      db.prepare<UpdateBookParams>(
        `UPDATE books
         SET title = @title,
             author = @author,
             description = @description,
             publisher = @publisher,
             language = @language,
             identifier = @identifier,
             file_name = @fileName,
             file_size = @fileSize,
             file_mtime_ms = @fileMtimeMs,
             cover_path = @coverPath,
             cover_thumbnail_small_path = @coverThumbnailSmallPath,
             cover_thumbnail_large_path = @coverThumbnailLargePath,
             cover_thumbnail_version = @coverThumbnailVersion,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`,
      ).run({
        id: existing.id,
        title,
        author: metadata.author,
        description: metadata.description,
        publisher: metadata.publisher,
        language: metadata.language,
        identifier: metadata.identifier,
        fileName: displayFileName,
        fileSize: fileStat.size,
        fileMtimeMs,
        coverPath,
        coverThumbnailSmallPath,
        coverThumbnailLargePath,
        coverThumbnailVersion,
      });

      const updatedBook = db
        .prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?')
        .get(existing.id);

      return requireQueryResult(updatedBook, 'updated book');
    }

    const result = db
      .prepare<InsertBookParams>(
        `INSERT INTO books (
           title,
           author,
           description,
           publisher,
           language,
           identifier,
           file_name,
           file_path,
           file_size,
           file_mtime_ms,
           cover_path,
           cover_thumbnail_small_path,
           cover_thumbnail_large_path,
           cover_thumbnail_version,
           sort_order
         )
         VALUES (
           @title,
           @author,
           @description,
           @publisher,
           @language,
           @identifier,
           @fileName,
           @filePath,
           @fileSize,
           @fileMtimeMs,
           @coverPath,
           @coverThumbnailSmallPath,
           @coverThumbnailLargePath,
           @coverThumbnailVersion,
           @sortOrder
         )`,
      )
      .run({
        title,
        author: metadata.author,
        description: metadata.description,
        publisher: metadata.publisher,
        language: metadata.language,
        identifier: metadata.identifier,
        fileName,
        filePath: storedPath,
        fileSize: fileStat.size,
        fileMtimeMs,
        coverPath,
        coverThumbnailSmallPath,
        coverThumbnailLargePath,
        coverThumbnailVersion,
        sortOrder: nextShelfSortOrder(db),
      });

    const insertedBook = db
      .prepare<[number | bigint], BookRow>('SELECT * FROM books WHERE id = ?')
      .get(result.lastInsertRowid);

    return requireQueryResult(insertedBook, 'inserted book');
  })();
}

export function removeBookFileFromLibrary(db: DatabaseHandle, filePath: string): number {
  const storedPath = toStoredPath(filePath);
  const book = db
    .prepare<[string], Pick<BookRow, 'folder_id'>>(
      `SELECT folder_id
       FROM books
       WHERE file_path = ?`,
    )
    .get(storedPath);
  const changes = db
    .prepare<[string]>('DELETE FROM books WHERE file_path = ?')
    .run(storedPath).changes;

  if (changes) {
    deleteBookCoverFiles(filePath);

    if (book?.folder_id) {
      db.prepare<[number]>(
        `DELETE FROM folders
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM books
             WHERE folder_id = folders.id
           )`,
      ).run(book.folder_id);
    }
  }

  return changes;
}

export function getBookById(db: DatabaseHandle, id: number): BookDto | null {
  const row = db.prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?').get(id);
  return row ? formatBook(row) : null;
}

export function getBookFilePath(db: DatabaseHandle, id: number): string | null {
  const row = db
    .prepare<[number], Pick<BookRow, 'file_path'>>('SELECT file_path FROM books WHERE id = ?')
    .get(id);
  if (!row) return null;
  return managedBookFilePath(row.file_path);
}

export function deleteBookById(db: DatabaseHandle, id: number): BookDto | null {
  const book = db.prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?').get(id);

  if (!book) {
    return null;
  }

  const bookFilePath = managedBookFilePath(book.file_path);

  if (existsSync(bookFilePath)) {
    unlinkSync(bookFilePath);
  }

  removeBookFileFromLibrary(db, bookFilePath);

  return formatBook(book);
}

function listEpubFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...listEpubFilesRecursive(filePath));
      continue;
    }

    if (entry.isFile() && isEpubFileName(entry.name)) {
      files.push(filePath);
    }
  }

  return files;
}

export async function syncBookDirectory(
  db: DatabaseHandle,
  options: SyncBookDirectoryOptions = {},
): Promise<void> {
  ensureBookDirectory();

  const currentBookPaths = new Set<string>();
  const filePaths = listEpubFilesRecursive(booksDir);

  for (const filePath of filePaths) {
    try {
      const book = await addBookFileToLibrary(db, filePath, {
        parseDetails: options.parseDetails,
      });
      if (book) currentBookPaths.add(toStoredPath(filePath));
    } catch (error) {
      if (!(error instanceof InvalidEpubError)) throw error;
      console.warn(`Skipped invalid EPUB file ${path.resolve(filePath)} [${error.code}]`);
      removeBookFileFromLibrary(db, filePath);
    }
  }

  const trackedBooks = db
    .prepare<[string], Pick<BookRow, 'id' | 'file_path' | 'cover_path'>>(
      'SELECT id, file_path, cover_path FROM books WHERE file_path LIKE ?',
    )
    .all(`${booksStoragePrefix}%`);

  for (const book of trackedBooks) {
    const absolutePath = toAbsoluteStoragePath(book.file_path);

    if (!currentBookPaths.has(book.file_path) && !existsSync(absolutePath)) {
      removeBookFileFromLibrary(db, absolutePath);
    }
  }
}

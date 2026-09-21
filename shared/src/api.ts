/**
 * HTTP response envelopes.
 *
 * Every entry mirrors a `res.json(...)` call in `server/src/routes/`. Envelope
 * property names are part of the compatibility surface and must not be renamed.
 */
import type { BookDto, CatalogBookDto } from './book.js';
import type { FolderDto } from './folder.js';
import type { ShelfItemDto } from './shelf.js';
import type { LibrarySnapshot } from './librarySnapshot.js';
import type { ReadingPositionDto, RecentReadingEntryDto } from './reading.js';

/** `GET /api/books`, `PATCH /api/books/order`. */
export interface BooksResponse {
  readonly books: BookDto[];
}

/**
 * `GET /api/books/catalog`.
 *
 * Same envelope property as `BooksResponse`, but each entry carries the three
 * extra Catalog fields, so a `BooksResponse` consumer keeps working unchanged.
 */
export interface CatalogBooksResponse {
  readonly books: CatalogBookDto[];
}

/** `GET /api/books/:id`, `POST /api/books` (201), `DELETE /api/books/:id`. */
export interface BookResponse {
  readonly book: BookDto;
}

/** `GET /api/folders`. */
export interface FoldersResponse {
  readonly folders: FolderDto[];
}

/** `GET /api/folders/:id`, `PATCH /api/folders/:id`. */
export interface FolderResponse {
  readonly folder: FolderDto;
}

/** `GET /api/folders/shelf`, `PATCH /api/folders/shelf/order`. */
export interface ShelfItemsResponse {
  readonly items: ShelfItemDto[];
}

/**
 * `POST /api/folders` (201) and `PATCH /api/folders/:id/import-book/:bookId`.
 * The Folder contents and the whole Bookshelf come back together so the client
 * never has to re-derive the new ordering.
 */
export interface FolderMutationResponse {
  readonly folder: FolderDto;
  readonly books: BookDto[];
  readonly shelfItems: ShelfItemDto[];
}

/**
 * `PATCH /api/folders/:id/books/:bookId/move-to-shelf`.
 *
 * Emptying a Folder deletes it: `folder` is then `null`, `books` is empty and
 * `removedFolderId` carries the deleted id.
 */
export interface MoveFolderBookToShelfResponse {
  readonly book: BookDto;
  readonly folder: FolderDto | null;
  readonly books: BookDto[];
  readonly shelfItems: ShelfItemDto[];
  readonly removedFolderId: number | null;
}

/** `GET /api/folders/:id/books`, `PATCH /api/folders/:id/books/order`. */
export interface FolderBooksResponse {
  readonly books: BookDto[];
}

/** `GET /api/library/snapshot` body. A 304 reply carries no body at all. */
export interface LibrarySnapshotResponse {
  readonly snapshot: LibrarySnapshot;
}

/** `GET /api/reading/:bookId`, `PUT /api/reading/:bookId`. */
export interface ReadingPositionResponse {
  /** `null` when the Book has never been opened. */
  readonly progress: ReadingPositionDto | null;
}

/** `GET /api/reading/recent`. */
export interface RecentReadingResponse {
  readonly items: RecentReadingEntryDto[];
}

/**
 * Error body produced by the server's error handler.
 *
 * `error` is the thrown message below 500 and the literal
 * `'Internal Server Error'` at 500. `code` is only present below 500 and only
 * when the thrown error carried one (for example `BOOK_NOT_FOUND`).
 */
export interface ApiErrorResponse {
  readonly error: string;
  readonly code?: string;
}

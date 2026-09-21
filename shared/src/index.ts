/**
 * Cross-process contracts shared by the client and the server.
 *
 * This package is browser-safe: it must never import Node builtins, database
 * drivers, React, or epub.js. Anything that only one side needs — SQLite row
 * shapes, React state, EPUB instances — stays in that side's workspace.
 */
export type {
  BookDto,
  CatalogBookDto,
  SnapshotBookDto,
  UploadedBookRecord,
} from './book.js';
export type { FolderDto, SnapshotFolderDto } from './folder.js';
export { MAX_FOLDER_NAME_LENGTH } from './folder.js';
export type { ShelfItemDto, ShelfItemRef, ShelfItemType, ShelfOrderItem } from './shelf.js';
export { isShelfBookItem, isShelfFolderItem } from './shelf.js';
export type {
  ReadingPositionDto,
  ReadingPositionUpdate,
  RecentReadingEntryDto,
  SnapshotRecentEntry,
} from './reading.js';
export type { LibrarySnapshot } from './librarySnapshot.js';
export {
  LIBRARY_SNAPSHOT_SCHEMA_VERSION,
  decodeLibrarySnapshot,
  decodeLibrarySnapshotResponse,
} from './librarySnapshot.js';
export type {
  ApiErrorResponse,
  BookResponse,
  BooksResponse,
  CatalogBooksResponse,
  FolderBooksResponse,
  FolderMutationResponse,
  FolderResponse,
  FoldersResponse,
  LibrarySnapshotResponse,
  MoveFolderBookToShelfResponse,
  ReadingPositionResponse,
  RecentReadingResponse,
  ShelfItemsResponse,
  UploadBookResponse,
} from './api.js';
export {
  WireDecodeError,
  isRecord,
  requireArray,
  requireInteger,
  requireNumber,
  requireRecord,
} from './decode.js';

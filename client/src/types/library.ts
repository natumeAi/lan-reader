import type { FolderDto, LibrarySnapshot, ReadingPositionDto, SnapshotBookDto } from '@lan-reader/shared';

/** Fields shared by REST books and snapshot books. Reading joins may be absent on REST. */
export type Book = Omit<SnapshotBookDto, 'readingProgress' | 'readingUpdatedAt'> & {
  readingProgress?: number | null;
  readingUpdatedAt?: string | null;
};
export type CatalogBook = Book & { folderName: string | null };
export type Folder = Omit<FolderDto, 'previewBooks'> & { previewBooks: Book[] };
export type FolderBook = Book & { key: string };
export type ShelfItem =
  | { type: 'book'; id: number; key: string; sortOrder?: number; book: Book; folderName?: string | null }
  | { type: 'folder'; id: number; key: string; sortOrder?: number; folder: Folder };
export type RecentReadingItem = { book: Book; progress: ReadingPositionDto };
export interface HydratedLibrarySnapshot {
  catalogData: { books: CatalogBook[] };
  folderBooksByFolderId: Map<number, FolderBook[]>;
  recentData: { items: RecentReadingItem[] };
  shelfData: { items: ShelfItem[] };
}
export interface CachedSnapshotRecord {
  etag: string | null;
  snapshot: LibrarySnapshot;
  savedAt?: number;
}
export type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ReaderBook = Book | import('../utils/activeReaderStorage.js').ActiveReaderBookSnapshot;

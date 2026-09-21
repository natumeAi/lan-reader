import {
  WireDecodeError, decodeLibrarySnapshot as decodeSnapshotReferences,
  requireRecord, requireArray, requireInteger, requireNumber,
} from '@lan-reader/shared';
import type {
  BookDto, CatalogBookDto, FolderDto, LibrarySnapshot, ReadingPositionDto,
  ShelfItemDto, SnapshotBookDto,
} from '@lan-reader/shared';

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WireDecodeError(`${field} must be a string`);
  return value;
}
function nullableString(value: unknown, field: string): string | null {
  return value == null ? null : string(value, field);
}
function nullableNumber(value: unknown, field: string): number | null {
  return value == null ? null : requireNumber(value, field);
}
/** Old snapshot caches can omit unused fields; normalize them rather than asserting a complete DTO. */
export function decodeSnapshotBook(value: unknown): SnapshotBookDto {
  const b = requireRecord(value, 'book');
  return {
    id: requireInteger(b['id'], 'book.id'),
    folderId: nullableNumber(b['folderId'], 'book.folderId'),
    title: string(b['title'] ?? '', 'book.title'),
    author: nullableString(b['author'], 'book.author'),
    identifier: nullableString(b['identifier'], 'book.identifier'),
    fileName: string(b['fileName'] ?? '', 'book.fileName'),
    fileSize: requireNumber(b['fileSize'] ?? 0, 'book.fileSize'),
    coverPath: nullableString(b['coverPath'], 'book.coverPath'),
    coverUrl: nullableString(b['coverUrl'], 'book.coverUrl'),
    coverThumbnailUrl: nullableString(b['coverThumbnailUrl'], 'book.coverThumbnailUrl'),
    coverThumbnail2xUrl: nullableString(b['coverThumbnail2xUrl'], 'book.coverThumbnail2xUrl'),
    coverThumbnailVersion: nullableString(b['coverThumbnailVersion'], 'book.coverThumbnailVersion'),
    sortOrder: requireNumber(b['sortOrder'] ?? 0, 'book.sortOrder'),
    createdAt: string(b['createdAt'] ?? '', 'book.createdAt'),
    updatedAt: string(b['updatedAt'] ?? '', 'book.updatedAt'),
    readingProgress: nullableNumber(b['readingProgress'], 'book.readingProgress'),
    readingUpdatedAt: nullableString(b['readingUpdatedAt'], 'book.readingUpdatedAt'),
  };
}
export function decodeBook(value: unknown): BookDto {
  const b = requireRecord(value, 'book');
  const common = decodeSnapshotBook(b);
  return {
    ...common,
    title: string(b['title'], 'book.title'),
    fileName: string(b['fileName'], 'book.fileName'),
    fileSize: requireNumber(b['fileSize'], 'book.fileSize'),
    sortOrder: requireNumber(b['sortOrder'], 'book.sortOrder'),
    createdAt: string(b['createdAt'], 'book.createdAt'),
    updatedAt: string(b['updatedAt'], 'book.updatedAt'),
    description: nullableString(b['description'], 'book.description'),
    publisher: nullableString(b['publisher'], 'book.publisher'),
    language: nullableString(b['language'], 'book.language'),
    coverThumbnailSmallPath: nullableString(b['coverThumbnailSmallPath'], 'book.coverThumbnailSmallPath'),
    coverThumbnailLargePath: nullableString(b['coverThumbnailLargePath'], 'book.coverThumbnailLargePath'),
  };
}
export function decodeCatalogBook(value: unknown): CatalogBookDto {
  const b = requireRecord(value, 'book');
  return {
    ...decodeBook(b),
    folderName: nullableString(b['folderName'], 'book.folderName'),
    readingProgress: nullableNumber(b['readingProgress'], 'book.readingProgress'),
    readingUpdatedAt: nullableString(b['readingUpdatedAt'], 'book.readingUpdatedAt'),
  };
}
export function decodeReadingPosition(value: unknown): ReadingPositionDto {
  const p = requireRecord(value, 'progress');
  return {
    bookId: requireInteger(p['bookId'], 'progress.bookId'),
    progress: requireNumber(p['progress'], 'progress.progress'),
    cfi: nullableString(p['cfi'], 'progress.cfi'),
    chapterHref: nullableString(p['chapterHref'], 'progress.chapterHref'),
    chapterLabel: nullableString(p['chapterLabel'], 'progress.chapterLabel'),
    updatedAt: string(p['updatedAt'] ?? '', 'progress.updatedAt'),
  };
}
export function decodeFolder(value: unknown): FolderDto {
  const f = requireRecord(value, 'folder');
  return {
    id: requireInteger(f['id'], 'folder.id'),
    name: string(f['name'], 'folder.name'),
    sortOrder: requireNumber(f['sortOrder'], 'folder.sortOrder'),
    bookCount: requireInteger(f['bookCount'], 'folder.bookCount'),
    previewBooks: requireArray(f['previewBooks'], 'folder.previewBooks').map(decodeBook),
    createdAt: string(f['createdAt'], 'folder.createdAt'),
    updatedAt: string(f['updatedAt'], 'folder.updatedAt'),
  };
}
export function decodeShelfItem(value: unknown): ShelfItemDto {
  const s = requireRecord(value, 'shelf item');
  const base = {
    id: requireInteger(s['id'], 'item.id'),
    sortOrder: requireNumber(s['sortOrder'], 'item.sortOrder'),
  };
  if (s['type'] === 'book') return { ...base, type: 'book', book: decodeBook(s['book']) };
  if (s['type'] === 'folder') return { ...base, type: 'folder', folder: decodeFolder(s['folder']) };
  throw new WireDecodeError('Unknown shelf item type');
}
export const decodeBooks = (value: unknown) => ({ books: requireArray(requireRecord(value, 'response')['books'], 'books').map(decodeBook) });
export const decodeBookResponse = (value: unknown) => ({ book: decodeBook(requireRecord(value, 'response')['book']) });
export const decodeCatalog = (value: unknown) => ({ books: requireArray(requireRecord(value, 'response')['books'], 'books').map(decodeCatalogBook) });
export const decodeShelf = (value: unknown) => ({ items: requireArray(requireRecord(value, 'response')['items'], 'items').map(decodeShelfItem) });
export const decodeFolderResponse = (value: unknown) => ({ folder: decodeFolder(requireRecord(value, 'response')['folder']) });
export function decodeFolderMutation(value: unknown) {
  const r = requireRecord(value, 'response');
  return {
    folder: decodeFolder(r['folder']),
    books: requireArray(r['books'], 'books').map(decodeBook),
    shelfItems: requireArray(r['shelfItems'], 'shelfItems').map(decodeShelfItem),
  };
}
export function decodeMoveToShelf(value: unknown) {
  const r = requireRecord(value, 'response');
  return {
    book: decodeBook(r['book']),
    folder: r['folder'] == null ? null : decodeFolder(r['folder']),
    books: requireArray(r['books'], 'books').map(decodeBook),
    shelfItems: requireArray(r['shelfItems'], 'shelfItems').map(decodeShelfItem),
    removedFolderId: nullableNumber(r['removedFolderId'], 'removedFolderId'),
  };
}
export function decodeProgress(value: unknown) {
  const p = requireRecord(value, 'response')['progress'];
  return { progress: p == null ? null : decodeReadingPosition(p) };
}
export function decodeRecent(value: unknown) {
  return {
    items: requireArray(requireRecord(value, 'response')['items'], 'items').map(value => {
      const r = requireRecord(value, 'recent');
      return { book: decodeBook(r['book']), progress: decodeReadingPosition(r['progress']) };
    }),
  };
}
export function decodeLibrarySnapshot(value: unknown): LibrarySnapshot {
  const snapshot = decodeSnapshotReferences(value);
  return {
    ...snapshot,
    books: snapshot.books.map(decodeSnapshotBook),
    folders: snapshot.folders.map(value => {
      const f = requireRecord(value, 'folder');
      return {
        id: requireInteger(f['id'], 'folder.id'),
        name: string(f['name'] ?? '', 'folder.name'),
        sortOrder: requireNumber(f['sortOrder'] ?? 0, 'folder.sortOrder'),
        bookCount: requireInteger(f['bookCount'] ?? 0, 'folder.bookCount'),
        bookIds: requireArray(f['bookIds'] ?? [], 'folder.bookIds')
          .map(v => requireInteger(v, 'bookId')),
        previewBookIds: requireArray(f['previewBookIds'] ?? [], 'folder.previewBookIds')
          .map(v => requireInteger(v, 'bookId')),
        createdAt: string(f['createdAt'] ?? '', 'folder.createdAt'),
        updatedAt: string(f['updatedAt'] ?? '', 'folder.updatedAt'),
      };
    }),
    shelf: snapshot.shelf.map(s => ({
      id: s.id,
      type: s.type,
      sortOrder: requireNumber(s.sortOrder ?? 0, 'shelf.sortOrder'),
    })),
    recent: snapshot.recent.map(r => ({
      bookId: r.bookId,
      progress: decodeReadingPosition(r.progress),
    })),
  };
}

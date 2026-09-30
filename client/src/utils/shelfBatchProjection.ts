import type { Book, CatalogBook, Folder, FolderBook, ShelfItem } from '../types/library.js';
import { normalizeFolderBook, normalizeShelfItem } from './libraryItems.js';

export interface BatchShelfState {
  shelfItems: ShelfItem[];
  catalogBooks?: CatalogBook[];
  folderBooksByFolderId?: Map<number, FolderBook[]>;
}

/** Snapshot-only projections; the response and the following refresh remain authoritative. */
export function projectShelfBatch(previous: BatchShelfState, books: Book[], target: Folder | 'shelf' | 'delete'): BatchShelfState {
  const ids = new Set(books.map(book => book.id));
  const sourceIds = new Set(books.flatMap(book => book.folderId == null ? [] : [book.folderId]));
  const map = previous.folderBooksByFolderId ? new Map(previous.folderBooksByFolderId) : undefined;
  for (const id of sourceIds) {
    const remaining = map?.get(id)?.filter(book => !ids.has(book.id));
    if (remaining) map?.set(id, remaining);
  }
  if (typeof target === 'object') {
    const current = previous.folderBooksByFolderId?.get(target.id) ?? target.previewBooks.map(normalizeFolderBook);
    map?.set(target.id, [...current, ...books.filter(book => book.folderId !== target.id)
      .map(book => normalizeFolderBook({ ...book, folderId: target.id }))]);
  }
  const shelfItems = previous.shelfItems.flatMap((item): ShelfItem[] => {
    if (item.type === 'book') return ids.has(item.id) && target !== 'shelf' ? [] : [item];
    const remaining = map?.get(item.id);
    const moved = target === 'shelf' && sourceIds.has(item.id)
      ? (previous.folderBooksByFolderId?.get(item.id) ?? books.filter(book => book.folderId === item.id))
        .filter(book => ids.has(book.id)).map(book => normalizeShelfItem({
          type: 'book' as const, id: book.id, book: { ...book, folderId: null },
        })) : [];
    const affected = sourceIds.has(item.id) || typeof target === 'object' && item.id === target.id;
    const kept = affected && remaining?.length === 0 ? [] : [affected && remaining ? {
      ...item, folder: { ...item.folder, bookCount: remaining.length, previewBooks: remaining.slice(0, 4) },
    } : item];
    return [...kept, ...moved];
  });
  for (const [id, remaining] of map ?? []) if (remaining.length === 0) map?.delete(id);
  const catalogBooks = previous.catalogBooks?.flatMap(book => {
    if (!ids.has(book.id)) return [book];
    if (target === 'delete') return [];
    return [{ ...book, folderId: target === 'shelf' ? null : target.id,
      folderName: target === 'shelf' ? null : target.name }];
  });
  return { shelfItems, catalogBooks, folderBooksByFolderId: map };
}

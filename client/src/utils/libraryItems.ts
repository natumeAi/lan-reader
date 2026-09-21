import type { ShelfOrderItem } from '@lan-reader/shared';
import type { Book, ShelfItem, RecentReadingItem } from '../types/library.js';
export function shelfItemKey(item: ShelfOrderItem) {
  return `${item.type}:${item.id}`;
}

export function toShelfOrderItem(item: ShelfOrderItem): ShelfOrderItem {
  return {
    type: item.type,
    id: item.id,
  };
}

export function normalizeShelfItem<T extends ShelfOrderItem>(item: T): T & { key: string } {
  return {
    ...item,
    key: shelfItemKey(item),
  };
}

export function folderBookKey(book: { id: number }) {
  return `folder-book:${book.id}`;
}

export function normalizeFolderBook<T extends { id: number }>(book: T): T & { key: string } {
  return {
    ...book,
    key: folderBookKey(book),
  };
}

export function normalizeShelfBookFromFolderBook(book: Book): Extract<ShelfItem, { type: 'book' }> {
  return {
    type: 'book',
    id: book.id,
    sortOrder: book.sortOrder,
    book,
    key: folderBookKey(book),
  };
}

export function findBookInLoadedLibrary(bookId: number, shelfData: { items?: ShelfItem[] }, recentData: { items?: RecentReadingItem[] }) {
  const shelfBook = (shelfData.items || [])
    .find((item): item is Extract<ShelfItem, { type: 'book' }> => item.type === 'book' && Number(item.book.id) === bookId)
    ?.book;

  if (shelfBook) {
    return shelfBook;
  }

  return (recentData.items || [])
    .find((item) => Number(item.book?.id) === bookId)
    ?.book || null;
}

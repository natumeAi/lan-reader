export function shelfItemKey(item) {
  return `${item.type}:${item.id}`;
}

export function toShelfOrderItem(item) {
  return {
    type: item.type,
    id: item.id,
  };
}

export function normalizeShelfItem(item) {
  return {
    ...item,
    key: shelfItemKey(item),
  };
}

export function folderBookKey(book) {
  return `folder-book:${book.id}`;
}

export function normalizeFolderBook(book) {
  return {
    ...book,
    key: folderBookKey(book),
  };
}

export function normalizeShelfBookFromFolderBook(book) {
  return {
    type: 'book',
    id: book.id,
    sortOrder: book.sortOrder,
    book,
    key: folderBookKey(book),
  };
}

export function findBookInLoadedLibrary(bookId, shelfData, recentData) {
  const shelfBook = (shelfData.items || [])
    .find((item) => item.type === 'book' && Number(item.book?.id) === bookId)
    ?.book;

  if (shelfBook) {
    return shelfBook;
  }

  return (recentData.items || [])
    .find((item) => Number(item.book?.id) === bookId)
    ?.book || null;
}

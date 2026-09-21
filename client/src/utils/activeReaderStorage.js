const activeReaderBookStorageKey = 'epub-reader.activeBookId';
const activeReaderBookSnapshotStorageKey = 'epub-reader.activeBookSnapshot';

function sanitizeBookSnapshot(book) {
  const id = Number(book?.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  return {
    id,
    folderId: book.folderId != null && Number.isInteger(Number(book.folderId))
      ? Number(book.folderId)
      : null,
    title: typeof book.title === 'string' ? book.title : '',
    author: typeof book.author === 'string' ? book.author : null,
    identifier: typeof book.identifier === 'string' ? book.identifier : null,
    fileName: typeof book.fileName === 'string' ? book.fileName : '',
    fileSize: Number.isFinite(Number(book.fileSize)) ? Number(book.fileSize) : 0,
    coverPath: typeof book.coverPath === 'string' ? book.coverPath : null,
    coverUrl: typeof book.coverUrl === 'string' ? book.coverUrl : null,
  };
}

export function readActiveReaderBookId() {
  try {
    const value = localStorage.getItem(activeReaderBookStorageKey);
    const bookId = Number(value);

    return Number.isInteger(bookId) && bookId > 0 ? bookId : null;
  } catch {
    return null;
  }
}

export function writeActiveReaderBookId(bookId) {
  try {
    localStorage.setItem(activeReaderBookStorageKey, String(bookId));
  } catch {
    // Reading still works when storage is unavailable.
  }
}

export function readActiveReaderBookSnapshot() {
  try {
    const activeBookId = readActiveReaderBookId();
    if (!activeBookId) return null;

    const snapshot = sanitizeBookSnapshot(
      JSON.parse(localStorage.getItem(activeReaderBookSnapshotStorageKey)),
    );
    return snapshot?.id === activeBookId ? snapshot : null;
  } catch {
    return null;
  }
}

export function writeActiveReaderBookSnapshot(book) {
  const snapshot = sanitizeBookSnapshot(book);
  if (!snapshot) return;

  try {
    localStorage.setItem(activeReaderBookSnapshotStorageKey, JSON.stringify(snapshot));
  } catch {
    // The ID-only restore path remains available when storage is unavailable.
  }
}

export function clearActiveReaderBookId() {
  try {
    localStorage.removeItem(activeReaderBookStorageKey);
    localStorage.removeItem(activeReaderBookSnapshotStorageKey);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

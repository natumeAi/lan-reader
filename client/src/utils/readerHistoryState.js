export const READER_BOOK_HISTORY_KEY = '__epubReaderBookId';
export const IMAGE_VIEWER_HISTORY_KEY = '__epubReaderImageViewer';

function copyHistoryState(state) {
  return state && typeof state === 'object' ? { ...state } : {};
}

export function readerBookIdFromHistoryState(state) {
  const bookId = Number(state?.[READER_BOOK_HISTORY_KEY]);
  return Number.isInteger(bookId) && bookId > 0 ? bookId : null;
}

export function hasImageViewerHistoryState(state) {
  return state?.[IMAGE_VIEWER_HISTORY_KEY] === true;
}

export function withReaderHistoryState(state, bookId) {
  const next = copyHistoryState(state);
  next[READER_BOOK_HISTORY_KEY] = bookId;
  delete next[IMAGE_VIEWER_HISTORY_KEY];
  return next;
}

export function withImageViewerHistoryState(state) {
  const next = copyHistoryState(state);
  next[IMAGE_VIEWER_HISTORY_KEY] = true;
  return next;
}

export function withoutReaderHistoryState(state) {
  const next = copyHistoryState(state);
  delete next[READER_BOOK_HISTORY_KEY];
  delete next[IMAGE_VIEWER_HISTORY_KEY];
  return next;
}

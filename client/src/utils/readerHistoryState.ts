import { isRecord } from '@lan-reader/shared';
export const READER_BOOK_HISTORY_KEY = '__epubReaderBookId';
export const IMAGE_VIEWER_HISTORY_KEY = '__epubReaderImageViewer';

function copyHistoryState(state: unknown): Record<string, unknown> {
  return isRecord(state) ? { ...state } : {};
}

export function readerBookIdFromHistoryState(state: unknown) {
  const bookId = Number(isRecord(state) ? state[READER_BOOK_HISTORY_KEY] : undefined);
  return Number.isInteger(bookId) && bookId > 0 ? bookId : null;
}

export function hasImageViewerHistoryState(state: unknown) {
  return isRecord(state) && state[IMAGE_VIEWER_HISTORY_KEY] === true;
}

export function withReaderHistoryState(state: unknown, bookId: number) {
  const next = copyHistoryState(state);
  next[READER_BOOK_HISTORY_KEY] = bookId;
  delete next[IMAGE_VIEWER_HISTORY_KEY];
  return next;
}

export function withImageViewerHistoryState(state: unknown) {
  const next = copyHistoryState(state);
  next[IMAGE_VIEWER_HISTORY_KEY] = true;
  return next;
}

export function withoutReaderHistoryState(state: unknown) {
  const next = copyHistoryState(state);
  delete next[READER_BOOK_HISTORY_KEY];
  delete next[IMAGE_VIEWER_HISTORY_KEY];
  return next;
}

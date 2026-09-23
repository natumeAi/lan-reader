import { readActiveReaderBookId } from './activeReaderStorage.js';

export const MAIN_VIEW = {
  HOME: 'home',
  SHELF: 'shelf',
} as const;

export type MainView = typeof MAIN_VIEW[keyof typeof MAIN_VIEW];

/**
 * The main view an active reader was opened from. It is only consulted while an
 * active reader is being restored; a normal entry always starts on the home view.
 */
export const READER_ORIGIN_MAIN_VIEW_STORAGE_KEY = 'epub-reader:reader-origin-main-view';

export function sanitizeMainView(value: unknown): MainView {
  return value === MAIN_VIEW.SHELF ? MAIN_VIEW.SHELF : MAIN_VIEW.HOME;
}

export function readReaderOriginMainView(): MainView {
  try {
    return sanitizeMainView(localStorage.getItem(READER_ORIGIN_MAIN_VIEW_STORAGE_KEY));
  } catch {
    return MAIN_VIEW.HOME;
  }
}

export function writeReaderOriginMainView(view: MainView) {
  try {
    localStorage.setItem(READER_ORIGIN_MAIN_VIEW_STORAGE_KEY, sanitizeMainView(view));
  } catch {
    // Without storage a restored reader simply returns to the home view.
  }
}

export function clearReaderOriginMainView() {
  try {
    localStorage.removeItem(READER_ORIGIN_MAIN_VIEW_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/** Normal entry is home; an active-reader restore returns to the view it came from. */
export function readInitialMainView(): MainView {
  return readActiveReaderBookId() ? readReaderOriginMainView() : MAIN_VIEW.HOME;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBook } from '../api/booksApi.js';
import {
  clearActiveReaderBookId,
  readActiveReaderBookId,
  readActiveReaderBookSnapshot,
  writeActiveReaderBookId,
  writeActiveReaderBookSnapshot,
} from '../utils/activeReaderStorage.js';
import { findBookInLoadedLibrary } from '../utils/libraryItems.js';
import {
  readerBookIdFromHistoryState,
  withReaderHistoryState,
  withoutReaderHistoryState,
} from '../utils/readerHistoryState.js';

function historyStateWithReader(bookId) {
  return withReaderHistoryState(window.history.state, bookId);
}

function ensureReaderHistoryEntry(bookId, { fresh = false } = {}) {
  try {
    if (fresh && readerBookIdFromHistoryState(window.history.state)) {
      clearStaleReaderHistoryState();
    }

    const state = historyStateWithReader(bookId);
    if (readerBookIdFromHistoryState(window.history.state)) {
      window.history.replaceState(state, '', window.location.href);
    } else {
      window.history.pushState(state, '', window.location.href);
    }
  } catch {
    // The reader still works when browser history is unavailable.
  }
}

function clearStaleReaderHistoryState() {
  try {
    const currentState = window.history.state;
    if (!readerBookIdFromHistoryState(currentState)) return;

    window.history.replaceState(
      withoutReaderHistoryState(currentState),
      '',
      window.location.href,
    );
  } catch {
    // Nothing else is required when browser history is unavailable.
  }
}

export function useReaderSession() {
  const [readingBook, setReadingBook] = useState(readActiveReaderBookSnapshot);
  const [readingBookOrigin, setReadingBookOrigin] = useState(null);
  const readingBookRef = useRef(readingBook);
  const hasTriedReaderRestoreRef = useRef(Boolean(readingBook));
  const restoredHistoryInitializedRef = useRef(false);

  useEffect(() => {
    readingBookRef.current = readingBook;
    if (readingBook) writeActiveReaderBookSnapshot(readingBook);
  }, [readingBook]);

  useEffect(() => {
    const restoredBook = readingBookRef.current;
    if (!restoredBook || restoredHistoryInitializedRef.current) return;
    restoredHistoryInitializedRef.current = true;
    ensureReaderHistoryEntry(restoredBook.id, { fresh: true });
  }, []);

  const dismissReader = useCallback(() => {
    readingBookRef.current = null;
    clearActiveReaderBookId();
    setReadingBook(null);
    setReadingBookOrigin(null);
  }, []);

  useEffect(() => {
    const handlePopState = (event) => {
      if (readingBookRef.current) {
        if (!readerBookIdFromHistoryState(event.state)) {
          dismissReader();
        }
        return;
      }

      const activeBookId = readActiveReaderBookId();
      if (activeBookId && !readerBookIdFromHistoryState(event.state)) {
        hasTriedReaderRestoreRef.current = true;
        clearActiveReaderBookId();
      } else if (!activeBookId) {
        clearStaleReaderHistoryState();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [dismissReader]);

  const openBook = useCallback((book, originRect, options = {}) => {
    if (!book || options.disabled) {
      return;
    }

    ensureReaderHistoryEntry(book.id);
    writeActiveReaderBookId(book.id);
    writeActiveReaderBookSnapshot(book);
    readingBookRef.current = book;
    setReadingBookOrigin(originRect || null);
    setReadingBook(book);
  }, []);

  const clearReadingBookOrigin = useCallback(() => {
    setReadingBookOrigin(null);
  }, []);

  const closeReader = useCallback(() => {
    const shouldPopReaderHistory = Boolean(
      readingBookRef.current && readerBookIdFromHistoryState(window.history.state),
    );

    dismissReader();
    if (shouldPopReaderHistory) {
      try {
        window.history.back();
      } catch {
        clearStaleReaderHistoryState();
      }
    }
  }, [dismissReader]);

  const clearReaderBookIfDeleted = useCallback((bookId) => {
    if (readingBookRef.current?.id === bookId || readActiveReaderBookId() === bookId) {
      const shouldPopReaderHistory = Boolean(
        readerBookIdFromHistoryState(window.history.state),
      );
      dismissReader();
      if (shouldPopReaderHistory) {
        try {
          window.history.back();
        } catch {
          clearStaleReaderHistoryState();
        }
      }
    }
  }, [dismissReader]);

  const restoreReaderBook = useCallback(async (shelfData, recentData) => {
    const activeBookId = readActiveReaderBookId();

    if (!activeBookId || readingBookRef.current || hasTriedReaderRestoreRef.current) {
      return;
    }

    hasTriedReaderRestoreRef.current = true;
    let bookToRestore = findBookInLoadedLibrary(activeBookId, shelfData, recentData);

    if (!bookToRestore) {
      try {
        const data = await getBook(activeBookId);
        bookToRestore = data.book;
      } catch {
        clearActiveReaderBookId();
      }
    }

    if (
      bookToRestore &&
      !readingBookRef.current &&
      readActiveReaderBookId() === activeBookId
    ) {
      // A restored PWA window may have retained only its previous reader
      // entry. Recreate a shelf entry directly beneath it so one Back action
      // always returns to the library instead of leaving the application.
      ensureReaderHistoryEntry(bookToRestore.id, { fresh: true });
      readingBookRef.current = bookToRestore;
      setReadingBookOrigin(null);
      setReadingBook(bookToRestore);
    }
  }, []);

  return {
    clearReadingBookOrigin,
    clearReaderBookIfDeleted,
    closeReader,
    openBook,
    readingBook,
    readingBookOrigin,
    restoreReaderBook,
  };
}

import type { Book, Folder } from '../types/library.js';
import { errorMessage } from '../api/transport.js';

interface BookDeletionOptions {
  clearReaderBookIfDeleted?: (id: number) => void;
  loadShelf?: () => unknown;
  /** Called once the server deleted the Book (its statistics are deleted with it). */
  onBookDeleted?: (id: number) => void;
  openFolder?: Folder | null;
  refreshOpenFolderBooksOrClose?: () => unknown;
  setError?: (message: string) => void;
  setFolderError?: (message: string) => void;
}

import { useCallback, useState } from 'react';
import { deleteBook } from '../api/booksApi.js';

const noop = () => {};

export function useBookDeletion({
  clearReaderBookIfDeleted = noop,
  loadShelf = noop,
  onBookDeleted = noop,
  openFolder,
  refreshOpenFolderBooksOrClose = noop,
  setError = noop,
  setFolderError = noop,
}: BookDeletionOptions = {}) {
  const [deleteCandidateBook, setDeleteCandidateBook] = useState<Book | null>(null);
  const [isDeletingBook, setIsDeletingBook] = useState(false);

  const handleDropBookOnDelete = useCallback(
    (book: Book) => {
      setError('');
      setFolderError('');
      setDeleteCandidateBook(book);
    },
    [setError, setFolderError],
  );

  const handleCancelDeleteBook = useCallback(() => {
    if (isDeletingBook) {
      return;
    }

    setDeleteCandidateBook(null);
  }, [isDeletingBook]);

  const handleConfirmDeleteBook = useCallback(async () => {
    const book = deleteCandidateBook;

    if (!book || isDeletingBook) {
      return;
    }

    setIsDeletingBook(true);
    setError('');
    setFolderError('');

    try {
      await deleteBook(book.id);

      clearReaderBookIfDeleted(book.id);
      onBookDeleted(book.id);
      setDeleteCandidateBook(null);

      if (openFolder) {
        await refreshOpenFolderBooksOrClose();
      }

      await loadShelf();
    } catch (err) {
      const message = errorMessage(err, '无法删除书籍');

      if (openFolder) {
        setFolderError(message);
      } else {
        setError(message);
      }
    } finally {
      setIsDeletingBook(false);
    }
  }, [
    clearReaderBookIfDeleted,
    deleteCandidateBook,
    isDeletingBook,
    loadShelf,
    onBookDeleted,
    openFolder,
    refreshOpenFolderBooksOrClose,
    setError,
    setFolderError,
  ]);

  return {
    deleteCandidateBook,
    handleCancelDeleteBook,
    handleConfirmDeleteBook,
    handleDropBookOnDelete,
    isDeletingBook,
  };
}

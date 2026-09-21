import { useCallback, useState } from 'react';
import { deleteBook } from '../api/booksApi.js';

const noop = () => {};

export function useBookDeletion({
  clearReaderBookIfDeleted = noop,
  loadShelf = noop,
  openFolder,
  refreshOpenFolderBooksOrClose = noop,
  setError = noop,
  setFolderError = noop,
} = {}) {
  const [deleteCandidateBook, setDeleteCandidateBook] = useState(null);
  const [isDeletingBook, setIsDeletingBook] = useState(false);

  const handleDropBookOnDelete = useCallback(
    (book) => {
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
      setDeleteCandidateBook(null);

      if (openFolder) {
        await refreshOpenFolderBooksOrClose();
      }

      await loadShelf();
    } catch (err) {
      const message = err.message || '无法删除书籍';

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

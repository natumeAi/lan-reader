import type { Book, Folder } from './types/library.js';
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { DeleteConfirmDialog } from './components/bookshelf/DeleteConfirmDialog.js';
import { DeleteDropZone } from './components/bookshelf/DeleteDropZone.js';
import { DragPreview } from './components/bookshelf/DragPreview.js';
import { FixedDragPreview } from './components/bookshelf/FixedDragPreview.js';
import { LibraryHome } from './components/bookshelf/LibraryHome.js';
import { FolderOverlay } from './components/folders/FolderOverlay.js';
import { useBookDeletion } from './hooks/useBookDeletion.js';
import { useFolderState } from './hooks/useFolderState.js';
import { useLibraryDrag } from './hooks/useLibraryDrag.js';
import { useReaderSession } from './hooks/useReaderSession.js';
import { useShelfData } from './hooks/useShelfData.js';
import { rectIntersectsViewport } from './utils/folderMotion.js';

const ReaderView = lazy(() => import('./components/reader/ReaderView.js'));

function ReaderRestoreFallback() {
  return (
    <div className="reader-overlay reader-restore-fallback" role="status" aria-live="polite">
      <span className="reader-loading-spinner" aria-hidden="true" />
      <span>正在恢复阅读</span>
    </div>
  );
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    clearReadingBookOrigin,
    clearReaderBookIfDeleted,
    closeReader,
    openBook,
    readingBook,
    readingBookOrigin,
    restoreReaderBook,
  } = useReaderSession();
  const {
    catalogBooks,
    catalogError,
    folderBooksByFolderId,
    handleFileChange,
    hasLoadedCatalog,
    hasLoadedShelf,
    isCatalogLoading,
    isLoading,
    isSavingOrder,
    isUploading,
    loadCatalog,
    loadShelf,
    operationError,
    recentReadingItems,
    reapplyPendingReadingPositions,
    replaceShelfFolder,
    setIsSavingOrder,
    setOperationError,
    setShelfItems,
    shelfError,
    shelfItems,
    uploadProgress,
  } = useShelfData({ restoreReaderBook });
  const handleFolderRenamed = useCallback((renamedFolder: Folder) => {
    replaceShelfFolder(renamedFolder);
    void loadShelf();
  }, [loadShelf, replaceShelfFolder]);
  const {
    finishCloseFolder,
    folderBooks,
    folderCloseVersion,
    folderError,
    folderNameDraft,
    folderOriginRect,
    handleCancelFolderRename,
    handleCloseFolder: closeFolder,
    handleOpenFolder: openFolderFromShelf,
    handleStartFolderRename,
    handleSubmitFolderRename,
    isFolderClosing,
    isFolderLoading,
    isRenamingFolder,
    isSavingFolderName,
    isSavingFolderOrder,
    openFolder,
    refreshOpenFolderBooksOrClose,
    setFolderBooks,
    setFolderError,
    setFolderNameDraft,
    setIsFolderLoading,
    setIsRenamingFolder,
    setIsSavingFolderOrder,
    setOpenFolder,
  } = useFolderState({ onFolderRenamed: handleFolderRenamed });
  const {
    deleteCandidateBook,
    handleCancelDeleteBook,
    handleConfirmDeleteBook,
    handleDropBookOnDelete,
    isDeletingBook,
  } = useBookDeletion({
    clearReaderBookIfDeleted,
    loadShelf,
    openFolder,
    refreshOpenFolderBooksOrClose,
    setError: setOperationError,
    setFolderError,
  });
  const {
    activeDragModifier,
    activeDragPreview,
    appCollisionDetection,
    dragIntent,
    fixedDragPreviewPoint,
    getFolderOpenIgnoreUntil,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    sensors,
  } = useLibraryDrag({
    folderBooks,
    folderCloseVersion,
    isSavingFolderOrder,
    isSavingOrder,
    loadShelf,
    onDropOnDelete: handleDropBookOnDelete,
    openFolder,
    setError: setOperationError,
    setFolderBooks,
    setFolderError,
    setIsFolderLoading,
    setIsRenamingFolder,
    setIsSavingFolderOrder,
    setIsSavingOrder,
    setOpenFolder,
    setShelfItems,
    shelfItems,
  });
  function handleOpenBook(book: Book, originRect: DOMRect | null) {
    openBook(book, originRect, { disabled: isSavingOrder });
  }

  const handleReaderProgressSettled = useCallback(() => {
    reapplyPendingReadingPositions();
    void loadShelf({ background: true, allowCached: false });
  }, [loadShelf, reapplyPendingReadingPositions]);

  const handleBookUnavailable = useCallback((bookId: number) => {
    clearReaderBookIfDeleted(bookId);
    void loadShelf();
  }, [clearReaderBookIfDeleted, loadShelf]);

  function handleOpenFolder(folder: Folder, originRect: DOMRect | null) {
    openFolderFromShelf(folder, {
      books: folderBooksByFolderId.get(folder.id) || [],
      ignoreUntil: getFolderOpenIgnoreUntil(),
      isShelfBusy: isSavingOrder,
      originRect,
    });
    void loadShelf({ background: true, allowCached: false });
  }

  function handleCloseFolder() {
    const sourceElement = openFolder
      ? document.querySelector(`[data-folder-id="${openFolder.id}"] .folder-cover`)
      : null;
    const sourceRect = sourceElement?.getBoundingClientRect() || null;
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    closeFolder({
      originRect: rectIntersectsViewport(sourceRect, viewport) ? sourceRect : null,
    });
  }

  useEffect(() => {
    if (!openFolder || isSavingFolderOrder) return;

    const updatedFolderItem = shelfItems.find(
      (item) => item.type === 'folder' && item.id === openFolder.id,
    );
    if (!updatedFolderItem || updatedFolderItem.type !== 'folder') {
      finishCloseFolder();
      return;
    }

    setOpenFolder(updatedFolderItem.folder);
    setFolderBooks(folderBooksByFolderId.get(openFolder.id) || []);
  }, [
    finishCloseFolder,
    folderBooksByFolderId,
    isSavingFolderOrder,
    openFolder?.id,
    setFolderBooks,
    setOpenFolder,
    shelfItems,
  ]);

  return (
    <DndContext
      modifiers={[activeDragModifier]}
      sensors={sensors}
      collisionDetection={appCollisionDetection}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragStart={handleDragStart}
    >
      <main className="app-shell" aria-label="EPUB Reader">
        <LibraryHome
          catalogBooks={catalogBooks}
          catalogError={catalogError}
          operationError={operationError}
          shelfError={shelfError}
          dragIntent={dragIntent}
          fileInputRef={fileInputRef}
          hasLoadedCatalog={hasLoadedCatalog}
          hasLoadedShelf={hasLoadedShelf}
          isCatalogLoading={isCatalogLoading}
          isLoading={isLoading}
          isSavingOrder={isSavingOrder}
          isUploading={isUploading}
          onFileChange={handleFileChange}
          onOpenBook={handleOpenBook}
          onOpenFolder={handleOpenFolder}
          onRetryCatalog={loadCatalog}
          onRetryShelf={loadShelf}
          recentReadingItems={recentReadingItems}
          shelfItems={shelfItems}
          uploadProgress={uploadProgress}
        />
        <FolderOverlay
          books={folderBooks}
          error={folderError}
          folder={openFolder}
          originRect={folderOriginRect}
          isClosing={isFolderClosing}
          isLoading={isFolderLoading}
          isRenaming={isRenamingFolder}
          isRenameSaving={isSavingFolderName}
          isSavingOrder={isSavingFolderOrder}
          onClose={handleCloseFolder}
          onOpenBook={handleOpenBook}
          onRenameCancel={handleCancelFolderRename}
          onRenameDraftChange={setFolderNameDraft}
          onRenameStart={handleStartFolderRename}
          onRenameSubmit={handleSubmitFolderRename}
          renameDraft={folderNameDraft}
        />
        {readingBook && (
          <Suspense fallback={readingBookOrigin ? null : <ReaderRestoreFallback />}>
            <ReaderView
              book={readingBook}
              originRect={readingBookOrigin}
              onBookUnavailable={handleBookUnavailable}
              onClose={closeReader}
              onOriginConsumed={clearReadingBookOrigin}
              onProgressSettled={handleReaderProgressSettled}
            />
          </Suspense>
        )}
        <DeleteDropZone
          visible={activeDragPreview?.type === 'book' || activeDragPreview?.type === 'folder-book'}
        />
        <DeleteConfirmDialog
          book={deleteCandidateBook}
          isDeleting={isDeletingBook}
          onCancel={handleCancelDeleteBook}
          onConfirm={handleConfirmDeleteBook}
        />
      </main>
      <DragOverlay dropAnimation={null}>
        <DragPreview item={fixedDragPreviewPoint ? null : activeDragPreview} />
      </DragOverlay>
      <FixedDragPreview item={activeDragPreview} point={fixedDragPreviewPoint} />
    </DndContext>
  );
}

export default App;

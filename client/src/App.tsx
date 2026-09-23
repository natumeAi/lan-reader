import type { Book, Folder } from './types/library.js';
import type { MainView } from './utils/mainViewPreference.js';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { DeleteConfirmDialog } from './components/bookshelf/DeleteConfirmDialog.js';
import { DeleteDropZone } from './components/bookshelf/DeleteDropZone.js';
import { DragPreview } from './components/bookshelf/DragPreview.js';
import { FixedDragPreview } from './components/bookshelf/FixedDragPreview.js';
import { LibraryHome } from './components/bookshelf/LibraryHome.js';
import { MainNavigation } from './components/common/MainNavigation.js';
import { FolderOverlay } from './components/folders/FolderOverlay.js';
import { ReadingHome } from './components/home/ReadingHome.js';
import { useBookDeletion } from './hooks/useBookDeletion.js';
import { useFolderState } from './hooks/useFolderState.js';
import { useLibraryDrag } from './hooks/useLibraryDrag.js';
import { useMainView } from './hooks/useMainView.js';
import { useReaderSession } from './hooks/useReaderSession.js';
import { useReducedMotion } from './hooks/useReducedMotion.js';
import { useShelfData } from './hooks/useShelfData.js';
import { dropAnimationConfig } from './utils/dragMotion.js';
import { rectIntersectsViewport } from './utils/folderMotion.js';
import { MAIN_VIEW } from './utils/mainViewPreference.js';

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
  const reducedMotion = useReducedMotion();
  const {
    clearReadingBookOrigin,
    clearReaderBookIfDeleted,
    closeReader,
    openBook,
    readingBook,
    readingBookOrigin,
    restoreReaderBook,
  } = useReaderSession();
  const { mainView, selectMainView } = useMainView({ readerActive: Boolean(readingBook) });
  const homeViewRef = useRef<HTMLDivElement>(null);
  const shelfViewRef = useRef<HTMLDivElement>(null);
  const previousMainViewRef = useRef(mainView);
  const {
    beginShelfProjection,
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
    getFolderSession,
    handleCancelFolderRename,
    handleCloseFolder: closeFolder,
    handleOpenFolder: openFolderFromShelf,
    handleStartFolderRename,
    handleSubmitFolderRename,
    isFolderClosing,
    isFolderLoading,
    isFolderSessionCurrent,
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
    dragPreviewMotion,
    getFolderOpenIgnoreUntil,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    isFixedDragPreviewActive,
    landingKey,
    mutationFeedback,
    sensors,
  } = useLibraryDrag({
    beginShelfProjection,
    folderBooks,
    folderCloseVersion,
    getFolderSession,
    isFolderSessionCurrent,
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
  // The reader, an open/closing Folder, the delete dialog and an active drag each own
  // interaction; the main views cannot be switched underneath them.
  const isMainNavigationBlocked = Boolean(
    readingBook ||
    openFolder ||
    isFolderClosing ||
    deleteCandidateBook ||
    activeDragPreview,
  );

  const handleSelectMainView = useCallback((view: MainView) => {
    if (isMainNavigationBlocked) return;
    selectMainView(view);
  }, [isMainNavigationBlocked, selectMainView]);

  const handleOpenShelf = useCallback(() => {
    handleSelectMainView(MAIN_VIEW.SHELF);
  }, [handleSelectMainView]);

  // A control inside the view that was just hidden loses focus with it (for example the
  // empty-state shelf action). Hand focus to the newly shown view instead of the document.
  useLayoutEffect(() => {
    if (previousMainViewRef.current === mainView) return;
    previousMainViewRef.current = mainView;
    const activeElement = document.activeElement;
    const shownView = mainView === MAIN_VIEW.HOME ? homeViewRef.current : shelfViewRef.current;
    const hiddenView = mainView === MAIN_VIEW.HOME ? shelfViewRef.current : homeViewRef.current;
    if (!activeElement || activeElement === document.body || hiddenView?.contains(activeElement)) {
      shownView?.focus({ preventScroll: true });
    }
  }, [mainView]);

  // Stable so the memoized shelf cards survive a DndContext re-render.
  const handleOpenBook = useCallback((book: Book, originRect: DOMRect | null) => {
    openBook(book, originRect, { disabled: isSavingOrder });
  }, [isSavingOrder, openBook]);

  const handleReaderProgressSettled = useCallback(() => {
    reapplyPendingReadingPositions();
    void loadShelf({ background: true, allowCached: false });
  }, [loadShelf, reapplyPendingReadingPositions]);

  const handleBookUnavailable = useCallback((bookId: number) => {
    clearReaderBookIfDeleted(bookId);
    void loadShelf();
  }, [clearReaderBookIfDeleted, loadShelf]);

  const handleOpenFolder = useCallback((folder: Folder, originRect: DOMRect | null) => {
    openFolderFromShelf(folder, {
      books: folderBooksByFolderId.get(folder.id) || [],
      ignoreUntil: getFolderOpenIgnoreUntil(),
      isShelfBusy: isSavingOrder,
      originRect,
    });
    void loadShelf({ background: true, allowCached: false });
  }, [
    folderBooksByFolderId,
    getFolderOpenIgnoreUntil,
    isSavingOrder,
    loadShelf,
    openFolderFromShelf,
  ]);

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
      <main className="app-shell has-main-navigation" aria-label="EPUB Reader">
        {/* Both views stay mounted so shelf search/view/sort, grid and scroll context survive
            a round trip. The hidden view is display:none and inert: it takes no focus, has no
            laid-out cover for reader transitions, and cannot start a drag. */}
        <div
          ref={homeViewRef}
          className="main-view"
          data-main-view={MAIN_VIEW.HOME}
          hidden={mainView !== MAIN_VIEW.HOME}
          inert={mainView !== MAIN_VIEW.HOME}
          tabIndex={-1}
        >
          <ReadingHome
            hasLoadedRecentReading={hasLoadedShelf}
            onOpenBook={handleOpenBook}
            onOpenShelf={handleOpenShelf}
            onRetryRecentReading={loadShelf}
            recentReadingError={shelfError}
            recentReadingItems={recentReadingItems}
          />
        </div>
        <div
          ref={shelfViewRef}
          className="main-view"
          data-main-view={MAIN_VIEW.SHELF}
          hidden={mainView !== MAIN_VIEW.SHELF}
          inert={mainView !== MAIN_VIEW.SHELF}
          tabIndex={-1}
        >
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
            landingKey={landingKey}
            mutationFeedback={mutationFeedback}
            onFileChange={handleFileChange}
            onOpenBook={handleOpenBook}
            onOpenFolder={handleOpenFolder}
            onRetryCatalog={loadCatalog}
            onRetryShelf={loadShelf}
            shelfItems={shelfItems}
            uploadProgress={uploadProgress}
          />
        </div>
        {isMainNavigationBlocked ? null : (
          <MainNavigation activeView={mainView} onSelectView={handleSelectMainView} />
        )}
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
          mutationFeedback={mutationFeedback}
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
              key={readingBook.id}
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
          armed={dragIntent.type === 'delete'}
          visible={activeDragPreview?.type === 'book' || activeDragPreview?.type === 'folder-book'}
        />
        <DeleteConfirmDialog
          book={deleteCandidateBook}
          isDeleting={isDeletingBook}
          onCancel={handleCancelDeleteBook}
          onConfirm={handleConfirmDeleteBook}
        />
      </main>
      {/* The overlay settles onto the accepted destination (or back to the origin on a
          cancel) instead of vanishing. While the fixed preview owns the visual the overlay
          renders nothing, so the configuration has no node to animate there. */}
      <DragOverlay dropAnimation={dropAnimationConfig(reducedMotion)}>
        <DragPreview item={isFixedDragPreviewActive ? null : activeDragPreview} />
      </DragOverlay>
      <FixedDragPreview
        active={isFixedDragPreviewActive}
        item={activeDragPreview}
        motion={dragPreviewMotion}
      />
    </DndContext>
  );
}

export default App;

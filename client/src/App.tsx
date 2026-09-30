import type { Book, Folder } from './types/library.js';
import type { MainView } from './utils/mainViewPreference.js';
import type { GoalKind } from './utils/readingStatsFormat.js';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, TransitionEvent } from 'react';
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
import { RecentReadingSheet } from './components/home/RecentReadingSheet.js';
import { ReadingHome } from './components/home/ReadingHome.js';
import { ReadingStatistics } from './components/statistics/ReadingStatistics.js';
import { StatisticsRankingDetail } from './components/statistics/StatisticsRankingDetail.js';
import { ShelfItemMenu } from './components/bookshelf/ShelfItemMenu.js';
import { useShelfItemMenu } from './hooks/useShelfItemMenu.js';
import type { ItemMenuRequest } from './hooks/useShelfItemMenu.js';
import { useBookDeletion } from './hooks/useBookDeletion.js';
import { useFolderState } from './hooks/useFolderState.js';
import { useLibraryDrag } from './hooks/useLibraryDrag.js';
import { MAIN_VIEW_PHASE_MS, useMainView } from './hooks/useMainView.js';
import { useReaderSession } from './hooks/useReaderSession.js';
import { useReadingActivityDelivery } from './hooks/useReadingActivityDelivery.js';
import { useReadingDashboard } from './hooks/useReadingDashboard.js';
import { useReadingStatistics } from './hooks/useReadingStatistics.js';
import { useStatisticsRanking } from './hooks/useStatisticsRanking.js';
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
  const ranking = useStatisticsRanking(reducedMotion);
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
    mainView,
    requestedView,
    motionPhase,
    motionDirection,
    motionGeneration,
    motionInstant,
    selectMainView,
    finishPhase,
    setNavigationBlocked,
  } = useMainView({ readerActive: Boolean(readingBook), reducedMotion });
  // Delivers reading activity independently of any open reader. Only the dashboard observes
  // its status (while active); the shell never subscribes.
  const readingActivityDelivery = useReadingActivityDelivery();
  const homeViewRef = useRef<HTMLDivElement>(null);
  const shelfViewRef = useRef<HTMLDivElement>(null);
  const statisticsViewRef = useRef<HTMLDivElement>(null);
  const focusHandoffRef = useRef<HTMLButtonElement | null>(null);
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
  // 首页 statistics. Active only while 首页 is shown with no reader over it, so entering 首页
  // and closing a reader onto it refresh, and delivery status is observed only then.
  const readingDashboard = useReadingDashboard({
    active: mainView === MAIN_VIEW.HOME && !readingBook,
    delivery: readingActivityDelivery,
    selectedBookId: recentReadingItems[0]?.book.id ?? null,
  });
  const {
    closeGoalDialog,
    goalDialog,
    invalidate: invalidateReadingDashboard,
    openGoalDialog,
    refresh: refreshReadingDashboard,
    saveGoals: saveReadingGoals,
  } = readingDashboard;
  // 统计 page data. Like the dashboard it works only while its page is shown with no reader
  // over it; its dimension/period selection lives as long as App.
  const readingStatistics = useReadingStatistics({
    active: mainView === MAIN_VIEW.STATISTICS && !readingBook,
    delivery: readingActivityDelivery,
  });
  const { invalidate: invalidateReadingStatistics } = readingStatistics;
  const handleBookDeleted = useCallback(() => {
    invalidateReadingDashboard();
    invalidateReadingStatistics();
  }, [invalidateReadingDashboard, invalidateReadingStatistics]);
  const [recentSheetOpen, setRecentSheetOpen] = useState(false);
  const handleRecentSheetClosed = useCallback(() => setRecentSheetOpen(false), []);
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
  const itemMenu = useShelfItemMenu({ shelfItems, folderBooks, openFolder });
  const {
    deleteCandidateBook,
    handleCancelDeleteBook,
    handleConfirmDeleteBook,
    requestDeleteBook,
    isDeletingBook,
  } = useBookDeletion({
    clearReaderBookIfDeleted,
    loadShelf,
    onBookDeleted: handleBookDeleted,
    openFolder,
    refreshOpenFolderBooksOrClose,
    setError: setOperationError,
    setFolderError,
  });
  const {
    accessibility,
    activeDragModifier,
    activeDragPreview,
    activeDragWidth,
    appCollisionDetection,
    dragIntent,
    dragIntentAnnouncement,
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
    operations,
  } = useLibraryDrag({
    beginShelfProjection,
    folderBooks,
    folderCloseVersion,
    getFolderSession,
    isFolderSessionCurrent,
    isSavingFolderOrder,
    isSavingOrder,
    loadShelf,
    onDropOnDelete: requestDeleteBook,
    onRequestItemMenu: itemMenu.request,
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
  // A card's right-click or menu key never opens a menu underneath an active drag. The drag's
  // own still-release request is made after the drag ended and goes to `itemMenu.request`.
  const dragActiveRef = useRef(false);
  dragActiveRef.current = Boolean(activeDragPreview);
  const { request: requestItemMenu } = itemMenu;
  const handleRequestCardMenu = useCallback((request: ItemMenuRequest) => {
    if (!dragActiveRef.current) requestItemMenu(request);
  }, [requestItemMenu]);
  // The reader, an open/closing Folder, the delete and goal dialogs and an active drag each
  // own interaction; the main views cannot be switched underneath them.
  const isMainNavigationBlocked = Boolean(
    readingBook ||
    openFolder ||
    isFolderClosing ||
    deleteCandidateBook ||
    goalDialog ||
    recentSheetOpen ||
    itemMenu.menu ||
    ranking.session ||
    activeDragPreview,
  );

  useLayoutEffect(() => {
    setNavigationBlocked(isMainNavigationBlocked);
  }, [isMainNavigationBlocked, setNavigationBlocked]);

  const handleSaveReadingGoal = useCallback((kind: GoalKind, value: number) => (
    saveReadingGoals(kind === 'daily' ? { dailyMinutes: value } : { annualBooks: value })
  ), [saveReadingGoals]);

  const handleSelectMainView = useCallback((view: MainView) => {
    if (isMainNavigationBlocked) return;
    selectMainView(view);
  }, [isMainNavigationBlocked, selectMainView]);

  const handleOpenShelf = useCallback(() => {
    if (isMainNavigationBlocked || motionPhase !== 'idle') return;
    const source = homeViewRef.current;
    if (source?.contains(document.activeElement)) {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-main-navigation-view="${MAIN_VIEW.SHELF}"]`,
      );
      button?.focus({ preventScroll: true });
      focusHandoffRef.current = button;
    }
    handleSelectMainView(MAIN_VIEW.SHELF);
  }, [handleSelectMainView, isMainNavigationBlocked, motionPhase]);

  // A home CTA hands focus through the stable navigation button while both moving pages
  // are inert. Do not steal focus if the user moved it during the transition.
  useLayoutEffect(() => {
    if (motionPhase !== 'idle' || !focusHandoffRef.current) return;
    const anchor = focusHandoffRef.current;
    focusHandoffRef.current = null;
    if (isMainNavigationBlocked || document.activeElement !== anchor) return;
    const viewRefs = {
      [MAIN_VIEW.HOME]: homeViewRef,
      [MAIN_VIEW.SHELF]: shelfViewRef,
      [MAIN_VIEW.STATISTICS]: statisticsViewRef,
    };
    viewRefs[mainView].current?.focus({ preventScroll: true });
  }, [isMainNavigationBlocked, mainView, motionPhase]);

  const handleMainViewTransitionEnd = useCallback((event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'opacity') return;
    if (motionPhase !== 'exiting' && motionPhase !== 'entering' && motionPhase !== 'restoring') return;
    // A transitionend queued by the page we just hid must not finish the new page's entry.
    if (event.currentTarget.dataset.mainView !== mainView || event.currentTarget.hidden) return;
    finishPhase(motionPhase, motionGeneration);
  }, [finishPhase, mainView, motionGeneration, motionPhase]);

  // Stable so the memoized shelf cards survive a DndContext re-render.
  const handleOpenBook = useCallback((book: Book, originRect: DOMRect | null) => {
    if (motionPhase !== 'idle') return;
    openBook(book, originRect, { disabled: isSavingOrder });
  }, [isSavingOrder, motionPhase, openBook]);

  const handleReaderProgressSettled = useCallback(() => {
    reapplyPendingReadingPositions();
    void loadShelf({ background: true, allowCached: false });
  }, [loadShelf, reapplyPendingReadingPositions]);

  const handleBookUnavailable = useCallback((bookId: number) => {
    clearReaderBookIfDeleted(bookId);
    void loadShelf();
  }, [clearReaderBookIfDeleted, loadShelf]);

  const handleOpenFolder = useCallback((folder: Folder, originRect: DOMRect | null, options?: { startRename?: boolean }) => {
    if (motionPhase !== 'idle') return;
    openFolderFromShelf(folder, {
      startRename: options?.startRename,
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
    motionPhase,
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
      accessibility={accessibility}
      modifiers={[activeDragModifier]}
      sensors={sensors}
      collisionDetection={appCollisionDetection}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragStart={motionPhase === 'idle' ? handleDragStart : undefined}
    >
      <div className="visually-hidden" role="status" aria-atomic="true">{dragIntentAnnouncement}</div>
      <main className="app-shell has-main-navigation" aria-label="EPUB Reader"
        style={{
          '--main-view-phase-duration': `${MAIN_VIEW_PHASE_MS}ms`,
          '--main-navigation-duration': `${MAIN_VIEW_PHASE_MS * 2}ms`,
        } as CSSProperties}>
        {/* Every main view stays mounted so shelf search/view/sort, the statistics selection,
            grid and scroll context survive a round trip. A hidden view is display:none and
            inert: it takes no focus, has no laid-out cover for reader transitions, and
            cannot start a drag. */}
        <div
          ref={homeViewRef}
          className="main-view"
          data-main-view={MAIN_VIEW.HOME}
          data-motion-phase={mainView === MAIN_VIEW.HOME ? motionPhase : undefined}
          data-motion-direction={mainView === MAIN_VIEW.HOME ? motionDirection : undefined}
          data-motion-instant={mainView === MAIN_VIEW.HOME && motionInstant ? '' : undefined}
          hidden={mainView !== MAIN_VIEW.HOME}
          inert={mainView !== MAIN_VIEW.HOME || recentSheetOpen || Boolean(itemMenu.menu) || Boolean(ranking.session) || motionPhase !== 'idle'}
          tabIndex={-1}
          onTransitionEnd={handleMainViewTransitionEnd}
        >
          <ReadingHome
            catalogBooks={catalogBooks}
            catalogError={catalogError}
            hasLoadedCatalog={hasLoadedCatalog}
            onRetryCatalog={loadCatalog}
            onOpenRecent={() => setRecentSheetOpen(true)}
            goalDialog={goalDialog}
            hasLoadedRecentReading={hasLoadedShelf}
            onCloseGoalDialog={closeGoalDialog}
            onEditGoal={openGoalDialog}
            onOpenBook={handleOpenBook}
            onOpenShelf={handleOpenShelf}
            onRetryReadingStats={refreshReadingDashboard}
            onRetryRecentReading={loadShelf}
            onSaveGoal={handleSaveReadingGoal}
            readingActivityNotice={readingDashboard.deliveryNotice}
            readingStats={readingDashboard.stats}
            readingStatsError={readingDashboard.error}
            recentReadingError={shelfError}
            recentReadingItems={recentReadingItems}
          />
        </div>
        <div
          ref={shelfViewRef}
          className="main-view"
          data-main-view={MAIN_VIEW.SHELF}
          data-motion-phase={mainView === MAIN_VIEW.SHELF ? motionPhase : undefined}
          data-motion-direction={mainView === MAIN_VIEW.SHELF ? motionDirection : undefined}
          data-motion-instant={mainView === MAIN_VIEW.SHELF && motionInstant ? '' : undefined}
          hidden={mainView !== MAIN_VIEW.SHELF}
          inert={mainView !== MAIN_VIEW.SHELF || recentSheetOpen || Boolean(itemMenu.menu) || Boolean(ranking.session) || motionPhase !== 'idle'}
          tabIndex={-1}
          onTransitionEnd={handleMainViewTransitionEnd}
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
            onRequestItemMenu={handleRequestCardMenu}
            onOpenFolder={handleOpenFolder}
            onRetryCatalog={loadCatalog}
            onRetryShelf={loadShelf}
            shelfItems={shelfItems}
            uploadProgress={uploadProgress}
          />
        </div>
        <div
          ref={statisticsViewRef}
          className="main-view"
          data-main-view={MAIN_VIEW.STATISTICS}
          data-motion-phase={mainView === MAIN_VIEW.STATISTICS ? motionPhase : undefined}
          data-motion-direction={mainView === MAIN_VIEW.STATISTICS ? motionDirection : undefined}
          data-motion-instant={mainView === MAIN_VIEW.STATISTICS && motionInstant ? '' : undefined}
          hidden={mainView !== MAIN_VIEW.STATISTICS}
          inert={mainView !== MAIN_VIEW.STATISTICS || recentSheetOpen || Boolean(itemMenu.menu) || Boolean(ranking.session) || motionPhase !== 'idle'}
          tabIndex={-1}
          onTransitionEnd={handleMainViewTransitionEnd}
        >
          <ReadingStatistics model={ranking.session
            ? { ...readingStatistics, statistics: ranking.session.statistics, title: ranking.session.title }
            : readingStatistics} onOpenRanking={opener => {
              if (isMainNavigationBlocked || motionPhase !== 'idle' || !readingStatistics.statistics) return;
              ranking.open(readingStatistics.statistics, readingStatistics.title, opener);
            }} />
        </div>
        {ranking.session ? <StatisticsRankingDetail ranking={ranking.session.statistics.ranking}
          title={ranking.session.title} phase={ranking.session.phase} onClose={ranking.close} /> : null}
        {isMainNavigationBlocked ? null : (
          <MainNavigation activeView={mainView} visualView={requestedView}
            onSelectView={handleSelectMainView} />
        )}
        {recentSheetOpen ? <RecentReadingSheet items={recentReadingItems}
          onClose={handleRecentSheetClosed}
          onOpenBook={(book, rect) => { setRecentSheetOpen(false); handleOpenBook(book, rect); }} /> : null}
        <FolderOverlay
          menuOpen={Boolean(itemMenu.menu)}
          onRequestItemMenu={handleRequestCardMenu}
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
              activitySink={readingActivityDelivery}
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
        {itemMenu.menu ? <ShelfItemMenu {...itemMenu.menu} shelfItems={shelfItems}
          isSaving={isSavingOrder || isSavingFolderOrder} operations={operations} onClose={itemMenu.close}
          onOpenBook={handleOpenBook} onOpenFolder={handleOpenFolder} onDelete={requestDeleteBook} /> : null}
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
        width={activeDragWidth}
      />
    </DndContext>
  );
}

export default App;

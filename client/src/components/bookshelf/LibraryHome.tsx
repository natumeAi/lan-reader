import type { ChangeEventHandler, RefObject } from 'react';
import type { CatalogBook, ShelfItem } from '../../types/library.js';
import type { DragIntent, ShelfMutationFeedback } from '../../hooks/useLibraryDrag.js';
import type { ShelfItemActions } from './ReadOnlyShelfItem.js';
import type { UploadEntry } from '../../hooks/useUploadBooks.js';
import type { UploadPlaceholderActions } from './UploadPlaceholderCard.js';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ShelfOperations } from '../../hooks/useShelfOperations.js';
import { useShelfSelection } from '../../hooks/useShelfSelection.js';
import { useBookDeletion } from '../../hooks/useBookDeletion.js';
import { ActionSheet } from '../common/ActionSheet.js';
import { FolderPicker } from './FolderPicker.js';
import { SelectionActionBar } from './SelectionActionBar.js';
import { DeleteConfirmDialog } from './DeleteConfirmDialog.js';
import { useLibraryView } from '../../hooks/useLibraryView.js';
import { useStuckState } from '../../hooks/useStuckState.js';
import { normalizeLibrarySearchText } from '../../utils/libraryView.js';
import { LibraryGrid } from './LibraryGrid.js';
import { LibrarySearchBar } from './LibrarySearchBar.js';
import { LibraryViewToolbar } from './LibraryViewToolbar.js';

interface LibraryHomeProps extends ShelfItemActions, UploadPlaceholderActions {
  uploadEntries?: readonly UploadEntry[];
  onUploadsReplaced?: (ids: readonly string[]) => void;
  importRejection?: string;
  operations?: ShelfOperations;
  onSelectionActiveChange?: (active: boolean) => void;
  onBookDeleted?: (id: number) => void;
  onOperationErrorChange?: (message: string) => void;
  catalogBooks: CatalogBook[];
  catalogError: string;
  dragIntent: DragIntent;
  fileInputRef: RefObject<HTMLInputElement | null>;
  hasLoadedCatalog: boolean;
  hasLoadedShelf: boolean;
  isCatalogLoading: boolean;
  isLoading: boolean;
  isSavingOrder: boolean;
  isUploading: boolean;
  landingKey: string | null;
  mutationFeedback: ShelfMutationFeedback;
  onFileChange: ChangeEventHandler<HTMLInputElement>;
  onRetryCatalog: () => void;
  onRetryShelf: () => void;
  onSortMenuOpenChange?: (open: boolean) => void;
  operationError: string;
  shelfError: string;
  shelfItems: ShelfItem[];
  uploadProgress: string;
}


export function LibraryHome({
  uploadEntries,
  onRetryUpload,
  onRemoveUpload,
  onUploadsReplaced,
  importRejection = '',
  operations,
  onSelectionActiveChange,
  onBookDeleted,
  onOperationErrorChange,
  catalogBooks,
  catalogError,
  dragIntent,
  fileInputRef,
  hasLoadedCatalog,
  hasLoadedShelf,
  isCatalogLoading,
  isLoading,
  isSavingOrder,
  isUploading,
  landingKey,
  mutationFeedback,
  onFileChange,
  onOpenBook,
  onOpenFolder,
  onRequestItemMenu,
  onRetryCatalog,
  onRetryShelf,
  onSortMenuOpenChange,
  operationError,
  shelfError,
  shelfItems,
  uploadProgress,
}: LibraryHomeProps) {
  const libraryView = useLibraryView({ shelfItems, catalogBooks });
  const markLanding = operations?.markLanding;
  useLayoutEffect(() => {
    if (!markLanding || !onUploadsReplaced || !uploadEntries?.length) return;
    const keys = new Set(shelfItems.map(item => item.key));
    const arrived = uploadEntries.filter(entry => entry.status === 'uploaded' && keys.has(`book:${entry.bookId}`));
    if (!arrived.length) return;
    arrived.forEach(entry => markLanding(`book:${entry.bookId}`));
    onUploadsReplaced(arrived.map(entry => entry.id));
  }, [markLanding, onUploadsReplaced, shelfItems, uploadEntries]);
  const selection = useShelfSelection(libraryView.visibleItems, isSavingOrder);
  const [picker, setPicker] = useState<{ opener: HTMLElement; anchorRect: DOMRect } | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const folders = shelfItems.flatMap(item => item.type === 'folder' ? [item.folder] : []);
  const selectedBooks = useMemo(() => libraryView.visibleItems.flatMap(item =>
    item.type === 'book' && selection.keys.has(item.key) ? [item.book] : []), [libraryView.visibleItems, selection.keys]);
  const deletion = useBookDeletion({ batchDelete: operations?.batchDelete, onBookDeleted,
    onBatchDeleted: selection.exit, setError: onOperationErrorChange });
  const closePicker = useCallback(() => setPicker(null), []);
  const modalOpen = Boolean(picker || deletion.deleteCandidateBooks);
  useLayoutEffect(() => {
    onSelectionActiveChange?.(selection.active);
  }, [onSelectionActiveChange, selection.active]);
  // Modal owners stop propagation: Escape dismisses the top sheet/dialog before selection.
  useLayoutEffect(() => {
    if (!selection.active || modalOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); selection.exit();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [modalOpen, selection.active, selection.exit]);
  const wasSelecting = useRef(false);
  useLayoutEffect(() => {
    if (!wasSelecting.current && selection.active) {
      const firstBook = sectionRef.current?.querySelector<HTMLElement>('.shelf-grid button[aria-pressed]');
      const done = sectionRef.current?.querySelector<HTMLElement>('.library-selection-controls button:last-child');
      (firstBook ?? done)?.focus({ preventScroll: true });
    } else if (wasSelecting.current && !selection.active) {
      const controls = sectionRef.current?.querySelector<HTMLElement>('.library-selection-controls');
      const button = controls?.querySelector<HTMLButtonElement>('button');
      (button && !button.disabled ? button : controls)?.focus({ preventScroll: true });
    }
    wasSelecting.current = selection.active;
  }, [selection.active]);
  const { clearSearch } = libraryView;
  const { isStuck, sentinelRef, stickyRef } = useStuckState();
  const savedScrollTopRef = useRef(0);
  // Same criterion as the mode announcement: focusing the box without typing is still the list.
  const subtitle = normalizeLibrarySearchText(libraryView.query)
    ? `${libraryView.resultCount} 个结果`
    : `${libraryView.resultCount} 项`;
  const selectionDisabled = isSavingOrder || isUploading;
  const visibleBookCount = libraryView.visibleItems.filter(item => item.type === 'book').length;
  const catalogControlsDisabled =
    isCatalogLoading || Boolean(catalogError) || !hasLoadedCatalog;
  const operationStatus = isUploading
    ? uploadProgress || '正在上传'
    : isSavingOrder
      ? mutationFeedback.status === 'pending' && mutationFeedback.intent === 'delete'
        ? '正在删除书籍'
        : mutationFeedback.status === 'pending' && (mutationFeedback.intent === 'absorb' || mutationFeedback.intent === 'move-out')
          ? '正在移动书籍'
          : '正在保存顺序'
      : isCatalogLoading
        ? '正在加载搜索目录'
        : isLoading && hasLoadedShelf
          ? '正在更新书架'
          : '';

  function handleSearchFocus() {
    if (!libraryView.searchMode) savedScrollTopRef.current = window.scrollY;
    libraryView.focusSearch();
  }

  const restoreSearch = useCallback((action: () => void) => {
    action();
    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScrollTopRef.current, behavior: 'auto' });
    });
  }, []);

  // Stable callbacks, so the memoized grid is not re-rendered by unrelated renders.
  const handleClearSearch = useCallback(() => {
    restoreSearch(clearSearch);
  }, [clearSearch, restoreSearch]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, [fileInputRef]);

  return (
    <section className="library-home" ref={sectionRef}>
      <div className="library-selection-content" inert={modalOpen}>
      <div className="library-header">
        <div>
          <h1>我的书架</h1>
          <p className="library-subtitle">
            {selection.active
              ? <span role="status" aria-live="polite" aria-atomic="true">已选 {selection.keys.size} 本</span>
              : subtitle}
          </p>
        </div>

        <div className="library-selection-controls" tabIndex={-1}>
          {selection.active ? <>
            <button type="button" onClick={selection.selectAll} disabled={selectionDisabled || !visibleBookCount}>全选</button>
            <button type="button" className="is-done" onClick={selection.exit} disabled={selectionDisabled}>完成</button>
          </> : <>
            <button type="button" onClick={selection.enter} disabled={selectionDisabled}>选择</button>
            <button
              className="upload-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="上传 EPUB"
            >
              <span className="upload-button-icon" aria-hidden="true" />
            </button>
          </>}
        </div>
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept=".epub,application/epub+zip"
          multiple
          onChange={onFileChange}
        />
      </div>

      <div ref={sentinelRef} className="library-search-sentinel" aria-hidden="true" />
      <div
        ref={stickyRef}
        className={isStuck ? 'library-search-shell is-stuck' : 'library-search-shell'}
      >
        <LibrarySearchBar
          bookCount={catalogBooks.length}
          catalogError={catalogError}
          isCatalogLoading={isCatalogLoading}
          query={libraryView.query}
          searchMode={libraryView.searchMode}
          onCancel={() => restoreSearch(libraryView.cancelSearch)}
          onClear={() => restoreSearch(libraryView.clearSearch)}
          onFocus={handleSearchFocus}
          onQueryChange={libraryView.changeQuery}
          onRetry={onRetryCatalog}
        />
      </div>

      {shelfError ? (
        <div className="library-shelf-error" role="alert">
          <span>{shelfError}</span>
          <button
            className="library-error-action"
            type="button"
            onClick={onRetryShelf}
          >
            重试加载书架
          </button>
        </div>
      ) : null}

      {operationError ? (
        <div className="library-operation-error" role="alert">
          <span>{operationError}</span>
        </div>
      ) : null}

      {importRejection ? <p className="library-operation-error" role="alert">{importRejection}</p> : null}

      <p
        className="status-message library-operation-status"
        role="status"
        aria-live="polite"
      >
        {operationStatus}
      </p>

      <LibraryViewToolbar
        selecting={selection.active}
        controlsDisabled={catalogControlsDisabled}
        editable={libraryView.editable}
        modeLabel={libraryView.modeLabel}
        onSortChange={libraryView.selectSort}
        onViewChange={libraryView.selectView}
        onSortMenuOpenChange={onSortMenuOpenChange}
        searchMode={libraryView.searchMode}
        sort={libraryView.sort}
        sortOptions={libraryView.sortOptions}
        view={libraryView.view}
      />

      <LibraryGrid
        uploadEntries={uploadEntries}
        onRetryUpload={onRetryUpload}
        onRemoveUpload={onRemoveUpload}
        landingKeys={operations?.landingKeys}
        selection={selection}
        dragIntent={dragIntent}
        editable={libraryView.editable}
        hasLoadedShelf={hasLoadedShelf}
        isLoading={isLoading}
        isSavingOrder={isSavingOrder}
        items={libraryView.visibleItems}
        landingKey={landingKey}
        mutationFeedback={mutationFeedback}
        onClearSearch={handleClearSearch}
        onImport={handleImport}
        onOpenBook={onOpenBook}
        onOpenFolder={onOpenFolder}
        onRequestItemMenu={onRequestItemMenu}
        query={libraryView.query}
        searchMode={libraryView.searchMode}
        view={libraryView.view}
      />
      {selection.active ? <SelectionActionBar books={selectedBooks} hasFolders={Boolean(folders.length)}
        disabled={isSavingOrder || !operations} onMoveToFolder={event => {
          const opener = event.currentTarget;
          setPicker({ opener, anchorRect: opener.getBoundingClientRect() });
        }} onMoveToShelf={() => {
          if (operations) void operations.batchMoveToShelf(selectedBooks, selection.exit);
        }} onDelete={event => {
          deleteOpenerRef.current = event.currentTarget;
          deletion.requestDeleteBooks(selectedBooks);
        }} /> : null}
      </div>
      {picker ? <ActionSheet title="移到文件夹" anchorRect={picker.anchorRect} returnFocusElement={picker.opener} onClose={closePicker}>
        <FolderPicker folders={folders} disabled={isSavingOrder} onSelect={folder => {
          if (!operations || isSavingOrder) return;
          closePicker();
          void operations.batchMoveToFolder(selectedBooks, folder, selection.exit);
        }} />
      </ActionSheet> : null}
      <DeleteConfirmDialog books={deletion.deleteCandidateBooks ?? undefined} isDeleting={deletion.isDeletingBook}
        error={deletion.deleteCandidateBooks ? operationError : undefined} returnFocusElement={deleteOpenerRef.current}
        onCancel={deletion.handleCancelDeleteBook} onConfirm={deletion.handleConfirmDeleteBooks} />
    </section>
  );
}

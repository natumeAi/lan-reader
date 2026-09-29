import type { ChangeEventHandler, RefObject } from 'react';
import type { CatalogBook, ShelfItem } from '../../types/library.js';
import type { DragIntent, ShelfMutationFeedback } from '../../hooks/useLibraryDrag.js';
import type { ShelfItemActions } from './ReadOnlyShelfItem.js';
import { useCallback, useRef } from 'react';
import { useLibraryView } from '../../hooks/useLibraryView.js';
import { useStuckState } from '../../hooks/useStuckState.js';
import { normalizeLibrarySearchText } from '../../utils/libraryView.js';
import { LibraryGrid } from './LibraryGrid.js';
import { LibrarySearchBar } from './LibrarySearchBar.js';
import { LibraryViewToolbar } from './LibraryViewToolbar.js';

interface LibraryHomeProps extends ShelfItemActions {
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
  operationError: string;
  shelfError: string;
  shelfItems: ShelfItem[];
  uploadProgress: string;
}


export function LibraryHome({
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
  onRetryCatalog,
  onRetryShelf,
  operationError,
  shelfError,
  shelfItems,
  uploadProgress,
}: LibraryHomeProps) {
  const libraryView = useLibraryView({ shelfItems, catalogBooks });
  const { clearSearch } = libraryView;
  const { isStuck, sentinelRef, stickyRef } = useStuckState();
  const savedScrollTopRef = useRef(0);
  // Same criterion as the mode announcement: focusing the box without typing is still the list.
  const subtitle = normalizeLibrarySearchText(libraryView.query)
    ? `${libraryView.resultCount} 个结果`
    : `${libraryView.resultCount} 项`;
  const catalogControlsDisabled =
    isCatalogLoading || Boolean(catalogError) || !hasLoadedCatalog;
  const operationStatus = isUploading
    ? uploadProgress || '正在上传'
    : isSavingOrder
      ? '正在保存顺序'
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
    <section className="library-home">
      <div className="library-header">
        <div>
          <h1>我的书架</h1>
          <p className="library-subtitle">{subtitle}</p>
        </div>

        <button
          className="upload-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          aria-label="上传 EPUB"
        >
          <span className="upload-button-icon" aria-hidden="true" />
        </button>
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

      <p
        className="status-message library-operation-status"
        role="status"
        aria-live="polite"
      >
        {operationStatus}
      </p>

      <LibraryViewToolbar
        controlsDisabled={catalogControlsDisabled}
        editable={libraryView.editable}
        modeLabel={libraryView.modeLabel}
        onSortChange={libraryView.selectSort}
        onViewChange={libraryView.selectView}
        sort={libraryView.sort}
        sortOptions={libraryView.sortOptions}
        view={libraryView.view}
      />

      <LibraryGrid
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
        query={libraryView.query}
        view={libraryView.view}
      />
    </section>
  );
}

import { useRef } from 'react';
import { useLibraryView } from '../../hooks/useLibraryView.js';
import { ContinueReadingSection } from './ContinueReadingSection.jsx';
import { LibraryGrid } from './LibraryGrid.jsx';
import { LibrarySearchBar } from './LibrarySearchBar.jsx';
import { LibraryViewToolbar } from './LibraryViewToolbar.jsx';

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
  onFileChange,
  onOpenBook,
  onOpenFolder,
  onRetryCatalog,
  onRetryShelf,
  operationError,
  recentReadingItems,
  shelfError,
  shelfItems,
  uploadProgress,
}) {
  const libraryView = useLibraryView({ shelfItems, catalogBooks });
  const savedScrollTopRef = useRef(0);
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

  function restoreSearch(action) {
    action();
    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScrollTopRef.current, behavior: 'auto' });
    });
  }

  return (
    <section className="library-home">
      <div className="library-header">
        <div>
          <p className="eyebrow">Library</p>
          <h1>我的书架</h1>
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

      <div className="library-search-shell">
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

      <ContinueReadingSection
        items={recentReadingItems}
        onOpenBook={onOpenBook}
        searchMode={libraryView.searchMode}
      />

      <LibraryViewToolbar
        controlsDisabled={catalogControlsDisabled}
        editable={libraryView.editable}
        modeLabel={libraryView.modeLabel}
        onSortChange={libraryView.selectSort}
        onViewChange={libraryView.selectView}
        resultCount={libraryView.resultCount}
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
        onClearSearch={() => restoreSearch(libraryView.clearSearch)}
        onImport={() => fileInputRef.current?.click()}
        onOpenBook={onOpenBook}
        onOpenFolder={onOpenFolder}
        query={libraryView.query}
        view={libraryView.view}
      />
    </section>
  );
}

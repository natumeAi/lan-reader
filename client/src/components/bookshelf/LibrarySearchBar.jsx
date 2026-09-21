export function LibrarySearchBar({
  bookCount,
  catalogError,
  isCatalogLoading,
  onCancel,
  onClear,
  onFocus,
  onQueryChange,
  onRetry,
  query,
  searchMode,
}) {
  return (
    <div className="library-search" role="search">
      <div className="library-search-control">
        <span className="library-search-icon" aria-hidden="true" />
        <input
          id="library-search-input"
          className="library-search-input"
          type="search"
          aria-label="搜索书名、作者或文件夹"
          autoComplete="off"
          disabled={isCatalogLoading || Boolean(catalogError)}
          placeholder={isCatalogLoading ? '正在加载搜索目录' : `搜索 ${bookCount} 本书`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={onFocus}
        />
        {query ? (
          <button className="library-search-clear" type="button" onClick={onClear}>
            清空搜索
          </button>
        ) : null}
        {searchMode ? (
          <button className="library-search-cancel" type="button" onClick={onCancel}>
            取消搜索
          </button>
        ) : null}
      </div>
      {catalogError ? (
        <div className="library-catalog-error" role="alert">
          <span>搜索目录加载失败</span>
          <button type="button" onClick={onRetry} aria-label="重试加载搜索目录">
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}

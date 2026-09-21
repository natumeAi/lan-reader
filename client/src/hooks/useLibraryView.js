import { useCallback, useMemo, useRef, useState } from 'react';
import {
  deriveVisibleLibraryItems,
  getLibrarySortOptions,
  LIBRARY_SORT,
  LIBRARY_VIEW,
  normalizeLibrarySearchText,
} from '../utils/libraryView.js';
import {
  getLibrarySortPreference,
  loadLibrarySortPreferences,
  rememberLibrarySortPreference,
} from '../utils/libraryViewPreferences.js';

const allowedSorts = new Set(Object.values(LIBRARY_SORT));
const allowedViews = new Set(Object.values(LIBRARY_VIEW));

const viewLabels = Object.freeze({
  [LIBRARY_VIEW.ALL]: '全部',
  [LIBRARY_VIEW.RECENT_ADDED]: '最近添加',
  [LIBRARY_VIEW.FOLDERS]: '文件夹',
});

export function useLibraryView({ shelfItems, catalogBooks }) {
  const [initialSortPreferences] = useState(loadLibrarySortPreferences);
  const sortPreferencesRef = useRef(initialSortPreferences);
  const [query, setQuery] = useState('');
  const [view, setView] = useState(LIBRARY_VIEW.ALL);
  const [sort, setSort] = useState(() => getLibrarySortPreference(
    initialSortPreferences,
    LIBRARY_VIEW.ALL,
  ));
  const [searchFocused, setSearchFocused] = useState(false);
  const searchSnapshotRef = useRef(null);
  const normalizedQuery = normalizeLibrarySearchText(query);
  const searchMode = searchFocused || Boolean(normalizedQuery);

  const focusSearch = useCallback(() => {
    if (!searchSnapshotRef.current) {
      searchSnapshotRef.current = { view, sort };
    }
    setSearchFocused(true);
    if (sort === LIBRARY_SORT.MANUAL || view === LIBRARY_VIEW.FOLDERS) {
      setSort(LIBRARY_SORT.TITLE);
    }
  }, [sort, view]);

  const changeQuery = useCallback((value) => {
    setQuery(value);
  }, []);

  const restoreSearchSnapshot = useCallback(() => {
    const snapshot = searchSnapshotRef.current;
    setQuery('');
    setSearchFocused(false);
    if (snapshot) {
      setView(snapshot.view);
      setSort(snapshot.sort);
    }
    searchSnapshotRef.current = null;
  }, []);

  const selectView = useCallback((nextView) => {
    if (!allowedViews.has(nextView)) return;
    setQuery('');
    setSearchFocused(false);
    searchSnapshotRef.current = null;
    setView(nextView);
    setSort(getLibrarySortPreference(sortPreferencesRef.current, nextView));
  }, []);

  const selectSort = useCallback((nextSort) => {
    if (!allowedSorts.has(nextSort)) return;

    setSort(nextSort);
    if (searchMode) return;

    sortPreferencesRef.current = rememberLibrarySortPreference(
      sortPreferencesRef.current,
      view,
      nextSort,
    );
  }, [searchMode, view]);

  const visibleItems = useMemo(() => deriveVisibleLibraryItems({
    shelfItems,
    catalogBooks,
    query,
    view,
    sort,
  }), [catalogBooks, query, shelfItems, sort, view]);
  const editable = !normalizedQuery &&
    view === LIBRARY_VIEW.ALL &&
    sort === LIBRARY_SORT.MANUAL;
  const resultCount = visibleItems.length;
  const modeLabel = normalizedQuery
    ? `搜索“${query.trim()}”，${resultCount} 项结果`
    : `${viewLabels[view]}，${resultCount} 项${editable ? '' : '，只读视图'}`;
  const sortOptions = useMemo(
    () => getLibrarySortOptions({ view, searchMode }),
    [searchMode, view],
  );

  return {
    query,
    view,
    sort,
    searchFocused,
    focusSearch,
    changeQuery,
    clearSearch: restoreSearchSnapshot,
    cancelSearch: restoreSearchSnapshot,
    selectView,
    selectSort,
    visibleItems,
    resultCount,
    searchMode,
    editable,
    modeLabel,
    sortOptions,
  };
}

import { LIBRARY_SORT, LIBRARY_VIEW } from './libraryView.js';

export const LIBRARY_SORT_PREFERENCES_STORAGE_KEY =
  'epub-reader:library-sort-preferences';

const rememberedViews = Object.freeze([
  LIBRARY_VIEW.ALL,
  LIBRARY_VIEW.RECENT_ADDED,
]);

const allowedSortsByView = Object.freeze({
  [LIBRARY_VIEW.ALL]: new Set(Object.values(LIBRARY_SORT)),
  [LIBRARY_VIEW.RECENT_ADDED]: new Set([
    LIBRARY_SORT.RECENT_READING,
    LIBRARY_SORT.RECENT_ADDED,
    LIBRARY_SORT.TITLE,
    LIBRARY_SORT.AUTHOR,
  ]),
});

export function getDefaultLibrarySort(view) {
  if (view === LIBRARY_VIEW.RECENT_ADDED) return LIBRARY_SORT.RECENT_ADDED;
  return LIBRARY_SORT.MANUAL;
}

function browserStorage() {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage) {
  return storage === undefined ? browserStorage() : storage;
}

function isAllowedSort(view, sort) {
  return allowedSortsByView[view]?.has(sort) === true;
}

export function normalizeLibrarySortPreferences(preferences) {
  const normalized = {};

  for (const view of rememberedViews) {
    const sort = preferences?.[view];
    normalized[view] = isAllowedSort(view, sort)
      ? sort
      : getDefaultLibrarySort(view);
  }

  return normalized;
}

export function loadLibrarySortPreferences(storage) {
  try {
    const value = resolveStorage(storage)?.getItem(
      LIBRARY_SORT_PREFERENCES_STORAGE_KEY,
    );
    return value
      ? normalizeLibrarySortPreferences(JSON.parse(value))
      : normalizeLibrarySortPreferences(null);
  } catch {
    return normalizeLibrarySortPreferences(null);
  }
}

export function saveLibrarySortPreferences(preferences, storage) {
  const normalized = normalizeLibrarySortPreferences(preferences);

  try {
    resolveStorage(storage)?.setItem(
      LIBRARY_SORT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // Ignore unavailable storage; this session can still use the selected sort.
  }

  return normalized;
}

export function rememberLibrarySortPreference(
  preferences,
  view,
  sort,
  storage,
) {
  const normalized = normalizeLibrarySortPreferences(preferences);
  if (!isAllowedSort(view, sort)) return normalized;

  return saveLibrarySortPreferences({
    ...normalized,
    [view]: sort,
  }, storage);
}

export function getLibrarySortPreference(preferences, view) {
  const sort = preferences?.[view];
  return isAllowedSort(view, sort) ? sort : getDefaultLibrarySort(view);
}

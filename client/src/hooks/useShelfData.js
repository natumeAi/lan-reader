import { useCallback, useEffect, useRef, useState } from 'react';
import { getLibrarySnapshot } from '../api/libraryApi.js';
import { hydrateLibrarySnapshot } from '../utils/librarySnapshot.js';
import {
  loadCachedLibrarySnapshot,
  saveCachedLibrarySnapshot,
} from '../utils/librarySnapshotCache.js';
import { normalizeShelfItem } from '../utils/libraryItems.js';
import { readProgressOutbox } from '../utils/readingProgress.js';
import { useUploadBooks } from './useUploadBooks.js';

const REVALIDATE_THROTTLE_MS = 2000;

export function useShelfData({ restoreReaderBook } = {}) {
  const [shelfItems, setShelfItems] = useState([]);
  const [recentReadingItems, setRecentReadingItems] = useState([]);
  const [folderBooksByFolderId, setFolderBooksByFolderId] = useState(() => new Map());
  const [hasLoadedShelf, setHasLoadedShelf] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [shelfError, setShelfError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [catalogBooks, setCatalogBooks] = useState([]);
  const [catalogError, setCatalogError] = useState('');
  const [hasLoadedCatalog, setHasLoadedCatalog] = useState(false);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const snapshotRequestRef = useRef({
    controller: null,
    requestId: 0,
  });
  const latestSnapshotRecordRef = useRef(null);
  const latestHydratedStateRef = useRef(null);
  const hasAppliedSnapshotRef = useRef(false);
  const lastRevalidateAtRef = useRef(0);

  const applySnapshot = useCallback((snapshot) => {
    const hydrated = hydrateLibrarySnapshot(snapshot, {
      pendingProgressRecords: readProgressOutbox(),
    });
    const shouldRestoreReader = !hasAppliedSnapshotRef.current;

    hasAppliedSnapshotRef.current = true;
    latestHydratedStateRef.current = hydrated;
    setShelfItems(hydrated.shelfData.items);
    setCatalogBooks(hydrated.catalogData.books);
    setRecentReadingItems(hydrated.recentData.items);
    setFolderBooksByFolderId(hydrated.folderBooksByFolderId);
    setHasLoadedShelf(true);
    setHasLoadedCatalog(true);
    setShelfError('');
    setCatalogError('');

    if (shouldRestoreReader) {
      restoreReaderBook?.(hydrated.shelfData, hydrated.recentData);
    }

    return hydrated;
  }, [restoreReaderBook]);

  const beginSnapshotRequest = useCallback(() => {
    snapshotRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const request = {
      controller,
      requestId: snapshotRequestRef.current.requestId + 1,
    };
    snapshotRequestRef.current = request;
    return request;
  }, []);

  const isCurrentSnapshotRequest = useCallback((request) => (
    snapshotRequestRef.current.requestId === request.requestId &&
    snapshotRequestRef.current.controller === request.controller
  ), []);

  const loadShelf = useCallback(async (options = {}) => {
    const background = options?.background === true;
    const allowCached = options?.allowCached ?? !hasAppliedSnapshotRef.current;
    const request = beginSnapshotRequest();
    let hasUsableState = hasAppliedSnapshotRef.current;
    let snapshotRecord = latestSnapshotRecordRef.current;

    if (!background) {
      setIsLoading(true);
      setIsCatalogLoading(true);
      setShelfError('');
      setCatalogError('');
    }

    if (allowCached && !hasUsableState) {
      try {
        const cachedRecord = await loadCachedLibrarySnapshot();
        if (!isCurrentSnapshotRequest(request)) return null;

        if (cachedRecord?.snapshot) {
          applySnapshot(cachedRecord.snapshot);
          latestSnapshotRecordRef.current = cachedRecord;
          snapshotRecord = cachedRecord;
          hasUsableState = true;
          setIsLoading(false);
          setIsCatalogLoading(false);
        }
      } catch {
        // IndexedDB may be unavailable or contain an obsolete entry; the network remains authoritative.
      }
    }

    try {
      const response = await getLibrarySnapshot({
        etag: snapshotRecord?.etag,
        signal: request.controller.signal,
      });
      if (!isCurrentSnapshotRequest(request)) return null;

      if (!response.notModified && response.snapshot) {
        const hydrated = applySnapshot(response.snapshot);
        const nextRecord = {
          etag: response.etag,
          snapshot: response.snapshot,
        };
        latestSnapshotRecordRef.current = nextRecord;
        hasUsableState = true;
        void saveCachedLibrarySnapshot(nextRecord).catch(() => {});
        return hydrated;
      }

      setShelfError('');
      setCatalogError('');
      return latestHydratedStateRef.current;
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrentSnapshotRequest(request)) {
        return null;
      }

      if (!hasUsableState) {
        const message = error.message || '无法加载书架';
        setShelfError(message);
        setCatalogError(message);
      }
      return null;
    } finally {
      if (isCurrentSnapshotRequest(request)) {
        setHasLoadedShelf(true);
        setHasLoadedCatalog(true);
        setIsLoading(false);
        setIsCatalogLoading(false);
        snapshotRequestRef.current = {
          controller: null,
          requestId: request.requestId,
        };
      }
    }
  }, [
    applySnapshot,
    beginSnapshotRequest,
    isCurrentSnapshotRequest,
  ]);

  const loadCatalog = useCallback(async () => {
    const hydrated = await loadShelf();
    return hydrated?.catalogData ?? latestHydratedStateRef.current?.catalogData ?? null;
  }, [loadShelf]);

  const loadRecentReading = useCallback(async () => {
    const hydrated = await loadShelf({ background: true, allowCached: false });
    return hydrated?.recentData ?? latestHydratedStateRef.current?.recentData ?? { items: [] };
  }, [loadShelf]);

  const reapplyPendingReadingPositions = useCallback(() => {
    const snapshot = latestSnapshotRecordRef.current?.snapshot;
    return snapshot ? applySnapshot(snapshot) : latestHydratedStateRef.current;
  }, [applySnapshot]);

  const {
    handleFileChange,
    isUploading,
    uploadProgress,
  } = useUploadBooks({ loadShelf, setError: setOperationError });

  useEffect(() => {
    void loadShelf({ allowCached: true });

    return () => {
      snapshotRequestRef.current.controller?.abort();
    };
  }, [loadShelf]);

  useEffect(() => {
    const revalidate = () => {
      if (!hasAppliedSnapshotRef.current) return;
      const now = Date.now();
      if (now - lastRevalidateAtRef.current < REVALIDATE_THROTTLE_MS) return;
      lastRevalidateAtRef.current = now;
      void loadShelf({ background: true, allowCached: false });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        revalidate();
      }
    };

    window.addEventListener('focus', revalidate);
    window.addEventListener('online', revalidate);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('online', revalidate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadShelf]);

  const replaceShelfFolder = useCallback((renamedFolder) => {
    setShelfItems((items) =>
      items.map((item) =>
        item.type === 'folder' && item.id === renamedFolder.id
          ? normalizeShelfItem({ ...item, folder: renamedFolder })
          : item,
      ),
    );
  }, []);

  return {
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
    loadRecentReading,
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
  };
}

import type { LibrarySnapshot } from '@lan-reader/shared';
import type { CachedSnapshotRecord, CatalogBook, Folder, FolderBook, HydratedLibrarySnapshot, RecentReadingItem, ShelfItem } from '../types/library.js';
import { errorMessage, isAbortError } from '../api/transport.js';

export interface LoadShelfOptions { background?: boolean; allowCached?: boolean }
/**
 * Ownership of the visible shelf/folder lists while a drag or its mutation is in flight.
 * A background snapshot decodes and stays retained, but it may not reorder a live projection.
 */
export interface ShelfProjection {
  /** Invalidate in-flight and queued snapshots that predate a committing mutation. */
  discardPendingSnapshots(): void;
  /** Stop owning the visible list; adopt a still-valid queued snapshot. */
  release(): void;
}
interface SnapshotRequest { controller: AbortController | null; requestId: number }
interface DeferredSnapshot { epoch: number; hydrated: HydratedLibrarySnapshot }
interface ShelfDataOptions { restoreReaderBook?: (shelf: HydratedLibrarySnapshot['shelfData'], recent: HydratedLibrarySnapshot['recentData']) => unknown }

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLibrarySnapshot } from '../api/libraryApi.js';
import { hydrateDecodedLibrarySnapshot } from '../utils/librarySnapshot.js';
import {
  loadCachedLibrarySnapshot,
  saveCachedLibrarySnapshot,
} from '../utils/librarySnapshotCache.js';
import { normalizeShelfItem } from '../utils/libraryItems.js';
import { readProgressOutbox } from '../utils/readingProgress.js';
import { useUploadBooks } from './useUploadBooks.js';

const REVALIDATE_THROTTLE_MS = 2000;

export function useShelfData({ restoreReaderBook }: ShelfDataOptions = {}) {
  const [shelfItems, setShelfItems] = useState<ShelfItem[]>([]);
  const [recentReadingItems, setRecentReadingItems] = useState<RecentReadingItem[]>([]);
  const [folderBooksByFolderId, setFolderBooksByFolderId] = useState(() => new Map<number, FolderBook[]>());
  const [hasLoadedShelf, setHasLoadedShelf] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [shelfError, setShelfError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [catalogBooks, setCatalogBooks] = useState<CatalogBook[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [hasLoadedCatalog, setHasLoadedCatalog] = useState(false);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const snapshotRequestRef = useRef<SnapshotRequest>({
    controller: null,
    requestId: 0,
  });
  const latestSnapshotRecordRef = useRef<CachedSnapshotRecord | null>(null);
  const latestHydratedStateRef = useRef<HydratedLibrarySnapshot | null>(null);
  const hasAppliedSnapshotRef = useRef(false);
  const lastRevalidateAtRef = useRef(0);
  const projectionRef = useRef<number | null>(null);
  const projectionIdRef = useRef(0);
  const deferredSnapshotRef = useRef<DeferredSnapshot | null>(null);
  const snapshotEpochRef = useRef(0);

  const publishShelfProjection = useCallback((hydrated: HydratedLibrarySnapshot) => {
    setShelfItems(hydrated.shelfData.items);
    setFolderBooksByFolderId(hydrated.folderBooksByFolderId);
  }, []);

  const applySnapshot = useCallback((snapshot: LibrarySnapshot) => {
    const hydrated = hydrateDecodedLibrarySnapshot(snapshot, {
      pendingProgressRecords: readProgressOutbox(),
    });
    const shouldRestoreReader = !hasAppliedSnapshotRef.current;

    hasAppliedSnapshotRef.current = true;
    latestHydratedStateRef.current = hydrated;

    if (projectionRef.current === null) {
      publishShelfProjection(hydrated);
    } else {
      // A drag or its mutation owns the visible arrangement; retain this result instead.
      deferredSnapshotRef.current = { epoch: snapshotEpochRef.current, hydrated };
    }

    setCatalogBooks(hydrated.catalogData.books);
    setRecentReadingItems(hydrated.recentData.items);
    setHasLoadedShelf(true);
    setHasLoadedCatalog(true);
    setShelfError('');
    setCatalogError('');

    if (shouldRestoreReader) {
      restoreReaderBook?.(hydrated.shelfData, hydrated.recentData);
    }

    return hydrated;
  }, [publishShelfProjection, restoreReaderBook]);

  const beginShelfProjection = useCallback((): ShelfProjection => {
    const id = projectionIdRef.current + 1;
    projectionIdRef.current = id;
    projectionRef.current = id;

    return {
      discardPendingSnapshots() {
        snapshotEpochRef.current += 1;
        deferredSnapshotRef.current = null;
      },
      release() {
        if (projectionRef.current !== id) {
          return;
        }

        projectionRef.current = null;
        const deferred = deferredSnapshotRef.current;
        deferredSnapshotRef.current = null;

        if (deferred && deferred.epoch === snapshotEpochRef.current) {
          publishShelfProjection(deferred.hydrated);
        }
      },
    };
  }, [publishShelfProjection]);

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

  const isCurrentSnapshotRequest = useCallback((request: SnapshotRequest) => (
    snapshotRequestRef.current.requestId === request.requestId &&
    snapshotRequestRef.current.controller === request.controller
  ), []);

  const loadShelf = useCallback(async (options: LoadShelfOptions = {}) => {
    const background = options?.background === true;
    const allowCached = options?.allowCached ?? !hasAppliedSnapshotRef.current;
    const request = beginSnapshotRequest();
    const epoch = snapshotEpochRef.current;
    const isCurrentEpoch = () => snapshotEpochRef.current === epoch;
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
        if (!isCurrentSnapshotRequest(request) || !isCurrentEpoch()) return null;

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
      // A mutation committed after this request started; its body, ETag and cache entry are obsolete.
      if (!isCurrentEpoch()) return null;

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
      if (isAbortError(error) || !isCurrentSnapshotRequest(request) || !isCurrentEpoch()) {
        return null;
      }

      if (!hasUsableState) {
        const message = errorMessage(error, '无法加载书架');
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
      projectionRef.current = null;
      deferredSnapshotRef.current = null;
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

  const replaceShelfFolder = useCallback((renamedFolder: Folder) => {
    setShelfItems((items) =>
      items.map((item) =>
        item.type === 'folder' && item.id === renamedFolder.id
          ? normalizeShelfItem({ ...item, folder: renamedFolder })
          : item,
      ),
    );
  }, []);

  return {
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

import type { ProgressRecord, ProgressRecords } from '../utils/readingProgress.js';
import type { ReadingPositionUpdate } from '@lan-reader/shared';
import { isRecord } from '@lan-reader/shared';
import { useCallback, useEffect, useRef } from 'react';
import { saveReadingProgress } from '../api/readingApi.js';
import {
  isSameProgressSnapshot,
  readProgressOutbox,
  sanitizeProgressRecord,
  writeProgressOutbox,
} from '../utils/readingProgress.js';

function isPermanentFailure(error: unknown) {
  return isRecord(error) && (error.status === 400 || error.status === 404);
}

function nextRecord(records: ProgressRecords, preferredBookId: number) {
  return records[preferredBookId] || Object.values(records)[0] || null;
}

export function useReadingProgressPersistence({
  bookId,
  saveProgress = saveReadingProgress,
}: { bookId: number; saveProgress?: (bookId: number, data: ReadingPositionUpdate, options: { keepalive?: boolean }) => Promise<unknown> }) {
  const memoryOutboxRef = useRef<ProgressRecords>({});
  const storageUnavailableRef = useRef(false);
  const workerRef = useRef<Promise<void> | null>(null);
  const flushRequestedRef = useRef(false);
  const keepaliveRequestedRef = useRef(false);
  const saveProgressRef = useRef(saveProgress);

  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  const readRecords = useCallback(() => (
    storageUnavailableRef.current ? memoryOutboxRef.current : readProgressOutbox()
  ), []);

  const replaceRecords = useCallback((records: ProgressRecords) => {
    if (!storageUnavailableRef.current && writeProgressOutbox(records)) {
      memoryOutboxRef.current = {};
      return;
    }

    storageUnavailableRef.current = true;
    memoryOutboxRef.current = records;
  }, []);

  const flushProgress = useCallback((options: { keepalive?: boolean } = {}): Promise<void> => {
    if (options.keepalive) keepaliveRequestedRef.current = true;
    flushRequestedRef.current = true;
    if (workerRef.current) return workerRef.current;
    if (!nextRecord(readRecords(), bookId)) {
      flushRequestedRef.current = false;
      keepaliveRequestedRef.current = false;
      return Promise.resolve();
    }

    const worker = (async () => {
      while (true) {
        const records = readRecords();
        const snapshot = nextRecord(records, bookId);
        if (!snapshot) return;

        flushRequestedRef.current = false;
        const keepalive = keepaliveRequestedRef.current;
        keepaliveRequestedRef.current = false;

        try {
          await saveProgressRef.current(snapshot.bookId, {
            cfi: snapshot.cfi,
            progress: snapshot.progress,
            chapterHref: snapshot.chapterHref,
            chapterLabel: snapshot.chapterLabel,
          }, { keepalive });
        } catch (error) {
          if (isPermanentFailure(error)) {
            const currentRecords = readRecords();
            delete currentRecords[snapshot.bookId];
            replaceRecords({ ...currentRecords });
            continue;
          }
          return;
        }

        const currentRecords = readRecords();
        if (isSameProgressSnapshot(currentRecords[snapshot.bookId], snapshot)) {
          delete currentRecords[snapshot.bookId];
          replaceRecords({ ...currentRecords });
        }
      }
    })();

    workerRef.current = worker;
    worker.finally(() => {
      if (workerRef.current !== worker) return;
      workerRef.current = null;
      if (flushRequestedRef.current) void flushProgress();
    });
    return worker;
  }, [bookId, readRecords, replaceRecords]);

  const enqueueProgress = useCallback((progressData: Omit<ProgressRecord, "bookId">) => {
    const record = sanitizeProgressRecord({ bookId, ...progressData });
    if (!record) return false;

    replaceRecords({ ...readRecords(), [record.bookId]: record });
    void flushProgress();
    return true;
  }, [bookId, flushProgress, readRecords, replaceRecords]);

  const retryPendingProgress = useCallback(() => flushProgress(), [flushProgress]);

  useEffect(() => {
    const handlePageHide = () => { void flushProgress({ keepalive: true }); };
    const handlePageShow = () => { void retryPendingProgress(); };
    const handleOnline = () => { void retryPendingProgress(); };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void retryPendingProgress();
    };

    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void retryPendingProgress();

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushProgress, retryPendingProgress]);

  return { enqueueProgress, flushProgress, retryPendingProgress };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { FoliateEngine } from '../reader/foliateEngine';
import { createReaderController } from '../reader/readerController';
import type { ReaderController } from '../reader/readerController';
import type { ReaderEngine, StablePosition } from '../reader/types';
import type { TocItem } from '../types/epub';
import type { ReaderSettings } from './useReaderSettings';
import type { usePageProgress } from './usePageProgress';
import { getReadingProgress } from '../api/readingApi';
import { readProgressOutbox } from '../utils/readingProgress';
import type { ProgressRecord } from '../utils/readingProgress';

interface Options {
  book: { id: number };
  containerRef: RefObject<HTMLElement | null>;
  renditionRef: RefObject<ReaderEngine | null>;
  currentCfiRef: RefObject<string | null>;
  readerSettingsRef: RefObject<ReaderSettings>;
  isLayoutReady: boolean;
  enqueueProgress: (record: Omit<ProgressRecord, 'bookId'>) => boolean;
  setError: (error: string) => void;
  setIsLoading: (loading: boolean) => void;
  loadReaderSettings: () => Promise<ReaderSettings>;
  markReaderSettingsLoaded: () => void;
  resetReaderSettingsLoad: () => void;
  pageProgressController: ReturnType<typeof usePageProgress>['pageProgressController'];
  onBookUnavailable?: (id: number) => void;
}
export function useFoliateReader(options: Options) {
  const { book, containerRef, renditionRef, currentCfiRef, readerSettingsRef, isLayoutReady, enqueueProgress, setError, setIsLoading, loadReaderSettings, markReaderSettingsLoaded, resetReaderSettingsLoad, pageProgressController, onBookUnavailable } = options;
  const [toc, setToc] = useState<TocItem[]>([]);
  const [currentChapter, setCurrentChapter] = useState<TocItem | null>(null);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [engine, setEngine] = useState<FoliateEngine | null>(null);
  const [controller, setController] = useState<ReaderController | null>(null);
  const [reload, setReload] = useState(0);
  const [canFallback, setCanFallback] = useState(false);
  const restore = useRef<string | number | null>(null);
  const fallback = useRef<string | null>(null);
  const capture = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    if (!isLayoutReady || !containerRef.current) return;
    let disposed = false;
    let owned: FoliateEngine | null = null;
    let coordinator: ReaderController | null = null;
    const abort = new AbortController();
    setIsLoading(true); setError(''); resetReaderSettingsLoad(); pageProgressController.beginBookPageProgress();
    const hidden = () => { coordinator?.suspend(); };
    const shown = () => {
      if (!owned || document.visibilityState === 'hidden' || owned.state === 'ready' || owned.state === 'failed') return;
      if (!owned.stable) setReload(value => value + 1);
      else void coordinator?.resume();
    };
    const visibility = () => { if (document.visibilityState === 'hidden') hidden(); else shown(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hidden); window.addEventListener('pageshow', shown);
    const displayPosition = (position: StablePosition, persist: boolean) => {
      if (disposed || !owned) return;
      const location = position.location;
      const chapter = owned.currentChapter(position.cfi, location.start?.href);
      currentCfiRef.current = position.cfi;
      restore.current = position.cfi;
      fallback.current = chapter?.href ?? location.start?.href ?? null;
      setCanFallback(Boolean(fallback.current));
      setCurrentChapter(chapter ?? null); setCurrentHref(location.start?.href ?? null);
      setProgress(location.start?.percentage ?? 0);
      pageProgressController.updatePageProgressFromLocation(location, { readingSectionId: chapter?.href });
      if (persist) enqueueProgress({ cfi: position.cfi, progress: location.start?.percentage ?? 0, chapterHref: chapter?.href ?? location.start?.href ?? null, chapterLabel: chapter?.label ?? null });
    };
    void (async () => {
      try {
        const pending = readProgressOutbox()[book.id];
        const [response, saved, settings] = await Promise.all([
          fetch(`/api/books/${book.id}/file`, { signal: abort.signal }),
          pending ? Promise.resolve(pending) : getReadingProgress(book.id).then(r => r.progress),
          loadReaderSettings(),
        ]);
        if (disposed) return;
        if (!response.ok) { if (response.status === 404) onBookUnavailable?.(book.id); throw new Error(`文件加载失败 (${response.status})`); }
        const data = await response.arrayBuffer(); if (disposed) return;
        // A failed progress request must not silently open and overwrite page 1.
        const target = restore.current ?? saved?.cfi ?? 0;
        restore.current = target;
        fallback.current = saved?.chapterHref ?? fallback.current;
        setCanFallback(Boolean(fallback.current));
        if (restore.current === 0 && saved && !saved.cfi && saved.progress > 0) throw new Error('记录缺少精确阅读位置。原记录已保留，请重试或选择从本章开头继续。');
        owned = new FoliateEngine(containerRef.current!, settings);
        renditionRef.current = owned; setEngine(owned);
        coordinator = createReaderController(owned.session, { onAccepted: event => displayPosition(event.position, event.reason !== 'layout-restored') });
        setController(coordinator);
        owned.onPages = pageProgressController.setReadingSectionPageRanges;
        owned.onInvalidatePages = pageProgressController.invalidateReadingSectionPages;
        owned.onState = (state, error) => {
          if (disposed) return;
          if (state === 'failed') { setIsLoading(false); setError(`未能精确恢复阅读位置。原记录已保留，请重试，或主动选择从本章开头继续。${error instanceof Error ? `（${error.message}）` : ''}`); }
          if (state === 'ready') { setError(''); setIsLoading(false); }
        };
        await coordinator.open(data, target);
        if (disposed) return;
        setToc(owned.toc); pageProgressController.setReadingSections(owned.readingSections);
        markReaderSettingsLoaded();
        if (document.visibilityState === 'hidden') coordinator.suspend();
        capture.current = () => !disposed && Boolean(coordinator?.capture());
      } catch (error) {
        if (disposed) return;
        setError(error instanceof Error ? error.message : '无法打开书籍；原记录已保留，请重试'); setIsLoading(false);
      }
    })();
    return () => {
      disposed = true; abort.abort(); capture.current = null;
      coordinator?.destroy();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hidden); window.removeEventListener('pageshow', shown);
      owned?.destroy(); if (renditionRef.current === owned) renditionRef.current = null;
    };
  }, [book.id, isLayoutReady, reload, containerRef, renditionRef, currentCfiRef, readerSettingsRef, enqueueProgress, setError, setIsLoading, loadReaderSettings, markReaderSettingsLoaded, resetReaderSettingsLoad, pageProgressController, onBookUnavailable]);
  const captureCurrentProgress = useCallback(async () => capture.current?.() ?? false, []);
  const requestBookPagination = useCallback(() => { if (controller?.snapshot.phase === 'idle') engine?.session.pagination.request(); }, [engine, controller]);
  const retry = useCallback(() => { setReload(value => value + 1); }, []);
  const startChapter = useCallback(() => { if (fallback.current) { restore.current = fallback.current; setReload(value => value + 1); } }, []);
  return { engine, controller, toc, currentChapter, currentHref, progress, captureCurrentProgress, requestBookPagination, retry, startChapter, canFallback };
}

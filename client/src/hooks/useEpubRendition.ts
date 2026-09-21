import type { RefObject } from 'react';
import { isRecord } from '@lan-reader/shared';
import type { EpubView, ReaderLocation, TocItem } from '../types/epub.js';
import type { SessionBook, SessionRendition } from '../types/readerSession.js';
import { sessionBook } from '../types/readerSession.js';
import type { ProgressRecord } from '../utils/readingProgress.js';
import type { usePageProgress } from './usePageProgress.js';
import type { useReaderSettings, ReaderSettings } from './useReaderSettings.js';

type SettingsController = ReturnType<typeof useReaderSettings>;
export interface EpubRenditionOptions extends Pick<SettingsController,
  'applyReaderHorizontalMargin' | 'applyReaderSettings' | 'applyReaderSettingsToContents' |
  'flushPendingReaderSettings' | 'loadReaderSettings' | 'markReaderSettingsLoaded' | 'resetReaderSettingsLoad'> {
  book: { id: number };
  bookRef: RefObject<SessionBook | null>;
  containerRef: RefObject<HTMLElement | null>;
  createEpub?: (data: ArrayBuffer) => SessionBook;
  currentCfiRef: RefObject<string | null>;
  enqueueProgress: (progress: Omit<ProgressRecord, 'bookId'>) => boolean;
  error: string;
  isClosingRef: RefObject<boolean>;
  isLayoutReady: boolean;
  isLoading: boolean;
  onBookUnavailable?: (bookId: number) => void;
  pageProgressController: ReturnType<typeof usePageProgress>['pageProgressController'];
  readerSettingsRef: RefObject<ReaderSettings>;
  renditionRef: RefObject<SessionRendition | null>;
  setError: (error: string) => void;
  setIsLoading: (loading: boolean) => void;
}
import { useCallback, useEffect, useRef, useState } from 'react';
import Epub, { EpubCFI } from 'epubjs';
import { getReadingProgress } from '../api/readingApi.js';
import { createEpubPagination } from '../utils/epubPagination.js';
import { createEpubPageTurnAdapter } from '../utils/epubPageTurnAdapter.js';
import {
  addTocProgress,
  createReadingSections,
  findCurrentTocItem,
  prepareTocItems,
} from '../utils/epubToc.js';
import { readProgressOutbox, selectProgressForRelocation } from '../utils/readingProgress.js';
import { getReaderPageGap } from './useReaderSettings.js';

const createSessionEpub = (data: ArrayBuffer) => sessionBook(Epub(data));

const READER_RESUME_DELAY_MS = 120;
const READER_RECOVERY_TIMEOUT_MS = 5000;
const READER_LOADING_STALL_MS = 8000;
const READER_LAYOUT_WAIT_MS = 1200;
const READER_LAYOUT_POLL_MS = 80;

function hasUsableLayout(element: HTMLElement | null) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

async function waitForUsableLayout(element: HTMLElement | null) {
  const deadline = Date.now() + READER_LAYOUT_WAIT_MS;

  while (Date.now() < deadline) {
    if (hasUsableLayout(element)) return true;
    await new Promise((resolve) => setTimeout(resolve, READER_LAYOUT_POLL_MS));
  }

  return hasUsableLayout(element);
}

function settlesWithin(value: unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve(value).then(
      () => finish(true),
      () => finish(false),
    );
  });
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 250);

    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  });
}

function isTextNode(node: Node | null | undefined): node is Text {
  return node?.nodeType === 3;
}

function collapsedTextRange(document: Document | undefined, sourceRange: Range | null) {
  const container = sourceRange?.startContainer;
  if (!document || !sourceRange || !isTextNode(container) || !container.data.length) return null;

  const offset = Math.min(
    container.data.length - 1,
    Math.max(0, Number(sourceRange.startOffset) || 0),
  );
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  return range;
}

function textRangeAtPoint(document: Document | undefined, x: number, y: number) {
  try {
    if (typeof document?.caretRangeFromPoint === 'function') {
      return collapsedTextRange(document, document.caretRangeFromPoint(x, y));
    }

    if (typeof document?.caretPositionFromPoint === 'function') {
      const position = document.caretPositionFromPoint(x, y);
      if (!position?.offsetNode) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return collapsedTextRange(document, range);
    }
  } catch {
    return null;
  }

  return null;
}

function createVisiblePageAnchorCfi(rendition: SessionRendition) {
  const manager = rendition?.manager;
  const containerRect = manager?.container?.getBoundingClientRect?.();
  if (!manager || !containerRect?.width || !containerRect?.height) return null;

  const views = manager.visible?.() || manager.views?.displayed?.() || [];
  const xSamples = [0.5, 0.4, 0.6];
  const ySamples = [0.5, 0.35, 0.65, 0.25, 0.75];

  for (const yRatio of ySamples) {
    for (const xRatio of xSamples) {
      const pageX = Number(containerRect.left) + containerRect.width * xRatio;
      const pageY = Number(containerRect.top) + containerRect.height * yRatio;

      for (const view of views) {
        const frame = view?.iframe || view?.element?.querySelector?.('iframe');
        const frameRect = frame?.getBoundingClientRect?.();
        const contents = view?.contents;
        const document = contents?.document;
        if (
          !frameRect ||
          pageX < frameRect.left ||
          pageX > frameRect.right ||
          pageY < frameRect.top ||
          pageY > frameRect.bottom
        ) {
          continue;
        }

        const range = textRangeAtPoint(
          document,
          pageX - frameRect.left,
          pageY - frameRect.top,
        );
        if (!range) continue;

        try {
          const cfi = contents?.cfiFromRange?.(range);
          if (typeof cfi === 'string' && cfi.startsWith('epubcfi(')) return cfi;
        } catch {
          // Try another point in the visible page.
        }
      }
    }
  }

  return null;
}

function createInteriorRestoreCfi(rendition: SessionRendition, cfi: string) {
  if (!cfi || typeof EpubCFI !== 'function') return cfi;

  try {
    const parsedCfi = new EpubCFI(cfi);
    const contents = rendition.getContents?.().find(
      (candidate) => candidate?.sectionIndex === parsedCfi.spinePos,
    );
    const document = contents?.document;
    const sourceRange = document ? parsedCfi.toRange(document) : null;
    const container = sourceRange?.startContainer;
    const startOffset = Number(sourceRange?.startOffset) || 0;

    // Existing page-start CFIs commonly end in :0. Move those anchors into
    // the paragraph so WebKit cannot round an exact column boundary backward.
    if (!document || !isTextNode(container) || startOffset !== 0 || container.data.length < 3) {
      return cfi;
    }

    const range = document.createRange();
    const interiorOffset = Math.min(
      container.data.length - 1,
      Math.max(2, Math.floor(container.data.length / 2)),
    );
    range.setStart(container, interiorOffset);
    range.collapse(true);
    return contents?.cfiFromRange?.(range) || cfi;
  } catch {
    return cfi;
  }
}

function hasHealthyRenderedFrame(container: HTMLElement | null) {
  const frames = [...(container?.querySelectorAll('iframe') || [])];

  return frames.some((frame) => {
    if (!frame.isConnected) return false;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;

    try {
      const frameDocument = frame.contentDocument;
      const body = frameDocument?.body;
      if (!frameDocument?.documentElement || !body || frameDocument.readyState === 'loading') {
        return false;
      }

      return body.childElementCount > 0 || Boolean(body.textContent?.trim());
    } catch {
      return false;
    }
  });
}

export function useEpubRendition({
  applyReaderHorizontalMargin,
  applyReaderSettings,
  applyReaderSettingsToContents,
  book,
  bookRef,
  containerRef,
  createEpub = createSessionEpub,
  currentCfiRef,
  enqueueProgress,
  error,
  flushPendingReaderSettings,
  isClosingRef,
  isLayoutReady,
  isLoading,
  loadReaderSettings,
  markReaderSettingsLoaded,
  onBookUnavailable,
  pageProgressController,
  readerSettingsRef,
  renditionRef,
  resetReaderSettingsLoad,
  setError,
  setIsLoading,
}: EpubRenditionOptions) {
  const {
    beginBookPageProgress,
    failReadingSectionPageRanges,
    invalidateReadingSectionPages,
    setReadingSectionPageRanges,
    setReadingSections,
    updatePageProgressFromLocation,
  } = pageProgressController;
  const [progress, setProgress] = useState(0);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [currentChapter, setCurrentChapter] = useState<TocItem | null>(null);
  const [readerReloadKey, setReaderReloadKey] = useState(0);
  const [pageTurnAdapter, setPageTurnAdapter] = useState<ReturnType<typeof createEpubPageTurnAdapter> | null>(null);
  const pageTurnAdapterRef = useRef<(ReturnType<typeof createEpubPageTurnAdapter>) | null>(null);
  const loadingStateRef = useRef(isLoading);
  const errorStateRef = useRef(error);
  const loadStartedAtRef = useRef(0);
  const progressRef = useRef(0);
  const reloadCfiRef = useRef<(string) | null>(null);
  const reloadProgressRef = useRef<(number) | null>(null);
  const fullReloadPendingRef = useRef(false);
  const needsResumeRecoveryRef = useRef(false);
  const recoveryInFlightRef = useRef(false);
  const recoveryTimerRef = useRef<(ReturnType<typeof setTimeout>) | null>(null);
  const recoverVisibleReaderRef = useRef<(() => void) | null>(null);
  const resumeLifecycleActiveRef = useRef(true);
  const locationCaptureRef = useRef<(() => Promise<boolean | undefined>) | null>(null);
  const bookPaginationRequestRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isLayoutReady || !containerRef.current || !book?.id) return undefined;

    pageTurnAdapterRef.current?.destroy();
    pageTurnAdapterRef.current = null;
    setPageTurnAdapter(null);

    let destroyed = false;
    const abortController = new AbortController();
    let ownedBook: SessionBook | null = null;
    let ownedRendition: SessionRendition | null = null;
    const disposeOwnedResources = () => {
      const rendition = ownedRendition;
      const epubBook = ownedBook;
      ownedRendition = null;
      ownedBook = null;
      if (rendition && handleRelocated) rendition.off('relocated', handleRelocated);
      if (rendition && reapplyReaderSettingsToView) rendition.off('rendered', reapplyReaderSettingsToView);
      if (rendition && handleRenditionResized) rendition.off('resized', handleRenditionResized);
      // Book owns the rendition returned by renderTo; epub.js Book.destroy()
      // already destroys it. A second call repeats private manager teardown.
      epubBook?.destroy();
      if (renditionRef.current === rendition) renditionRef.current = null;
      if (bookRef.current === epubBook) bookRef.current = null;
    };
    let handleRelocated: ((location: ReaderLocation) => void) | undefined;
    let reapplyReaderSettingsToView: ((section: unknown, view?: EpubView) => void) | undefined;
    let adapter: ReturnType<typeof createEpubPageTurnAdapter> | null = null;
    let activeToc: TocItem[] = [];
    let bookArrayBuffer: ArrayBuffer | null = null;
    let epubPagination: ReturnType<typeof createEpubPagination> | null = null;
    let handleRenditionResized: (() => void) | undefined;
    let latestHref: string | null = null;
    let latestSectionIndex: number | null = null;
    let isInitializing = true;
    loadStartedAtRef.current = Date.now();
    loadingStateRef.current = true;
    errorStateRef.current = '';
    setIsLoading(true);
    setError('');
    beginBookPageProgress();
    setToc([]);
    setCurrentHref(null);
    setCurrentChapter(null);
    resetReaderSettingsLoad();

    const requestBookPagination = (sectionIndex = latestSectionIndex) => {
      if (destroyed) return;
      void epubPagination?.request({
        container: containerRef.current,
        currentSectionIndex: sectionIndex,
        settings: { ...readerSettingsRef.current },
      });
    };
    bookPaginationRequestRef.current = requestBookPagination;

    (async () => {
      try {
        const fileResponse = await fetch(`/api/books/${book.id}/file`, { signal: abortController.signal });
        if (!fileResponse.ok) {
          const fileError: Error & { code?: string } = new Error(`文件加载失败 (${fileResponse.status})`);
          if (fileResponse.status === 404) fileError.code = 'BOOK_NOT_FOUND';
          throw fileError;
        }
        if (destroyed) return;

        const arrayBuffer = await fileResponse.arrayBuffer();
        if (destroyed) return;
        bookArrayBuffer = arrayBuffer;

        const epubBook = createEpub(arrayBuffer);
        ownedBook = epubBook;
        bookRef.current = epubBook;

        const container = containerRef.current;
        if (!container) return;
        const rendition = epubBook.renderTo(container, {
          width: '100%',
          height: '100%',
          manager: 'continuous',
          flow: 'paginated',
          gap: getReaderPageGap(readerSettingsRef.current.horizontalMargin),
          spread: 'none',
          snap: true,
        });
        ownedRendition = rendition;
        renditionRef.current = rendition;
        rendition.hooks.content.register((contents) => {
          applyReaderSettingsToContents(contents);
        });
        reapplyReaderSettingsToView = (_section, view) => {
          const applyToRenderedContents = () => {
            if (destroyed) return;
            if (view?.contents) {
              applyReaderSettingsToContents(view.contents, readerSettingsRef.current);
              return;
            }
            rendition.getContents?.().forEach((contents) => {
              applyReaderSettingsToContents(contents, readerSettingsRef.current);
            });
          };

          applyToRenderedContents();
          requestAnimationFrame(() => {
            applyToRenderedContents();
          });
        };
        rendition.on('rendered', reapplyReaderSettingsToView);
        handleRenditionResized = () => requestBookPagination();
        rendition.on('resized', handleRenditionResized);

        let startCfi = reloadCfiRef.current || undefined;
        let loadedReaderSettings = readerSettingsRef.current;
        let lastValidProgress = Number.isFinite(reloadProgressRef.current)
          ? reloadProgressRef.current ?? 0
          : 0;
        let locationsReady = false;

        const pendingProgress = readProgressOutbox()[book.id] || null;
        const [progressResult, settingsResult] = await Promise.allSettled([
          getReadingProgress(book.id),
          loadReaderSettings(),
        ]);

        if (destroyed) return;

        const savedProgress = pendingProgress || (
          progressResult.status === 'fulfilled' ? progressResult.value.progress : null
        );
        if (savedProgress) {
          if (!startCfi) {
            startCfi = savedProgress?.cfi || undefined;
          }
          if (!Number.isFinite(reloadProgressRef.current) && Number.isFinite(savedProgress?.progress)) {
            lastValidProgress = Math.min(1, Math.max(0, savedProgress.progress));
            progressRef.current = lastValidProgress;
            setProgress(lastValidProgress);
          }
        }

        if (settingsResult.status === 'fulfilled') {
          loadedReaderSettings = settingsResult.value;
        }

        const syncCurrentChapter = (cfi = currentCfiRef.current, href = latestHref) => {
          const chapter = findCurrentTocItem(activeToc, {
            book: epubBook,
            cfi,
            href: href || undefined,
          });
          setCurrentChapter(chapter ?? null);
          return chapter;
        };

        const updateFromLocation = (location: ReaderLocation | null | undefined, options: { allowUnstable?: boolean; force?: boolean; persist?: boolean } = {}) => {
          const {
            allowUnstable = false,
            force = false,
            persist = true,
          } = options;
          if (!force && (isInitializing || isClosingRef.current)) return false;
          if (!allowUnstable && adapter && !adapter.isStableAligned()) return false;
          if (destroyed || !location?.start?.cfi) return false;
          // Mobile browsers can emit a synthetic relocation while the PWA is
          // leaving the foreground, before visibilityState has changed, or
          // after its iframe has lost usable layout. Keep the last foreground
          // location authoritative until recovery completes.
          if (
            needsResumeRecoveryRef.current ||
            document.visibilityState !== 'visible'
          ) {
            return false;
          }
          const cfi = createVisiblePageAnchorCfi(rendition) || location.start.cfi;
          const progressValue = selectProgressForRelocation({
            atEnd: location.atEnd,
            cfi,
            lastValidProgress,
            locations: { percentageFromCfi: (value) => value ? epubBook.locations.percentageFromCfi?.(value) : undefined },
            locationsReady,
          });

          lastValidProgress = progressValue;
          progressRef.current = progressValue;
          currentCfiRef.current = cfi;
          latestHref = location.start.href || null;
          const relocatedSectionIndex = Number(location.start.index);
          if (Number.isInteger(relocatedSectionIndex)) latestSectionIndex = relocatedSectionIndex;
          const chapter = syncCurrentChapter(cfi, latestHref);
          setProgress(progressValue);
          updatePageProgressFromLocation(location, {
            readingSectionId: chapter?.href || null,
          });
          requestBookPagination(latestSectionIndex);
          setCurrentHref(latestHref);
          if (persist) {
            enqueueProgress({
              cfi,
              progress: progressValue,
              chapterHref: chapter?.href || latestHref,
              chapterLabel: chapter?.label || null,
            });
          }
          return true;
        };

        const captureLatestLocation = async () => {
          if (destroyed || renditionRef.current !== rendition) return false;

          let captured = false;
          let reportResult;
          try {
            reportResult = rendition.reportLocation?.();
          } catch {
            reportResult = null;
          }

          try {
            const immediateLocation = rendition.currentLocation?.();
            if (immediateLocation && !('then' in immediateLocation)) {
              captured = updateFromLocation(immediateLocation, {
                allowUnstable: true,
                force: true,
              });
            }
          } catch {
            // The reported location below remains the compatibility path.
          }

          try {
            await Promise.resolve(reportResult);
          } catch {
            // currentLocation below can still provide the stable visible page.
          }

          if (destroyed || renditionRef.current !== rendition) return captured;
          const location = await Promise.resolve(rendition.currentLocation?.());
          if (destroyed || renditionRef.current !== rendition || !location?.start?.cfi) {
            return captured;
          }

          return updateFromLocation(location, {
            allowUnstable: true,
            force: true,
          });
        };

        handleRelocated = updateFromLocation;
        rendition.on('relocated', handleRelocated);
        applyReaderSettings(rendition, loadedReaderSettings);
        await rendition.display(startCfi);
        if (destroyed) return;
        await applyReaderHorizontalMargin(
          rendition,
          loadedReaderSettings.horizontalMargin,
          startCfi,
        );

        if (destroyed) return;

        // epub.js derives CFIs from rendered geometry. Wait for the final
        // reader layout, then re-anchor after all injected styles have painted.
        // A cached book can otherwise finish while the cover FLIP is still
        // transforming the container and resume one or two pages too early.
        await waitForNextPaint();
        if (destroyed) return;
        if (startCfi) {
          startCfi = createInteriorRestoreCfi(rendition, startCfi);
          await rendition.display(startCfi);
          if (destroyed) return;
          await waitForNextPaint();
        }

        if (destroyed) return;
        isInitializing = false;
        const initialLocation = await Promise.resolve(rendition.currentLocation?.());
        if (destroyed) return;
        updateFromLocation(initialLocation, {
          allowUnstable: true,
          persist: false,
        });
        locationCaptureRef.current = captureLatestLocation;
        adapter = createEpubPageTurnAdapter(rendition);
        pageTurnAdapterRef.current = adapter;
        setPageTurnAdapter(adapter);
        markReaderSettingsLoaded();
        reloadCfiRef.current = null;
        reloadProgressRef.current = null;
        fullReloadPendingRef.current = false;
        loadingStateRef.current = false;
        setIsLoading(false);

        const navigationPromise = epubBook.loaded.navigation
          .then((nav) => prepareTocItems(nav?.toc, '', {
            book: epubBook,
            navigationPath: epubBook.packaging?.navPath || epubBook.packaging?.ncxPath || '',
          }))
          .catch(() => [])
          .then((nextToc) => {
            if (destroyed) return nextToc;
            activeToc = nextToc;
            const readingSections = createReadingSections(nextToc, epubBook);
            setToc(nextToc);
            const chapter = syncCurrentChapter();
            setReadingSections(readingSections, chapter?.href || null);
            epubPagination?.destroy();
            epubPagination = createEpubPagination({
              applyReaderSettingsToContents,
              arrayBuffer: bookArrayBuffer!,
              onLayoutInvalidated: invalidateReadingSectionPages,
              onReadingSectionComplete: setReadingSectionPageRanges,
              onReadingSectionFailed: failReadingSectionPageRanges,
              readingSections,
            });
            requestBookPagination();
            return nextToc;
          });

        epubBook.locations.generate(1024)
          .then(
            () => {
              locationsReady = true;
            },
            () => {
              locationsReady = false;
            },
          )
          .then(async () => {
            if (destroyed) return;
            const currentLocation = await Promise.resolve(rendition.currentLocation?.());
            updateFromLocation(currentLocation, { persist: false });
            const preparedToc = await navigationPromise;
            const nextToc = await addTocProgress(preparedToc, epubBook, {
              shouldStop: () => destroyed,
            });
            if (destroyed) return;
            activeToc = nextToc;
            setToc(nextToc);
            const enrichedLocation = await Promise.resolve(rendition.currentLocation?.());
            updateFromLocation(enrichedLocation, { persist: false });
          })
          .catch(() => {});
      } catch (openError) {
        if (!destroyed) {
          if (isRecord(openError) && openError.code === 'BOOK_NOT_FOUND') {
            errorStateRef.current = '书籍不存在';
            setError('书籍不存在');
            onBookUnavailable?.(book.id);
          } else {
            errorStateRef.current = '无法打开这本书';
            setError('无法打开这本书');
          }
          fullReloadPendingRef.current = false;
          loadingStateRef.current = false;
          setIsLoading(false);
        }
        disposeOwnedResources();
      }
    })();

    return () => {
      destroyed = true;
      abortController.abort();
      epubPagination?.destroy();
      if (bookPaginationRequestRef.current === requestBookPagination) {
        bookPaginationRequestRef.current = null;
      }
      flushPendingReaderSettings();

      adapter?.destroy();
      if (pageTurnAdapterRef.current === adapter) {
        pageTurnAdapterRef.current = null;
      }
      disposeOwnedResources();
      currentCfiRef.current = null;
      locationCaptureRef.current = null;

    };
  }, [
    applyReaderHorizontalMargin,
    applyReaderSettings,
    applyReaderSettingsToContents,
    beginBookPageProgress,
    book?.id,
    bookRef,
    containerRef,
    createEpub,
    currentCfiRef,
    enqueueProgress,
    failReadingSectionPageRanges,
    flushPendingReaderSettings,
    invalidateReadingSectionPages,
    isLayoutReady,
    loadReaderSettings,
    markReaderSettingsLoaded,
    onBookUnavailable,
    readerReloadKey,
    readerSettingsRef,
    renditionRef,
    resetReaderSettingsLoad,
    setReadingSectionPageRanges,
    setReadingSections,
    setError,
    setIsLoading,
    updatePageProgressFromLocation,
  ]);

  const requestBookPagination = useCallback(() => {
    bookPaginationRequestRef.current?.();
  }, []);

  const captureCurrentProgress = useCallback(() => {
    const captureLocation = locationCaptureRef.current;
    return captureLocation ? captureLocation() : Promise.resolve(false);
  }, []);

  const requestFullReaderReload = useCallback((resumeCfi: string | null = null, resumeProgress: number | null = null) => {
    if (
      !book?.id ||
      isClosingRef.current ||
      fullReloadPendingRef.current ||
      !resumeLifecycleActiveRef.current
    ) {
      return;
    }

    const cfi = resumeCfi || currentCfiRef.current;
    if (cfi) reloadCfiRef.current = cfi;
    reloadProgressRef.current = Number.isFinite(resumeProgress)
      ? resumeProgress
      : progressRef.current;
    fullReloadPendingRef.current = true;
    needsResumeRecoveryRef.current = false;
    errorStateRef.current = '';
    loadingStateRef.current = true;
    pageTurnAdapterRef.current?.cancel({ reason: 'resume-reload', restoreOrigin: true });
    setError('');
    setIsLoading(true);
    resetReaderSettingsLoad();
    setReaderReloadKey((key) => key + 1);
  }, [
    book?.id,
    currentCfiRef,
    isClosingRef,
    resetReaderSettingsLoad,
    setError,
    setIsLoading,
  ]);

  const runResumeRecovery = useCallback(async () => {
    if (
      !resumeLifecycleActiveRef.current ||
      !book?.id ||
      isClosingRef.current ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }

    if (errorStateRef.current) {
      needsResumeRecoveryRef.current = false;
      return;
    }

    if (loadingStateRef.current) {
      requestFullReaderReload(currentCfiRef.current, progressRef.current);
      return;
    }

    const container = containerRef.current;
    if (!container || !(await waitForUsableLayout(container))) {
      requestFullReaderReload(currentCfiRef.current, progressRef.current);
      return;
    }

    if (
      !resumeLifecycleActiveRef.current ||
      isClosingRef.current ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }

    const rendition = renditionRef.current;
    const resumeCfi = currentCfiRef.current;
    const resumeProgress = progressRef.current;
    if (!rendition || typeof rendition.clear !== 'function') {
      requestFullReaderReload(resumeCfi, resumeProgress);
      return;
    }

    const finishResumeRecovery = async () => {
      rendition.getContents?.().forEach((contents) => {
        applyReaderSettingsToContents(contents, readerSettingsRef.current);
      });
      needsResumeRecoveryRef.current = document.visibilityState !== 'visible';
      if (!needsResumeRecoveryRef.current) {
        try {
          await locationCaptureRef.current?.();
        } catch {
          // The preserved foreground location remains the safe fallback.
        }
        needsResumeRecoveryRef.current = document.visibilityState !== 'visible';
      }
      loadingStateRef.current = false;
      setIsLoading(false);
    };

    if (hasHealthyRenderedFrame(container)) {
      pageTurnAdapterRef.current?.cancel({ reason: 'resume-reuse', restoreOrigin: true });

      try {
        rendition.resize?.();
        const displayCompleted = resumeCfi
          ? await settlesWithin(
              rendition.display(resumeCfi),
              READER_RECOVERY_TIMEOUT_MS,
            )
          : true;
        await waitForNextPaint();

        if (
          displayCompleted &&
          resumeLifecycleActiveRef.current &&
          renditionRef.current === rendition &&
          document.visibilityState === 'visible' &&
          hasHealthyRenderedFrame(container)
        ) {
          await finishResumeRecovery();
          return;
        }
      } catch {
        // Fall through to rebuilding the existing rendition.
      }
    }

    if (
      !resumeLifecycleActiveRef.current ||
      isClosingRef.current ||
      document.visibilityState !== 'visible' ||
      renditionRef.current !== rendition
    ) {
      return;
    }

    loadingStateRef.current = true;
    errorStateRef.current = '';
    setError('');
    setIsLoading(true);
    pageTurnAdapterRef.current?.cancel({ reason: 'resume-rebuild', restoreOrigin: true });

    try {
      // Recreate epub.js views even when the old iframe node still exists.
      // Some mobile browsers retain that node after discarding its document or
      // compositing surface, so resize/display alone cannot recover it.
      rendition.clear();
      rendition.resize?.();
      const displayCompleted = await settlesWithin(
        rendition.display(resumeCfi || undefined),
        READER_RECOVERY_TIMEOUT_MS,
      );
      await waitForNextPaint();

      if (
        !displayCompleted ||
        !resumeLifecycleActiveRef.current ||
        renditionRef.current !== rendition ||
        !hasHealthyRenderedFrame(container)
      ) {
        requestFullReaderReload(resumeCfi, resumeProgress);
        return;
      }

      await finishResumeRecovery();
    } catch {
      requestFullReaderReload(resumeCfi, resumeProgress);
    }
  }, [
    applyReaderSettingsToContents,
    book?.id,
    containerRef,
    currentCfiRef,
    isClosingRef,
    readerSettingsRef,
    renditionRef,
    requestFullReaderReload,
    setError,
    setIsLoading,
  ]);

  const recoverVisibleReader = useCallback(() => {
    if (
      !resumeLifecycleActiveRef.current ||
      !needsResumeRecoveryRef.current ||
      !book?.id ||
      isClosingRef.current ||
      document.visibilityState !== 'visible' ||
      fullReloadPendingRef.current
    ) {
      return;
    }

    if (errorStateRef.current) {
      needsResumeRecoveryRef.current = false;
      return;
    }

    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
    }

    const loadingDelay = loadingStateRef.current
      ? Math.max(0, READER_LOADING_STALL_MS - (Date.now() - loadStartedAtRef.current))
      : 0;
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      if (
        recoveryInFlightRef.current ||
        !needsResumeRecoveryRef.current ||
        document.visibilityState !== 'visible'
      ) {
        return;
      }

      recoveryInFlightRef.current = true;
      void runResumeRecovery().finally(() => {
        recoveryInFlightRef.current = false;
        if (
          resumeLifecycleActiveRef.current &&
          needsResumeRecoveryRef.current &&
          document.visibilityState === 'visible' &&
          !fullReloadPendingRef.current
        ) {
          setTimeout(() => recoverVisibleReaderRef.current?.(), 0);
        }
      });
    }, Math.max(READER_RESUME_DELAY_MS, loadingDelay));
  }, [book?.id, isClosingRef, runResumeRecovery]);

  recoverVisibleReaderRef.current = recoverVisibleReader;

  useEffect(() => {
    loadingStateRef.current = isLoading;
    errorStateRef.current = error;

    if (
      !isLoading &&
      !error &&
      needsResumeRecoveryRef.current &&
      document.visibilityState === 'visible'
    ) {
      recoverVisibleReader();
    }
  }, [error, isLoading, recoverVisibleReader]);

  useEffect(() => {
    resumeLifecycleActiveRef.current = true;
    recoverVisibleReaderRef.current = recoverVisibleReader;

    const markReaderHidden = () => {
      needsResumeRecoveryRef.current = true;
      if (recoveryTimerRef.current !== null) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      flushPendingReaderSettings();
    };
    const handlePageShow = () => {
      recoverVisibleReader();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        recoverVisibleReader();
      } else {
        markReaderHidden();
      }
    };
    const handleWindowFocus = () => {
      recoverVisibleReader();
    };

    window.addEventListener('blur', markReaderHidden);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('pagehide', markReaderHidden);
    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      resumeLifecycleActiveRef.current = false;
      recoverVisibleReaderRef.current = null;
      if (recoveryTimerRef.current !== null) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      window.removeEventListener('blur', markReaderHidden);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('pagehide', markReaderHidden);
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushPendingReaderSettings, recoverVisibleReader]);

  return {
    captureCurrentProgress,
    currentChapter,
    currentHref,
    pageTurnAdapter,
    progress,
    requestBookPagination,
    toc,
  };
}

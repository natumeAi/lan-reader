import { useCallback, useEffect, useRef, useState } from 'react';
import Epub from 'epubjs';
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

const READER_RESUME_DELAY_MS = 120;
const READER_RECOVERY_TIMEOUT_MS = 5000;
const READER_LOADING_STALL_MS = 8000;
const READER_LAYOUT_WAIT_MS = 1200;
const READER_LAYOUT_POLL_MS = 80;

function hasUsableLayout(element) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

async function waitForUsableLayout(element) {
  const deadline = Date.now() + READER_LAYOUT_WAIT_MS;

  while (Date.now() < deadline) {
    if (hasUsableLayout(element)) return true;
    await new Promise((resolve) => setTimeout(resolve, READER_LAYOUT_POLL_MS));
  }

  return hasUsableLayout(element);
}

function settlesWithin(value, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
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
  return new Promise((resolve) => {
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

function collapsedTextRange(document, sourceRange) {
  const container = sourceRange?.startContainer;
  if (!document || container?.nodeType !== 3 || !container.data?.length) return null;

  const offset = Math.min(
    container.data.length - 1,
    Math.max(0, Number(sourceRange.startOffset) || 0),
  );
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  return range;
}

function textRangeAtPoint(document, x, y) {
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

function createVisiblePageAnchorCfi(rendition) {
  const manager = rendition?.manager;
  const containerRect = manager?.container?.getBoundingClientRect?.();
  if (!containerRect?.width || !containerRect?.height) return null;

  const views = manager.visible?.() || manager.views?.displayed?.() || [];
  const xSamples = [0.5, 0.4, 0.6];
  const ySamples = [0.5, 0.35, 0.65, 0.25, 0.75];

  for (const yRatio of ySamples) {
    for (const xRatio of xSamples) {
      const pageX = containerRect.left + containerRect.width * xRatio;
      const pageY = containerRect.top + containerRect.height * yRatio;

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
          const cfi = contents.cfiFromRange?.(range);
          if (typeof cfi === 'string' && cfi.startsWith('epubcfi(')) return cfi;
        } catch {
          // Try another point in the visible page.
        }
      }
    }
  }

  return null;
}

function createInteriorRestoreCfi(rendition, cfi) {
  if (!cfi || typeof Epub.CFI !== 'function') return cfi;

  try {
    const parsedCfi = new Epub.CFI(cfi);
    const contents = rendition.getContents?.().find(
      (candidate) => candidate?.sectionIndex === parsedCfi.spinePos,
    );
    const document = contents?.document;
    const sourceRange = document ? parsedCfi.toRange(document) : null;
    const container = sourceRange?.startContainer;
    const startOffset = Number(sourceRange?.startOffset) || 0;

    // Existing page-start CFIs commonly end in :0. Move those anchors into
    // the paragraph so WebKit cannot round an exact column boundary backward.
    if (container?.nodeType !== 3 || startOffset !== 0 || container.data.length < 3) {
      return cfi;
    }

    const range = document.createRange();
    const interiorOffset = Math.min(
      container.data.length - 1,
      Math.max(2, Math.floor(container.data.length / 2)),
    );
    range.setStart(container, interiorOffset);
    range.collapse(true);
    return contents.cfiFromRange?.(range) || cfi;
  } catch {
    return cfi;
  }
}

function hasHealthyRenderedFrame(container) {
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
  createEpub = Epub,
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
}) {
  const {
    beginBookPageProgress,
    failReadingSectionPageRanges,
    invalidateReadingSectionPages,
    setReadingSectionPageRanges,
    setReadingSections,
    updatePageProgressFromLocation,
  } = pageProgressController;
  const [progress, setProgress] = useState(0);
  const [toc, setToc] = useState([]);
  const [currentHref, setCurrentHref] = useState(null);
  const [currentChapter, setCurrentChapter] = useState(null);
  const [readerReloadKey, setReaderReloadKey] = useState(0);
  const [pageTurnAdapter, setPageTurnAdapter] = useState(null);
  const pageTurnAdapterRef = useRef(null);
  const loadingStateRef = useRef(isLoading);
  const errorStateRef = useRef(error);
  const loadStartedAtRef = useRef(0);
  const progressRef = useRef(0);
  const reloadCfiRef = useRef(null);
  const reloadProgressRef = useRef(null);
  const fullReloadPendingRef = useRef(false);
  const needsResumeRecoveryRef = useRef(false);
  const recoveryInFlightRef = useRef(false);
  const recoveryTimerRef = useRef(null);
  const recoverVisibleReaderRef = useRef(null);
  const resumeLifecycleActiveRef = useRef(true);
  const locationCaptureRef = useRef(null);
  const bookPaginationRequestRef = useRef(null);

  useEffect(() => {
    if (!isLayoutReady || !containerRef.current || !book?.id) return undefined;

    pageTurnAdapterRef.current?.destroy();
    pageTurnAdapterRef.current = null;
    setPageTurnAdapter(null);

    let destroyed = false;
    let handleRelocated;
    let reapplyReaderSettingsToView;
    let adapter = null;
    let activeToc = [];
    let bookArrayBuffer = null;
    let epubPagination = null;
    let handleRenditionResized;
    let latestHref = null;
    let latestSectionIndex = null;
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
      let epubBook;
      let rendition;

      try {
        const fileResponse = await fetch(`/api/books/${book.id}/file`);
        if (!fileResponse.ok) {
          const fileError = new Error(`文件加载失败 (${fileResponse.status})`);
          if (fileResponse.status === 404) fileError.code = 'BOOK_NOT_FOUND';
          throw fileError;
        }
        if (destroyed) return;

        const arrayBuffer = await fileResponse.arrayBuffer();
        if (destroyed) return;
        bookArrayBuffer = arrayBuffer;

        epubBook = createEpub(arrayBuffer);
        bookRef.current = epubBook;

        rendition = epubBook.renderTo(containerRef.current, {
          width: '100%',
          height: '100%',
          manager: 'continuous',
          flow: 'paginated',
          gap: getReaderPageGap(readerSettingsRef.current.horizontalMargin),
          spread: 'none',
          snap: true,
        });
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
          ? reloadProgressRef.current
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
            href,
          });
          setCurrentChapter(chapter);
          return chapter;
        };

        const updateFromLocation = (location, options = {}) => {
          const {
            allowUnstable = false,
            force = false,
            persist = true,
          } = options;
          if (!force && (isInitializing || isClosingRef.current)) return false;
          if (!allowUnstable && adapter && !adapter.isStableAligned()) return;
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
            locations: epubBook.locations,
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
            if (immediateLocation && typeof immediateLocation.then !== 'function') {
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
        await applyReaderHorizontalMargin(
          rendition,
          loadedReaderSettings.horizontalMargin,
          startCfi,
        );

        // epub.js derives CFIs from rendered geometry. Wait for the final
        // reader layout, then re-anchor after all injected styles have painted.
        // A cached book can otherwise finish while the cover FLIP is still
        // transforming the container and resume one or two pages too early.
        await waitForNextPaint();
        if (startCfi) {
          startCfi = createInteriorRestoreCfi(rendition, startCfi);
          await rendition.display(startCfi);
          await waitForNextPaint();
        }

        if (destroyed) return;
        isInitializing = false;
        const initialLocation = await Promise.resolve(rendition.currentLocation?.());
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
              arrayBuffer: bookArrayBuffer,
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
          if (openError.code === 'BOOK_NOT_FOUND') {
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
        rendition?.destroy();
        epubBook?.destroy();
        if (bookRef.current === epubBook) bookRef.current = null;
        if (renditionRef.current === rendition) renditionRef.current = null;
      }
    })();

    return () => {
      destroyed = true;
      epubPagination?.destroy();
      if (bookPaginationRequestRef.current === requestBookPagination) {
        bookPaginationRequestRef.current = null;
      }
      flushPendingReaderSettings();
      renditionRef.current?.off?.('relocated', handleRelocated);
      renditionRef.current?.off?.('rendered', reapplyReaderSettingsToView);
      renditionRef.current?.off?.('resized', handleRenditionResized);
      adapter?.destroy();
      if (pageTurnAdapterRef.current === adapter) {
        pageTurnAdapterRef.current = null;
      }
      renditionRef.current?.destroy();
      bookRef.current?.destroy();
      currentCfiRef.current = null;
      locationCaptureRef.current = null;
      bookRef.current = null;
      renditionRef.current = null;
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

  const requestFullReaderReload = useCallback((resumeCfi = null, resumeProgress = null) => {
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

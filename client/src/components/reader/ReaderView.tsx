import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { ReaderBook } from '../../types/library.js';
import type { SessionRendition } from '../../types/readerSession.js';
interface ReaderViewProps { book: ReaderBook; originRect?: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> | null; onBookUnavailable?: (id: number) => void; onClose: () => void; onOriginConsumed?: () => void; onProgressSettled?: () => void }
import { useCallback, useEffect, useRef, useState } from 'react';
import '../../styles/reader.css';
import { useFoliateReader } from '../../hooks/useFoliateReader.js';
import { useImageViewerSession } from '../../hooks/useImageViewerSession.js';
import { useModalDialog } from '../../hooks/useModalDialog.js';
import { usePageTurnController } from '../../hooks/usePageTurnController.js';
import { usePageProgress } from '../../hooks/usePageProgress.js';
import { usePageScrollLock } from '../../hooks/usePageScrollLock.js';
import { useReadingProgressPersistence } from '../../hooks/useReadingProgressPersistence.js';
import { useReaderSettings } from '../../hooks/useReaderSettings.js';
import type { ReaderSettings } from '../../hooks/useReaderSettings.js';
import type { ReaderController } from '../../reader/readerController';
import { useReducedMotion } from '../../hooks/useReducedMotion.js';
import {
  contentImageCursorAtViewportPoint,
  findContentImageAtViewportPoint,
} from '../../utils/contentImage.js';
import { requestFrameOrTimeout } from '../../utils/animationFrame.js';
import { findVisibleBookCoverRect } from '../../utils/coverOrigin.js';
import { readerBookIdFromHistoryState } from '../../utils/readerHistoryState.js';
import { ImageViewer } from './ImageViewer.js';
import { ReaderBottomBar } from './ReaderBottomBar.js';
import { ReaderSettingsPanel } from './ReaderSettingsPanel.js';
import { ReaderTopBar } from './ReaderTopBar.js';
import { TocPanel } from './TocPanel.js';
import { exportReaderDiagnostics } from '../../reader/diagnostics';
import { PAGE_TURN_DEBUG_STORAGE_KEY, readPageTurnDebugConfig } from '../../utils/pageTurnDiagnostics';

// Open/close FLIP animation: overlay scales between the shelf cover rect and full screen.
// Same duration/easing both directions to keep open/close symmetric.
const READER_FLIP_ANIM_MS = 300;
const READER_FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const READER_COVER_FADE_MS = 200;
const READER_PANEL_ANIM_MS = 260;
// Fallback when the origin/target cover rect can't be found (e.g. off-screen).
const READER_FALLBACK_ANIM_MS = 220;
const noop = () => {};

function isKeyboardEditingTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [role="slider"]'));
}

// Builds the transform that collapses the full-screen reader overlay down onto
// a cover's on-screen rect (or the inverse, expanding from it).
function rectToTransformString(rect: ReaderViewProps['originRect']) {
  if (!rect || !rect.width || !rect.height) return null;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (!vw || !vh) return null;

  return `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / vw}, ${rect.height / vh})`;
}

export function ReaderView({
  book,
  originRect,
  onBookUnavailable,
  onClose,
  onOriginConsumed = noop,
  onProgressSettled = noop,
}: ReaderViewProps) {
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<(HTMLDivElement) | null>(null);
  const renditionRef = useRef<(SessionRendition) | null>(null);
  const readerInitialFocusRef = useRef<(HTMLDivElement) | null>(null);
  const currentCfiRef = useRef<(string) | null>(null);
  const originRectRef = useRef(originRect);
  const isClosingRef = useRef(false);
  const pageEdgeRef = useRef<(HTMLDivElement) | null>(null);
  const readerControllerRef = useRef<ReaderController | null>(null);
  const cancelPageTurnRef = useRef<((reason: string) => void) | null>(null);
  const captureCurrentProgressRef = useRef<(() => Promise<boolean | undefined>) | null>(null);
  const closeAnimationFramesRef = useRef(new Set<number>());
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelCloseTimerRef = useRef<(ReturnType<typeof setTimeout>) | null>(null);
  const progressSettlementRef = useRef<(Promise<void>) | null>(null);
  const unmountSettlementTimerRef = useRef<(ReturnType<typeof setTimeout>) | null>(null);
  const applyReaderSettings = useCallback(async (settings: ReaderSettings) => {
    await readerControllerRef.current?.applySettings(settings);
  }, []);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(() => readPageTurnDebugConfig().enabled);
  const [chromeVisible, setChromeVisible] = useState(false);
  // Bottom-bar panel: null | 'toc' | 'settings'
  const [activePanel, setActivePanel] = useState<'toc' | 'settings' | null>(null);
  const [isPanelClosing, setIsPanelClosing] = useState(false);
  // Settings panel page: 'main' | 'font'
  const [settingsView, setSettingsView] = useState<'main' | 'font'>('main');
  // Open/close FLIP animation state: the overlay transform collapses onto (or
  // expands from) the shelf cover rect captured at click time.
  const [flipTransform, setFlipTransform] = useState(() => (
    originRect && !reducedMotion ? rectToTransformString(originRect) : null
  ));
  const [flipTransitionEnabled, setFlipTransitionEnabled] = useState(false);
  const [coverOpacity, setCoverOpacity] = useState(() => (
    originRect && !reducedMotion ? 1 : 0
  ));
  const [isFallbackClosing, setIsFallbackClosing] = useState(false);
  const [isReaderLayoutReady, setIsReaderLayoutReady] = useState(() => (
    !originRect || reducedMotion
  ));
  const {
    contentImage,
    isClosing: isImageViewerClosing,
    openImage,
    requestClose: requestImageViewerClose,
    viewerKey: imageViewerKey,
  } = useImageViewerSession({ bookId: book?.id, reducedMotion });
  const isImageViewerOpen = Boolean(contentImage);
  usePageScrollLock();

  const clearPanelCloseTimer = useCallback(() => {
    if (panelCloseTimerRef.current === null) return;
    clearTimeout(panelCloseTimerRef.current);
    panelCloseTimerRef.current = null;
  }, []);

  const openPanel = useCallback((panel: 'toc' | 'settings') => {
    clearPanelCloseTimer();
    setIsPanelClosing(false);
    setActivePanel(panel);
  }, [clearPanelCloseTimer]);

  const closePanel = useCallback(() => {
    if (!activePanel || isPanelClosing) return;
    clearPanelCloseTimer();
    if (reducedMotion) {
      setActivePanel(null);
      setIsPanelClosing(false);
      return;
    }

    setIsPanelClosing(true);
    panelCloseTimerRef.current = setTimeout(() => {
      panelCloseTimerRef.current = null;
      setActivePanel(null);
      setIsPanelClosing(false);
    }, READER_PANEL_ANIM_MS);
  }, [activePanel, clearPanelCloseTimer, isPanelClosing, reducedMotion]);

  useEffect(() => {
    const frames = closeAnimationFramesRef.current;
    return () => {
      clearPanelCloseTimer();
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
      frames.forEach(cancelAnimationFrame);
      frames.clear();
    };
  }, [clearPanelCloseTimer]);

  useEffect(() => {
    if (originRectRef.current) onOriginConsumed();
  }, [onOriginConsumed]);

  const {
    pageProgressController,
    pageProgressLabel,
  } = usePageProgress({ renditionRef });

  const {
    decreaseFontSize,
    fontFamilyId,
    fontFamilyOptions,
    fontSize,
    fontSizeMax,
    fontSizeMin,
    fontSizeStep,
    handleFontFamilyChange,
    handleFontSizeChange,
    handleThemeChange,
    increaseFontSize,
    layoutSettings,
    loadReaderSettings,
    markReaderSettingsLoaded,
    readerFont,
    readerSettingsRef,
    readerTheme,
    readerThemeId,
    resetReaderSettingsLoad,
    themeOptions,
  } = useReaderSettings({
    applySettings: applyReaderSettings,
    containerRef,
    currentCfiRef,
    isReaderReady: !isLoading && !error,
    renditionRef,
  });

  const {
    enqueueProgress,
    flushProgress,
  } = useReadingProgressPersistence({ bookId: book?.id });

  const settleReaderProgress = useCallback(() => {
    if (progressSettlementRef.current) return progressSettlementRef.current;

    const settlement = Promise.resolve(captureCurrentProgressRef.current?.())
      .catch(() => false)
      .then(() => flushProgress({ keepalive: true }))
      .then(
        () => onProgressSettled(),
        () => onProgressSettled(),
      );
    progressSettlementRef.current = settlement;
    return settlement;
  }, [flushProgress, onProgressSettled]);

  useEffect(() => {
    if (unmountSettlementTimerRef.current !== null) {
      clearTimeout(unmountSettlementTimerRef.current);
      unmountSettlementTimerRef.current = null;
    }

    return () => {
      unmountSettlementTimerRef.current = setTimeout(() => {
        unmountSettlementTimerRef.current = null;
        void settleReaderProgress();
      }, 0);
    };
  }, [settleReaderProgress]);

  const {
    captureCurrentProgress,
    currentChapter,
    currentHref,
    engine,
    controller,
    retry,
    startChapter,
    canFallback,
    progress,
    toc,
  } = useFoliateReader({
    book,
    containerRef,
    currentCfiRef,
    enqueueProgress,
    isLayoutReady: isReaderLayoutReady,
    loadReaderSettings,
    markReaderSettingsLoaded,
    onBookUnavailable,
    pageProgressController,
    readerSettingsRef,
    renditionRef,
    resetReaderSettingsLoad,
    setError,
    setIsLoading,
  });
  readerControllerRef.current = controller;
  captureCurrentProgressRef.current = captureCurrentProgress;
  const handleExportDiagnostics = () => exportReaderDiagnostics(engine, readerSettingsRef.current);
  const handleStartDiagnostics = () => {
    try { sessionStorage.setItem(PAGE_TURN_DEBUG_STORAGE_KEY, JSON.stringify({ enabled: true })); } catch { return; }
    setDiagnosticsEnabled(true);
    setActivePanel(null);
    retry();
  };

  useEffect(() => {
    const handleHistoryNavigation = (event: PopStateEvent) => {
      if (readerBookIdFromHistoryState(event.state) === Number(book?.id)) return;
      cancelPageTurnRef.current?.('history');
      if (isClosingRef.current) return;
      isClosingRef.current = true;
      void settleReaderProgress();
    };

    window.addEventListener('popstate', handleHistoryNavigation);
    return () => window.removeEventListener('popstate', handleHistoryNavigation);
  }, [book?.id, settleReaderProgress]);

  const handleCenterTap = useCallback(() => {
    setChromeVisible((visible) => {
      if (visible) closePanel();
      return !visible;
    });
  }, [closePanel]);

  const handleReaderTap = useCallback(({ clientX, clientY }: { clientX: number; clientY: number }) => {
    if (readerControllerRef.current?.snapshot.phase !== 'idle') return false;
    const image = findContentImageAtViewportPoint(
      renditionRef.current?.getContents() ?? [],
      clientX,
      clientY,
    );
    return image ? openImage(image) : false;
  }, [openImage]);

  const {
    cancelPageTurn,
    direction: pageTurnDirection,
    handlePointerCancel,
    handleLostPointerCapture,
    handlePointerDown,
    handlePointerMove: handlePagePointerMove,
    handlePointerUp,
    navigateTo,
    phase: pageTurnPhase,
    turnPage,
  } = usePageTurnController({
    controller,
    disabled: Boolean(activePanel) || isImageViewerOpen || isLoading || Boolean(error),
    edgeRef: pageEdgeRef,
    onCenterTap: handleCenterTap,
    onTap: handleReaderTap,
    reducedMotion,
  });

  const handleGesturePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    handlePagePointerMove(event);
    if (event.pointerType !== 'mouse' || event.buttons) return;
    if (readerControllerRef.current?.snapshot.phase !== 'idle') return;
    const cursor = contentImageCursorAtViewportPoint(
      renditionRef.current?.getContents() ?? [],
      event.clientX,
      event.clientY,
    );
    if (cursor) event.currentTarget.style.setProperty('cursor', cursor);
    else event.currentTarget.style.removeProperty('cursor');
  }, [handlePagePointerMove]);

  const clearGestureCursor = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.removeProperty('cursor');
  }, []);

  useEffect(() => {
    cancelPageTurnRef.current = cancelPageTurn;
    return () => {
      if (cancelPageTurnRef.current === cancelPageTurn) {
        cancelPageTurnRef.current = null;
      }
    };
  }, [cancelPageTurn]);

  useEffect(() => {
    if (activePanel !== 'settings') {
      setSettingsView('main');
    }
  }, [activePanel]);

  // Expand from the shelf cover rect (captured at click time) to full screen.
  // Skips animating entirely if no origin rect was captured.
  useEffect(() => {
    if (reducedMotion || !originRectRef.current) {
      setFlipTransitionEnabled(false);
      setFlipTransform(null);
      setCoverOpacity(0);
      setIsReaderLayoutReady(true);
      return undefined;
    }

    // Frame waits are bounded: a visible page that delivers no frames must
    // still reach layout-ready, or the reader never starts loading.
    let cancelFrame: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setIsReaderLayoutReady(false);
    cancelFrame = requestFrameOrTimeout(() => {
      cancelFrame = requestFrameOrTimeout(() => {
        cancelFrame = null;
        setFlipTransitionEnabled(true);
        setFlipTransform(null);
        setCoverOpacity(0);
        timer = setTimeout(() => {
          timer = null;
          setFlipTransitionEnabled(false);
          cancelFrame = requestFrameOrTimeout(() => {
            cancelFrame = null;
            setIsReaderLayoutReady(true);
          });
        }, READER_FLIP_ANIM_MS);
      });
    });

    return () => {
      cancelFrame?.();
      if (timer) clearTimeout(timer);
    };
  }, [reducedMotion]);

  const handleCloseClick = useCallback(() => {
    cancelPageTurnRef.current?.('close');
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    void settleReaderProgress();
    if (reducedMotion) {
      onClose();
      return;
    }

    const targetRect = book?.id ? findVisibleBookCoverRect(book.id) : null;

    if (targetRect) {
      setFlipTransitionEnabled(true);
      const firstFrame = requestAnimationFrame(() => {
        closeAnimationFramesRef.current.delete(firstFrame);
        const secondFrame = requestAnimationFrame(() => {
          closeAnimationFramesRef.current.delete(secondFrame);
          setFlipTransform(rectToTransformString(targetRect));
          setCoverOpacity(1);
        });
        closeAnimationFramesRef.current.add(secondFrame);
      });
      closeAnimationFramesRef.current.add(firstFrame);
      closeTimerRef.current = setTimeout(onClose, READER_FLIP_ANIM_MS);
    } else {
      setIsFallbackClosing(true);
      closeTimerRef.current = setTimeout(onClose, READER_FALLBACK_ANIM_MS);
    }
  }, [book?.id, onClose, reducedMotion, settleReaderProgress]);

  const { dialogRef, onKeyDown: onDialogKeyDown } = useModalDialog({
    initialFocusRef: readerInitialFocusRef,
    onRequestClose: handleCloseClick,
    open: true,
  });

  useEffect(() => {
    if (isLoading || error || activePanel || isImageViewerOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isKeyboardEditingTarget(event.target)) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void turnPage('prev', {
          action: 'tap-prev',
          inputTime: event.timeStamp,
        });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        void turnPage('next', {
          action: 'tap-next',
          inputTime: event.timeStamp,
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePanel, error, isImageViewerOpen, isLoading, turnPage]);

  const goToHref = useCallback((href: string) => {
    if (!href) return;
    void navigateTo(href);
    closePanel();
  }, [closePanel, navigateTo]);

  const overlayStyle: CSSProperties & Record<`--${string}`, string> = {
    '--reader-bg': readerTheme.background,
    '--reader-text': readerTheme.text,
    '--reader-text-secondary': readerTheme.muted,
  };
  if (flipTransform) {
    overlayStyle.transform = flipTransform;
    overlayStyle.transformOrigin = '0 0';
  }
  if (flipTransitionEnabled) {
    overlayStyle.transition = `transform ${READER_FLIP_ANIM_MS}ms ${READER_FLIP_EASE}`;
  }
  const handleToggleTocPanel = () => {
    if (activePanel === 'toc') {
      closePanel();
      return;
    }
    openPanel('toc');
  };

  const handleToggleSettingsPanel = () => {
    if (activePanel === 'settings') {
      closePanel();
      return;
    }
    setSettingsView('main');
    openPanel('settings');
  };

  return (
    <div
      ref={(node) => {
        dialogRef.current = node;
        readerInitialFocusRef.current = node;
      }}
      className={[
        'reader-overlay',
        `reader-theme-${readerThemeId}`,
        chromeVisible ? '' : 'reader-chrome-hidden',
        pageTurnPhase ? 'reader-page-turn-' + pageTurnPhase : '',
        pageTurnDirection ? 'reader-page-turn-direction-' + pageTurnDirection : '',
        isPanelClosing ? 'reader-panel-closing' : '',
        isFallbackClosing ? 'reader-fallback-closing' : '',
      ].filter(Boolean).join(' ')}
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`正在阅读：${book?.title || '书籍'}`}
      onKeyDown={onDialogKeyDown}
      tabIndex={-1}
    >
      <ReaderTopBar
        onClose={handleCloseClick}
        title={book?.title}
      />

      {!isLoading && !error && currentChapter?.label && (
        <div className="reader-chapter-title" aria-live="polite">
          {currentChapter.label}
        </div>
      )}

      {book?.coverUrl && (
        <img
          className="reader-cover-clone"
          src={book.coverUrl}
          alt=""
          aria-hidden="true"
          style={{
            opacity: coverOpacity,
            transitionDuration: `${reducedMotion ? 0 : READER_COVER_FADE_MS}ms`,
          }}
        />
      )}

      <div className="reader-body">
        {isLoading && (
          <div className="reader-loading" role="status" aria-live="polite">
            <span className="reader-loading-spinner" aria-hidden="true" />
            <p>正在打开书籍</p>
          </div>
        )}
        {error && (
          <div className="reader-error error-message" role="alert"><p>{error}</p><button onClick={retry}>重试</button>{canFallback && <button onClick={startChapter}>从本章开头继续</button>}<button onClick={handleExportDiagnostics}>导出阅读诊断</button></div>
        )}
        <div
          ref={containerRef}
          className="reader-epub-container"
        />
        <div
          ref={pageEdgeRef}
          className={[
            'reader-page-edge',
            pageTurnDirection ? 'reader-page-edge-' + pageTurnDirection : '',
          ].filter(Boolean).join(' ')}
          aria-hidden="true"
        />
      </div>

      {/* Gesture layer: tap thirds (prev / toggle chrome / next) + horizontal swipe */}
      <div
        className="reader-gesture-layer"
        style={isLoading || error ? { pointerEvents: 'none' } : undefined}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onPointerDown={handlePointerDown}
        onPointerLeave={clearGestureCursor}
        onPointerMove={handleGesturePointerMove}
        onPointerUp={handlePointerUp}
        aria-hidden="true"
      />

      {!isLoading && !error && (
        <span className="reader-page-progress" aria-label={`页码 ${pageProgressLabel}`}>
          {pageProgressLabel}
        </span>
      )}

      {!isLoading && !error && (
        <span
          className="reader-book-progress"
          aria-label={`书籍进度 ${Math.round(progress * 100)}%`}
        >
          {Math.round(progress * 100)}%
        </span>
      )}

      {!isLoading && !error && (
        <ReaderBottomBar
          activePanel={activePanel}
          onToggleSettings={handleToggleSettingsPanel}
          onToggleToc={handleToggleTocPanel}
        />
      )}

      {activePanel && (
        <div className="reader-panel-backdrop" onClick={closePanel} />
      )}
      {activePanel === 'toc' && (
        <TocPanel
          currentChapterId={currentChapter?.chapterId}
          currentHref={currentHref}
          onSelect={goToHref}
          toc={toc}
        />
      )}
      {activePanel === 'settings' && (
        <ReaderSettingsPanel
          diagnosticsEnabled={diagnosticsEnabled}
          onStartDiagnostics={handleStartDiagnostics}
          onExportDiagnostics={handleExportDiagnostics}
          fontFamilyId={fontFamilyId}
          fontFamilyOptions={fontFamilyOptions}
          fontSize={fontSize}
          fontSizeMax={fontSizeMax}
          fontSizeMin={fontSizeMin}
          fontSizeStep={fontSizeStep}
          layoutSettings={layoutSettings}
          onBackToMain={() => setSettingsView('main')}
          onDecreaseFontSize={decreaseFontSize}
          onFontFamilyChange={handleFontFamilyChange}
          onFontSizeChange={handleFontSizeChange}
          onIncreaseFontSize={increaseFontSize}
          onOpenFontSettings={() => setSettingsView('font')}
          onThemeChange={handleThemeChange}
          readerFont={readerFont}
          readerTheme={readerTheme}
          readerThemeId={readerThemeId}
          settingsView={settingsView}
          themeOptions={themeOptions}
        />
      )}
      {contentImage && (
        <ImageViewer
          contentImage={contentImage}
          isClosing={isImageViewerClosing}
          key={imageViewerKey}
          onRequestClose={requestImageViewerClose}
          reducedMotion={reducedMotion}
        />
      )}
    </div>
  );
}

export default ReaderView;

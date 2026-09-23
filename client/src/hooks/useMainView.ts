import type { MainView } from '../utils/mainViewPreference.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clearReaderOriginMainView,
  MAIN_VIEW,
  readInitialMainView,
  writeReaderOriginMainView,
} from '../utils/mainViewPreference.js';

interface UseMainViewOptions {
  /** True while a reader session is open or being displayed over the main views. */
  readerActive: boolean;
}

/**
 * Owns the 首页 / 书架 selection and each view's window scroll position.
 *
 * Switching views never touches browser history, so it cannot compete with the reader or
 * image-viewer history markers. The view an open reader belongs to is remembered in a
 * small sanitized preference, so reloading into an active reader returns to that view.
 */
export function useMainView({ readerActive }: UseMainViewOptions) {
  const [mainView, setMainView] = useState<MainView>(readInitialMainView);
  const mainViewRef = useRef(mainView);
  const scrollPositionsRef = useRef<Record<MainView, number>>({
    [MAIN_VIEW.HOME]: 0,
    [MAIN_VIEW.SHELF]: 0,
  });
  const pendingScrollRestoreRef = useRef<MainView | null>(null);
  const wasReaderActiveRef = useRef(readerActive);

  const selectMainView = useCallback((nextView: MainView) => {
    const currentView = mainViewRef.current;
    if (currentView === nextView) return;

    scrollPositionsRef.current[currentView] = window.scrollY;
    mainViewRef.current = nextView;
    pendingScrollRestoreRef.current = nextView;
    setMainView(nextView);
  }, []);

  // Restore before paint so the newly shown view never flashes at the other view's offset.
  useLayoutEffect(() => {
    if (pendingScrollRestoreRef.current !== mainView) return;
    pendingScrollRestoreRef.current = null;
    window.scrollTo({ top: scrollPositionsRef.current[mainView], behavior: 'auto' });
  }, [mainView]);

  // The origin preference exists only while a reader is open: written when it opens (or is
  // restored) and removed when it closes, so no stale value outlives its reader session.
  useEffect(() => {
    if (readerActive) {
      writeReaderOriginMainView(mainView);
    } else if (wasReaderActiveRef.current) {
      clearReaderOriginMainView();
    }
    wasReaderActiveRef.current = readerActive;
  }, [mainView, readerActive]);

  useEffect(() => {
    const body = document.body;
    body.dataset.mainView = mainView;
    return () => {
      delete body.dataset.mainView;
    };
  }, [mainView]);

  return { mainView, selectMainView };
}

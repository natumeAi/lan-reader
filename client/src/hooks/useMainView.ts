import type { MainView } from '../utils/mainViewPreference.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { requestFrameOrTimeout } from '../utils/animationFrame.js';
import {
  clearReaderOriginMainView,
  MAIN_VIEW,
  mainViewIndex,
  readInitialMainView,
  writeReaderOriginMainView,
} from '../utils/mainViewPreference.js';

export const MAIN_VIEW_PHASE_MS = 130;

export type MainViewMotionPhase = 'idle' | 'exiting' | 'preparing' | 'entering' | 'restoring';

interface MotionState {
  mainView: MainView;
  requestedView: MainView;
  /** The page that was visible when the current switch began exiting. */
  sourceView: MainView;
  phase: MainViewMotionPhase;
  direction: -1 | 1;
  generation: number;
  instant: boolean;
}

interface UseMainViewOptions {
  /** True while a reader session is open or being displayed over the main views. */
  readerActive: boolean;
  reducedMotion?: boolean;
}

/**
 * Movement direction from one destination to another by their navigation order. A switch
 * back to the same page (possible only as a retarget while both pages are transparent)
 * reverses the current movement.
 */
function directionBetween(from: MainView, to: MainView, current: -1 | 1): -1 | 1 {
  const delta = mainViewIndex(to) - mainViewIndex(from);
  if (delta === 0) return current === 1 ? -1 : 1;
  return delta > 0 ? 1 : -1;
}

/** Owns the committed page, latest visual target and each page's window scroll offset. */
export function useMainView({
  readerActive,
  reducedMotion = false,
}: UseMainViewOptions) {
  const [motion, setMotion] = useState<MotionState>(() => {
    const mainView = readInitialMainView();
    return { mainView, requestedView: mainView, sourceView: mainView, phase: 'idle',
      direction: 1, generation: 0, instant: false };
  });
  const motionRef = useRef(motion);
  const scrollPositionsRef = useRef<Record<MainView, number>>({
    [MAIN_VIEW.HOME]: 0,
    [MAIN_VIEW.SHELF]: 0,
    [MAIN_VIEW.STATISTICS]: 0,
  });
  const pendingScrollRestoreRef = useRef<MainView | null>(null);
  const wasReaderActiveRef = useRef(readerActive);
  const blockedRef = useRef(false);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const publish = useCallback((next: MotionState) => {
    motionRef.current = next;
    setMotion(next);
  }, []);

  const commitImmediately = useCallback((target: MainView) => {
    const current = motionRef.current;
    if (target !== current.mainView) {
      scrollPositionsRef.current[current.mainView] = window.scrollY;
      pendingScrollRestoreRef.current = target;
    }
    publish({
      mainView: target,
      requestedView: target,
      sourceView: target,
      phase: 'idle',
      direction: current.direction,
      generation: current.generation + 1,
      instant: true,
    });
  }, [publish]);

  const selectMainView = useCallback((nextView: MainView) => {
    if (blockedRef.current) return;
    const current = motionRef.current;
    if (current.requestedView === nextView) return;
    if (reducedMotionRef.current) {
      commitImmediately(nextView);
      return;
    }
    const generation = current.generation + 1;
    if (current.phase === 'preparing') {
      // Both pages are transparent. Retarget the swap without showing an obsolete page.
      if (nextView !== current.mainView) pendingScrollRestoreRef.current = nextView;
      // The direction stays relative to the page that exited, not the transparent target.
      publish({ ...current, mainView: nextView, requestedView: nextView, phase: 'preparing',
        direction: directionBetween(current.sourceView, nextView, current.direction),
        generation, instant: false });
      return;
    }
    if (nextView === current.mainView) {
      publish({ ...current, requestedView: nextView, phase: 'restoring',
        generation, instant: false });
      return;
    }
    publish({ ...current, requestedView: nextView, sourceView: current.mainView, phase: 'exiting',
      direction: directionBetween(current.mainView, nextView, current.direction),
      generation, instant: false });
  }, [commitImmediately, publish]);

  const finishPhase = useCallback((phase: MainViewMotionPhase, generation: number) => {
    const current = motionRef.current;
    if (current.phase !== phase || current.generation !== generation) return;
    if (blockedRef.current) {
      publish({ ...current, requestedView: current.mainView, phase: 'idle',
        generation: generation + 1, instant: true });
      return;
    }
    if (reducedMotionRef.current) {
      commitImmediately(current.requestedView);
      return;
    }
    if (phase === 'exiting') {
      // Take the source's latest offset at the transparent point, not at request time.
      scrollPositionsRef.current[current.mainView] = window.scrollY;
      pendingScrollRestoreRef.current = current.requestedView;
      publish({ ...current, mainView: current.requestedView, phase: 'preparing',
        generation: generation + 1 });
    } else if (phase === 'entering' || phase === 'restoring') {
      publish({ ...current, requestedView: current.mainView, phase: 'idle',
        generation: generation + 1, instant: false });
    }
  }, [commitImmediately, publish]);

  const setNavigationBlocked = useCallback((blocked: boolean) => {
    blockedRef.current = blocked;
    const current = motionRef.current;
    if (!blocked || current.phase === 'idle') return;
    publish({ ...current, requestedView: current.mainView, phase: 'idle',
      generation: current.generation + 1, instant: true });
  }, [publish]);

  // Hidden/visible layout changes and scroll restoration complete together before paint.
  useLayoutEffect(() => {
    if (pendingScrollRestoreRef.current !== motion.mainView) return;
    pendingScrollRestoreRef.current = null;
    window.scrollTo({ top: scrollPositionsRef.current[motion.mainView], behavior: 'auto' });
  }, [motion.mainView]);

  useLayoutEffect(() => {
    if (motion.phase === 'idle') return undefined;
    if (motion.phase === 'preparing') {
      // The transparent entry offset must be committed before enabling its transition.
      let cancelSecond: (() => void) | undefined;
      const cancelFirst = requestFrameOrTimeout(() => {
        cancelSecond = requestFrameOrTimeout(() => {
          const current = motionRef.current;
          if (current.phase !== 'preparing' || current.generation !== motion.generation) return;
          publish({ ...current, phase: 'entering', generation: current.generation + 1 });
        });
      });
      return () => { cancelFirst(); cancelSecond?.(); };
    }
    const timer = setTimeout(() => finishPhase(motion.phase, motion.generation), MAIN_VIEW_PHASE_MS + 34);
    return () => clearTimeout(timer);
  }, [finishPhase, motion.generation, motion.phase, publish]);

  // A live reduced-motion change settles the latest accepted target and invalidates its
  // previous phase's frame/timer callbacks.
  useLayoutEffect(() => {
    const current = motionRef.current;
    if (current.phase === 'idle') return;
    if (reducedMotion && !blockedRef.current) {
      commitImmediately(current.requestedView);
    }
  }, [commitImmediately, reducedMotion]);

  // The origin preference exists only while a reader is open.
  useEffect(() => {
    if (readerActive) {
      writeReaderOriginMainView(motion.mainView);
    } else if (wasReaderActiveRef.current) {
      clearReaderOriginMainView();
    }
    wasReaderActiveRef.current = readerActive;
  }, [motion.mainView, readerActive]);

  useEffect(() => {
    const body = document.body;
    body.dataset.mainView = motion.mainView;
    return () => { delete body.dataset.mainView; };
  }, [motion.mainView]);

  return {
    mainView: motion.mainView,
    requestedView: motion.requestedView,
    motionPhase: motion.phase,
    motionDirection: motion.direction,
    motionGeneration: motion.generation,
    motionInstant: motion.instant,
    selectMainView,
    finishPhase,
    setNavigationBlocked,
  };
}

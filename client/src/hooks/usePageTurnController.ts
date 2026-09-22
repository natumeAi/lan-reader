import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { ReaderRendition, ReaderLocation } from '../types/epub.js';
import type { createEpubPageTurnAdapter } from '../utils/epubPageTurnAdapter.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PAGE_TURN_RULES,
  classifyDirection,
  decidePageDelta,
  getRecentVelocity,
  getSettleDuration,
  getTapZone,
} from '../utils/pageTurnGesture.js';
import {
  displayRenditionTarget,
  navigateBasicRenditionPage,
  readRenditionLocation,
  releaseContinuousManagerLayoutAnchor,
  stabilizeContinuousManagerLayout,
  waitForContinuousManagerQueue,
} from '../utils/epubNavigation.js';

type PageDirection = 'next' | 'prev';
type TurnPhase = 'basic' | 'idle' | 'pending' | 'dragging' | 'settling';
type ConcreteAdapter = ReturnType<typeof createEpubPageTurnAdapter>;
type TurnSession = Pick<NonNullable<ReturnType<ConcreteAdapter['begin']>>, 'canNext' | 'canPrevious' | 'pageWidth'>;
/** The controller owns interactions; the adapter owns renderer internals. */
export interface PageTurnAdapter {
  begin(...args: Parameters<ConcreteAdapter['begin']>): TurnSession | null;
  cancel(...args: Parameters<ConcreteAdapter['cancel']>): boolean | void;
  dragBy(distanceX: number): Pick<NonNullable<ReturnType<ConcreteAdapter['dragBy']>>, 'effectiveDistanceX' | 'progress'> | null;
  end: ConcreteAdapter['end'];
  inspect(): { available: boolean; pageWidth?: number };
  isStableAt: ConcreteAdapter['isStableAt'];
  animateTo(...args: Parameters<ConcreteAdapter['animateTo']>): PromiseLike<Pick<Awaited<ReturnType<ConcreteAdapter['animateTo']>>, 'status'>>;
  recover(stableCfi?: string | null): boolean | PromiseLike<boolean>;
}
type PointerCoordinates = Pick<ReactPointerEvent<HTMLElement>, 'clientX' | 'clientY' | 'currentTarget' | 'pointerId' | 'timeStamp'>;
type PointerDown = PointerCoordinates & Pick<ReactPointerEvent<HTMLElement>, 'pointerType'> & { isPrimary?: boolean };
type PointerMove = PointerCoordinates & Pick<ReactPointerEvent<HTMLElement>, 'cancelable' | 'preventDefault'>;
interface TurnInteraction { action?: string; inputTime?: number; duration?: number }
interface RelocationWait {
  cancel(): void;
  isSettled(): boolean;
  promise: Promise<ReaderLocation | null>;
}
interface TurnPointer {
  operationVersion: number;
  pointerId: number;
  pointerType: string;
  target: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  locked: 'horizontal' | null;
  captured: boolean;
  mode: 'basic' | 'tap' | 'enhanced';
  session: TurnSession | null;
  samples: { x: number; time: number }[];
}
export interface PageTurnControllerOptions {
  adapter?: PageTurnAdapter | null;
  currentCfiRef: RefObject<string | null>;
  disabled?: boolean;
  edgeRef: RefObject<HTMLElement | null>;
  onCenterTap?: () => void;
  onNavigationSettled?: () => unknown;
  /** Detach the failed session and preserve an explicitly superseding display target. */
  onNavigationStalled?: (rendition: ReaderRendition, stableCfi: string | null, target?: string) => void;
  onPageTurnCommitted?: () => unknown;
  onTap?: (input: { clientX: number; clientY: number; inputTime: number; pointerType: string }) => unknown;
  reducedMotion?: boolean;
  renditionRef: RefObject<ReaderRendition | null>;
}

const SYSTEM_NAVIGATION_EDGE_PX = 32;

async function settleWithin<T>(value: T | PromiseLike<T>, timeoutMs = PAGE_TURN_RULES.relocatedTimeoutMs) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(value).then(
        (result) => ({ status: 'completed' as const, value: result }),
        () => ({ status: 'failed' as const }),
      ),
      timeout,
    ]);
  } finally { clearTimeout(timer); }
}

function pageDelta(direction: PageDirection) {
  return direction === 'next' ? 1 : -1;
}

function isBoundary(location: ReaderLocation | null | undefined, direction: PageDirection) {
  return direction === 'next' ? Boolean(location?.atEnd) : Boolean(location?.atStart);
}

function startsInSystemNavigationEdge(event: PointerCoordinates) {
  const rect = event.currentTarget?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0) return false;

  const offsetX = event.clientX - rect.left;
  const edgeWidth = Math.min(SYSTEM_NAVIGATION_EDGE_PX, rect.width / 4);
  return offsetX <= edgeWidth || offsetX >= rect.width - edgeWidth;
}

function createRelocationWait(rendition: ReaderRendition | null, predicate: (location: ReaderLocation) => boolean, timeoutMs: number): RelocationWait {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise: (location: ReaderLocation | null) => void;

  const cleanup = () => {
    rendition?.off?.('relocated', handleRelocated);
    clearTimeout(timer);
  };
  const finish = (value: ReaderLocation | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const handleRelocated = (location: ReaderLocation) => {
    if (predicate(location)) finish(location);
  };
  const promise = new Promise<ReaderLocation | null>((resolve) => {
    resolvePromise = resolve;
    rendition?.on?.('relocated', handleRelocated);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
  return {
    cancel: () => finish(null),
    isSettled: () => settled,
    promise,
  };
}

function requestCommittedLocation(rendition: ReaderRendition | null, waiter: RelocationWait) {
  if (waiter?.isSettled?.() || typeof rendition?.reportLocation !== 'function') return;

  try {
    void Promise.resolve(rendition.reportLocation()).catch(() => {});
  } catch {
    // The existing relocation timeout remains the recovery path.
  }
}

export function usePageTurnController({
  adapter,
  currentCfiRef,
  disabled = false,
  edgeRef,
  onCenterTap,
  onNavigationSettled,
  onNavigationStalled,
  onPageTurnCommitted,
  onTap,
  reducedMotion = false,
  renditionRef,
}: PageTurnControllerOptions) {
  const [phase, setPhaseState] = useState<TurnPhase>('basic');
  const [direction, setDirection] = useState<PageDirection | null>(null);
  const phaseRef = useRef<TurnPhase>('basic');
  const basicRef = useRef(true);
  const relocationWaitRef = useRef<RelocationWait | null>(null);
  const pointerRef = useRef<TurnPointer | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragDistanceRef = useRef(0);
  const cancellationVersionRef = useRef(0);
  const pendingEngineRef = useRef<{ rendition: ReaderRendition; version: number; recovery?: boolean } | null>(null);
  const retiredRenditionsRef = useRef(new WeakSet<ReaderRendition>());

  const setPhase = useCallback((nextPhase: TurnPhase) => {
    phaseRef.current = nextPhase;
    setPhaseState(nextPhase);
  }, []);

  const publishCurrentProgress = useCallback(() => (
    settleWithin(Promise.resolve().then(() => onNavigationSettled?.()))
  ), [onNavigationSettled]);

  const syncCommittedPage = useCallback(() => (
    Promise.resolve(onPageTurnCommitted?.()).catch(() => false)
  ), [onPageTurnCommitted]);

  const isCurrentOperation = useCallback((version: number) => (
    cancellationVersionRef.current === version
  ), []);

  const beginOperation = useCallback(() => {
    releaseContinuousManagerLayoutAnchor(renditionRef.current);
    cancellationVersionRef.current += 1;
    return cancellationVersionRef.current;
  }, [renditionRef]);

  const setEdgeOpacity = useCallback((opacity: string) => {
    const edge = edgeRef.current;
    if (!edge || edge.style.opacity === opacity) return;
    edge.style.setProperty('opacity', opacity);
  }, [edgeRef]);

  const hideEdge = useCallback(() => {
    setEdgeOpacity('0');
  }, [setEdgeOpacity]);

  const showEdge = useCallback((nextDirection: PageDirection) => {
    setDirection(nextDirection);
    setEdgeOpacity('1');
  }, [setEdgeOpacity]);

  const clearEdge = useCallback(() => {
    hideEdge();
    setDirection(null);
  }, [hideEdge]);

  const restoreReadyPhase = useCallback(() => {
    clearEdge();
    setPhase(basicRef.current ? 'basic' : 'idle');
  }, [clearEdge, setPhase]);

  const enterBasic = useCallback(() => {
    basicRef.current = true;
    clearEdge();
    setPhase('basic');
  }, [clearEdge, setPhase]);

  const clearDragFrame = useCallback(() => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
  }, []);

  const releasePointer = useCallback((pointer = pointerRef.current) => {
    if (!pointer) return;
    try {
      if (pointer.target?.hasPointerCapture?.(pointer.pointerId)) {
        pointer.target.releasePointerCapture(pointer.pointerId);
      }
    } catch {
      // Pointer capture can already be gone after browser cancellation.
    }
  }, []);

  const writeDragFrame = useCallback((distanceX: number) => {
    return adapter?.dragBy(distanceX);
  }, [adapter]);

  const queueDragFrame = useCallback((distanceX: number) => {
    pendingDragDistanceRef.current = distanceX;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      writeDragFrame(pendingDragDistanceRef.current);
    });
  }, [writeDragFrame]);

  const finishPointer = useCallback(() => {
    clearDragFrame();
    releasePointer();
    pointerRef.current = null;
  }, [clearDragFrame, releasePointer]);

  const rememberCurrentCfi = useCallback((rendition = renditionRef.current) => {
    try {
      const location = rendition?.currentLocation?.();
      if (location && !('then' in location) && location.start?.cfi) {
        currentCfiRef.current = location.start.cfi;
      } else if (location && 'then' in location) {
        void Promise.resolve(location).catch(() => {});
      }
    } catch {
      // Keep the last verified content anchor if layout is unavailable.
    }
  }, [currentCfiRef, renditionRef]);

  const retireSession = useCallback((rendition: ReaderRendition, version: number, rememberPosition = true, target?: string) => {
    if (!isCurrentOperation(version)) return;
    retiredRenditionsRef.current.add(rendition);
    pendingEngineRef.current = null;
    cancellationVersionRef.current += 1;
    relocationWaitRef.current?.cancel();
    relocationWaitRef.current = null;
    finishPointer();
    adapter?.cancel({ reason: 'navigation-timeout', restoreOrigin: true });
    if (rememberPosition) rememberCurrentCfi(rendition);
    // Book disposal alone does not cancel Rendition.q in epub.js 0.3.93. The
    // integration detaches this session synchronously; queued page turns also
    // check the now-invalid operation before touching their old manager.
    onNavigationStalled?.(rendition, currentCfiRef.current, target);
    restoreReadyPhase();
  }, [adapter, currentCfiRef, finishPointer, isCurrentOperation, onNavigationStalled, rememberCurrentCfi, restoreReadyPhase]);

  const recoverToReady = useCallback(async (operationVersion: number, stableCfi = currentCfiRef.current) => {
    let restored: boolean;
    const rendition = renditionRef.current;
    try {
      if (rendition) pendingEngineRef.current = { rendition, version: operationVersion, recovery: true };
      const recovery = await settleWithin(adapter?.recover?.(stableCfi));
      if (recovery.status === 'timeout' && rendition) {
        retireSession(rendition, operationVersion, false);
        return false;
      }
      restored = recovery.status === 'completed' && Boolean(recovery.value);
    } catch {
      restored = false;
    } finally {
      if (pendingEngineRef.current?.version === operationVersion) pendingEngineRef.current = null;
    }
    if (!isCurrentOperation(operationVersion)) return false;
    if (!restored && rendition) {
      retireSession(rendition, operationVersion, false);
      return false;
    }
    const capability = restored ? adapter?.inspect?.() : null;
    clearEdge();
    basicRef.current = reducedMotion || !capability?.available;
    setPhase(basicRef.current ? 'basic' : 'idle');
    void syncCommittedPage();
    return restored;
  }, [adapter, clearEdge, currentCfiRef, isCurrentOperation, reducedMotion, renditionRef, retireSession, setPhase, syncCommittedPage]);

  const cancelPageTurn = useCallback((reason = 'cancelled') => {
    const pending = pendingEngineRef.current;
    // Repeated resize events belong to the same reflow and restore anchor.
    // Keep exclusive ownership until its bounded recovery has settled.
    if (pending?.recovery && reason === 'viewport') return;
    if (pending && !['unmount', 'history'].includes(reason)) {
      retireSession(pending.rendition, pending.version);
    }
    releaseContinuousManagerLayoutAnchor(renditionRef.current);
    cancellationVersionRef.current += 1;
    relocationWaitRef.current?.cancel();
    relocationWaitRef.current = null;
    finishPointer();
    const restored = adapter?.cancel({ reason, restoreOrigin: true });
    if (restored === false && renditionRef.current && !['unmount', 'history'].includes(reason)) {
      if (['viewport', 'settings'].includes(reason)) {
        // A resized page cannot reuse its pixel origin. The verified CFI is
        // still valid: restore it in this rendition before considering a reload.
        setPhase('settling');
        void recoverToReady(cancellationVersionRef.current);
        return;
      }
      retireSession(renditionRef.current, cancellationVersionRef.current, false);
    } else if (restored !== false) rememberCurrentCfi();
    void syncCommittedPage();
    restoreReadyPhase();
  }, [adapter, finishPointer, rememberCurrentCfi, recoverToReady, renditionRef, restoreReadyPhase, retireSession, setPhase, syncCommittedPage]);

  const navigateTo = useCallback(async (target: string) => {
    if (!target || !renditionRef.current) return 'failed';

    const pending = pendingEngineRef.current;
    if (pending && isCurrentOperation(pending.version) && onNavigationStalled) {
      // Replacement detaches renditionRef synchronously and initializes later.
      // Hand the user's target to that session instead of dropping it in the gap.
      retireSession(pending.rendition, pending.version, false, target);
      return 'recovering';
    }
    cancelPageTurn('display');
    const operationVersion = cancellationVersionRef.current;
    const rendition = renditionRef.current;
    if (!rendition || retiredRenditionsRef.current.has(rendition)) return 'failed';
    setPhase('settling');
    try {
      pendingEngineRef.current = { rendition, version: operationVersion };
      const display = await settleWithin(displayRenditionTarget(rendition, target, {
        shouldContinue: () => isCurrentOperation(operationVersion),
      }));
      if (!isCurrentOperation(operationVersion)) return 'ignored';
      if (display.status === 'timeout') {
        retireSession(rendition, operationVersion);
        return 'failed';
      }
      if (display.status !== 'completed' || !display.value) return 'failed';
      pendingEngineRef.current = null;

      void syncCommittedPage();
      await publishCurrentProgress();
      return isCurrentOperation(operationVersion) ? 'completed' : 'ignored';
    } catch {
      return isCurrentOperation(operationVersion) ? 'failed' : 'ignored';
    } finally {
      if (pendingEngineRef.current?.version === operationVersion) pendingEngineRef.current = null;
      if (isCurrentOperation(operationVersion)) restoreReadyPhase();
    }
  }, [
    cancelPageTurn,
    isCurrentOperation,
    onNavigationStalled,
    publishCurrentProgress,
    renditionRef,
    retireSession,
    restoreReadyPhase,
    setPhase,
    syncCommittedPage,
  ]);

  useEffect(() => {
    cancellationVersionRef.current += 1;
    adapter?.cancel({ restoreOrigin: true });
    const restoreContinuousLayout = stabilizeContinuousManagerLayout(renditionRef.current);
    const capability = adapter?.inspect?.();
    basicRef.current = reducedMotion || !capability?.available;
    setPhase(basicRef.current ? 'basic' : 'idle');
    return () => {
      cancellationVersionRef.current += 1;
      relocationWaitRef.current?.cancel();
      adapter?.cancel({ restoreOrigin: true });
      restoreContinuousLayout();
    };
  }, [adapter, reducedMotion, renditionRef, setPhase]);

  useEffect(() => {
    const cancelForLifecycle = () => cancelPageTurn('viewport');
    const cancelWhenHidden = () => {
      if (document.visibilityState === 'hidden') cancelPageTurn('hidden');
    };
    window.addEventListener('resize', cancelForLifecycle);
    window.addEventListener('orientationchange', cancelForLifecycle);
    document.addEventListener('visibilitychange', cancelWhenHidden);
    return () => {
      window.removeEventListener('resize', cancelForLifecycle);
      window.removeEventListener('orientationchange', cancelForLifecycle);
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      cancelPageTurn('unmount');
    };
  }, [cancelPageTurn]);

  const runBasicNavigation = useCallback(async (
    nextDirection: PageDirection,
    operationVersion = cancellationVersionRef.current,
  ) => {
    const rendition = renditionRef.current;
    if (!rendition || retiredRenditionsRef.current.has(rendition)) return 'failed';
    let navigationActive = true;
    const waiter = createRelocationWait(
      rendition,
      () => true,
      PAGE_TURN_RULES.relocatedTimeoutMs,
    );
    relocationWaitRef.current = waiter;
    try {
      const navigation = navigateBasicRenditionPage(rendition, nextDirection, {
        shouldContinue: () => navigationActive && isCurrentOperation(operationVersion),
        waitForCompletion: true,
        onEnginePendingChange: (pending) => {
          if (!navigationActive || !isCurrentOperation(operationVersion)) return;
          pendingEngineRef.current = pending ? { rendition, version: operationVersion } : null;
        },
      });
      // Continuous navigation moves the viewport synchronously, while its
      // preload/check queue can take much longer. Publish the visual page now
      // so the label cannot lag one turn behind the content.
      void syncCommittedPage();
      const completion = await settleWithin(navigation);
      if (!isCurrentOperation(operationVersion)) return 'ignored';
      if (completion.status !== 'completed') {
        if (pendingEngineRef.current) retireSession(rendition, operationVersion);
        return 'failed';
      }
      if (completion.value === false) return 'failed';
      void syncCommittedPage();
      const currentLocation = await settleWithin(readRenditionLocation(rendition));
      const location = currentLocation.status === 'completed' && currentLocation.value?.start?.cfi
        ? currentLocation.value
        : await waiter.promise;
      if (!isCurrentOperation(operationVersion)) return 'ignored';
      if (!location?.start?.cfi) {
        void syncCommittedPage();
        return 'failed';
      }
      await publishCurrentProgress();
      return isCurrentOperation(operationVersion) ? 'completed' : 'ignored';
    } catch {
      waiter.cancel();
      void syncCommittedPage();
      return 'failed';
    } finally {
      navigationActive = false;
      waiter.cancel();
      if (pendingEngineRef.current?.version === operationVersion) pendingEngineRef.current = null;
      if (relocationWaitRef.current === waiter) relocationWaitRef.current = null;
    }
  }, [isCurrentOperation, publishCurrentProgress, renditionRef, retireSession, syncCommittedPage]);

  const runEnhancedNavigation = useCallback(async (
    nextDirection: PageDirection,
    operationVersion: number,
    interaction: TurnInteraction,
  ) => {
    if (!adapter) return 'ignored';
    const delta = pageDelta(nextDirection);
    const rendition = renditionRef.current;
    const waiter = createRelocationWait(
      rendition,
      () => adapter.isStableAt(delta),
      PAGE_TURN_RULES.relocatedTimeoutMs,
    );
    relocationWaitRef.current = waiter;
    const animationResult = await settleWithin(Promise.resolve().then(() => adapter.animateTo(delta, {
      action: interaction.action,
      duration: interaction.duration ?? PAGE_TURN_RULES.tapDurationMs,
      inputTime: interaction.inputTime,
    })));

    if (!isCurrentOperation(operationVersion)) {
      waiter.cancel();
      return 'ignored';
    }
    hideEdge();
    if (animationResult.status !== 'completed') {
      waiter.cancel();
      await recoverToReady(operationVersion);
      return isCurrentOperation(operationVersion) ? 'failed' : 'ignored';
    }
    const animation = animationResult.value;
    if (animation.status !== 'completed') {
      waiter.cancel();
      if (animation.status === 'unavailable') {
        await recoverToReady(operationVersion);
        return isCurrentOperation(operationVersion) ? 'failed' : 'ignored';
      }
      return 'ignored';
    }

    // The destination page is already visible here, while epub.js may not
    // publish its relocated event until a later frame. Refresh the page label
    // directly from the manager geometry so it changes with the visual page.
    void syncCommittedPage();
    if (adapter.isStableAt(delta)) rememberCurrentCfi(rendition);
    requestCommittedLocation(rendition, waiter);
    await waitForContinuousManagerQueue(rendition?.manager);
    const currentLocation = await settleWithin(readRenditionLocation(rendition));
    const location = currentLocation.status === 'completed' && currentLocation.value?.start?.cfi
      ? currentLocation.value
      : await waiter.promise;
    waiter.cancel();
    if (relocationWaitRef.current === waiter) relocationWaitRef.current = null;
    if (!isCurrentOperation(operationVersion)) return 'ignored';
    if (!location || !adapter.isStableAt(delta)) {
      await recoverToReady(operationVersion);
      return isCurrentOperation(operationVersion) ? 'failed' : 'ignored';
    }

    adapter.end();
    await publishCurrentProgress();
    return isCurrentOperation(operationVersion) ? 'completed' : 'ignored';
  }, [
    adapter,
    hideEdge,
    isCurrentOperation,
    publishCurrentProgress,
    recoverToReady,
    rememberCurrentCfi,
    renditionRef,
    syncCommittedPage,
  ]);

  const turnPage = useCallback(async (nextDirection: PageDirection, interaction: TurnInteraction = {}) => {
    if (disabled || !['idle', 'basic'].includes(phaseRef.current)) return 'ignored';
    const rendition = renditionRef.current;
    if (!rendition || !['prev', 'next'].includes(nextDirection)) return 'ignored';
    if (retiredRenditionsRef.current.has(rendition)) return 'failed';
    const inputTime = Number.isFinite(interaction.inputTime)
      ? interaction.inputTime
      : performance.now();
    const action = interaction.action || `tap-${nextDirection}`;

    const operationVersion = beginOperation();
    setPhase('settling');
    try {
      const locationRead = await settleWithin(readRenditionLocation(rendition));
      const location = locationRead.status === 'completed' ? locationRead.value : null;
      if (!isCurrentOperation(operationVersion)) return 'ignored';
      if (isBoundary(location, nextDirection)) return 'blocked';

      if (basicRef.current) {
        return await runBasicNavigation(nextDirection, operationVersion);
      }

      const session = adapter?.begin(currentCfiRef.current, {
        action,
        edgeElement: edgeRef.current,
        inputTime,
      });
      if (!session || !adapter) {
        enterBasic();
        return await runBasicNavigation(nextDirection, operationVersion);
      }

      const neighborReady =
        nextDirection === 'next' ? session.canNext : session.canPrevious;
      if (!neighborReady) {
        adapter.cancel({ restoreOrigin: true });
        return await runBasicNavigation(nextDirection, operationVersion);
      }

      showEdge(nextDirection);
      return await runEnhancedNavigation(nextDirection, operationVersion, {
        action,
        inputTime,
      });
    } finally {
      if (isCurrentOperation(operationVersion)) restoreReadyPhase();
    }
  }, [
    adapter,
    beginOperation,
    currentCfiRef,
    disabled,
    edgeRef,
    enterBasic,
    isCurrentOperation,
    renditionRef,
    restoreReadyPhase,
    runBasicNavigation,
    runEnhancedNavigation,
    setPhase,
    showEdge,
  ]);

  const handlePointerDown = useCallback((event: PointerDown) => {
    const touch = event.pointerType === 'touch';
    if (
      disabled ||
      !['idle', 'basic'].includes(phaseRef.current) ||
      (touch && event.isPrimary === false) ||
      (touch && startsInSystemNavigationEdge(event))
    ) {
      return;
    }

    let session: TurnSession | null = null;
    let mode: TurnPointer['mode'] = touch ? 'basic' : 'tap';
    if (touch && !basicRef.current) {
      session = adapter?.begin(currentCfiRef.current, {
        action: 'drag',
        edgeElement: edgeRef.current,
        inputTime: event.timeStamp,
      }) ?? null;
      if (session) mode = 'enhanced';
      else enterBasic();
    }

    pointerRef.current = {
      operationVersion: beginOperation(),
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      target: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      locked: null,
      captured: false,
      mode,
      session,
      samples: [{ x: event.clientX, time: event.timeStamp }],
    };
    setPhase('pending');
  }, [adapter, beginOperation, currentCfiRef, disabled, edgeRef, enterBasic, setPhase]);

  const handlePointerMove = useCallback((event: PointerMove) => {
    const pointer = pointerRef.current;
    if (!pointer || event.pointerId !== pointer.pointerId || pointer.pointerType !== 'touch') return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    pointer.samples.push({ x: event.clientX, time: event.timeStamp });
    if (pointer.samples.length > 12) pointer.samples.shift();

    if (!pointer.locked) {
      const lock = classifyDirection(dx, dy);
      if (lock === 'pending') return;
      if (lock === 'vertical') {
        adapter?.cancel({ restoreOrigin: true });
        finishPointer();
        restoreReadyPhase();
        return;
      }
      pointer.locked = 'horizontal';
      if (pointer.mode === 'enhanced') {
        const nextDirection = dx < 0 ? 'next' : 'prev';
        showEdge(nextDirection);
        setPhase('dragging');
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.captured = true;
        } catch {
          pointer.captured = false;
        }
      }
    }

    if (pointer.locked === 'horizontal') {
      if (event.cancelable) event.preventDefault();
      if (pointer.mode === 'enhanced') queueDragFrame(dx);
    }
  }, [adapter, finishPointer, queueDragFrame, restoreReadyPhase, setPhase, showEdge]);

  const handlePointerUp = useCallback((event: PointerCoordinates) => {
    const pointer = pointerRef.current;
    if (!pointer || event.pointerId !== pointer.pointerId) return;
    const operationVersion = pointer.operationVersion;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    pointer.samples.push({ x: event.clientX, time: event.timeStamp });

    const settle = async () => {
      if (pointer.pointerType !== 'touch' || !pointer.locked) {
        adapter?.cancel({ restoreOrigin: true });
        finishPointer();
        restoreReadyPhase();
        if (Math.max(Math.abs(dx), Math.abs(dy)) >= PAGE_TURN_RULES.directionLockPx) return;
        const tapConsumed = await Promise.resolve(onTap?.({
          clientX: event.clientX,
          clientY: event.clientY,
          inputTime: event.timeStamp,
          pointerType: pointer.pointerType,
        })).catch(() => false);
        if (tapConsumed) return;
        const rect = pointer.target.getBoundingClientRect();
        const zone = getTapZone(event.clientX, rect.left, rect.width);
        if (zone === 'center') onCenterTap?.();
        else await turnPage(zone, {
          action: `tap-${zone}`,
          inputTime: event.timeStamp,
        });
        return;
      }

      if (pointer.locked !== 'horizontal') {
        cancelPageTurn('vertical');
        return;
      }

      clearDragFrame();
      const dragResult = pointer.mode === 'enhanced'
        ? writeDragFrame(dx)
        : {
            effectiveDistanceX: dx,
            progress: pointer.session ? Math.abs(dx) / pointer.session.pageWidth : 0,
          };
      const velocityX = getRecentVelocity(pointer.samples);
      const capability = adapter?.inspect();
      const width = pointer.session?.pageWidth ||
        (capability && 'pageWidth' in capability ? capability.pageWidth : 0) ||
        event.currentTarget.getBoundingClientRect().width;
      const delta = decidePageDelta({
        distanceX: dx,
        velocityX,
        pageWidth: width,
      });
      const nextDirection = delta === 1
        ? 'next'
        : delta === -1
          ? 'prev'
          : dx < 0
            ? 'next'
            : 'prev';
      finishPointer();

      if (pointer.mode !== 'enhanced') {
        restoreReadyPhase();
        if (delta) await turnPage(nextDirection);
        return;
      }

      if (!adapter || !pointer.session) return;
      setPhase('settling');
      try {
        if (delta === 0) {
          const duration = getSettleDuration(
            Math.abs(dragResult?.effectiveDistanceX || 0),
            pointer.session.pageWidth,
          );
          const animationResult = await settleWithin(adapter.animateTo(0, {
            action: 'rollback',
            duration,
            inputTime: event.timeStamp,
          }));
          if (!isCurrentOperation(operationVersion)) return;
          if (animationResult.status !== 'completed') {
            await recoverToReady(operationVersion);
            return;
          }
          const animation = animationResult.value;
          if (animation.status !== 'completed') {
            if (animation.status === 'unavailable') {
              await recoverToReady(operationVersion);
            }
            return;
          }
          hideEdge();
          adapter.end();
          return;
        }

        const neighborReady =
          delta === 1 ? pointer.session.canNext : pointer.session.canPrevious;
        if (!neighborReady) {
          const animationResult = await settleWithin(adapter.animateTo(0, {
            action: 'rollback',
            duration: PAGE_TURN_RULES.settleDurationMinMs,
            inputTime: event.timeStamp,
          }));
          if (!isCurrentOperation(operationVersion)) return;
          if (animationResult.status !== 'completed') {
            await recoverToReady(operationVersion);
            return;
          }
          const animation = animationResult.value;
          if (animation.status !== 'completed') {
            if (animation.status === 'unavailable') {
              await recoverToReady(operationVersion);
            }
            return;
          }
          hideEdge();
          adapter.end();
          const locationRead = await settleWithin(readRenditionLocation(renditionRef.current));
          const location = locationRead.status === 'completed' ? locationRead.value : null;
          if (!isCurrentOperation(operationVersion)) return;
          if (!isBoundary(location, nextDirection)) {
            await runBasicNavigation(nextDirection, operationVersion);
            if (!isCurrentOperation(operationVersion)) return;
          }
          return;
        }

        const remaining = Math.max(
          0,
          pointer.session.pageWidth - Math.abs(dragResult?.effectiveDistanceX || 0),
        );
        await runEnhancedNavigation(nextDirection, operationVersion, {
          action: 'commit',
          duration: getSettleDuration(remaining, pointer.session.pageWidth),
          inputTime: event.timeStamp,
        });
      } finally {
        if (isCurrentOperation(operationVersion)) restoreReadyPhase();
      }
    };

    void settle();
  }, [
    adapter,
    cancelPageTurn,
    clearDragFrame,
    finishPointer,
    hideEdge,
    isCurrentOperation,
    onCenterTap,
    onTap,
    renditionRef,
    recoverToReady,
    restoreReadyPhase,
    runBasicNavigation,
    runEnhancedNavigation,
    setPhase,
    turnPage,
    writeDragFrame,
  ]);

  const handlePointerCancel = useCallback((event: Pick<ReactPointerEvent<HTMLElement>, 'pointerId'>) => {
    if (pointerRef.current?.pointerId !== event.pointerId) return;
    cancelPageTurn('pointercancel');
  }, [cancelPageTurn]);

  return {
    cancelPageTurn,
    direction,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    navigateTo,
    phase,
    turnPage,
  };
}

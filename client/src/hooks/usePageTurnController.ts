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
  cancel: ConcreteAdapter['cancel'];
  dragBy(distanceX: number): Pick<NonNullable<ReturnType<ConcreteAdapter['dragBy']>>, 'effectiveDistanceX' | 'progress'> | null;
  end: ConcreteAdapter['end'];
  inspect(): { available: boolean; pageWidth?: number };
  isStableAt: ConcreteAdapter['isStableAt'];
  animateTo(...args: Parameters<ConcreteAdapter['animateTo']>): PromiseLike<Pick<Awaited<ReturnType<ConcreteAdapter['animateTo']>>, 'status'>>;
  recover(): boolean | PromiseLike<boolean>;
}
type PointerCoordinates = Pick<ReactPointerEvent<HTMLElement>, 'clientX' | 'clientY' | 'currentTarget' | 'pointerId' | 'timeStamp'>;
type PointerDown = PointerCoordinates & Pick<ReactPointerEvent<HTMLElement>, 'pointerType'> & { isPrimary?: boolean };
type PointerMove = PointerCoordinates & Pick<ReactPointerEvent<HTMLElement>, 'cancelable' | 'preventDefault'>;
interface TurnInteraction { action?: string; inputTime?: number }
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
  onPageTurnCommitted?: () => unknown;
  onTap?: (input: { clientX: number; clientY: number; inputTime: number; pointerType: string }) => unknown;
  reducedMotion?: boolean;
  renditionRef: RefObject<ReaderRendition | null>;
}

const SYSTEM_NAVIGATION_EDGE_PX = 32;

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

  const setPhase = useCallback((nextPhase: TurnPhase) => {
    phaseRef.current = nextPhase;
    setPhaseState(nextPhase);
  }, []);

  const publishCurrentProgress = useCallback(() => (
    Promise.resolve(onNavigationSettled?.()).catch(() => false)
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

  const cancelPageTurn = useCallback((reason = 'cancelled') => {
    releaseContinuousManagerLayoutAnchor(renditionRef.current);
    cancellationVersionRef.current += 1;
    relocationWaitRef.current?.cancel();
    relocationWaitRef.current = null;
    finishPointer();
    adapter?.cancel({ reason, restoreOrigin: true });
    void syncCommittedPage();
    restoreReadyPhase();
  }, [adapter, finishPointer, renditionRef, restoreReadyPhase, syncCommittedPage]);

  const navigateTo = useCallback(async (target: string) => {
    if (!target || !renditionRef.current) return 'failed';

    cancelPageTurn('display');
    const operationVersion = cancellationVersionRef.current;
    const rendition = renditionRef.current;
    setPhase('settling');
    try {
      const displayed = await displayRenditionTarget(rendition, target, {
        shouldContinue: () => isCurrentOperation(operationVersion),
      });
      if (!isCurrentOperation(operationVersion)) return 'ignored';
      if (!displayed) return 'failed';

      void syncCommittedPage();
      await publishCurrentProgress();
      return isCurrentOperation(operationVersion) ? 'completed' : 'ignored';
    } catch {
      return isCurrentOperation(operationVersion) ? 'failed' : 'ignored';
    } finally {
      if (isCurrentOperation(operationVersion)) restoreReadyPhase();
    }
  }, [
    cancelPageTurn,
    isCurrentOperation,
    publishCurrentProgress,
    renditionRef,
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
    const waiter = createRelocationWait(
      rendition,
      () => true,
      PAGE_TURN_RULES.relocatedTimeoutMs,
    );
    relocationWaitRef.current = waiter;
    try {
      const navigation = navigateBasicRenditionPage(rendition, nextDirection, {
        shouldContinue: () => isCurrentOperation(operationVersion),
      });
      // Continuous navigation moves the viewport synchronously, while its
      // preload/check queue can take much longer. Publish the visual page now
      // so the label cannot lag one turn behind the content.
      void syncCommittedPage();
      await navigation;
      void syncCommittedPage();
      const location = await waiter.promise;
      if (!location) {
        void syncCommittedPage();
        return 'failed';
      }
      await publishCurrentProgress();
      return 'completed';
    } catch {
      waiter.cancel();
      void syncCommittedPage();
      return 'failed';
    } finally {
      if (relocationWaitRef.current === waiter) relocationWaitRef.current = null;
    }
  }, [isCurrentOperation, publishCurrentProgress, renditionRef, syncCommittedPage]);

  const recoverToReady = useCallback(async (operationVersion: number) => {
    let restored: boolean;
    try {
      restored = Boolean(await adapter?.recover?.());
    } catch {
      restored = false;
    }
    if (!isCurrentOperation(operationVersion)) return false;
    const capability = restored ? adapter?.inspect?.() : null;
    clearEdge();
    basicRef.current = !capability?.available;
    setPhase(basicRef.current ? 'basic' : 'idle');
    void syncCommittedPage();
    return restored;
  }, [adapter, clearEdge, isCurrentOperation, setPhase, syncCommittedPage]);

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
    const animation = await adapter.animateTo(delta, {
      action: interaction.action,
      duration: PAGE_TURN_RULES.tapDurationMs,
      inputTime: interaction.inputTime,
    });

    if (!isCurrentOperation(operationVersion)) {
      waiter.cancel();
      return 'ignored';
    }
    hideEdge();
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
    requestCommittedLocation(rendition, waiter);
    const location = await waiter.promise;
    if (!isCurrentOperation(operationVersion)) return 'ignored';
    if (!location || !adapter.isStableAt(delta)) {
      await recoverToReady(operationVersion);
      return isCurrentOperation(operationVersion) ? 'failed' : 'ignored';
    }

    await waitForContinuousManagerQueue(rendition?.manager);
    if (!isCurrentOperation(operationVersion)) return 'ignored';
    adapter.end();
    await publishCurrentProgress();
    return 'completed';
  }, [
    adapter,
    hideEdge,
    isCurrentOperation,
    publishCurrentProgress,
    recoverToReady,
    renditionRef,
    syncCommittedPage,
  ]);

  const turnPage = useCallback(async (nextDirection: PageDirection, interaction: TurnInteraction = {}) => {
    if (!['idle', 'basic'].includes(phaseRef.current)) return 'ignored';
    const rendition = renditionRef.current;
    if (!rendition || !['prev', 'next'].includes(nextDirection)) return 'ignored';
    const inputTime = Number.isFinite(interaction.inputTime)
      ? interaction.inputTime
      : performance.now();
    const action = interaction.action || `tap-${nextDirection}`;

    const operationVersion = beginOperation();
    setPhase('settling');
    try {
      const location = await readRenditionLocation(rendition).catch(() => null);
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
          const animation = await adapter.animateTo(0, {
            action: 'rollback',
            duration,
            inputTime: event.timeStamp,
          });
          if (!isCurrentOperation(operationVersion)) return;
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
          const animation = await adapter.animateTo(0, {
            action: 'rollback',
            duration: PAGE_TURN_RULES.settleDurationMinMs,
            inputTime: event.timeStamp,
          });
          if (!isCurrentOperation(operationVersion)) return;
          if (animation.status !== 'completed') {
            if (animation.status === 'unavailable') {
              await recoverToReady(operationVersion);
            }
            return;
          }
          hideEdge();
          adapter.end();
          const location = await readRenditionLocation(renditionRef.current).catch(() => null);
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
        const waiter = createRelocationWait(
          renditionRef.current,
          () => adapter.isStableAt(delta),
          PAGE_TURN_RULES.relocatedTimeoutMs,
        );
        relocationWaitRef.current = waiter;
        const animation = await adapter.animateTo(delta, {
          action: 'commit',
          duration: getSettleDuration(remaining, pointer.session.pageWidth),
          inputTime: event.timeStamp,
        });
        if (!isCurrentOperation(operationVersion)) {
          waiter.cancel();
          return;
        }
        hideEdge();
        if (animation.status !== 'completed') {
          waiter.cancel();
          if (animation.status === 'unavailable') {
            await recoverToReady(operationVersion);
          }
          return;
        }
        void syncCommittedPage();
        requestCommittedLocation(renditionRef.current, waiter);
        const location = await waiter.promise;
        if (!isCurrentOperation(operationVersion)) return;
        if (!location || !adapter.isStableAt(delta)) {
          waiter.cancel();
          await recoverToReady(operationVersion);
        } else {
          await waitForContinuousManagerQueue(renditionRef.current?.manager);
          if (!isCurrentOperation(operationVersion)) return;
          adapter.end();
          await publishCurrentProgress();
        }
        if (relocationWaitRef.current === waiter) relocationWaitRef.current = null;
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
    publishCurrentProgress,
    renditionRef,
    recoverToReady,
    restoreReadyPhase,
    runBasicNavigation,
    setPhase,
    syncCommittedPage,
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

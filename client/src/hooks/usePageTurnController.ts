import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { ReaderEngine } from '../reader/types';
import { PAGE_TURN_RULES, classifyDirection, decidePageDelta, getRecentVelocity, getSettleDuration, getTapZone, clampDragDistance, dampBoundaryDistance } from '../utils/pageTurnGesture';
import { createPageTurnDiagnostics, readPageTurnDebugConfig } from '../utils/pageTurnDiagnostics';
import { createPageRenderer } from '../reader/pageRenderer';
import type { PageRendererBinding, PageMotionResult } from '../reader/pageRenderer';

type Direction = 'next' | 'prev';
interface Options {
  engine: ReaderEngine | null;
  disabled: boolean;
  reducedMotion: boolean;
  onCenterTap: () => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  onNavigationSettled?: () => Promise<boolean | undefined>;
  onPageTurnCommitted?: () => Promise<void>;
  currentCfiRef: RefObject<string | null>;
  edgeRef: RefObject<HTMLElement | null>;
  renditionRef: RefObject<ReaderEngine | null>;
}
interface Pointer { id: number; x: number; y: number; start: number; dx: number; visualDx: number; horizontal: boolean; samples: { x: number; time: number }[]; element: HTMLElement }
interface Preview {
  direction: Direction;
  sign: -1 | 1;
  width: number;
  element: HTMLElement | null;
  ready: Promise<Preview | null>;
}
function releasePointer(p: Pointer | null) {
  try { if (p?.element.hasPointerCapture(p.id)) p.element.releasePointerCapture(p.id); } catch { /* iOS already released capture. */ }
}
function directionOf(dx: number, engine: ReaderEngine): Direction {
  return (dx < 0) !== (engine.direction === 'rtl') ? 'next' : 'prev';
}
function isBoundary(engine: ReaderEngine, next: Direction) {
  return Boolean(next === 'next' ? engine.currentLocation()?.atEnd : engine.currentLocation()?.atStart);
}

export function usePageTurnController({ engine, disabled, reducedMotion, onCenterTap, onTap, onPageTurnCommitted, edgeRef }: Options) {
  const [phase, setPhase] = useState('idle');
  const [direction, setDirection] = useState<Direction | null>(null);
  const pointer = useRef<Pointer | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const renderer = useRef<ReturnType<typeof createPageRenderer> | null>(null);
  if (!renderer.current) renderer.current = createPageRenderer();
  const surfaceBinding = useRef<{ pair: Preview | null; binding: PageRendererBinding } | null>(null);
  const preview = useRef<Preview | null>(null);
  const diagnostic = useRef<ReturnType<typeof createPageTurnDiagnostics> | null>(null);
  const record = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    const edge = edgeRef.current;
    if (!edge) return;
    const previous = edge.style.visibility;
    // The old fixed-left shadow is not the seam between the two moving pages.
    edge.style.visibility = 'hidden';
    return () => { edge.style.visibility = previous; };
  }, [edgeRef]);
  useEffect(() => {
    diagnostic.current = createPageTurnDiagnostics({ enabled: readPageTurnDebugConfig().enabled });
    return () => diagnostic.current?.destroy();
  }, [engine]);
  const releaseSurfaces = useCallback(() => {
    renderer.current?.release();
    surfaceBinding.current = null;
  }, []);
  const bindSurfaces = useCallback((pair: Preview | null) => {
    if (!engine) return null;
    if (surfaceBinding.current?.pair === pair) return surfaceBinding.current.binding;
    const binding = renderer.current!.bind({
      current: engine.element, incoming: pair?.element,
      width: pair?.width ?? 0, sign: pair?.sign ?? 1,
    });
    surfaceBinding.current = { pair, binding };
    return binding;
  }, [engine]);
  const clearPreview = useCallback(() => {
    // Invalidate first: a late prepare completion can share a cached view with
    // a newer request and must never restyle that newer request's page.
    preview.current = null;
    releaseSurfaces();
    engine?.cancelTurnPreview();
  }, [engine, releaseSurfaces]);
  const reset = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    clearPreview();
    const p = pointer.current;
    pointer.current = null;
    releasePointer(p);
    busy.current = false; setPhase('idle'); setDirection(null);
    engine?.schedulePages?.();
  }, [clearPreview, engine]);
  const cancelPageTurn = useCallback((reason = 'cancelled') => {
    ++generation.current; diagnostic.current?.cancel(record.current, reason); record.current = null; reset();
  }, [reset]);
  useEffect(() => {
    const cancel = () => cancelPageTurn('background');
    const visibility = () => { if (document.visibilityState === 'hidden') cancel(); };
    window.addEventListener('pagehide', cancel); window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', visibility);
    return () => { cancel(); window.removeEventListener('pagehide', cancel); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', visibility); };
  }, [cancelPageTurn]);
  useEffect(() => { if (disabled) cancelPageTurn('disabled'); }, [disabled, cancelPageTurn]);

  const positionPair = useCallback((pair: Preview, dx: number) => {
    if (!engine || !pair.element || preview.current !== pair) return;
    bindSurfaces(pair)?.update(dx);
    diagnostic.current?.markVisualUpdate(record.current, performance.now());
    if (pointer.current?.horizontal) diagnostic.current?.startPhase(record.current, 'motion');
  }, [engine, bindSurfaces]);
  const prepare = useCallback((next: Direction): Promise<Preview | null> => {
    if (!engine) return Promise.resolve(null);
    if (preview.current?.direction === next) return preview.current.ready;
    clearPreview();
    engine.pauseMeasurement?.();
    // Keep the current page covering the viewport until its neighbor is ready.
    // Pointer samples continue accumulating during the asynchronous preparation.
    if (pointer.current) pointer.current.visualDx = 0;
    const pair: Preview = {
      direction: next, sign: (next === 'next') !== (engine.direction === 'rtl') ? -1 : 1,
      width: engine.element.clientWidth, element: null, ready: Promise.resolve(null),
    };
    preview.current = pair;
    const diagnostics = diagnostic.current;
    const prepareRecord = record.current;
    diagnostics?.startPhase(prepareRecord, 'prepare');
    pair.ready = engine.prepareTurn(next).then(element => {
      if (preview.current !== pair || engine.state !== 'ready' || !element) return null;
      pair.element = element;
      const p = pointer.current;
      const dx = p?.horizontal && directionOf(p.dx, engine) === next ? clampDragDistance(p.dx, pair.width) : 0;
      if (p) p.visualDx = dx;
      positionPair(pair, dx);
      diagnostic.current?.markMilestone(record.current, 'neighborReady');
      diagnostic.current?.markVisualUpdate(record.current, performance.now());
      return pair;
    }).catch(() => null).finally(() => diagnostics?.endPhase(prepareRecord, 'prepare'));
    return pair.ready;
  }, [clearPreview, engine, positionPair]);
  const animate = useCallback(async (from: number, to: number, duration: number, pair: Preview | null): Promise<PageMotionResult> => {
    if (!engine) return 'cancelled';
    if (reducedMotion) return 'finished';
    const binding = bindSurfaces(pair);
    if (!binding) return 'cancelled';
    const time = document.timeline?.currentTime;
    const diagnostics = diagnostic.current;
    const animationRecord = record.current;
    const result = binding.settle(from, to, duration, typeof time === 'number' ? time : null, () => {
      diagnostics?.markVisualUpdate(animationRecord, performance.now());
      diagnostics?.startPhase(animationRecord, 'motion');
      diagnostics?.markAnimationStart(animationRecord, performance.now(), { sampleFrames: true });
    });
    try { return await result; }
    finally { diagnostics?.endPhase(animationRecord, 'motion'); }
  }, [engine, reducedMotion, bindSurfaces]);
  const turnPage = useCallback(async (next: Direction, options: { action?: string; inputTime?: number } = {}, drag = 0) => {
    const diagnostics = diagnostic.current;
    diagnostics?.countInput('received');
    if (!engine || disabled || busy.current || pointer.current || engine.state !== 'ready') {
      diagnostics?.countInput('rejected');
      return;
    }
    diagnostics?.countInput('accepted');
    const version = ++generation.current;
    busy.current = true; setPhase('settling'); setDirection(next); engine.pauseMeasurement?.();
    record.current = diagnostics?.begin({ action: options.action ?? 'tap-' + next, backend: 'foliate-paired-views', inputTime: options.inputTime }) ?? null;
    const turnRecord = record.current;
    diagnostics?.startPhase(turnRecord, 'busy');
    const boundary = isBoundary(engine, next);
    try {
      const pair = !boundary && !reducedMotion ? await prepare(next) : null;
      if (version !== generation.current || engine.state !== 'ready') return;
      if (pair) diagnostics?.markMilestone(turnRecord, 'neighborReady');
      if (boundary) { clearPreview(); if (await animate(drag, 0, PAGE_TURN_RULES.settleDurationMinMs, null) === 'cancelled') return; }
      else if (pair) {
        positionPair(pair, drag);
        const duration = options.action === 'release'
          ? getSettleDuration(Math.max(0, pair.width - Math.abs(drag)), pair.width)
          : PAGE_TURN_RULES.tapDurationMs;
        if (await animate(drag, pair.sign * pair.width, duration, pair) === 'cancelled') return;
      }
      if (version !== generation.current || engine.state !== 'ready') return;
      if (!boundary) {
        // Leave the incoming real page at x=0 above the main renderer while
        // the main renderer verifies its new content with normal geometry.
        surfaceBinding.current?.binding.holdIncoming();
        if (reducedMotion) clearPreview();
        diagnostics?.startPhase(turnRecord, 'handoff');
        const previousPosition = engine.stable;
        await engine.turn(next);
        if (version !== generation.current || engine.state !== 'ready') return;
        diagnostics?.endPhase(turnRecord, 'handoff');
        // A resolved operation alone is not success. Require a new stable
        // snapshot, and count a committed turn only when its anchor changed.
        if (engine.stable && engine.stable !== previousPosition) {
          diagnostics?.markMilestone(turnRecord, 'engineVerified');
          if (engine.stable.cfi !== previousPosition?.cfi) {
            diagnostics?.markMilestone(turnRecord, 'committed');
            diagnostics?.countInput('committed');
          }
        }
        await onPageTurnCommitted?.();
      }
      diagnostics?.endPhase(turnRecord, 'busy');
      diagnostics?.finish(turnRecord);
    } catch (error) {
      if (version === generation.current) diagnostics?.cancel(turnRecord, 'navigation-error');
      console.error('Page turn failed', error);
    } finally {
      if (version === generation.current) { diagnostics?.cancel(turnRecord, 'interrupted'); record.current = null; reset(); }
    }
  }, [animate, clearPreview, disabled, engine, onPageTurnCommitted, positionPair, prepare, reducedMotion, reset]);
  const navigateTo = useCallback(async (target: string) => {
    cancelPageTurn('navigation');
    if (!engine || engine.state !== 'ready') return;
    const version = ++generation.current;
    busy.current = true; engine.pauseMeasurement?.();
    try {
      await engine.display(target);
      if (version === generation.current && engine.state === 'ready') await onPageTurnCommitted?.();
    } catch (error) { console.error('Reader navigation failed', error); }
    finally { if (version === generation.current) reset(); }
  }, [cancelPageTurn, engine, onPageTurnCommitted, reset]);
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!engine || disabled || busy.current || pointer.current || engine.state !== 'ready' || !event.isPrimary || event.button !== 0) return;
    if (event.pointerType !== 'mouse' && (event.clientX < 20 || event.clientX > innerWidth - 20)) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, visualDx: 0, start: event.timeStamp, horizontal: false, samples: [{ x: event.clientX, time: event.timeStamp }], element: event.currentTarget };
    engine.pauseMeasurement?.();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancelPageTurn('capture-failed'); }
  }, [cancelPageTurn, disabled, engine]);
  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || event.pointerId !== p.id || !engine) return;
    if (engine.state !== 'ready') { cancelPageTurn('unavailable'); return; }
    p.dx = event.clientX - p.x;
    if (!p.horizontal) {
      const axis = classifyDirection(p.dx, event.clientY - p.y);
      if (axis === 'vertical') { cancelPageTurn('vertical'); return; }
      if (axis !== 'horizontal') return;
      p.horizontal = true; setPhase('dragging');
      record.current = diagnostic.current?.begin({ action: 'drag', backend: 'foliate-paired-views', inputTime: event.timeStamp }) ?? null;
      diagnostic.current?.markAnimationStart(record.current, performance.now(), { sampleFrames: true });
    }
    p.samples.push({ x: event.clientX, time: event.timeStamp }); p.samples = p.samples.slice(-20);
    event.preventDefault();
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pointer.current !== p) return;
      const next = directionOf(p.dx, engine);
      setDirection(next);
      if (isBoundary(engine, next)) {
        if (preview.current) clearPreview();
        p.visualDx = dampBoundaryDistance(p.dx);
        bindSurfaces(null)?.update(p.visualDx);
        diagnostic.current?.markVisualUpdate(record.current, performance.now());
        diagnostic.current?.startPhase(record.current, 'motion');
      } else {
        void prepare(next);
        const pair = preview.current;
        if (pair?.element) {
          p.visualDx = clampDragDistance(p.dx, pair.width);
          positionPair(pair, p.visualDx);
          diagnostic.current?.markVisualUpdate(record.current, performance.now());
        }
      }
    });
  }, [cancelPageTurn, clearPreview, engine, positionPair, prepare, bindSurfaces]);
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || event.pointerId !== p.id || !engine) return;
    pointer.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; releasePointer(p);
    if (!p.horizontal) {
      engine.schedulePages?.();
      if (event.timeStamp - p.start > 300) return;
      if (onTap?.({ clientX: event.clientX, clientY: event.clientY })) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const zone = getTapZone(event.clientX, rect.left, rect.width);
      if (zone === 'center') onCenterTap();
      else void turnPage(zone, { inputTime: p.start });
      return;
    }
    p.dx = event.clientX - p.x;
    p.samples.push({ x: event.clientX, time: event.timeStamp });
    const delta = decidePageDelta({ distanceX: p.dx, velocityX: getRecentVelocity(p.samples), pageWidth: engine.element.clientWidth });
    diagnostic.current?.endPhase(record.current, 'motion');
    diagnostic.current?.finish(record.current); record.current = null;
    if (disabled || engine.state !== 'ready') { cancelPageTurn('unavailable'); return; }
    if (delta) {
      const next = (delta > 0) !== (engine.direction === 'rtl') ? 'next' : 'prev';
      const sameDirection = p.visualDx !== 0 && directionOf(p.visualDx, engine) === next;
      const drag = sameDirection && (!preview.current || preview.current.direction === next) ? p.visualDx : 0;
      void turnPage(next, { action: 'release', inputTime: event.timeStamp }, drag);
    } else {
      busy.current = true; setPhase('settling'); const version = ++generation.current;
      record.current = diagnostic.current?.begin({ action: 'rebound', backend: 'foliate-paired-views', inputTime: event.timeStamp }) ?? null;
      diagnostic.current?.startPhase(record.current, 'busy');
      const pair = preview.current?.element ? preview.current : null;
      if (!pair) clearPreview();
      void animate(p.visualDx, 0, getSettleDuration(Math.abs(p.visualDx), engine.element.clientWidth), pair).finally(() => {
        if (version === generation.current) { diagnostic.current?.endPhase(record.current, 'busy'); diagnostic.current?.finish(record.current); record.current = null; reset(); }
      });
    }
  }, [animate, cancelPageTurn, clearPreview, disabled, engine, onCenterTap, onTap, reset, turnPage]);
  const handleLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id === event.pointerId) cancelPageTurn('capture-lost');
  }, [cancelPageTurn]);
  return { cancelPageTurn, direction, phase, navigateTo, turnPage, handlePointerDown, handlePointerMove, handlePointerUp, handleLostPointerCapture, handlePointerCancel: () => cancelPageTurn('pointercancel') };
}

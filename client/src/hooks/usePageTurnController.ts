import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { ReaderEngine } from '../reader/types';
import { PAGE_TURN_RULES, classifyDirection, decidePageDelta, getRecentVelocity, getSettleDuration, getTapZone, clampDragDistance, dampBoundaryDistance, sampleEaseOutCubicKeyframes } from '../utils/pageTurnGesture';
import { createPageTurnDiagnostics, readPageTurnDebugConfig } from '../utils/pageTurnDiagnostics';

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
  sign: number;
  width: number;
  element: HTMLElement | null;
  ready: Promise<Preview | null>;
}
function releasePointer(p: Pointer | null) {
  try { if (p?.element.hasPointerCapture(p.id)) p.element.releasePointerCapture(p.id); } catch { /* iOS already released capture. */ }
}
const translate = (x: number) => `translateX(${x}px)`;
// Use the same sampled cubic curve as the original epub.js compositor path.
const turnEasing = sampleEaseOutCubicKeyframes();
const turnKeyframes = (from: number, to: number): Keyframe[] => turnEasing.map(({ offset, value }) => ({
  offset, transform: translate(from + (to - from) * value),
}));
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
  const animations = useRef<Animation[]>([]);
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
  const stopAnimations = useCallback(() => {
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
  }, []);
  const clearPreview = useCallback(() => {
    // Invalidate first: a late prepare completion can share a cached view with
    // a newer request and must never restyle that newer request's page.
    preview.current = null;
    engine?.cancelTurnPreview();
  }, [engine]);
  const reset = useCallback(() => {
    stopAnimations();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (engine) { engine.element.style.transform = ''; engine.element.style.willChange = ''; }
    clearPreview();
    const p = pointer.current;
    pointer.current = null;
    releasePointer(p);
    busy.current = false; setPhase('idle'); setDirection(null);
    engine?.schedulePages?.();
  }, [clearPreview, engine, stopAnimations]);
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
    // Both real pages move by the same distance, exactly one viewport apart.
    pair.element.style.transform = translate(dx - pair.sign * pair.width);
    pair.element.style.willChange = 'transform';
    pair.element.style.visibility = 'visible';
    engine.element.style.willChange = 'transform';
    engine.element.style.transform = translate(dx);
  }, [engine]);
  const prepare = useCallback((next: Direction): Promise<Preview | null> => {
    if (!engine) return Promise.resolve(null);
    if (preview.current?.direction === next) return preview.current.ready;
    clearPreview();
    engine.pauseMeasurement?.();
    // Keep the current page covering the viewport until its neighbor is ready.
    // Pointer samples continue accumulating during the asynchronous preparation.
    engine.element.style.transform = '';
    if (pointer.current) pointer.current.visualDx = 0;
    const pair: Preview = {
      direction: next, sign: (next === 'next' ? -1 : 1) * (engine.direction === 'rtl' ? -1 : 1),
      width: engine.element.clientWidth, element: null, ready: Promise.resolve(null),
    };
    preview.current = pair;
    pair.ready = engine.prepareTurn(next).then(element => {
      if (preview.current !== pair || engine.state !== 'ready' || !element) return null;
      pair.element = element;
      const p = pointer.current;
      const dx = p?.horizontal && directionOf(p.dx, engine) === next ? clampDragDistance(p.dx, pair.width) : 0;
      if (p) p.visualDx = dx;
      positionPair(pair, dx);
      diagnostic.current?.markVisualUpdate(record.current, performance.now());
      return pair;
    }).catch(() => null);
    return pair.ready;
  }, [clearPreview, engine, positionPair]);
  const animate = useCallback(async (from: number, to: number, duration: number, pair: Preview | null) => {
    if (!engine || reducedMotion) return;
    const options: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'forwards' };
    const current = engine.element.animate(turnKeyframes(from, to), options);
    const list = [current];
    if (pair?.element) {
      const offset = -pair.sign * pair.width;
      list.push(pair.element.animate(turnKeyframes(from + offset, to + offset), options));
    }
    const time = document.timeline?.currentTime;
    if (typeof time === 'number') for (const animation of list) animation.startTime = time;
    animations.current = list;
    diagnostic.current?.markAnimationStart(record.current, performance.now(), { sampleFrames: true });
    try { await Promise.all(list.map(animation => animation.finished)); } catch { /* Lifecycle or pointer cancellation. */ }
  }, [engine, reducedMotion]);
  const turnPage = useCallback(async (next: Direction, options: { action?: string; inputTime?: number } = {}, drag = 0) => {
    if (!engine || disabled || busy.current || pointer.current || engine.state !== 'ready') return;
    const version = ++generation.current;
    busy.current = true; setPhase('settling'); setDirection(next); engine.pauseMeasurement?.();
    const diagnostics = diagnostic.current;
    record.current = diagnostics?.begin({ action: options.action ?? 'tap-' + next, backend: 'foliate-paired-views', inputTime: options.inputTime }) ?? null;
    const boundary = isBoundary(engine, next);
    try {
      const pair = !boundary && !reducedMotion ? await prepare(next) : null;
      if (version !== generation.current || engine.state !== 'ready') return;
      if (boundary) { clearPreview(); await animate(drag, 0, PAGE_TURN_RULES.settleDurationMinMs, null); }
      else if (pair) {
        positionPair(pair, drag);
        const duration = options.action === 'release'
          ? getSettleDuration(Math.max(0, pair.width - Math.abs(drag)), pair.width)
          : PAGE_TURN_RULES.tapDurationMs;
        await animate(drag, pair.sign * pair.width, duration, pair);
      }
      if (version !== generation.current || engine.state !== 'ready') return;
      if (!boundary) {
        // Leave the incoming real page at x=0 above the main renderer while
        // the main renderer verifies its new content with normal geometry.
        if (pair?.element) pair.element.style.transform = translate(0);
        stopAnimations();
        engine.element.style.transform = '';
        if (reducedMotion) clearPreview();
        await engine.turn(next);
        if (version !== generation.current || engine.state !== 'ready') return;
        await onPageTurnCommitted?.();
      }
      diagnostics?.finish(record.current);
    } catch (error) {
      if (version === generation.current) diagnostics?.cancel(record.current, 'navigation-error');
      console.error('Page turn failed', error);
    } finally {
      if (version === generation.current) { diagnostics?.cancel(record.current, 'interrupted'); record.current = null; reset(); }
    }
  }, [animate, clearPreview, disabled, engine, onPageTurnCommitted, positionPair, prepare, reducedMotion, reset, stopAnimations]);
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
        clearPreview();
        p.visualDx = dampBoundaryDistance(p.dx);
        engine.element.style.transform = translate(p.visualDx);
        engine.element.style.willChange = 'transform';
        diagnostic.current?.markVisualUpdate(record.current, performance.now());
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
  }, [cancelPageTurn, clearPreview, engine, positionPair, prepare]);
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
      const pair = preview.current?.element ? preview.current : null;
      if (!pair) clearPreview();
      void animate(p.visualDx, 0, getSettleDuration(Math.abs(p.visualDx), engine.element.clientWidth), pair).finally(() => {
        if (version === generation.current) { diagnostic.current?.finish(record.current); record.current = null; reset(); }
      });
    }
  }, [animate, cancelPageTurn, clearPreview, disabled, engine, onCenterTap, onTap, reset, turnPage]);
  const handleLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id === event.pointerId) cancelPageTurn('capture-lost');
  }, [cancelPageTurn]);
  return { cancelPageTurn, direction, phase, navigateTo, turnPage, handlePointerDown, handlePointerMove, handlePointerUp, handleLostPointerCapture, handlePointerCancel: () => cancelPageTurn('pointercancel') };
}

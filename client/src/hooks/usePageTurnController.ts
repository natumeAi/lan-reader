import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { ReaderSession } from '../reader/types';
import { createReaderController } from '../reader/readerController';
import type { ReaderController } from '../reader/readerController';

interface Options {
  controller?: ReaderController | null;
  /** Transitional isolated-consumer seam; ReaderView passes its owned controller. */
  session?: ReaderSession | null;
  disabled: boolean; reducedMotion: boolean;
  onCenterTap: () => void;
  onTap?: (point: { clientX: number; clientY: number }) => boolean;
  onPageTurnCommitted?: () => Promise<void>;
  edgeRef: RefObject<HTMLElement | null>;
}
const idleSnapshot = { phase: 'idle' as const, direction: null };
const sample = (event: ReactPointerEvent<HTMLDivElement>) => ({ x: event.clientX, y: event.clientY, time: event.timeStamp });

/** React adapts events/capture and subscribes to low-frequency controller UI. */
export function usePageTurnController({ controller: supplied, session, disabled, reducedMotion, onCenterTap, onTap, onPageTurnCommitted, edgeRef }: Options) {
  const [local, setLocal] = useState<ReaderController | null>(null);
  const controller = supplied ?? local;
  const pointer = useRef<{ id: number; element: HTMLElement } | null>(null);
  const release = useCallback(() => {
    const current = pointer.current; pointer.current = null;
    try { if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id); } catch { /* Capture already released by browser. */ }
  }, []);
  useEffect(() => {
    if (supplied || !session) return;
    const owned = createReaderController(session); setLocal(owned);
    return () => { owned.destroy(); setLocal(null); };
  }, [session, supplied]);
  useEffect(() => {
    controller?.configure({ disabled, reducedMotion, onCenterTap, onTap, onPageTurnCommitted, onReleasePointer: release });
  }, [controller, disabled, reducedMotion, onCenterTap, onTap, onPageTurnCommitted, release]);
  useEffect(() => {
    const edge = edgeRef.current; if (!edge) return;
    const previous = edge.style.visibility; edge.style.visibility = 'hidden';
    return () => { edge.style.visibility = previous; };
  }, [edgeRef]);
  useEffect(() => {
    const blur = () => { void controller?.cancel('blur'); };
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); void controller?.cancel('unmount'); release(); };
  }, [controller, release]);
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller]);
  const getSnapshot = useCallback(() => controller?.snapshot ?? idleSnapshot, [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const cancelPageTurn = useCallback((reason = 'cancelled') => { void controller?.cancel(reason); release(); }, [controller, release]);
  const turnPage = useCallback((direction: 'next' | 'prev', options?: { action?: string; inputTime?: number }) => controller?.turnPage(direction, options) ?? Promise.resolve(), [controller]);
  const navigateTo = useCallback((target: string) => controller?.navigateTo(target) ?? Promise.resolve(), [controller]);
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || pointer.current) return;
    if (event.pointerType !== 'mouse' && (event.clientX < 20 || event.clientX > innerWidth - 20)) return;
    if (!controller?.pointerDown(event.pointerId, sample(event))) return;
    pointer.current = { id: event.pointerId, element: event.currentTarget };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancelPageTurn('capture-failed'); }
  }, [controller, cancelPageTurn]);
  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (controller?.pointerMove(event.pointerId, sample(event))) event.preventDefault();
  }, [controller]);
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => { controller?.pointerUp(event.pointerId, sample(event)); }, [controller]);
  const handleLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id === event.pointerId) cancelPageTurn('capture-lost');
  }, [cancelPageTurn]);
  return { ...state, cancelPageTurn, turnPage, navigateTo, handlePointerDown, handlePointerMove, handlePointerUp, handleLostPointerCapture, handlePointerCancel: () => cancelPageTurn('pointercancel') };
}

import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { TOUCH_ACTIVATION_DELAY_MS } from '../utils/dragMotion.js';

/** Movement at or beyond this distance turns a press into a scroll or swipe. */
const LONG_PRESS_TOLERANCE_PX = 8;

interface PendingPress {
  pointerId: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}

/**
 * Touch long press for read-only cards, which have no dnd-kit sensor to arbitrate touch input.
 *
 * Only a pending press listens on the window (release elsewhere, cancel, any scroll), so a grid
 * of hundreds of cards adds no global listeners while idle.
 */
export function useLongPress(onLongPress: (element: HTMLButtonElement) => void) {
  const pressRef = useRef<PendingPress | null>(null);
  const suppressClickRef = useRef(false);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const cancel = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    clearTimeout(press.timer);
    press.detach();
  }, []);

  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      cancel();
      suppressClickRef.current = false;
      if (event.pointerType !== 'touch' || !event.isPrimary) return;

      const element = event.currentTarget;
      const view = element.ownerDocument.defaultView ?? window;
      view.addEventListener('scroll', cancel, true);
      view.addEventListener('pointerup', cancel);
      view.addEventListener('pointercancel', cancel);
      const detach = () => {
        view.removeEventListener('scroll', cancel, true);
        view.removeEventListener('pointerup', cancel);
        view.removeEventListener('pointercancel', cancel);
      };
      const timer = setTimeout(() => {
        cancel();
        suppressClickRef.current = true;
        callbackRef.current(element);
      }, TOUCH_ACTIVATION_DELAY_MS);

      pressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer, detach };
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const press = pressRef.current;
      if (!press) return;
      if (
        press.pointerId !== event.pointerId ||
        Math.hypot(event.clientX - press.x, event.clientY - press.y) >= LONG_PRESS_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture(event: MouseEvent<HTMLButtonElement>) {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      // Keyboard activation (detail 0) is never the release of the long press.
      if (event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

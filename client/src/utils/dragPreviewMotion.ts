/**
 * Frame-coalesced position writes for the fixed drag preview.
 *
 * Pointer events arrive far more often than the compositor paints, and routing every
 * coordinate through React state re-rendered the whole application composition boundary.
 * The preview position therefore lives here: `setPoint` only records the request and
 * schedules at most one animation frame, and the frame performs the single DOM write.
 */
import type { Point } from './dragGeometry.js';

export interface DragPreviewMotion {
  /** Connect the rendered preview element, or null on unmount. */
  attach(element: HTMLElement | null): void;
  /** Request a position; writes are coalesced to at most one per animation frame. */
  setPoint(point: Point | null): void;
  /** Latest requested point. Exposed for tests and for handing the position to a successor. */
  readPoint(): Point | null;
  /** Cancel a pending frame and forget the position. */
  reset(): void;
  /** Test/measurement seam: called once per actual DOM write. */
  onWrite(listener: (() => void) | null): void;
}

function scheduleFrame(callback: () => void) {
  // SSR and non-visual JSDOM have no frame scheduler; writing synchronously keeps the
  // preview correct there instead of silently dropping the position.
  if (typeof requestAnimationFrame !== 'function') {
    callback();
    return null;
  }

  return requestAnimationFrame(callback);
}

function cancelFrame(handle: number) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
  }
}

export function createDragPreviewMotion(): DragPreviewMotion {
  let element: HTMLElement | null = null;
  let point: Point | null = null;
  let frame: number | null = null;
  let writeListener: (() => void) | null = null;

  const write = () => {
    if (!element || !point) {
      return;
    }

    element.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%)`;
    writeListener?.();
  };

  const clearFrame = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };

  const flush = () => {
    frame = null;
    write();
  };

  return {
    attach(nextElement) {
      element = nextElement;

      if (element && point) {
        // The element can mount after the position was requested; paint it at once so the
        // preview never appears at the origin for one frame.
        clearFrame();
        write();
      }
    },
    setPoint(nextPoint) {
      point = nextPoint;

      if (!nextPoint) {
        clearFrame();
        return;
      }

      if (frame !== null) {
        return;
      }

      frame = scheduleFrame(flush);
    },
    readPoint() {
      return point;
    },
    reset() {
      clearFrame();
      point = null;
    },
    onWrite(listener) {
      writeListener = listener;
    },
  };
}

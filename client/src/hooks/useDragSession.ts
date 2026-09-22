/**
 * Lifetime of one drag: generation, pointer stream, grab offset, cached geometry and the
 * preview motion writer.
 *
 * Pointer coordinates are deliberately not React state. A browser delivers a stationary
 * finger's movement dozens of times per second and every one of those used to reach the
 * application composition boundary, once per duplicated listener. Here they update refs
 * and one frame-coalesced transform write.
 */
import type { Point, Rect } from '../utils/dragGeometry.js';
import type { DragPreviewMotion } from '../utils/dragPreviewMotion.js';

export interface DragSession {
  /** Preview writer owned by the session; its identity is stable for the host's lifetime. */
  readonly previewMotion: DragPreviewMotion;
  /** Ends or cancels the drag: stops tracking, drops cached geometry and clears the preview. */
  end(): void;
  /** Scopes dwell candidates to the current drag. */
  generation(): number;
  /**
   * Requests a preview position: the pointer coordinate corrected by the grab offset, or
   * the overlay centre when no pointer coordinate is known (keyboard dragging). Ignored
   * while the preview is idle.
   */
  movePreview(pointerPoint: Point | null, overlayCenter: Point): void;
  /** Latest coordinate seen by the single active pointer stream. */
  pointerPoint(): Point | null;
  /** Turns the fixed preview on at the folder-to-shelf handoff and off when it ends. */
  setPreviewActive(active: boolean): void;
  /** Cached shelf sortable area, refreshed on scroll/resize and per drag. */
  shelfSortArea(): Rect | null;
  /** Starts a drag with the pointer's offset from the item centre. */
  start(grabOffset: Point): void;
}

import { useEffect, useMemo, useRef } from 'react';
import { pointFromInputEvent, shelfSortAreaRect } from '../utils/dragGeometry.js';
import { createDragPreviewMotion } from '../utils/dragPreviewMotion.js';

const zeroOffset: Point = { x: 0, y: 0 };

function measureShelfSortArea(): Rect | null {
  const shelfElement = document.querySelector('.shelf-grid');

  if (!shelfElement) {
    return null;
  }

  const viewportBottom = window.visualViewport
    ? window.visualViewport.offsetTop + window.visualViewport.height
    : window.innerHeight;

  return shelfSortAreaRect(shelfElement.getBoundingClientRect(), viewportBottom);
}

export function useDragSession(): DragSession {
  const generationRef = useRef(0);
  const grabOffsetRef = useRef<Point>(zeroOffset);
  const geometryCleanupRef = useRef<(() => void) | null>(null);
  const isPreviewActiveRef = useRef(false);
  const motionRef = useRef<DragPreviewMotion | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const pointerPointRef = useRef<Point | null>(null);
  const shelfSortAreaRef = useRef<Rect | null>(null);

  if (!motionRef.current) {
    motionRef.current = createDragPreviewMotion();
  }

  const previewMotion = motionRef.current;

  const session = useMemo<DragSession>(() => {
    const writePreview = (point: Point) => {
      const offset = grabOffsetRef.current;

      previewMotion.setPoint({ x: point.x - offset.x, y: point.y - offset.y });
    };

    const stopPointerTracking = () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      pointerPointRef.current = null;
    };

    const startPointerTracking = () => {
      stopPointerTracking();

      const updatePointerPoint = (event: Event) => {
        const point = pointFromInputEvent(event);

        if (!point) {
          return;
        }

        pointerPointRef.current = point;

        if (isPreviewActiveRef.current) {
          writePreview(point);
        }
      };

      // One stream only. Pointer events already describe mouse, touch and pen, so adding
      // the legacy streams next to them handles every movement two or three times.
      const eventNames = typeof window.PointerEvent === 'function'
        ? ['pointermove']
        : ['mousemove', 'touchmove'];

      for (const eventName of eventNames) {
        window.addEventListener(eventName, updatePointerPoint, { passive: true });
      }

      pointerCleanupRef.current = () => {
        for (const eventName of eventNames) {
          window.removeEventListener(eventName, updatePointerPoint);
        }
      };
    };

    const stopGeometryTracking = () => {
      geometryCleanupRef.current?.();
      geometryCleanupRef.current = null;
      shelfSortAreaRef.current = null;
    };

    const startGeometryTracking = () => {
      stopGeometryTracking();

      const invalidate = () => {
        shelfSortAreaRef.current = null;
      };

      // Capture phase so a scrolling container invalidates the cache too; never keep a
      // stale rect, the next evaluation measures again.
      window.addEventListener('scroll', invalidate, { capture: true, passive: true });
      window.addEventListener('resize', invalidate, { passive: true });
      window.visualViewport?.addEventListener('resize', invalidate);
      window.visualViewport?.addEventListener('scroll', invalidate);
      geometryCleanupRef.current = () => {
        window.removeEventListener('scroll', invalidate, { capture: true });
        window.removeEventListener('resize', invalidate);
        window.visualViewport?.removeEventListener('resize', invalidate);
        window.visualViewport?.removeEventListener('scroll', invalidate);
      };
    };

    return {
      previewMotion,
      end() {
        stopPointerTracking();
        stopGeometryTracking();
        isPreviewActiveRef.current = false;
        grabOffsetRef.current = zeroOffset;
        previewMotion.reset();
      },
      generation() {
        return generationRef.current;
      },
      movePreview(pointerPoint, overlayCenter) {
        if (!isPreviewActiveRef.current) {
          return;
        }

        if (!pointerPoint) {
          previewMotion.setPoint(overlayCenter);
          return;
        }

        writePreview(pointerPoint);
      },
      pointerPoint() {
        return pointerPointRef.current;
      },
      setPreviewActive(active) {
        isPreviewActiveRef.current = active;

        if (!active) {
          previewMotion.reset();
        }
      },
      shelfSortArea() {
        if (!shelfSortAreaRef.current) {
          shelfSortAreaRef.current = measureShelfSortArea();
        }

        return shelfSortAreaRef.current;
      },
      start(grabOffset) {
        generationRef.current += 1;
        grabOffsetRef.current = grabOffset;
        isPreviewActiveRef.current = false;
        previewMotion.reset();
        startPointerTracking();
        startGeometryTracking();
      },
    };
  }, [previewMotion]);

  // Listeners, frames and cached geometry never outlive the host.
  useEffect(() => () => session.end(), [session]);

  return session;
}

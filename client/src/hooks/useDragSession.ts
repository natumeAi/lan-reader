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
  /** Feed an existing sensor move after reparenting detaches its original event target. */
  movePointer(point: Point): void;
  /** One boolean publisher; coordinates never reach the subscriber. */
  onNearDeleteZoneChange(listener: ((near: boolean) => void) | null): void;
  /** Re-evaluate after the drag-start render has mounted the delete zone. */
  refreshDeleteZone(): void;
  /** Latest coordinate seen by the single active pointer stream. */
  pointerPoint(): Point | null;
  /** Turns the fixed preview on at the folder-to-shelf handoff and off when it ends. */
  setPreviewActive(active: boolean): void;
  /** Cached shelf sortable area, refreshed on scroll/resize and per drag. */
  shelfSortArea(): Rect | null;
  /** Starts a drag with the pointer's offset from the item centre. */
  start(grabOffset: Point, options?: { canDelete: boolean; pointerPoint: Point | null }): void;
}

import { useEffect, useMemo, useRef } from 'react';
import { getClientRect } from '@dnd-kit/core';
import { pointFromInputEvent, shelfSortAreaRect } from '../utils/dragGeometry.js';
import { DELETE_ZONE_SCROLL_GUARD_PX } from '../utils/dragMotion.js';
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
  const canDeleteRef = useRef(false);
  const nearDeleteZoneRef = useRef(false);
  const nearDeleteZoneListenerRef = useRef<((near: boolean) => void) | null>(null);
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
    const publishNearDeleteZone = (near: boolean) => {
      if (nearDeleteZoneRef.current === near) return;
      nearDeleteZoneRef.current = near;
      nearDeleteZoneListenerRef.current?.(near);
    };

    const refreshDeleteZone = () => {
      const point = pointerPointRef.current;
      const zone = canDeleteRef.current && point
        ? document.querySelector('.delete-drop-zone')
        : null;
      publishNearDeleteZone(Boolean(
        // Entry and armed animations must not move the auto-scroll boundary.
        point && zone && point.y >= getClientRect(zone, { ignoreTransform: true }).top - DELETE_ZONE_SCROLL_GUARD_PX,
      ));
    };

    const writePreview = (point: Point) => {
      const offset = grabOffsetRef.current;

      previewMotion.setPoint({ x: point.x - offset.x, y: point.y - offset.y });
    };

    const stopPointerTracking = () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      pointerPointRef.current = null;
    };

    const movePointer = (point: Point) => {
      pointerPointRef.current = point;
      refreshDeleteZone();
      if (isPreviewActiveRef.current) writePreview(point);
    };

    const startPointerTracking = () => {
      stopPointerTracking();

      const updatePointerPoint = (event: Event) => {
        const point = pointFromInputEvent(event);

        if (!point) {
          return;
        }

        movePointer(point);
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
        refreshDeleteZone();
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
        canDeleteRef.current = false;
        publishNearDeleteZone(false);
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
      movePointer,
      onNearDeleteZoneChange(listener) {
        nearDeleteZoneListenerRef.current = listener;
      },
      refreshDeleteZone,
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
      start(grabOffset, options) {
        generationRef.current += 1;
        grabOffsetRef.current = grabOffset;
        isPreviewActiveRef.current = false;
        previewMotion.reset();
        startPointerTracking();
        startGeometryTracking();
        canDeleteRef.current = options?.canDelete ?? false;
        pointerPointRef.current = options?.pointerPoint ?? null;
        refreshDeleteZone();
      },
    };
  }, [previewMotion]);

  // Listeners, frames and cached geometry never outlive the host.
  useEffect(() => () => session.end(), [session]);

  return session;
}

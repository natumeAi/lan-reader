import { clampDragDistance, classifyDirection, dampBoundaryDistance, decidePageDelta, getRecentVelocity, getSettleDuration } from '../utils/pageTurnGesture';

export type GestureDirection = 'next' | 'prev';
export interface GestureSnapshot {
  width: number;
  direction: 'ltr' | 'rtl';
  canPrev: boolean;
  canNext: boolean;
}
export interface GestureInput { x: number; y: number; time: number }
export interface GestureMoveResult {
  phase: 'tracking' | 'dragging' | 'cancelled';
  direction: GestureDirection | null;
  distance: number;
  visualDistance: number;
  boundary: boolean;
}
interface ReleaseMotion {
  distance: number;
  visualDistance: number;
  velocity: number;
  elapsedMs: number;
  duration: number;
}
export type GestureReleaseResult = ReleaseMotion & (
  | { kind: 'tap' | 'cancelled'; direction: null }
  | { kind: 'commit' | 'rebound'; direction: GestureDirection }
);

/** Numeric gesture decisions only. The caller owns actual rendered distance,
 * pointer capture, async preparation, command admission and navigation. */
export function createPageTurnEngine(snapshot: GestureSnapshot) {
  // Copy once: layout changes cancel this gesture, never alter its ruler mid-drag.
  const { width, direction, canPrev, canNext } = snapshot;
  let origin: GestureInput | null = null;
  let horizontal = false;
  let visualDistance = 0;
  let samples: { x: number; time: number }[] = [];
  const logicalDirection = (distance: number): GestureDirection =>
    (distance < 0) !== (direction === 'rtl') ? 'next' : 'prev';
  const boundary = (next: GestureDirection) => next === 'next' ? !canNext : !canPrev;
  const cancel = () => { origin = null; horizontal = false; visualDistance = 0; samples = []; };
  const cancelledMove = (): GestureMoveResult => ({ phase: 'cancelled', direction: null, distance: 0, visualDistance: 0, boundary: false });
  return {
    begin(input: GestureInput) {
      cancel();
      origin = { ...input };
      samples = [{ x: input.x, time: input.time }];
    },
    move(input: GestureInput): GestureMoveResult {
      if (!origin) return cancelledMove();
      const distance = input.x - origin.x;
      if (!horizontal) {
        const axis = classifyDirection(distance, input.y - origin.y);
        if (axis === 'vertical') { cancel(); return cancelledMove(); }
        if (axis === 'pending') return { phase: 'tracking', direction: null, distance, visualDistance: 0, boundary: false };
        horizontal = true;
      }
      samples.push({ x: input.x, time: input.time });
      samples = samples.slice(-20);
      const next = logicalDirection(distance);
      const atBoundary = boundary(next);
      visualDistance = atBoundary ? dampBoundaryDistance(distance) : clampDragDistance(distance, width);
      return { phase: 'dragging', direction: next, distance, visualDistance, boundary: atBoundary };
    },
    release(input: GestureInput): GestureReleaseResult {
      if (!origin) return { kind: 'cancelled', direction: null, distance: 0, visualDistance: 0, velocity: 0, elapsedMs: 0, duration: 0 };
      const distance = input.x - origin.x;
      const elapsedMs = input.time - origin.time;
      if (!horizontal) {
        cancel();
        // Preserve the existing hold-to-ignore policy (300 ms is not motion duration).
        return { kind: elapsedMs <= 300 ? 'tap' : 'cancelled', direction: null, distance, visualDistance: 0, velocity: 0, elapsedMs, duration: 0 };
      }
      samples.push({ x: input.x, time: input.time });
      const velocity = getRecentVelocity(samples);
      const delta = decidePageDelta({ distanceX: distance, velocityX: velocity, pageWidth: width });
      const next = delta ? logicalDirection(-delta) : logicalDirection(distance);
      const commit = Boolean(delta) && !boundary(next);
      // A velocity-led reversal must not launch from an opposite-side surface.
      const start = commit && visualDistance !== 0 && logicalDirection(visualDistance) !== next ? 0 : visualDistance;
      const duration = getSettleDuration(commit ? Math.max(0, width - Math.abs(start)) : Math.abs(start), width);
      cancel();
      return { kind: commit ? 'commit' : 'rebound', direction: next, distance, visualDistance: start, velocity, elapsedMs, duration };
    },
    cancel,
  };
}

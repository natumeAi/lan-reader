import { PAGE_TURN_RULES, clampDragDistance, classifyDirection, dampBoundaryDistance, decidePageDelta, getRecentVelocity, getSettleMotion } from '../utils/pageTurnGesture';

/** Guards a same-timestamp sample storm; 100 ms at 240 Hz needs about 25. */
const MAX_SAMPLES = 256;

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
  /** Reference launch slope; the caller recomputes it from the rendered start. */
  launch: number;
}
export type GestureReleaseResult = ReleaseMotion & (
  | { kind: 'tap' | 'cancelled'; direction: null }
  | { kind: 'commit' | 'rebound'; direction: GestureDirection }
);

/** Numeric gesture decisions only. The caller owns actual rendered distance,
 * pointer capture, async preparation, command admission and navigation. */
export function createPageTurnEngine(snapshot: GestureSnapshot) {
  // Copy once: layout changes cancel this gesture, never alter its ruler mid-drag.
  let { width, direction, canPrev, canNext } = snapshot;
  let origin: GestureInput | null = null;
  let horizontal = false;
  // Shown distance starts at the lock point, so locking never jumps the page.
  let lockOffset = 0;
  let visualDistance = 0;
  let samples: { x: number; time: number }[] = [];
  const logicalDirection = (distance: number): GestureDirection =>
    (distance < 0) !== (direction === 'rtl') ? 'next' : 'prev';
  const boundary = (next: GestureDirection) => next === 'next' ? !canNext : !canPrev;
  const cancel = () => { origin = null; horizontal = false; lockOffset = 0; visualDistance = 0; samples = []; };
  const cancelledMove = (): GestureMoveResult => ({ phase: 'cancelled', direction: null, distance: 0, visualDistance: 0, boundary: false });
  return {
    /** A waiting gesture is promoted at a new accepted origin, before it renders. */
    rebase(next: GestureSnapshot) { ({ width, direction, canPrev, canNext } = next); },
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
        lockOffset = Math.sign(distance) * PAGE_TURN_RULES.directionLockPx;
      }
      // Velocity reads only the first and the newest sample of one timestamp.
      const length = samples.length;
      if (length >= 2 && samples[length - 1]!.time === input.time && samples[length - 2]!.time === input.time) samples[length - 1] = { x: input.x, time: input.time };
      else samples.push({ x: input.x, time: input.time });
      // Keep the whole velocity window at any event rate (a fixed count shrinks
      // it at high refresh rates); older samples can never affect the velocity.
      const cutoff = input.time - PAGE_TURN_RULES.velocityWindowMs;
      let stale = 0;
      while (stale < samples.length - 1 && samples[stale]!.time < cutoff) stale++;
      stale = Math.max(stale, samples.length - MAX_SAMPLES);
      if (stale > 0) samples.splice(0, stale);
      const shown = distance - lockOffset;
      // At the lock point the shown distance is 0: keep the locked direction.
      const next = logicalDirection(shown !== 0 ? shown : distance);
      const atBoundary = boundary(next);
      visualDistance = atBoundary ? dampBoundaryDistance(shown) : clampDragDistance(shown, width);
      return { phase: 'dragging', direction: next, distance, visualDistance, boundary: atBoundary };
    },
    release(input: GestureInput): GestureReleaseResult {
      if (!origin) return { kind: 'cancelled', direction: null, distance: 0, visualDistance: 0, velocity: 0, elapsedMs: 0, duration: 0, launch: 0 };
      const distance = input.x - origin.x;
      const elapsedMs = input.time - origin.time;
      if (!horizontal) {
        cancel();
        // Preserve the existing hold-to-ignore policy (300 ms is not motion duration).
        return { kind: elapsedMs <= 300 ? 'tap' : 'cancelled', direction: null, distance, visualDistance: 0, velocity: 0, elapsedMs, duration: 0, launch: 0 };
      }
      samples.push({ x: input.x, time: input.time });
      const velocity = getRecentVelocity(samples);
      const delta = decidePageDelta({ distanceX: distance, velocityX: velocity, pageWidth: width });
      const next = delta ? logicalDirection(-delta) : logicalDirection(distance);
      const commit = Boolean(delta) && !boundary(next);
      // A velocity-led reversal must not launch from an opposite-side surface.
      const start = commit && visualDistance !== 0 && logicalDirection(visualDistance) !== next ? 0 : visualDistance;
      // Project the release velocity onto the physical settle direction.
      const heading = commit ? ((next === 'next') !== (direction === 'rtl') ? -1 : 1) : -Math.sign(start);
      const { duration, launch } = getSettleMotion({
        remaining: commit ? Math.max(0, width - Math.abs(start)) : Math.abs(start), width, velocity: Math.max(0, velocity * heading),
      });
      cancel();
      return { kind: commit ? 'commit' : 'rebound', direction: next, distance, visualDistance: start, velocity, elapsedMs, duration, launch };
    },
    cancel,
  };
}

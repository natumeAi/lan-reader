/**
 * Shared bookshelf drag motion parameters.
 *
 * The sortable shells used to carry their own copy of the reorder transition, so the shelf
 * and the Folder panel could drift apart silently. Every duration and easing that more than
 * one module needs lives here instead.
 *
 * These numbers are implementation tuning inside the approved behaviour. They are not a
 * measured frame-rate result and must not be read as one; changing them needs a comparative
 * browser check, not a unit test.
 */
export interface ShelfMotionTransition {
  duration: number;
  easing: string;
}

/**
 * Reorder motion of a sortable card. Kept at the reviewed 460 ms; the dwell threshold
 * (450 ms) and the touch activation delay (500 ms) are separate and deliberately unchanged.
 */
export const SHELF_SORT_TRANSITION: ShelfMotionTransition = {
  duration: 460,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
};

/** Release motion: the overlay settles onto the accepted destination instead of vanishing. */
export const DROP_SETTLE_MS = 260;
export const DROP_SETTLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Reduced motion keeps the same end state but collapses the travel to a single frame. */
export const REDUCED_MOTION_SETTLE_MS = 1;

/** A card that just arrived from a Folder settles in place rather than appearing abruptly. */
export const LANDING_SETTLE_MS = 320;

/** How long a failed save stays marked before the hook clears its own feedback. */
export const SAVE_FAILURE_FEEDBACK_MS = 2200;

/**
 * `DragOverlay` drop animation. dnd-kit animates the overlay clone toward the accepted
 * destination on a drop and back to the origin on a cancel; supplying `null` (the previous
 * value) made both cases disappear instantly.
 *
 * The result is deliberately the plain keyframe shape rather than dnd-kit's `DropAnimation`
 * union, so callers and tests can read the duration back; `App` proves it stays assignable.
 */
export function dropAnimationConfig(reducedMotion: boolean): ShelfMotionTransition {
  if (reducedMotion) {
    return { duration: REDUCED_MOTION_SETTLE_MS, easing: 'linear' };
  }

  return { duration: DROP_SETTLE_MS, easing: DROP_SETTLE_EASING };
}

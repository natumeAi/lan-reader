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
 * Reorder motion of a sortable card (UX decision D8); the hover dwells
 * (`SORT_DWELL_MS`, `INTENT_DWELL_MS` below) and the touch activation delay (350 ms) are separate.
 */
export const SHELF_SORT_TRANSITION: ShelfMotionTransition = {
  duration: 280,
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

// Hover dwells (UX decision D3, 2026-09-29). Changing either needs a new UX decision and an
// update to the bookshelf drag spec. Free shelf whitespace still sorts without a dwell.

/** Hover time before a card-edge sort target is adopted. */
export const SORT_DWELL_MS = 150;
/** Hover time in a target centre zone before merge/absorb is armed. */
export const INTENT_DWELL_MS = 350;
/** Total centre-zone dwell before a root Book opens its destination Folder (D13). */
export const SPRING_OPEN_DWELL_MS = 800;

export const TOUCH_ACTIVATION_DELAY_MS = 350;

/** Time outside the Folder panel before handing a book to the shelf. */
export const FOLDER_EXIT_DWELL_MS = 250;
/** Vertical viewport fraction used for edge auto-scroll away from the delete zone. */
export const AUTO_SCROLL_THRESHOLD_Y = 0.12;
/** Stop auto-scroll this far above the delete zone while dragging a book. */
export const DELETE_ZONE_SCROLL_GUARD_PX = 120;

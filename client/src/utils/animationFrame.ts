// Bounded animation-frame waits.
//
// A page can report `visibilityState === 'visible'` and still deliver no
// animation frames (an embedded/occluded pane that is not being composited).
// An unbounded `requestAnimationFrame` wait then never settles, which left the
// reader stuck on its open gate or timing out in layout settlement. These
// helpers race the next frame against a timer, so a starved page proceeds after
// the fallback while a normally painting page still continues on its frame
// (well before the fallback fires), with unchanged ordering.
//
// Do not use these for disposal that must wait for upstream frame callbacks to
// drain (e.g. closing a Foliate renderer): there, running early on a timer is
// the bug, and a hidden page correctly defers the release until it paints.

/** Matches the section-measurement frame wait that preceded this helper. */
export const FRAME_FALLBACK_MS = 100;

/**
 * Runs `callback` exactly once, on the next animation frame or after
 * `timeoutMs`, whichever comes first; the other pending mechanism is cleared.
 * Returns a cancel function that prevents a callback that has not yet run.
 */
export function requestFrameOrTimeout(callback: () => void, timeoutMs = FRAME_FALLBACK_MS): () => void {
  let done = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const run = () => {
    if (done) return;
    clear();
    callback();
  };
  timer = setTimeout(run, timeoutMs);
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run);
  return clear;
}

/** Promise form of {@link requestFrameOrTimeout}; resolves once. */
export function waitForFrameOrTimeout(timeoutMs = FRAME_FALLBACK_MS): Promise<void> {
  return new Promise<void>(resolve => { requestFrameOrTimeout(resolve, timeoutMs); });
}

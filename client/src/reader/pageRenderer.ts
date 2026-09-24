import { sampleEaseOutCubicKeyframes } from '../utils/pageTurnGesture';

type PageSurface = Pick<HTMLElement, 'style' | 'animate'>;
/** A prepared neighbor at `distance - sign * width`: LTR next has sign -1 (right of current). */
export interface PageNeighbor { element: PageSurface; sign: -1 | 1 }
/** Prepared outer surfaces only. The caller owns geometry and document lifetime. */
export interface PageSurfaces {
  current: PageSurface;
  width: number;
  /** Zero to two neighbors with distinct signs (previous and/or next). */
  neighbors?: readonly PageNeighbor[];
}
export type PageMotionResult = 'finished' | 'cancelled';
export interface PageRendererBinding {
  /** Native animation timeline progress; null when there is no active motion. */
  readonly progress: number | null;
  update(distance: number): void;
  settle(from: number, to: number, duration: number, timelineTime?: number | null, onAnimationWrite?: () => void): Promise<PageMotionResult>;
  /** Stationary handoff: keep the incoming surface covering normal foreground geometry. */
  holdIncoming(): void;
  cancel(): void;
  release(): void;
}

const translate = (x: number) => `translateX(${x}px)`;
const easing = sampleEaseOutCubicKeyframes();
const keyframes = (from: number, to: number): Keyframe[] => easing.map(({ offset, value }) => ({
  offset, transform: translate(from + (to - from) * value),
}));

/** No layout reads, engine calls, frames, document creation or navigation. */
export function createPageRenderer() {
  let active: PageRendererBinding | null = null;

  function bind({ current, width, neighbors = [] }: PageSurfaces): PageRendererBinding {
    if (neighbors.length > 2 || new Set(neighbors.map(neighbor => neighbor.sign)).size !== neighbors.length) {
      throw new RangeError('A binding holds at most one neighbor per side.');
    }
    active?.release();
    const original = { transform: current.style.transform, willChange: current.style.willChange };
    const sides = neighbors.map(({ element, sign }) => ({
      element, sign, offset: -sign * width,
      original: { transform: element.style.transform, willChange: element.style.willChange, visibility: element.style.visibility },
    }));
    let run: { animations: Animation[]; resolve: (result: PageMotionResult) => void } | null = null;
    // The last settle's endpoints select the covering neighbor at handoff.
    let last: { from: number; to: number } | null = null;
    const stop = () => {
      const previous = run;
      run = null;
      if (!previous) return;
      // Invalidate before cancellation can reject the old finished promises.
      for (const animation of previous.animations) animation.cancel();
      previous.resolve('cancelled');
    };
    const restoreTransforms = () => {
      current.style.transform = original.transform;
      for (const side of sides) side.element.style.transform = side.original.transform;
    };
    const binding: PageRendererBinding = {
      get progress() { return run?.animations[0]?.effect?.getComputedTiming().progress ?? null; },
      update(distance) {
        if (active !== binding) return;
        current.style.transform = translate(distance);
        for (const side of sides) side.element.style.transform = translate(distance + side.offset);
      },
      settle(from, to, duration, timelineTime, onAnimationWrite) {
        if (active !== binding) return Promise.resolve('cancelled');
        stop();
        last = { from, to };
        return new Promise<PageMotionResult>(resolve => {
          const motion = { animations: [] as Animation[], resolve };
          run = motion;
          try {
            const options: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'forwards' };
            motion.animations.push(current.animate(keyframes(from, to), options));
            onAnimationWrite?.();
            // Every bound neighbor shares the curve and timeline: a velocity-led
            // reversal can settle toward one side while the other one is on-screen.
            for (const side of sides) motion.animations.push(side.element.animate(keyframes(from + side.offset, to + side.offset), options));
            if (typeof timelineTime === 'number') {
              for (const animation of motion.animations) animation.startTime = timelineTime;
            }
            void Promise.all(motion.animations.map(animation => animation.finished)).then(() => {
              if (active === binding && run === motion) resolve('finished');
            }, () => {
              if (active === binding && run === motion) { stop(); restoreTransforms(); }
            });
          } catch {
            // A later surface can fail after an earlier animation exists.
            // Observe those promises before cancel rejects their finished state.
            void Promise.all(motion.animations.map(animation => animation.finished)).catch(() => {});
            stop(); restoreTransforms();
          }
        });
      },
      holdIncoming() {
        if (active !== binding) return;
        const covering = last ? Math.sign(last.to) || Math.sign(last.from) : 0;
        // Write the static cover (and keep the other neighbor off-screen at its
        // end position) before clearing WAAPI's forwards fill.
        for (const side of sides) {
          side.element.style.transform = translate(side.sign === covering ? 0 : (last?.to ?? 0) + side.offset);
        }
        current.style.transform = original.transform;
        stop();
      },
      cancel() {
        if (active !== binding) return;
        stop(); restoreTransforms();
      },
      release() {
        if (active !== binding) return;
        stop(); restoreTransforms();
        current.style.willChange = original.willChange;
        for (const side of sides) {
          side.element.style.willChange = side.original.willChange;
          side.element.style.visibility = side.original.visibility;
        }
        active = null;
      },
    };
    active = binding;
    current.style.willChange = 'transform';
    for (const side of sides) {
      // Off-screen before it becomes visible: no neighbor ever covers current untransformed.
      side.element.style.transform = translate(side.offset);
      side.element.style.willChange = 'transform';
      side.element.style.visibility = 'visible';
    }
    return binding;
  }

  return { bind, release() { active?.release(); } };
}

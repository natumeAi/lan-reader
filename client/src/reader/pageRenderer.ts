import { sampleEaseOutCubicKeyframes } from '../utils/pageTurnGesture';

/** Prepared outer surfaces only. The caller owns geometry and document lifetime. */
export interface PageSurfaces {
  current: Pick<HTMLElement, 'style' | 'animate'>;
  incoming?: Pick<HTMLElement, 'style' | 'animate'> | null;
  width: number;
  sign: -1 | 1;
}
export type PageMotionResult = 'finished' | 'cancelled';
export interface PageRendererBinding {
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

  function bind({ current, incoming, width, sign }: PageSurfaces): PageRendererBinding {
    active?.release();
    const original = {
      currentTransform: current.style.transform,
      currentWillChange: current.style.willChange,
      incomingTransform: incoming?.style.transform ?? '',
      incomingWillChange: incoming?.style.willChange ?? '',
      incomingVisibility: incoming?.style.visibility ?? '',
    };
    const offset = -sign * width;
    let run: { animations: Animation[]; resolve: (result: PageMotionResult) => void } | null = null;
    const stop = () => {
      const previous = run;
      run = null;
      if (!previous) return;
      // Invalidate before cancellation can reject the old finished promises.
      for (const animation of previous.animations) animation.cancel();
      previous.resolve('cancelled');
    };
    const restoreTransforms = () => {
      current.style.transform = original.currentTransform;
      if (incoming) incoming.style.transform = original.incomingTransform;
    };
    const binding: PageRendererBinding = {
      update(distance) {
        if (active !== binding) return;
        current.style.transform = translate(distance);
        if (incoming) incoming.style.transform = translate(distance + offset);
      },
      settle(from, to, duration, timelineTime, onAnimationWrite) {
        if (active !== binding) return Promise.resolve('cancelled');
        stop();
        return new Promise<PageMotionResult>(resolve => {
          const motion = { animations: [] as Animation[], resolve };
          run = motion;
          try {
            const options: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'forwards' };
            motion.animations.push(current.animate(keyframes(from, to), options));
            onAnimationWrite?.();
            if (incoming) motion.animations.push(incoming.animate(keyframes(from + offset, to + offset), options));
            if (typeof timelineTime === 'number') {
              for (const animation of motion.animations) animation.startTime = timelineTime;
            }
            void Promise.all(motion.animations.map(animation => animation.finished)).then(() => {
              if (active === binding && run === motion) resolve('finished');
            }, () => {
              if (active === binding && run === motion) { stop(); restoreTransforms(); }
            });
          } catch {
            // The second surface can fail after the first animation exists.
            // Observe those promises before cancel rejects their finished state.
            void Promise.all(motion.animations.map(animation => animation.finished)).catch(() => {});
            stop(); restoreTransforms();
          }
        });
      },
      holdIncoming() {
        if (active !== binding) return;
        // Write the static cover before clearing WAAPI's forwards fill.
        if (incoming) incoming.style.transform = translate(0);
        current.style.transform = original.currentTransform;
        stop();
      },
      cancel() {
        if (active !== binding) return;
        stop(); restoreTransforms();
      },
      release() {
        if (active !== binding) return;
        stop(); restoreTransforms();
        current.style.willChange = original.currentWillChange;
        if (incoming) {
          incoming.style.willChange = original.incomingWillChange;
          incoming.style.visibility = original.incomingVisibility;
        }
        active = null;
      },
    };
    active = binding;
    current.style.willChange = 'transform';
    if (incoming) {
      incoming.style.willChange = 'transform';
      incoming.style.visibility = 'visible';
    }
    return binding;
  }

  return { bind, release() { active?.release(); } };
}

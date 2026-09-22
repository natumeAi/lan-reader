/**
 * Hover dwell scheduling for drag sorting.
 *
 * dnd-kit recomputes collisions while `DndContext` renders, so a dwell threshold that is
 * only compared inside `collisionDetection` never matures while the pointer is stationary.
 * This hook owns one cancellable deadline per candidate and re-renders its host when the
 * deadline elapses, which makes `DndContext` recompute collisions and adopt the new target.
 */
export interface SortDwellCandidate {
  /** Scopes a candidate to one drag session / folder session. */
  generation: number;
  targetKey: string;
}
export interface SortDwell {
  /** Register the currently hovered candidate; returns true once its dwell has matured. */
  evaluate(candidate: SortDwellCandidate | null): boolean;
  /** Invalidate every pending deadline (target change, drag end/cancel, folder session change, unmount). */
  reset(): void;
}
interface PendingDwell {
  candidate: SortDwellCandidate;
  matured: boolean;
  startedAt: number;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export function useSortDwell(delayMs: number): SortDwell {
  const [, setTick] = useState(0);
  const isMountedRef = useRef(true);
  const pendingRef = useRef<PendingDwell | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelDeadline = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    cancelDeadline();
    pendingRef.current = null;
  }, [cancelDeadline]);

  const evaluate = useCallback(
    (candidate: SortDwellCandidate | null) => {
      if (!candidate) {
        reset();
        return false;
      }

      const pending = pendingRef.current;

      if (
        pending &&
        pending.candidate.generation === candidate.generation &&
        pending.candidate.targetKey === candidate.targetKey
      ) {
        return pending.matured || performance.now() - pending.startedAt >= delayMs;
      }

      cancelDeadline();
      const nextPending: PendingDwell = {
        candidate,
        matured: false,
        startedAt: performance.now(),
      };
      pendingRef.current = nextPending;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;

        if (!isMountedRef.current || pendingRef.current !== nextPending) {
          return;
        }

        nextPending.matured = true;
        // Re-render the owner so DndContext recomputes collisions with the current geometry.
        setTick((value) => value + 1);
      }, delayMs);

      return false;
    },
    [cancelDeadline, delayMs, reset],
  );

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      cancelDeadline();
      pendingRef.current = null;
    };
  }, [cancelDeadline]);

  return useMemo(() => ({ evaluate, reset }), [evaluate, reset]);
}

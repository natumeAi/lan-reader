import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryMutationOptions, LibraryMutations, MutationOutcome } from './useLibraryMutations.js';
import type { ShelfProjection } from './useShelfData.js';
import { LANDING_SETTLE_MS, SAVE_FAILURE_FEEDBACK_MS } from '../utils/dragMotion.js';
import { useLibraryMutations } from './useLibraryMutations.js';

/** Which bookshelf operation a card is currently carrying persistence feedback for. */
export type ShelfMutationIntent = 'sort' | 'merge' | 'absorb' | 'move-out';
/**
 * Honest persistence feedback for the cards taking part in the newest mutation.
 *
 * A card stays `pending` until the server confirms; nothing shows a settled result early.
 * `failed` is transient and the hook clears it itself.
 */
export type ShelfMutationFeedback =
  | { status: 'idle' }
  | { status: 'pending' | 'failed'; intent: ShelfMutationIntent; keys: readonly string[] };

export interface ShelfOperationsOptions extends LibraryMutationOptions {
  beginShelfProjection?: () => ShelfProjection;
}

export interface ShelfOperations {
  mutations: LibraryMutations;
  mutationFeedback: ShelfMutationFeedback;
  landingKey: string | null;
  beginMutationFeedback(intent: ShelfMutationIntent, keys: readonly string[]): (outcome: MutationOutcome) => void;
  markLanding(key: string): void;
  acquireShelfProjection(): void;
  takeShelfProjection(): ShelfProjection | null;
  releaseShelfProjection(): void;
}

const idleMutationFeedback: ShelfMutationFeedback = { status: 'idle' };

/** One mutation scope and visual lifetime shared by every operation on this shelf. */
export function useShelfOperations({
  beginShelfProjection,
  ...mutationOptions
}: ShelfOperationsOptions): ShelfOperations {
  const feedbackTokenRef = useRef(0);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shelfProjectionRef = useRef<ShelfProjection | null>(null);
  const [mutationFeedback, setMutationFeedback] = useState<ShelfMutationFeedback>(idleMutationFeedback);
  /** Key of a card that has just arrived from a Folder and is settling into the shelf. */
  const [landingKey, setLandingKey] = useState<string | null>(null);
  const mutations = useLibraryMutations(mutationOptions);

  const clearFailureTimer = useCallback(() => {
    if (failureTimerRef.current !== null) {
      clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    }
  }, []);

  /**
   * Marks the cards of a new mutation as pending and takes ownership of their feedback.
   * The returned reporter only publishes while it is still the newest mutation, so a stale
   * completion can neither clear a newer pending state nor surface an obsolete failure.
   */
  const beginMutationFeedback = useCallback(
    (intent: ShelfMutationIntent, keys: readonly string[]) => {
      clearFailureTimer();
      feedbackTokenRef.current += 1;
      const token = feedbackTokenRef.current;

      setMutationFeedback({ status: 'pending', intent, keys });

      return (outcome: MutationOutcome) => {
        if (feedbackTokenRef.current !== token) {
          return;
        }

        if (outcome !== 'failed') {
          setMutationFeedback(idleMutationFeedback);
          return;
        }

        setMutationFeedback({ status: 'failed', intent, keys });
        failureTimerRef.current = setTimeout(() => {
          failureTimerRef.current = null;

          if (feedbackTokenRef.current !== token) {
            return;
          }

          setMutationFeedback(idleMutationFeedback);
        }, SAVE_FAILURE_FEEDBACK_MS);
      };
    },
    [clearFailureTimer],
  );

  /** A card that replaced the temporary Folder item settles in place instead of appearing abruptly. */
  const markLanding = useCallback((key: string) => {
    if (landingTimerRef.current !== null) {
      clearTimeout(landingTimerRef.current);
    }

    setLandingKey(key);
    landingTimerRef.current = setTimeout(() => {
      landingTimerRef.current = null;
      setLandingKey(null);
    }, LANDING_SETTLE_MS);
  }, []);

  const releaseShelfProjection = useCallback(() => {
    shelfProjectionRef.current?.release();
    shelfProjectionRef.current = null;
  }, []);

  const acquireShelfProjection = useCallback(() => {
    releaseShelfProjection();
    shelfProjectionRef.current = beginShelfProjection?.() ?? null;
  }, [beginShelfProjection, releaseShelfProjection]);

  /** Hands the projection to the drag-end path that must decide when to publish or release it. */
  const takeShelfProjection = useCallback(() => {
    const projection = shelfProjectionRef.current;
    shelfProjectionRef.current = null;
    return projection;
  }, []);

  useEffect(
    () => () => {
      // Feedback deadlines never outlive the host; a stale failure cannot reappear.
      clearFailureTimer();

      if (landingTimerRef.current !== null) {
        clearTimeout(landingTimerRef.current);
        landingTimerRef.current = null;
      }

      // Never leave a projection held after unmount; a background refresh must not stay suppressed.
      releaseShelfProjection();
    },
    [clearFailureTimer, releaseShelfProjection],
  );

  // Stable identity between feedback changes, so consumers can list it as a dependency.
  return useMemo(
    () => ({
      mutations,
      mutationFeedback,
      landingKey,
      beginMutationFeedback,
      markLanding,
      acquireShelfProjection,
      takeShelfProjection,
      releaseShelfProjection,
    }),
    [
      acquireShelfProjection,
      beginMutationFeedback,
      landingKey,
      markLanding,
      mutationFeedback,
      mutations,
      releaseShelfProjection,
      takeShelfProjection,
    ],
  );
}

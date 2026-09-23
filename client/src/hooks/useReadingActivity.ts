import { useEffect, useState } from 'react';
import type { ReadingActivitySink } from '../utils/activityDelivery';
import type { ActivityTrackerOptions } from '../reader/activityTracker';
import { ReaderActivityTracker } from '../reader/activityTracker';

interface Options {
  bookId: number;
  sink: ReadingActivitySink | null | undefined;
  /** Loaded, laid out and without an error message. */
  contentReady: boolean;
  /** Settings/TOC panel open: blocks time and text. */
  blockingPanel: boolean;
  /** Book-image viewer open: time continues without text samples. */
  imageViewerOpen: boolean;
  /** Test seams (clock, sampler, delays). */
  tracker?: ActivityTrackerOptions;
}

/**
 * Owns the reading-activity observation of one ReaderView.
 *
 * Returns a stable accepted-position observer for `useFoliateReader` and an
 * idempotent `close` for reader close/history exit. The tracker lives as long
 * as the ReaderView (keyed by Book); mount/unmount (including StrictMode's
 * simulated remount) only attaches/detaches lifecycle listeners, which
 * checkpoints time without ending the session. No React state is updated by
 * timing, so reading causes no periodic re-renders.
 */
export function useReadingActivity({ bookId, sink, contentReady, blockingPanel, imageViewerOpen, tracker: trackerOptions }: Options) {
  const [tracker] = useState(() => new ReaderActivityTracker(bookId, trackerOptions));
  useEffect(() => {
    tracker.setInputs({ sink: sink ?? null, contentReady, blockingPanel, imageViewerOpen });
  }, [tracker, sink, contentReady, blockingPanel, imageViewerOpen]);
  useEffect(() => tracker.attach(), [tracker]);
  const [api] = useState(() => ({
    observeAccepted: tracker.observeAccepted,
    close: () => tracker.close(),
  }));
  return api;
}

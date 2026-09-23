import type { View } from 'foliate-js/view.js';
import type { FoliateBook } from './foliateTypes';
import type { PageRanges, ReadingSection } from '../types/epub';
import { waitForFrameOrTimeout } from '../utils/animationFrame';
import { isWholeDocumentReadingSection, measureReadingSectionPages } from '../utils/epubPageMap';
import { beginReaderWork } from './diagnostics';

// Upstream renderer style changes queue animation-frame callbacks that still
// access its document. Let queued work drain before closing its resources.
function settleDisposal() {
  // Do not race a timer: hidden documents suspend rAF, including the upstream
  // callbacks we must drain. Keep the invisible owner alive until painting
  // resumes, rather than letting those callbacks run against a closed renderer.
  return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export interface PaginationSnapshot {
  layoutKey: string;
  currentSectionIndex: number | undefined;
  readingSections: ReadingSection[];
}

interface SectionPaginationOptions {
  container: HTMLElement;
  /** Each call must own its resources and transforms independently of the reader. */
  createBook: () => Promise<FoliateBook>;
  createView: () => View;
  configure: (view: View) => void;
  getSnapshot: () => PaginationSnapshot;
  /** Permission for optional work. A request made without it is rejected, not remembered. */
  canMeasure: () => boolean;
  /**
   * Transient contention (preview buffer work). A permitted request is kept
   * pending while busy and starts once quiet, without another request.
   */
  isBusy?: () => boolean;
  /** Recheck interval while a retained request waits for contention to clear. */
  busyRetryMs?: number;
  onPages: (section: ReadingSection, ranges: PageRanges) => void;
  onInvalidate?: () => void;
  idleDelayMs?: number;
}

/** Current-section measurement is optional work, with independent book ownership. */
export function createSectionPagination(options: SectionPaginationOptions) {
  const busyRetryMs = options.busyRetryMs ?? 250;
  let generation = 0;
  let destroyed = false;
  let running = false;
  let pending = false;
  let actualPromise: Promise<void> | null = null;
  let draining = 0;
  let drainFailure: { error: unknown } | null = null;
  let layoutKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  // Set when retained work should recheck contention sooner than the idle delay.
  let contentionRetry = false;
  const measured = new Set<string>();

  const cancelSchedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (idle !== undefined) window.cancelIdleCallback(idle);
    idle = undefined;
  };
  const pause = () => {
    ++generation;
    pending = false;
    contentionRetry = false;
    cancelSchedule();
  };
  const invalidate = () => {
    pause();
    measured.clear();
    layoutKey = undefined;
    options.onInvalidate?.();
  };
  const permitted = () => !destroyed && draining === 0 && !drainFailure && options.canMeasure() && document.visibilityState !== 'hidden';
  const busy = () => options.isBusy?.() ?? false;
  // Whole-document Reading Sections take their label from the foreground
  // renderer; they never need a hidden measurement Book/View.
  const measurable = (snapshot: PaginationSnapshot) => snapshot.readingSections
    .filter(section => !isWholeDocumentReadingSection(section, snapshot.readingSections));
  const stopAndDrain = async () => {
    pause();
    draining++;
    try {
      await actualPromise;
      if (drainFailure) throw drainFailure.error;
    } finally { draining--; }
  };

  const run = async () => {
    if (running || !pending || !permitted()) return;
    // Contention leaves the request pending; start() reschedules the recheck.
    if (busy()) { contentionRetry = true; return; }
    pending = false;
    const snapshot = options.getSnapshot();
    if (snapshot.layoutKey !== layoutKey) {
      measured.clear();
      if (layoutKey !== undefined) options.onInvalidate?.();
      layoutKey = snapshot.layoutKey;
    }
    const readingSections = measurable(snapshot);
    if (!readingSections.some(section =>
      !measured.has(section.id) && snapshot.currentSectionIndex !== undefined &&
      section.sectionIndexes.includes(snapshot.currentSectionIndex))) return;
    const width = options.container.clientWidth;
    const height = options.container.clientHeight;
    if (width < 2 || height < 2) return;
    running = true;
    const diagnostics = beginReaderWork('measurement');
    const token = generation;
    let failed = false;
    // Contention is sticky for this run: once observed, every later check
    // stops, so a quick busy/quiet flip cannot surface as a section failure.
    let contended = false;
    const stopped = () => {
      if (failed || contended || token !== generation || !permitted() || options.getSnapshot().layoutKey !== snapshot.layoutKey) return true;
      if (busy()) contended = true;
      return contended;
    };
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;visibility:hidden;pointer-events:none;contain:strict`;
    host.setAttribute('aria-hidden', 'true');
    let view: View | undefined;
    let book: FoliateBook | undefined;
    // epubPageMap can time out/cancel before an underlying navigation settles.
    // Retain exclusive ownership until those operations finish; otherwise a late
    // load can recreate resources after close, or overlap the next measurement.
    const navigation: Promise<unknown>[] = [];
    try {
      book = await options.createBook();
      diagnostics?.bookCreated();
      if (stopped()) return;
      view = options.createView();
      diagnostics?.viewCreated();
      view.style.cssText = 'display:block;width:100%;height:100%';
      host.append(view);
      document.body.append(host);
      await view.open(book);
      if (stopped()) return;
      options.configure(view);
      const measurementView = view;
      const measure = (target: string | number) => {
        const result = (async () => {
          if (stopped()) throw new Error('Measurement interrupted');
          const resolved = measurementView.resolveNavigation(target);
          if (!resolved) throw new Error('Invalid section boundary');
          await measurementView.renderer.goTo(resolved);
          if (stopped()) throw new Error('Measurement interrupted');
          await Promise.all(measurementView.renderer.getContents().map(({ doc }) => doc.fonts?.ready));
          if (stopped()) throw new Error('Measurement interrupted');
          await waitForFrameOrTimeout(100);
          if (stopped()) throw new Error('Measurement interrupted');
          return {
            page: measurementView.isFixedLayout ? 1 : measurementView.renderer.page,
            total: measurementView.isFixedLayout ? 1 : measurementView.renderer.pages - 2,
            sectionIndex: resolved.index,
          };
        })();
        navigation.push(result);
        return result;
      };
      await measureReadingSectionPages({
        readingSections,
        prioritySectionIndex: snapshot.currentSectionIndex,
        measureCurrentReadingSectionsOnly: true,
        cachedReadingSectionIds: measured,
        shouldStop: stopped,
        measureTarget: measure,
        measureSection: async index => (await measure(index)).total,
        onReadingSectionFailed: () => { failed = true; },
        onReadingSectionComplete: (section, ranges) => {
          if (stopped()) return;
          measured.add(section.id);
          options.onPages(section, ranges);
        },
      });
    } catch {
      // Preserve unknown page counts; a future idle request can retry.
    } finally {
      try {
        await Promise.allSettled(navigation);
        diagnostics?.end();
        if (view) await settleDisposal();
        try { view?.close(); } finally {
          try { view?.remove(); } finally {
            try { host.remove(); } finally {
              book?.destroy();
            }
          }
        }
        diagnostics?.release();
      } finally {
        running = false;
        // Only a contention interruption of the current generation and layout
        // retries itself; measurement failures wait for a later explicit request.
        if (contended && !failed && token === generation && permitted() && options.getSnapshot().layoutKey === snapshot.layoutKey) {
          pending = true;
          contentionRetry = true;
        }
      }
    }
  };
  const start = () => {
    if (actualPromise) return;
    // Publish the run owner before invoking factories. Even a stop issued by a
    // synchronous factory callback must observe and await this entire lifetime.
    const work = Promise.resolve().then(run).catch(error => {
      drainFailure ??= { error };
      throw error;
    }).finally(() => {
      if (actualPromise === work) actualPromise = null;
      const retry = contentionRetry;
      contentionRetry = false;
      if (pending && permitted()) schedule(retry ? busyRetryMs : undefined);
    });
    actualPromise = work;
    // Optional dispatch has no awaiting caller; drain still receives failures
    // and must never treat failed disposal as a resource-safe motion boundary.
    void work.catch(() => {});
  };
  const schedule = (delayMs = options.idleDelayMs ?? 700) => {
    cancelSchedule();
    timer = setTimeout(() => {
      timer = undefined;
      if (!permitted()) { pending = false; return; }
      // Preview work keeps priority: keep the request and recheck shortly.
      if (busy()) { schedule(busyRetryMs); return; }
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(() => { idle = undefined; start(); });
      } else start();
    }, delayMs);
  };
  return {
    request() {
      if (!permitted()) return;
      pending = true;
      if (!running && !actualPromise) schedule();
    },
    pause,
    stopAndDrain,
    invalidate,
    destroy() { destroyed = true; pause(); measured.clear(); },
  };
}

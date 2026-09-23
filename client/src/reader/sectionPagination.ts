import type { View } from 'foliate-js/view.js';
import type { FoliateBook } from './foliateTypes';
import type { PageRanges, ReadingSection } from '../types/epub';
import { waitForFrameOrTimeout } from '../utils/animationFrame';
import { measureReadingSectionPages } from '../utils/epubPageMap';
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
  canMeasure: () => boolean;
  onPages: (section: ReadingSection, ranges: PageRanges) => void;
  onInvalidate?: () => void;
  idleDelayMs?: number;
}

/** Current-section measurement is optional work, with independent book ownership. */
export function createSectionPagination(options: SectionPaginationOptions) {
  let generation = 0;
  let destroyed = false;
  let running = false;
  let pending = false;
  let layoutKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
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
    cancelSchedule();
  };
  const invalidate = () => {
    pause();
    measured.clear();
    layoutKey = undefined;
    options.onInvalidate?.();
  };
  const available = () => !destroyed && options.canMeasure() && document.visibilityState !== 'hidden';

  const run = async () => {
    if (running || !pending || !available()) return;
    pending = false;
    const snapshot = options.getSnapshot();
    if (snapshot.layoutKey !== layoutKey) {
      measured.clear();
      if (layoutKey !== undefined) options.onInvalidate?.();
      layoutKey = snapshot.layoutKey;
    }
    if (!snapshot.readingSections.some(section =>
      !measured.has(section.id) && snapshot.currentSectionIndex !== undefined &&
      section.sectionIndexes.includes(snapshot.currentSectionIndex))) return;
    const width = options.container.clientWidth;
    const height = options.container.clientHeight;
    if (width < 2 || height < 2) return;
    running = true;
    const diagnostics = beginReaderWork('measurement');
    const token = generation;
    let failed = false;
    const stopped = () => failed || token !== generation || !available() || options.getSnapshot().layoutKey !== snapshot.layoutKey;
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
        readingSections: snapshot.readingSections,
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
      await Promise.allSettled(navigation);
      diagnostics?.end();
      if (view) await settleDisposal();
      try { view?.close(); } finally {
        view?.remove();
        host.remove();
        try { book?.destroy(); } finally { diagnostics?.release(); }
      }
      running = false;
      if (pending && available()) schedule();
    }
  };
  const schedule = () => {
    cancelSchedule();
    timer = setTimeout(() => {
      timer = undefined;
      if (!available()) return;
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(() => { idle = undefined; void run(); });
      } else void run();
    }, options.idleDelayMs ?? 700);
  };
  return {
    request() {
      if (destroyed) return;
      pending = true;
      if (!running) schedule();
    },
    pause,
    invalidate,
    destroy() { destroyed = true; pause(); measured.clear(); },
  };
}

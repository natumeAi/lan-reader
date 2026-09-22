import type { View } from 'foliate-js/view.js';
import type { FoliateBook, NavigationTarget } from './foliateTypes';

export type TurnDirection = 'next' | 'prev';
export function adjacentPageTarget(view: View, book: FoliateBook, direction: TurnDirection): NavigationTarget | null {
  const index = view.lastLocation?.section?.current ?? 0;
  const delta = direction === 'next' ? 1 : -1;
  const total = view.renderer.pages - 2;
  const page = view.renderer.page + delta;
  if (page >= 1 && page <= total) return { index, anchor: total > 1 ? (page - 1) / (total - 1) : 0 };
  let adjacent = index + delta;
  while (book.sections[adjacent]?.linear === 'no') adjacent += delta;
  return book.sections[adjacent] ? { index: adjacent, anchor: delta > 0 ? 0 : 1 } : null;
}

/** Foreground and preview use the same public navigation, including FXL spreads. */
export async function turnAdjacentView(view: View, book: FoliateBook, direction: TurnDirection) {
  if (view.isFixedLayout) {
    const before = view.lastLocation?.cfi;
    await view.renderer[direction]();
    return view.lastLocation?.cfi !== before;
  }
  const target = adjacentPageTarget(view, book, direction);
  if (!target) return false;
  await view.renderer.goTo(target);
  return true;
}

interface PreviewSnapshot { key: string; cfi: string; page: number }
interface Options {
  container: HTMLElement;
  createBook: () => Promise<FoliateBook>;
  createView: () => View;
  configure: (view: View) => void;
  snapshot: () => PreviewSnapshot | null;
  available: (direction: TurnDirection) => boolean;
  onWorkStart: () => void;
  onWorkEnd: () => void;
}
interface Entry {
  key: string; direction: TurnDirection; stale: boolean; disposed: boolean;
  abort: AbortController;
  view?: View; book?: FoliateBook; ready: Promise<View | null>;
}
function paint(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    let frame = 0;
    const finish = () => { cancelAnimationFrame(frame); signal.removeEventListener('abort', finish); resolve(); };
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', finish, { once: true });
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}
function fontsReady(view: View, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', finish, { once: true });
    Promise.all(view.renderer.getContents().map(({ doc }) => doc.fonts.ready)).then(finish, error => {
      signal.removeEventListener('abort', finish); reject(error);
    });
  });
}

export function createPageTurnPreview(options: Options) {
  const entries = new Map<TurnDirection, Entry>();
  let active: Entry | undefined;
  let request = 0;
  let destroyed = false;
  let working = 0;
  let warmGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const stopWarm = () => {
    ++warmGeneration;
    clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    idle = undefined;
  };
  const hide = (entry: Entry) => {
    if (!entry.view) return;
    entry.view.style.visibility = 'hidden';
    entry.view.style.transform = '';
    entry.view.style.willChange = '';
  };
  const dispose = (entry: Entry) => {
    if (entry.disposed) return;
    entry.disposed = true; entry.stale = true;
    entry.abort.abort();
    hide(entry);
    // Detachment cancels a pending iframe load through the pinned compatibility
    // adapter. Resources are released after that actual work settles.
    entry.view?.remove();
    if (entries.get(entry.direction) === entry) entries.delete(entry.direction);
    void entry.ready.finally(() => {
      try { entry.view?.close(); } finally { entry.book?.destroy(); }
    });
  };
  const obtain = (direction: TurnDirection) => {
    const snapshot = options.snapshot();
    if (destroyed || !snapshot || !options.available(direction)) return null;
    const existing = entries.get(direction);
    if (existing && existing.key === snapshot.key && !existing.stale) return existing;
    if (existing) {
      if (active === existing) return null;
      dispose(existing);
    }
    const entry: Entry = { key: snapshot.key, direction, stale: false, disposed: false, abort: new AbortController(), ready: Promise.resolve(null) };
    entries.set(direction, entry);
    const stopped = () => destroyed || entry.stale || options.snapshot()?.key !== snapshot.key;
    working++; options.onWorkStart();
    entry.ready = (async () => {
      try {
        const book = await options.createBook(); entry.book = book;
        if (stopped()) return null;
        const view = options.createView(); entry.view = view;
        view.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;z-index:2;visibility:hidden;pointer-events:none;contain:layout paint;background:var(--reader-bg,#fff)';
        view.setAttribute('aria-hidden', 'true');
        options.container.append(view);
        await view.open(book);
        if (stopped()) return null;
        options.configure(view);
        const target = view.resolveNavigation(snapshot.cfi);
        if (!target) return null;
        await view.renderer.goTo(target);
        await fontsReady(view, entry.abort.signal);
        await paint(entry.abort.signal);
        if (stopped() || (!view.isFixedLayout && view.renderer.page !== snapshot.page)) return null;
        if (!await turnAdjacentView(view, book, direction)) return null;
        await fontsReady(view, entry.abort.signal);
        await paint(entry.abort.signal);
        return stopped() ? null : view;
      } catch { return null; }
      finally { working--; options.onWorkEnd(); }
    })();
    void entry.ready.then(view => { if (!view) dispose(entry); });
    return entry;
  };
  const cancel = () => {
    ++request;
    if (active) {
      hide(active);
      if (active.stale) dispose(active);
      active = undefined;
    }
  };
  return {
    get busy() { return working > 0; },
    async prepare(direction: TurnDirection) {
      stopWarm(); cancel();
      const token = request;
      const entry = obtain(direction);
      if (!entry) return null;
      const view = await entry.ready;
      if (token !== request || destroyed || entry.stale || !options.available(direction)) return null;
      if (view) active = entry;
      return view;
    },
    cancel,
    pauseWarm: stopWarm,
    invalidate(preserveActive = false) {
      stopWarm(); ++request;
      for (const entry of entries.values()) {
        entry.stale = true;
        if (preserveActive && entry === active) continue;
        dispose(entry);
      }
      if (!preserveActive) active = undefined;
    },
    warm() {
      stopWarm();
      if (destroyed || active) return;
      const token = warmGeneration;
      const run = async () => {
        for (const direction of ['next', 'prev'] as const) {
          if (destroyed || active || token !== warmGeneration) return;
          const entry = obtain(direction);
          if (entry) await entry.ready;
        }
      };
      timer = setTimeout(() => {
        if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(() => { idle = undefined; void run(); });
        else void run();
      }, 350);
    },
    destroy() {
      destroyed = true; stopWarm(); cancel();
      for (const entry of entries.values()) dispose(entry);
    },
  };
}

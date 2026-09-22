import type { EpubManager, EpubSection, EpubView, EpubObserver, ReaderRendition } from '../types/epub.js';
interface Anchor { relativeLeft: number; view: EpubView }
interface NavigationOptions {
  managerQueueTimeoutMs?: number;
  shouldContinue?: () => boolean;
  waitForCompletion?: boolean;
  onEnginePendingChange?: (pending: boolean) => void;
}
interface LayoutEnvironment {
  requestAnimationFrame?: typeof requestAnimationFrame;
  cancelAnimationFrame?: typeof cancelAnimationFrame;
  ResizeObserver?: new (callback: () => void) => EpubObserver;
  setTimeout?: (callback: () => void, delay: number) => number | ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: number | ReturnType<typeof setTimeout>) => void;
}
const DEFAULT_MANAGER_QUEUE_TIMEOUT_MS = 600;
const MAX_PREPEND_LAYOUT_FRAMES = 4;
const PREPEND_ANCHOR_SETTLE_MS = 3000;
const continuousManagerAnchorReleases = new WeakMap<EpubManager, () => void>();

export function releaseContinuousManagerLayoutAnchor(rendition: ReaderRendition | null | undefined) {
  const manager = rendition?.manager;
  if (manager && typeof manager === 'object') {
    const release = continuousManagerAnchorReleases.get(manager);
    release?.();
  }
}

function isHorizontalLtrContinuousManager(manager: EpubManager | undefined): manager is EpubManager {
  return manager?.name === 'continuous' &&
    manager?.settings?.axis === 'horizontal' &&
    (manager?.settings?.direction || 'ltr') === 'ltr';
}

function readManagerViews(manager: EpubManager | undefined) {
  return manager?.views?.all?.() || manager?.views?._views;
}

function managerQueueTimeout(options: NavigationOptions) {
  return Number.isFinite(options?.managerQueueTimeoutMs)
    ? Math.max(0, options.managerQueueTimeoutMs!)
    : DEFAULT_MANAGER_QUEUE_TIMEOUT_MS;
}

export function stabilizeContinuousManagerLayout(rendition: ReaderRendition | null | undefined, environment: LayoutEnvironment = {}) {
  const manager = rendition?.manager;
  const originalDisplay = manager?.display;
  const originalErase = manager?.erase;
  const originalNext = manager?.next;
  const originalPrepend = manager?.prepend;
  const originalPrev = manager?.prev;
  const requestFrame = environment.requestAnimationFrame || globalThis.requestAnimationFrame;
  const cancelFrame = environment.cancelAnimationFrame || globalThis.cancelAnimationFrame;
  const ResizeObserverClass = environment.ResizeObserver || (globalThis.ResizeObserver ? class {
    private observer: ResizeObserver;
    constructor(callback: () => void) { this.observer = new ResizeObserver(callback); }
    disconnect() { this.observer.disconnect(); }
    observe(element: import('../types/epub.js').EpubElement) { this.observer.observe(element as Element); }
  } : undefined);
  const setTimer = environment.setTimeout || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = environment.clearTimeout || ((timer) => clearTimeout(timer));
  if (!isHorizontalLtrContinuousManager(manager)) return () => {};

  const containerStyle = manager.container?.style;
  const previousOverflowAnchor = containerStyle?.overflowAnchor;
  if (containerStyle) {
    // ContinuousViewManager already compensates both prepends and trims.
    // Native scroll anchoring would apply the same offset a second time.
    containerStyle.overflowAnchor = 'none';
  }
  const restoreOverflowAnchor = () => {
    if (containerStyle?.overflowAnchor === 'none') {
      containerStyle.overflowAnchor = previousOverflowAnchor || '';
    }
  };

  if (typeof originalErase !== 'function' || typeof requestFrame !== 'function') {
    return restoreOverflowAnchor;
  }

  let pendingAnchor: Anchor | null = null;
  let stabilizationFrame: number | null = null;
  let prependAnchor: Anchor | null = null;
  let prependAnchorOwner: 'display' | 'navigation' | 'prepend' | null = null;
  let prependFallbackTimer: number | ReturnType<typeof setTimeout> | null = null;
  let prependReleaseTimer: number | ReturnType<typeof setTimeout> | null = null;
  let prependStabilizationFrame: number | null = null;
  let prependResizeObserver: EpubObserver | null = null;
  let disposed = false;
  const pendingLayoutFrames = new Map<number, () => void>();
  const restoreViewDisplays = new Map<EpubView, () => void>();
  let pendingPrependDisplays = 0;
  let navigationVersion = 0;

  const visibleAnchor = (removedView: EpubView | null, includeCollapsed = false): Anchor | null => {
    const scrollLeft = Number(manager.container?.scrollLeft);
    const views = readManagerViews(manager);
    if (!Number.isFinite(scrollLeft) || !Array.isArray(views)) return null;

    const candidates = views.filter((candidate) => candidate !== removedView);
    let view = candidates.find((candidate) => {
      const left = Number(candidate?.element?.offsetLeft);
      const width = Number(candidate?.element?.offsetWidth);
      return Number.isFinite(left) && Number.isFinite(width) && width > 0 &&
        left <= scrollLeft + 1 && left + width > scrollLeft + 1;
    });
    if (!view && includeCollapsed) {
      view = candidates.reduce<EpubView | undefined>((closest, candidate) => {
        const left = Number(candidate?.element?.offsetLeft);
        if (!Number.isFinite(left)) return closest;
        if (!closest) return candidate;
        const closestLeft = Number(closest.element?.offsetLeft);
        return Math.abs(left - scrollLeft) < Math.abs(closestLeft - scrollLeft)
          ? candidate
          : closest;
      }, undefined);
    }
    const left = Number(view?.element?.offsetLeft);
    return view && Number.isFinite(left)
      ? { relativeLeft: left - scrollLeft, view }
      : null;
  };

  const stabilizeAnchor = (anchor: Anchor | null) => {
    if (!anchor) return false;

    const views = readManagerViews(manager);
    if (!Array.isArray(views) || !views.includes(anchor.view)) return false;

    const anchorLeft = Number(anchor.view?.element?.offsetLeft);
    const scrollLeft = Number(manager.container?.scrollLeft);
    if (!Number.isFinite(anchorLeft) || !Number.isFinite(scrollLeft)) return false;

    const targetScrollLeft = Math.max(0, anchorLeft - anchor.relativeLeft);
    if (Math.abs(scrollLeft - targetScrollLeft) <= 1) return false;

    if (typeof manager.scrollTo === 'function') {
      manager.scrollTo(targetScrollLeft, 0, true);
    } else if (manager.container) {
      manager.container.scrollLeft = targetScrollLeft;
    }
    return true;
  };

  const refreshVisibleViews = () => {
    // A temporarily displaced target can be unloaded before it is anchored
    // again. Re-run visibility and publish the corrected location.
    let updateResult;
    try {
      updateResult = typeof manager.q?.enqueue === 'function'
        ? manager.q!.enqueue(() => disposed ? undefined : manager.update?.())
        : manager.update?.();
    } catch {
      updateResult = null;
    }
    void Promise.resolve(updateResult)
      .then(() => disposed ? undefined : rendition?.reportLocation?.())
      .catch(() => {});
  };

  const reportAnchoredLocation = () => {
    void Promise.resolve()
      .then(() => disposed ? undefined : rendition?.reportLocation?.())
      .catch(() => {});
  };

  const stabilizePendingAnchor = () => {
    stabilizationFrame = null;
    const anchor = pendingAnchor;
    pendingAnchor = null;
    stabilizeAnchor(anchor);
  };

  const releasePrependAnchor = () => {
    if (prependStabilizationFrame !== null && typeof cancelFrame === 'function') {
      cancelFrame(prependStabilizationFrame);
    }
    prependStabilizationFrame = null;
    prependAnchor = null;
    prependAnchorOwner = null;
    prependResizeObserver?.disconnect();
    if (prependFallbackTimer !== null) clearTimer(prependFallbackTimer);
    if (prependReleaseTimer !== null) clearTimer(prependReleaseTimer);
    prependFallbackTimer = null;
    prependReleaseTimer = null;
  };

  const releaseNavigationAnchor = () => {
    navigationVersion += 1;
    if (stabilizationFrame !== null && typeof cancelFrame === 'function') {
      cancelFrame(stabilizationFrame);
    }
    stabilizationFrame = null;
    pendingAnchor = null;
    releasePrependAnchor();
  };

  const schedulePrependRelease = () => {
    if (disposed) return;
    if (prependAnchorOwner === 'display') return;
    if (prependReleaseTimer !== null) clearTimer(prependReleaseTimer);
    // ContinuousViewManager can enqueue its 250 ms trim behind document
    // rendering and location work. Keep the destination anchor through that
    // delayed trim; explicit display/next/prev calls still release it at once.
    prependReleaseTimer = setTimer(
      releasePrependAnchor,
      PREPEND_ANCHOR_SETTLE_MS,
    );
  };

  const schedulePrependStabilization = () => {
    if (disposed || !prependAnchor) return;
    if (prependStabilizationFrame === null) {
      prependStabilizationFrame = requestFrame(() => {
        prependStabilizationFrame = null;
        if (stabilizeAnchor(prependAnchor)) {
          if (prependAnchorOwner === 'navigation') reportAnchoredLocation();
          else refreshVisibleViews();
        }
      });
    }
    schedulePrependRelease();
  };

  const scheduleFallbackStabilization = () => {
    if (disposed) return;
    if (prependFallbackTimer !== null) clearTimer(prependFallbackTimer);
    prependFallbackTimer = setTimer(() => {
      prependFallbackTimer = null;
      schedulePrependStabilization();
    }, 180);
  };

  const stabilizeDisplayedSectionOnScroll = () => {
    if (prependAnchorOwner === 'display') {
      schedulePrependStabilization();
    }
  };
  manager.container?.addEventListener?.('scroll', stabilizeDisplayedSectionOnScroll);
  continuousManagerAnchorReleases.set(manager, releaseNavigationAnchor);

  if (typeof ResizeObserverClass === 'function') {
    prependResizeObserver = new ResizeObserverClass(() => {
      // The manager's own counter-scroll owns the initial render. Correcting
      // against its provisional zero-width geometry causes a visible bounce.
      if (pendingPrependDisplays === 0) schedulePrependStabilization();
    });
  }

  const retainDisplayedSection = (section: EpubSection | string, version: number, relativeLeft = 0) => {
    if (version !== navigationVersion) return;

    const sectionIndex = Number(typeof section === 'string' ? undefined : section.index);
    const sectionHref = typeof section === 'string' ? section : section?.href;
    const views = readManagerViews(manager);
    const view = Array.isArray(views)
      ? views.find((candidate) => (
        candidate?.section === section ||
        (Number.isFinite(sectionIndex) && Number(candidate?.section?.index) === sectionIndex) ||
        (sectionHref && candidate?.section?.href === sectionHref)
      ))
      : null;
    if (!view?.element) return;

    prependAnchor = { relativeLeft, view };
    prependAnchorOwner = 'display';
    views?.forEach((candidate) => {
      if (candidate?.element) prependResizeObserver?.observe(candidate.element);
    });
    schedulePrependStabilization();
    scheduleFallbackStabilization();
  };

  const retainVisibleNavigationPosition = (version: number) => {
    if (version !== navigationVersion) return;

    const anchor = visibleAnchor(null, true);
    if (!anchor) return;

    prependAnchor = anchor;
    prependAnchorOwner = 'navigation';
    const views = readManagerViews(manager);
    if (Array.isArray(views)) {
      views.forEach((view) => {
        if (view?.element) prependResizeObserver?.observe(view.element);
      });
    }
    schedulePrependStabilization();
    scheduleFallbackStabilization();
  };

  const synchronizeManagerScrollAfterDisplay = (view: EpubView) => {
    const originalViewDisplay = view?.display;
    if (typeof originalViewDisplay !== 'function') return false;

    const restoreDisplay = () => {
      if (view.display === synchronizedDisplay) view.display = originalViewDisplay;
      restoreViewDisplays.delete(view);
    };
    const synchronizedDisplay = function synchronizedDisplay(this: EpubView, ...args: unknown[]) {
      let result;
      pendingPrependDisplays += 1;
      try {
        result = originalViewDisplay.apply(this, args);
      } catch (error) {
        pendingPrependDisplays -= 1;
        restoreDisplay();
        if (pendingPrependDisplays === 0) scheduleFallbackStabilization();
        throw error;
      }

      return Promise.resolve(result)
        .then((value) => new Promise((resolve) => {
          if (disposed) { resolve(value); return; }
          const waitForCommittedLayout = (attempt: number): void => {
            const frameId = requestFrame(() => {
              pendingLayoutFrames.delete(frameId);
              if (disposed) { resolve(value); return; }
              // The view's display promise can resolve before Chromium commits
              // its final width. Let that layout land before check() recurses
              // into update(), or the still-visible illustration can be queued
              // for destruction using provisional zero-width geometry.
              const viewWidth = Number(view?.element?.offsetWidth);
              const scrollLeft = Number(manager.container?.scrollLeft);
              const anchorLeft = Number(prependAnchor?.view?.element?.offsetLeft);
              const anchorTarget = Math.max(0, anchorLeft - (prependAnchor?.relativeLeft ?? Number.NaN));
              const anchorSettled = !prependAnchor || (
                Number.isFinite(anchorTarget) &&
                Number.isFinite(scrollLeft) &&
                Math.abs(scrollLeft - anchorTarget) <= 1
              );
              if (
                (viewWidth <= 0 || !anchorSettled) &&
                attempt < MAX_PREPEND_LAYOUT_FRAMES
              ) {
                waitForCommittedLayout(attempt + 1);
                return;
              }
              if (!anchorSettled) stabilizeAnchor(prependAnchor);
              const synchronizedScrollLeft = Number(manager.container?.scrollLeft);
              if (Number.isFinite(synchronizedScrollLeft)) {
                manager.scrollLeft = synchronizedScrollLeft;
              }
              resolve(value);
            });
            // Teardown must also release the promise awaited by epub.js's queue.
            pendingLayoutFrames.set(frameId, () => resolve(value));
          };
          waitForCommittedLayout(1);
        }))
        .finally(() => {
          pendingPrependDisplays -= 1;
          restoreDisplay();
          if (pendingPrependDisplays === 0) scheduleFallbackStabilization();
        });
    };

    restoreViewDisplays.set(view, restoreDisplay);
    view.display = synchronizedDisplay;
    return true;
  };

  const stabilizedErase = function stabilizedErase(this: EpubManager, view: EpubView, ...args: [above?: boolean | EpubView[]]) {
    const retainedPrependAnchor = prependAnchor?.view !== view ? prependAnchor : null;
    pendingAnchor ||= retainedPrependAnchor || visibleAnchor(view);
    const result = originalErase!.call(this, view, ...args);
    if (pendingAnchor && stabilizationFrame === null) {
      stabilizationFrame = requestFrame(stabilizePendingAnchor);
    }
    return result;
  };

  // A later navigation owns a new destination and must not be pulled back by
  // resize notifications from the previous prepend cascade.
  const displayAfterReleasingPrependAnchor = function displayAfterReleasingPrependAnchor(
    this: EpubManager, ...args: [section: EpubSection | string, target?: string]
  ) {
    releaseNavigationAnchor();
    const version = navigationVersion;
    const [section, target] = args;
    const normalizedTarget = typeof target === 'string' ? target.trim() : '';
    const sectionStart = !normalizedTarget || (
      !normalizedTarget.startsWith('epubcfi(') && !normalizedTarget.includes('#')
    );
    const result = originalDisplay!.apply(this, args);
    if (sectionStart) retainDisplayedSection(section, version);
    void Promise.resolve(result)
      .then(() => {
        if (sectionStart) {
          retainDisplayedSection(section, version);
          return;
        }
        const anchor = visibleAnchor(null, true);
        if (version !== navigationVersion || !anchor) return;
        prependAnchor = anchor;
        prependAnchorOwner = 'display';
        schedulePrependStabilization();
        scheduleFallbackStabilization();
      })
      .catch(() => {});
    return result;
  };

  const nextAfterReleasingPrependAnchor = function nextAfterReleasingPrependAnchor(this: EpubManager, ...args: []) {
    releaseNavigationAnchor();
    const version = navigationVersion;
    const result = originalNext!.apply(this, args);
    retainVisibleNavigationPosition(version);
    return result;
  };

  const prevAfterReleasingPrependAnchor = function prevAfterReleasingPrependAnchor(this: EpubManager, ...args: []) {
    releaseNavigationAnchor();
    const version = navigationVersion;
    const result = originalPrev!.apply(this, args);
    retainVisibleNavigationPosition(version);
    return result;
  };

  const stabilizedPrepend = function stabilizedPrepend(this: EpubManager, section: EpubSection, ...args: []) {
    // Reader styles can expand a newly prepended view after epub.js has
    // already counter-scrolled its provisional width. Keep the old visible
    // view fixed until that delayed resize settles.
    if (!prependAnchor) {
      prependAnchor = visibleAnchor(null, true);
      prependAnchorOwner = prependAnchor ? 'prepend' : null;
      if (prependAnchor?.view?.element) {
        prependResizeObserver?.observe(prependAnchor.view.element);
      }
    }
    const view = originalPrepend!.call(this, section, ...args);
    const waitsForInitialDisplay = synchronizeManagerScrollAfterDisplay(view);
    if (view?.element) prependResizeObserver?.observe(view.element);
    if (!waitsForInitialDisplay) scheduleFallbackStabilization();
    return view;
  };

  if (typeof originalDisplay === 'function') {
    manager.display = displayAfterReleasingPrependAnchor;
  }
  manager.erase = stabilizedErase;
  if (typeof originalNext === 'function') manager.next = nextAfterReleasingPrependAnchor;
  if (typeof originalPrepend === 'function') manager.prepend = stabilizedPrepend;
  if (typeof originalPrev === 'function') manager.prev = prevAfterReleasingPrependAnchor;
  return () => {
    disposed = true;
    releaseNavigationAnchor();
    for (const [frameId, finish] of pendingLayoutFrames) {
      cancelFrame?.(frameId);
      finish();
    }
    pendingLayoutFrames.clear();
    for (const restore of restoreViewDisplays.values()) restore();
    restoreViewDisplays.clear();
    manager.container?.removeEventListener?.('scroll', stabilizeDisplayedSectionOnScroll);
    if (continuousManagerAnchorReleases.get(manager) === releaseNavigationAnchor) {
      continuousManagerAnchorReleases.delete(manager);
    }
    if (manager.display === displayAfterReleasingPrependAnchor) {
      manager.display = originalDisplay;
    }
    if (manager.erase === stabilizedErase) manager.erase = originalErase;
    if (manager.next === nextAfterReleasingPrependAnchor) manager.next = originalNext;
    if (manager.prepend === stabilizedPrepend) manager.prepend = originalPrepend;
    if (manager.prev === prevAfterReleasingPrependAnchor) manager.prev = originalPrev;
    if (stabilizationFrame !== null && typeof cancelFrame === 'function') {
      cancelFrame(stabilizationFrame);
    }
    stabilizationFrame = null;
    pendingAnchor = null;
    restoreOverflowAnchor();
  };
}

export async function readRenditionLocation(rendition: ReaderRendition | null | undefined) {
  const location = rendition?.currentLocation?.();
  return Promise.resolve(location);
}

function enqueueContinuousManagerQueueBarrier(manager: EpubManager | undefined) {
  if (typeof manager?.q?.enqueue !== 'function') return null;
  return Promise.resolve()
    .then(() => manager.q!.enqueue(() => undefined))
    .then(() => true, () => false);
}

function waitForQueueBarrier(queueBarrier: Promise<boolean>, timeoutMs: number) {
  let timeoutId: number | ReturnType<typeof setTimeout>;
  const timeoutResult = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([queueBarrier, timeoutResult])
    .finally(() => clearTimeout(timeoutId));
}

export function waitForContinuousManagerQueue(
  manager: EpubManager | undefined,
  timeoutMs = DEFAULT_MANAGER_QUEUE_TIMEOUT_MS,
) {
  const queueBarrier = enqueueContinuousManagerQueueBarrier(manager);
  return queueBarrier
    ? waitForQueueBarrier(queueBarrier, timeoutMs)
    : Promise.resolve(false);
}

export async function displayRenditionTarget(rendition: ReaderRendition | null | undefined, target: string | number | null | undefined, options: NavigationOptions = {}) {
  if (!target || typeof rendition?.display !== 'function') return false;

  const manager = rendition.manager;
  const managerQueueTimeoutMs = managerQueueTimeout(options);
  const shouldContinue = typeof options.shouldContinue === 'function'
    ? options.shouldContinue
    : () => true;
  if (manager?.name === 'continuous') {
    // display() has its own rendition queue but mutates the same views as the
    // continuous manager queue. Let pending preload/trim work finish first.
    await waitForContinuousManagerQueue(manager, managerQueueTimeoutMs);
  }

  if (!shouldContinue()) return false;

  await Promise.resolve(rendition.display(target));
  return true;
}

export async function navigateBasicRenditionPage(rendition: ReaderRendition | null | undefined, direction: 'next' | 'prev', options: NavigationOptions = {}) {
  const manager = rendition?.manager;
  const navigate = direction === 'next' ? rendition?.next : rendition?.prev;
  const managerQueueTimeoutMs = managerQueueTimeout(options);
  const shouldContinue = typeof options.shouldContinue === 'function'
    ? options.shouldContinue
    : () => true;
  const firstView = manager?.views?.first?.();
  const scrollLeft = Number(manager?.container?.scrollLeft);
  const shouldSettleContinuousPrevious = direction === 'prev' &&
    isHorizontalLtrContinuousManager(manager);
  const canLoadPreviousView = shouldSettleContinuousPrevious &&
    Number.isFinite(scrollLeft) &&
    Math.abs(scrollLeft) <= 1 &&
    Boolean(firstView?.section?.prev?.());
  const firstSectionIndex = canLoadPreviousView
    ? Number(firstView?.section?.index)
    : Number.NaN;
  const originLeft = Number(firstView?.element?.offsetLeft);
  const originRelativeLeft = originLeft - scrollLeft;
  const pageWidth = Number(manager?.layout?.pageWidth) * Number(manager?.layout?.divisor || 1) ||
    Number(manager?.layout?.delta);

  const navigateIfCurrent = async (canMove = shouldContinue) => {
    if (!shouldContinue()) return;
    options.onEnginePendingChange?.(true);
    try {
      const managerNavigate = direction === 'next' ? manager?.next : manager?.prev;
      if (rendition?.q && managerNavigate) {
        // Rendition.prev/next binds an unguarded manager method before enqueueing.
        // Check ownership inside that queue so cancellation also covers waiting
        // behind an earlier display, not just the time the input was accepted.
        await rendition.q.enqueue(() => {
          if (shouldContinue() && canMove()) return managerNavigate.call(manager);
          return undefined;
        });
        if (shouldContinue()) void Promise.resolve(rendition.reportLocation?.()).catch(() => {});
        return;
      }
      if (canMove()) return await navigate?.call(rendition);
    } finally {
      options.onEnginePendingChange?.(false);
    }
  };

  const result = await navigateIfCurrent();
  let queueBarrier = null;
  let queueSettled = false;
  if (shouldSettleContinuousPrevious) {
    queueBarrier = enqueueContinuousManagerQueueBarrier(manager);
    if (queueBarrier) {
      queueSettled = await waitForQueueBarrier(queueBarrier, managerQueueTimeoutMs);
    }
  }
  if (!Number.isInteger(firstSectionIndex)) return result;

  const completePreviousTurn = async () => {
    if (!shouldContinue()) return { completed: false, result: undefined };
    const canComplete = () => {
      if (!shouldContinue()) return false;
      const predecessor = manager?.views?.first?.();
      const nextFirstSectionIndex = Number(predecessor?.section?.index);
      if (!Number.isInteger(nextFirstSectionIndex) || nextFirstSectionIndex >= firstSectionIndex) return false;
      // Insertion precedes iframe display. A zero-width predecessor is neither
      // usable nor evidence that the requested movement has happened.
      if (predecessor?.displayed === false || (predecessor?.element && !(Number(predecessor.element.offsetWidth) > 0))) return false;
      const liveScroll = Number(manager?.container?.scrollLeft);
      if (!(liveScroll > 1)) return false;
      if (Number.isFinite(originRelativeLeft)) {
        if (!readManagerViews(manager)?.includes(firstView!)) return false;
        const livePageWidth = Number(manager?.layout?.pageWidth) * Number(manager?.layout?.divisor || 1) ||
          Number(manager?.layout?.delta);
        if (Number.isFinite(pageWidth) && livePageWidth !== pageWidth) return false;
        const movement = Number(firstView?.element?.offsetLeft) - liveScroll - originRelativeLeft;
        // A preload can finish before the first queued prev executes. Only an
        // unchanged content-relative origin permits the supplementary turn.
        return Number.isFinite(movement) && Math.abs(movement) <= 1;
      }
      return true;
    };
    if (!canComplete()) return { completed: false, result: undefined };

    // At the left edge epub.js uses the first prev() call to prepend a view,
    // then reports the unchanged page. Complete the requested turn now that
    // the predecessor is present instead of requiring a second key press.
    const nextResult = await navigateIfCurrent(canComplete);
    await waitForContinuousManagerQueue(manager, managerQueueTimeoutMs);
    return { completed: true, result: nextResult };
  };

  const completion = await completePreviousTurn();

  if (!completion.completed && !queueSettled && queueBarrier) {
    // A timeout keeps input responsive, but the queued prepend may still be
    // valid. Finish this same turn when it settles, provided the reader has
    // not moved in the meantime.
    const lateCompletion = queueBarrier.then((settled) => (
      settled ? completePreviousTurn() : null
    )).catch(() => null);
    // The controller holds exclusive input ownership until completion or its
    // session-recovery deadline. Standalone callers retain the bounded barrier.
    if (options.waitForCompletion) await lateCompletion;
  }

  if (options.waitForCompletion && Number.isFinite(originRelativeLeft) && Number.isFinite(pageWidth)) {
    const movement = Number(firstView?.element?.offsetLeft) - Number(manager?.container?.scrollLeft) - originRelativeLeft;
    if (Math.abs(movement - pageWidth) > 1) return false;
  }

  return completion.completed ? completion.result : result;
}

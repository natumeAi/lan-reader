import type { EpubManager, EpubView, EpubElement, EpubScroller, EpubStyle, EpubAnimation, EpubObserver, ReaderRendition } from '../types/epub.js';
import type { DebugConfig } from './pageTurnDiagnostics.js';
type Backend = 'scroll' | 'compositor';
export interface TurnResult { status: 'completed' | 'cancelled' | 'unavailable'; backend: Backend; reason?: string }
interface Unavailable { available: false; reason: string }
interface ScrollCoordinates { maxScroll: number; direction: string; rtlScrollType?: string }
interface ScrollGeometry { contentWidth: number; maxScroll: number; scrollLeft: number }
type StyledElement = EpubElement & { style: EpubStyle };
interface ScrollCapability extends ScrollCoordinates {
  available: true; reason: null; manager: EpubManager; scroller: EpubScroller & { style: EpubStyle };
  pageWidth: number; origin: number; canPrevious: boolean; canNext: boolean;
}
interface Geometry { bottom: number; height: number; left: number; right: number; top: number; width: number }
interface ElementSnapshot { element: StyledElement; transform: string; willChange: string }
interface ViewSnapshot extends ElementSnapshot { geometry: Geometry; view: EpubView }
interface CompositorCapability { available: true; edgeSnapshot: ElementSnapshot | null; reason: null; views: ViewSnapshot[] }
interface AnimationOptions { action?: string; duration?: number; inputTime?: number }
interface AdapterSession extends ScrollCapability {
  animationTargetOffset: number | null; animations: EpubAnimation[]; backend: Backend;
  cancellationOutcome: TurnResult | null; cancellationPromise: Promise<TurnResult>; cancellationSettled: boolean;
  contentWidth: number; stableCfi: string | null; edgeElement: StyledElement | null;
  edgeDirection: 'next' | 'prev' | null; edgeOffset: number | null; edgeSnapshot: ElementSnapshot | null;
  boundaryOffset: number; commitFrameId: number | null; diagnosticAction: string; diagnosticRecordId: number | null;
  generation: number; layoutAnchors: { element: StyledElement; left: number; offsetLeft: number }[];
  committedDelta: number | null;
  physicalScroll: number; previousEdgeTransform: string; previousEdgeWillChange: string; previousTransform: string;
  resolveCancellation: (result: TurnResult) => void; resolveCommit: ((result: TurnResult) => void) | null;
  stylesPrepared: boolean; views: ViewSnapshot[]; viewportWidth: number; visualOffset: number;
  watchers: { disconnect: () => void }[];
}
interface AdapterEnvironment {
  requestAnimationFrame?: typeof requestAnimationFrame; cancelAnimationFrame?: typeof cancelAnimationFrame;
  now?: () => number; MutationObserver?: (new (callback: () => void) => { observe: (element: EpubElement, options: MutationObserverInit) => void; disconnect: () => void }) | null; ResizeObserver?: (new (callback: () => void) => EpubObserver) | null;
  debugConfig?: DebugConfig; diagnostics?: Pick<ReturnType<typeof createPageTurnDiagnostics>, 'begin' | 'cancel' | 'destroy' | 'finish' | 'frame' | 'markAnimationStart' | 'markVisualUpdate'>;
  timeline?: { currentTime: number | null };
}
import {
  clampDragDistance,
  dampBoundaryDistance,
  easeOutCubic,
  sampleEaseOutCubicKeyframes,
} from './pageTurnGesture.js';
import {
  createPageTurnDiagnostics,
  readPageTurnDebugConfig,
} from './pageTurnDiagnostics.js';

const ALIGNMENT_EPSILON_PX = 1;
const DEFAULT_PAGE_TURN_BACKEND = 'compositor';
// epub.js sizes each view to the full section, which can be hundreds of pages
// wide. Promoting more than a few viewport surfaces can rebuild a very large
// GPU layer even when only one page is visible.
const MAX_COMPOSITOR_VIEWPORT_AREAS = 4;
const SUPPORTED_RTL_SCROLL_TYPES = new Set(['default', 'negative']);
const TRANSIENT_COMPOSITOR_REASONS = new Set(['geometry', 'views', 'view-disconnected']);
const EASE_OUT_CUBIC_SAMPLES = sampleEaseOutCubicKeyframes();

function unavailable(reason: string): Unavailable {
  return { available: false, reason };
}

function selectBackend({ compositor, forceBackend }: { compositor: CompositorCapability | Unavailable; forceBackend: Backend | null }): Backend | null {
  if (forceBackend === 'scroll') return 'scroll';
  if (forceBackend === 'compositor') return compositor.available ? 'compositor' : null;
  return DEFAULT_PAGE_TURN_BACKEND === 'compositor' && compositor.available
    ? 'compositor'
    : 'scroll';
}

export function configureEpubPageGap(rendition: ReaderRendition | null | undefined, pageGap: number) {
  const manager = rendition?.manager;
  const gap = Number(pageGap);
  if (
    !manager?.settings ||
    typeof manager.updateLayout !== 'function' ||
    !Number.isFinite(gap) ||
    gap < 0
  ) {
    return false;
  }

  manager.settings.gap = gap;
  manager.updateLayout();
  return true;
}

export function toLogicalScroll({
  scrollLeft,
  maxScroll,
  direction,
  rtlScrollType,
}: ScrollCoordinates & { scrollLeft: number }) {
  if (direction === 'ltr') return scrollLeft;
  if (direction === 'rtl' && rtlScrollType === 'default') {
    return maxScroll - scrollLeft;
  }
  if (direction === 'rtl' && rtlScrollType === 'negative') {
    return -scrollLeft;
  }
  return Number.NaN;
}

export function toPhysicalScroll({
  logicalScroll,
  maxScroll,
  direction,
  rtlScrollType,
}: ScrollCoordinates & { logicalScroll: number }) {
  if (direction === 'ltr') return logicalScroll;
  if (direction === 'rtl' && rtlScrollType === 'default') {
    return maxScroll - logicalScroll;
  }
  if (direction === 'rtl' && rtlScrollType === 'negative') {
    return -logicalScroll;
  }
  return Number.NaN;
}

export function createEpubPageTurnAdapter(rendition: ReaderRendition, environment: AdapterEnvironment = {}) {
  const requestFrame =
    environment.requestAnimationFrame || globalThis.requestAnimationFrame.bind(globalThis);
  const cancelFrame =
    environment.cancelAnimationFrame || globalThis.cancelAnimationFrame.bind(globalThis);
  const now = environment.now || (() => globalThis.performance.now());
  const MutationObserverImpl = environment.MutationObserver ?? (globalThis.MutationObserver ? class {
    private observer: MutationObserver;
    constructor(callback: () => void) { this.observer = new MutationObserver(callback); }
    disconnect() { this.observer.disconnect(); }
    observe(element: EpubElement, options: MutationObserverInit) { this.observer.observe(element as Node, options); }
  } : undefined);
  const ResizeObserverImpl = environment.ResizeObserver ?? (globalThis.ResizeObserver ? class {
    private observer: ResizeObserver;
    constructor(callback: () => void) { this.observer = new ResizeObserver(callback); }
    disconnect() { this.observer.disconnect(); }
    observe(element: EpubElement) { this.observer.observe(element as Element); }
  } : undefined);
  const debugConfig = environment.debugConfig || readPageTurnDebugConfig();
  const diagnostics = environment.diagnostics || createPageTurnDiagnostics({
    enabled: debugConfig.enabled,
    cancelAnimationFrame: cancelFrame,
    now,
    requestAnimationFrame: requestFrame,
  });
  let animation: { frameId: number; diagnosticRecordId: number | null; resolve: (result: TurnResult) => void } | null = null;
  let compositorDisabledReason: string | null = null;
  let destroyed = false;
  let enhancedDisabledReason: string | null = null;
  let recoveryCfi: string | null = null;
  let session: AdapterSession | null = null;
  let sessionGeneration = 0;

  function result(status: TurnResult['status'], backend: Backend = 'scroll', reason: string | null = null): TurnResult {
    return reason ? { status, backend, reason } : { status, backend };
  }

  function clearDiagnosticReference(recordId: number | null) {
    if (session?.diagnosticRecordId === recordId) {
      session.diagnosticRecordId = null;
    }
  }

  function finishDiagnostic(recordId: number | null, endTime = now()) {
    if (recordId === null || recordId === undefined) return;
    clearDiagnosticReference(recordId);
    diagnostics.finish(recordId, endTime);
  }

  function cancelDiagnostic(recordId: number | null, reason = 'cancelled', endTime = now()) {
    if (recordId === null || recordId === undefined) return;
    clearDiagnosticReference(recordId);
    diagnostics.cancel(recordId, reason, endTime);
  }

  function stopAnimation(reason = 'cancelled') {
    if (!animation) return;
    const activeAnimation = animation;
    cancelFrame(activeAnimation.frameId);
    animation = null;
    cancelDiagnostic(activeAnimation.diagnosticRecordId, reason);
    activeAnimation.resolve(result('cancelled'));
  }

  function forcedBackend() {
    return debugConfig.enabled ? debugConfig.forceBackend : null;
  }

  function compositorFailureBlocksRetry() {
    return compositorDisabledReason !== null &&
      !TRANSIENT_COMPOSITOR_REASONS.has(compositorDisabledReason);
  }

  function inspectScrollCapability(): ScrollCapability | Unavailable {
    const manager = rendition?.manager;
    if (!manager || manager.name !== 'continuous') return unavailable('manager');
    if (!manager.isPaginated) return unavailable('paginated');
    if (manager.settings?.axis !== 'horizontal') return unavailable('axis');
    if (!manager.settings?.snap || !manager.snapper) return unavailable('snap');

    const scroller = manager.container;
    if (!scroller || !scroller.style || !Number.isFinite(Number(scroller.scrollLeft))) {
      return unavailable('scroller');
    }

    const pageWidth = Number(manager.layout?.pageWidth) * Number(manager.layout?.divisor || 1);
    if (!Number.isFinite(pageWidth) || pageWidth <= 0) return unavailable('page-width');

    const direction = manager.settings?.direction || 'ltr';
    if (direction !== 'ltr' && direction !== 'rtl') return unavailable('direction');

    const rtlScrollType = manager.settings?.rtlScrollType;
    if (direction === 'rtl' && !SUPPORTED_RTL_SCROLL_TYPES.has(rtlScrollType || '')) {
      return unavailable('rtl-scroll-type');
    }

    const viewportWidth = Number(scroller.clientWidth || scroller.offsetWidth);
    const contentWidth = Number(scroller.scrollWidth);
    const maxScroll = Math.max(0, contentWidth - viewportWidth);
    if (!Number.isFinite(maxScroll)) return unavailable('scroller');

    const logicalScroll = toLogicalScroll({
      scrollLeft: Number(scroller.scrollLeft),
      maxScroll,
      direction,
      rtlScrollType,
    });
    if (!Number.isFinite(logicalScroll)) return unavailable('direction');

    const origin = Math.round(logicalScroll / pageWidth) * pageWidth;
    if (Math.abs(logicalScroll - origin) > ALIGNMENT_EPSILON_PX) {
      return unavailable('alignment');
    }

    return {
      available: true,
      reason: null,
      manager,
      scroller: scroller as EpubScroller & { style: EpubStyle },
      pageWidth,
      origin,
      maxScroll,
      direction,
      rtlScrollType,
      canPrevious: origin - pageWidth >= -ALIGNMENT_EPSILON_PX,
      canNext: origin + pageWidth <= maxScroll + ALIGNMENT_EPSILON_PX,
    };
  }

  function readViewGeometry(element: EpubElement | undefined): Geometry | null {
    if (typeof element?.getBoundingClientRect !== 'function') return null;
    try {
      const rect = element.getBoundingClientRect();
      const geometry = {
        bottom: Number(rect?.bottom),
        height: Number(rect?.height),
        left: Number(rect?.left),
        right: Number(rect?.right),
        top: Number(rect?.top),
        width: Number(rect?.width),
      };
      if (
        !Object.values(geometry).every(Number.isFinite) ||
        geometry.width <= 0 ||
        geometry.height <= 0 ||
        geometry.right <= geometry.left ||
        geometry.bottom <= geometry.top
      ) {
        return null;
      }
      return geometry;
    } catch {
      return null;
    }
  }

  function captureLayoutAnchors(manager: EpubManager) {
    let displayedViews;
    try {
      displayedViews = manager?.views?.displayed?.call(manager.views);
    } catch {
      return [];
    }
    if (!Array.isArray(displayedViews)) return [];
    const viewportLeft = Number(manager.container?.getBoundingClientRect?.().left) || 0;

    return displayedViews.flatMap((view) => {
      const element = view?.element;
      const geometry = readViewGeometry(element);
      return geometry && element?.style ? [{
        element: element as StyledElement, left: geometry.left, offsetLeft: Number(element.offsetLeft),
        visible: geometry.left <= viewportLeft + 1 && geometry.right > viewportLeft + 1,
      }] : [];
    }).sort((first, second) => Number(second.visible) - Number(first.visible));
  }

  function isStableAtVisualPage(activeSession: AdapterSession, pageDelta: number) {
    if (!activeSession?.layoutAnchors?.length) return false;

    // At the left preload edge epub.js can prepend a view and counter-scroll
    // by the same width. The destination stays visible even though its new
    // absolute scroll coordinate no longer matches the session's old target.
    const targetLogical = activeSession.origin + pageDelta * activeSession.pageWidth;
    const originPhysical = toPhysicalScroll({
      logicalScroll: activeSession.origin,
      maxScroll: activeSession.maxScroll,
      direction: activeSession.direction,
      rtlScrollType: activeSession.rtlScrollType,
    });
    const targetPhysical = toPhysicalScroll({
      logicalScroll: targetLogical,
      maxScroll: activeSession.maxScroll,
      direction: activeSession.direction,
      rtlScrollType: activeSession.rtlScrollType,
    });
    const expectedLeftDelta = originPhysical - targetPhysical;
    if (!Number.isFinite(expectedLeftDelta)) return false;

    return activeSession.layoutAnchors.some((anchor) => {
      if (anchor.element?.isConnected === false) return false;
      const geometry = readViewGeometry(anchor.element);
      return geometry &&
        Math.abs((geometry.left - anchor.left) - expectedLeftDelta) <=
          ALIGNMENT_EPSILON_PX;
    });
  }

  function inspectCompositor(capability: ScrollCapability, edgeElement: StyledElement | null = null, options: { ignoreSurfaceBudget?: boolean } = {}): CompositorCapability | Unavailable {
    const views = capability.manager?.views;
    let displayedViews;
    try {
      displayedViews = views?.displayed?.call(views);
    } catch {
      return unavailable('views');
    }
    if (!Array.isArray(displayedViews) || displayedViews.length === 0) {
      return unavailable('views');
    }

    const viewSnapshots: ViewSnapshot[] = [];
    const viewElements = new Set();
    for (const view of displayedViews) {
      const element = view?.element;
      if (!element?.style || !element.classList?.contains('epub-view') || viewElements.has(element)) {
        return unavailable('views');
      }
      if (!element.isConnected) return unavailable('view-disconnected');
      if (element.style?.transform?.trim()) return unavailable('view-transform');
      if (
        typeof element.animate !== 'function' ||
        typeof element.getAnimations !== 'function'
      ) {
        return unavailable('waapi');
      }

      let activeAnimations;
      try {
        activeAnimations = element.getAnimations();
      } catch {
        return unavailable('view-animation');
      }
      if (!Array.isArray(activeAnimations) || activeAnimations.length > 0) {
        return unavailable('view-animation');
      }

      const geometry = readViewGeometry(element);
      if (!geometry) return unavailable('geometry');
      viewElements.add(element);
      viewSnapshots.push({
        element: element as StyledElement,
        geometry,
        transform: element.style.transform || '',
        view,
        willChange: element.style.willChange || '',
      });
    }

    if (options.ignoreSurfaceBudget !== true) {
      const viewportWidth = Number(
        capability.scroller.clientWidth || capability.scroller.offsetWidth,
      );
      const viewportHeight = Number(
        capability.scroller.clientHeight || capability.scroller.offsetHeight,
      );
      if (
        !Number.isFinite(viewportWidth) ||
        viewportWidth <= 0 ||
        !Number.isFinite(viewportHeight) ||
        viewportHeight <= 0
      ) {
        return unavailable('viewport-geometry');
      }

      const viewportAreas = viewSnapshots.reduce((total, snapshot) => (
        total +
        (snapshot.geometry.width / viewportWidth) *
        (snapshot.geometry.height / viewportHeight)
      ), 0);
      if (
        !Number.isFinite(viewportAreas) ||
        viewportAreas > MAX_COMPOSITOR_VIEWPORT_AREAS
      ) {
        return unavailable('surface-area');
      }
    }

    if (edgeElement && typeof edgeElement.animate !== 'function') {
      return unavailable('waapi');
    }

    return {
      available: true,
      edgeSnapshot: edgeElement ? {
        element: edgeElement,
        transform: edgeElement.style.transform || '',
        willChange: edgeElement.style.willChange || '',
      } : null,
      reason: null,
      views: viewSnapshots,
    };
  }

  function validateCompositorSession(activeSession: AdapterSession) {
    const views = activeSession?.manager?.views;
    let displayedViews;
    try {
      displayedViews = views?.displayed?.call(views);
    } catch {
      return 'views';
    }
    if (
      !Array.isArray(displayedViews) ||
      displayedViews.length !== activeSession.views.length ||
      displayedViews.some((view, index) => (
        view !== activeSession.views[index]!.view ||
        view?.element !== activeSession.views[index]!.element
      ))
    ) {
      return 'views';
    }

    if (activeSession.views.some(({ element }) => !element?.isConnected)) {
      return 'view-disconnected';
    }

    const viewportWidth = Number(
      activeSession.scroller.clientWidth || activeSession.scroller.offsetWidth,
    );
    const contentWidth = Number(activeSession.scroller.scrollWidth);
    const maximumTransformOverflow = Math.max(
      Math.abs(activeSession.visualOffset || 0),
      Math.abs(activeSession.animationTargetOffset || 0),
    );
    const contentWidthDelta = contentWidth - activeSession.contentWidth;
    if (
      !Number.isFinite(viewportWidth) ||
      !Number.isFinite(contentWidth) ||
      Math.abs(viewportWidth - activeSession.viewportWidth) > ALIGNMENT_EPSILON_PX ||
      contentWidthDelta < -ALIGNMENT_EPSILON_PX ||
      contentWidthDelta > maximumTransformOverflow + ALIGNMENT_EPSILON_PX
    ) {
      return 'geometry';
    }

    const currentGeometries = activeSession.views.map(({ element }) => (
      readViewGeometry(element)
    ));
    if (currentGeometries.some((geometry) => !geometry)) return 'geometry';
    const firstSnapshot = activeSession.views[0]!.geometry;
    const firstCurrent = currentGeometries[0]!;
    const changed = currentGeometries.some((geometry, index) => {
      if (!geometry) return true;
      const snapshot = activeSession.views[index]!.geometry;
      return [
        [snapshot.width, geometry.width],
        [snapshot.height, geometry.height],
        [snapshot.top, geometry.top],
        [snapshot.bottom, geometry.bottom],
        [snapshot.left - firstSnapshot.left, geometry.left - firstCurrent.left],
        [snapshot.right - firstSnapshot.right, geometry.right - firstCurrent.right],
      ].some(([before, after]) => (
        Math.abs(before! - after!) > ALIGNMENT_EPSILON_PX
      ));
    });
    return changed ? 'geometry' : null;
  }

  function inspect() {
    if (enhancedDisabledReason) return unavailable(enhancedDisabledReason);
    const capability = inspectScrollCapability();
    if (!capability.available) return capability;
    if (forcedBackend() === 'compositor') {
      if (compositorFailureBlocksRetry()) return unavailable(compositorDisabledReason!);
      const compositor = inspectCompositor(capability, null, {
        ignoreSurfaceBudget: true,
      });
      if (!compositor.available) return unavailable(compositor.reason);
    }
    return capability;
  }

  // A snapshot belongs to one synchronous update only. Read again on the next
  // frame so epub.js prepend/trim and reflow can rebase the retained anchor.
  function readScrollGeometry(activeSession: AdapterSession): ScrollGeometry {
    const scroller = activeSession.scroller;
    const contentWidth = Number(scroller.scrollWidth);
    const viewportWidth = Number(scroller.clientWidth || scroller.offsetWidth);
    return {
      contentWidth,
      maxScroll: Math.max(0, contentWidth - viewportWidth),
      scrollLeft: Number(scroller.scrollLeft),
    };
  }

  function readLogical(activeSession = session, geometry = activeSession && readScrollGeometry(activeSession)) {
    if (!activeSession || !geometry) return Number.NaN;
    return toLogicalScroll({
      scrollLeft: geometry.scrollLeft,
      maxScroll: geometry.maxScroll,
      direction: activeSession.direction,
      rtlScrollType: activeSession.rtlScrollType,
    });
  }

  function liveOrigin(activeSession: AdapterSession, geometry = readScrollGeometry(activeSession)): number | null {
    const currentWidth = Number(activeSession.manager.layout?.pageWidth) * Number(activeSession.manager.layout?.divisor || 1);
    if (Math.abs(currentWidth - activeSession.pageWidth) > ALIGNMENT_EPSILON_PX) return null;
    const contentUnchanged = Math.abs(geometry.contentWidth - activeSession.contentWidth) <= ALIGNMENT_EPSILON_PX;
    const views = activeSession.manager.views?.all?.() || activeSession.manager.views?.displayed?.();
    const anchor = activeSession.layoutAnchors.find(({ element }) => (
      element.isConnected !== false && (!views || views.some((view) => view.element === element))
    ));
    if (!anchor) return !activeSession.layoutAnchors.length && contentUnchanged ? activeSession.origin : null;
    const originPhysical = toPhysicalScroll({ ...activeSession, logicalScroll: activeSession.origin });
    const offsetLeft = Number(anchor.element.offsetLeft);
    let physicalOrigin: number;
    if (Number.isFinite(offsetLeft) && Number.isFinite(anchor.offsetLeft)) {
      physicalOrigin = originPhysical + offsetLeft - anchor.offsetLeft;
    } else {
      if (contentUnchanged) return activeSession.origin;
      const anchorGeometry = readViewGeometry(anchor.element);
      if (!anchorGeometry) return null;
      physicalOrigin = geometry.scrollLeft + anchorGeometry.left - anchor.left -
        (activeSession.backend === 'compositor' ? activeSession.visualOffset : activeSession.boundaryOffset);
    }
    return toLogicalScroll({ ...activeSession, maxScroll: geometry.maxScroll, scrollLeft: physicalOrigin });
  }

  function restoreContentPosition(activeSession: AdapterSession) {
    // Remove compositor transforms before measuring a viewport-relative anchor.
    cancelAnimationGroup(activeSession.animations);
    restoreSessionStyles(activeSession);
    activeSession.visualOffset = 0;
    activeSession.boundaryOffset = 0;
    const geometry = readScrollGeometry(activeSession);
    const origin = liveOrigin(activeSession, geometry);
    if (origin === null) return false;
    writeLogical(origin + (activeSession.committedDelta ?? 0) * activeSession.pageWidth, activeSession, geometry);
    return true;
  }

  function writeLogical(logicalScroll: number, activeSession = session, geometry = activeSession && readScrollGeometry(activeSession)) {
    if (!activeSession || !geometry) return;
    const { maxScroll } = geometry;
    const clamped = Math.min(maxScroll, Math.max(0, logicalScroll));
    activeSession.scroller.scrollLeft = toPhysicalScroll({
      logicalScroll: clamped,
      maxScroll,
      direction: activeSession.direction,
      rtlScrollType: activeSession.rtlScrollType,
    });
  }

  function setBoundaryOffset(offset: number) {
    if (!session || session.boundaryOffset === offset) return;
    session.boundaryOffset = offset;
    const transform = offset
      ? 'translate3d(' + offset + 'px, 0, 0)'
      : session.previousTransform;
    if (session.scroller.style.transform !== transform) {
      session.scroller.style.transform = transform;
    }
  }

  function setEdgeDirection(direction: 'next' | 'prev' | null) {
    if (!session || !direction) return;
    if (session.edgeDirection !== direction) {
      session.edgeDirection = direction;
      session.edgeOffset = null;
    }
  }

  function transformForOffset(offset: number) {
    const normalizedOffset = Object.is(offset, -0) ? 0 : offset;
    return `translate3d(${normalizedOffset}px, 0, 0)`;
  }

  function setEdgeOffset(visualOffset: number) {
    if (!session?.edgeElement || !session.edgeDirection) return;
    const offset = session.edgeDirection === 'next'
      ? session.pageWidth + visualOffset
      : visualOffset;
    if (session.edgeOffset === offset) return;

    session.edgeOffset = offset;
    const transform = transformForOffset(offset);
    if (session.edgeElement.style.transform !== transform) {
      session.edgeElement.style.transform = transform;
    }
  }

  function writeCompositorOffset(offset: number, activeSession = session) {
    if (!activeSession || activeSession.backend !== 'compositor') return;
    activeSession.visualOffset = offset;
    const transform = transformForOffset(offset);
    activeSession.views.forEach((snapshot) => {
      if (snapshot.element.style.transform !== transform) {
        snapshot.element.style.transform = transform;
      }
    });
    setEdgeOffset(offset);
  }

  function restoreSessionStyles(activeSession = session) {
    if (!activeSession) return;
    if (activeSession.scroller.style.transform !== activeSession.previousTransform) {
      activeSession.scroller.style.transform = activeSession.previousTransform;
    }

    activeSession.views?.forEach((snapshot) => {
      if (snapshot.element.style.transform !== snapshot.transform) {
        snapshot.element.style.transform = snapshot.transform;
      }
      if (snapshot.element.style.willChange !== snapshot.willChange) {
        snapshot.element.style.willChange = snapshot.willChange;
      }
    });

    const edgeElement = activeSession.edgeSnapshot?.element || activeSession.edgeElement;
    if (!edgeElement) return;
    const edgeTransform = activeSession.edgeSnapshot?.transform ??
      activeSession.previousEdgeTransform;
    const edgeWillChange = activeSession.edgeSnapshot?.willChange ??
      activeSession.previousEdgeWillChange;
    if (edgeElement.style.transform !== edgeTransform) {
      edgeElement.style.transform = edgeTransform;
    }
    if (edgeElement.style.willChange !== edgeWillChange) {
      edgeElement.style.willChange = edgeWillChange;
    }
  }

  function cancelAnimationGroup(animations: EpubAnimation[] = []) {
    const activeAnimations = animations.splice(0);
    activeAnimations.forEach((activeAnimation) => {
      try {
        activeAnimation.cancel();
      } catch {
        // Style restoration below remains authoritative.
      }
    });
  }

  function settleSessionCancellation(activeSession: AdapterSession, outcome: TurnResult) {
    if (!activeSession || activeSession.cancellationSettled) return;
    activeSession.cancellationSettled = true;
    activeSession.cancellationOutcome = outcome;
    activeSession.resolveCancellation?.(outcome);
  }

  function cancelPendingCompositor(activeSession: AdapterSession, outcome: TurnResult) {
    if (!activeSession || activeSession.backend !== 'compositor') return;
    if (activeSession.commitFrameId !== null) {
      cancelFrame(activeSession.commitFrameId);
      activeSession.commitFrameId = null;
    }
    const resolveCommit = activeSession.resolveCommit;
    activeSession.resolveCommit = null;
    settleSessionCancellation(activeSession, outcome);
    resolveCommit?.(outcome);
  }

  function disconnectSessionWatchers(activeSession: AdapterSession) {
    activeSession.watchers?.forEach((watcher) => {
      try {
        watcher.disconnect();
      } catch {
        // Watcher cleanup must not block restoring the stable page.
      }
    });
    activeSession.watchers?.splice(0);
  }

  function releaseSession(activeSession = session) {
    if (!activeSession) return;
    cancelAnimationGroup(activeSession.animations);
    disconnectSessionWatchers(activeSession);
    restoreSessionStyles(activeSession);
    activeSession.views?.splice(0);
    activeSession.layoutAnchors?.splice(0);
    activeSession.edgeSnapshot = null;
  }

  function invalidateCompositorSession(activeSession: AdapterSession, reason: string) {
    const outcome = result('unavailable', 'compositor', reason);
    if (
      !activeSession ||
      activeSession.backend !== 'compositor' ||
      session !== activeSession
    ) {
      return activeSession?.cancellationOutcome || outcome;
    }

    compositorDisabledReason = reason;
    recoveryCfi = activeSession.stableCfi || recoveryCfi;
    sessionGeneration += 1;
    cancelPendingCompositor(activeSession, outcome);
    cancelDiagnostic(activeSession.diagnosticRecordId, reason);
    try {
      restoreContentPosition(activeSession);
    } finally {
      releaseSession(activeSession);
      session = null;
    }
    return outcome;
  }

  function observeCompositorSession(activeSession: AdapterSession) {
    const invalidateIfNeeded = () => {
      if (!isCurrentCompositorSession(activeSession, activeSession.generation)) return;
      const reason = validateCompositorSession(activeSession);
      if (reason) invalidateCompositorSession(activeSession, reason);
    };

    if (typeof ResizeObserverImpl === 'function') {
      let resizeObserver: EpubObserver | undefined;
      try {
        resizeObserver = new ResizeObserverImpl(invalidateIfNeeded);
        resizeObserver.observe(activeSession.scroller);
        activeSession.views.forEach(({ element }) => resizeObserver!.observe(element));
        activeSession.watchers.push(resizeObserver);
      } catch {
        try {
          resizeObserver?.disconnect?.();
        } catch {
          // Boundary validation still runs before and after Animation.finished.
        }
      }
    }

    const viewContainer = activeSession.manager?.views?.container;
    if (typeof MutationObserverImpl === 'function' && viewContainer) {
      let mutationObserver;
      try {
        mutationObserver = new MutationObserverImpl(invalidateIfNeeded);
        mutationObserver.observe(viewContainer, { childList: true });
        activeSession.watchers.push(mutationObserver);
      } catch {
        try {
          mutationObserver?.disconnect?.();
        } catch {
          // Boundary validation remains authoritative when observation is unavailable.
        }
      }
    }
  }

  function prepareSessionStyles(activeSession: AdapterSession) {
    try {
      activeSession.views?.forEach((snapshot) => {
        if (snapshot.element.style.willChange !== 'transform') {
          snapshot.element.style.willChange = 'transform';
        }
      });
      if (
        activeSession.edgeElement &&
        activeSession.edgeElement.style.willChange !== 'transform'
      ) {
        activeSession.edgeElement.style.willChange = 'transform';
      }
      return true;
    } catch {
      return false;
    }
  }

  function activateSessionStyles(activeSession = session) {
    if (!activeSession) return false;
    if (activeSession.stylesPrepared) return true;
    if (!prepareSessionStyles(activeSession)) {
      cancel({ reason: 'styles', restoreOrigin: true });
      return false;
    }
    activeSession.stylesPrepared = true;
    return true;
  }

  function createTransformKeyframes(from: number, to: number, pageWidth = 0) {
    return EASE_OUT_CUBIC_SAMPLES.map(({ offset, value }) => ({
      offset,
      transform: transformForOffset(
        pageWidth + from + ((to - from) * value),
      ),
    }));
  }

  function readAnimationStartTime() {
    const timelineTime = environment.timeline?.currentTime ??
      globalThis.document?.timeline?.currentTime;
    return typeof timelineTime === 'number' && Number.isFinite(timelineTime) ? timelineTime : now();
  }

  function runAnimationGroup({ from, to, duration, direction }: { from: number; to: number; duration: number; direction: 'next' | 'prev' }) {
    const activeSession = session!;
    const generation = activeSession?.generation;
    const animations: EpubAnimation[] = [];
    const finishedPromises: PromiseLike<unknown>[] = [];
    const timing = {
      duration,
      easing: 'linear',
      fill: 'forwards' as const,
    };
    const viewKeyframes = createTransformKeyframes(from, to);
    const edgeKeyframes = createTransformKeyframes(
      from,
      to,
      direction === 'next' ? activeSession.pageWidth : 0,
    );

    const animateElement = (element: StyledElement, keyframes: Keyframe[]) => {
      const activeAnimation = element.animate!(keyframes, timing);
      const finished = activeAnimation?.finished;
      if (
        typeof activeAnimation?.cancel !== 'function' ||
        !finished ||
        typeof finished.then !== 'function' ||
        !('startTime' in activeAnimation)
      ) {
        throw new Error('waapi');
      }
      animations.push(activeAnimation);
      finishedPromises.push(finished);
    };

    try {
      activeSession.views.forEach((snapshot) => {
        animateElement(snapshot.element, viewKeyframes);
      });
      if (activeSession.edgeElement) {
        animateElement(activeSession.edgeElement, edgeKeyframes);
      }
      const startTime = readAnimationStartTime();
      animations.forEach((activeAnimation) => {
        activeAnimation.startTime = startTime;
      });
      activeSession.animations.push(...animations);
    } catch (error) {
      cancelAnimationGroup(animations);
      return Promise.reject(error);
    }

    return Promise.all(finishedPromises).then(() => ({
      activeSession,
      generation,
    }));
  }

  function begin(stableCfi: string | null = null, {
    action = 'drag',
    edgeElement = null,
    inputTime = now(),
  }: { action?: string; edgeElement?: StyledElement | null; inputTime?: number } = {}) {
    if (destroyed || enhancedDisabledReason) return null;
    const capability = inspectScrollCapability();
    if (!capability.available) return null;
    const forceBackend = forcedBackend();
    const shouldInspectCompositor = forceBackend === 'compositor' || (
      forceBackend !== 'scroll' && DEFAULT_PAGE_TURN_BACKEND === 'compositor'
    );
    const compositor = shouldInspectCompositor
      ? compositorFailureBlocksRetry()
        ? unavailable(compositorDisabledReason!)
        : inspectCompositor(capability, edgeElement, {
            ignoreSurfaceBudget: forceBackend === 'compositor',
          })
      : unavailable('not-selected');
    const backend = selectBackend({ compositor, forceBackend });
    if (!backend) return null;
    // Geometry invalidates the old turn, not the capability of later turns.
    // Only a fresh begin/inspection may retry; animation failures stay disabled.
    if (compositor.available) compositorDisabledReason = null;

    let resolveCancellation!: (result: TurnResult) => void;
    const cancellationPromise = new Promise<TurnResult>((resolve) => {
      resolveCancellation = resolve;
    });

    session = {
      ...capability,
      animationTargetOffset: null,
      animations: [],
      backend,
      cancellationOutcome: null,
      cancellationPromise,
      cancellationSettled: false,
      contentWidth: Number(capability.scroller.scrollWidth),
      stableCfi,
      edgeElement,
      edgeDirection: null,
      edgeOffset: null,
      edgeSnapshot: compositor.available && backend === 'compositor' ? compositor.edgeSnapshot : null,
      boundaryOffset: 0,
      commitFrameId: null,
      diagnosticAction: action,
      diagnosticRecordId: null,
      generation: ++sessionGeneration,
      committedDelta: null,
      layoutAnchors: captureLayoutAnchors(capability.manager),
      physicalScroll: Number(capability.scroller.scrollLeft),
      previousEdgeTransform: edgeElement?.style.transform || '',
      previousEdgeWillChange: edgeElement?.style.willChange || '',
      previousTransform: capability.scroller.style.transform || '',
      resolveCancellation,
      resolveCommit: null,
      stylesPrepared: false,
      views: compositor.available && backend === 'compositor' ? compositor.views : [],
      viewportWidth: Number(
        capability.scroller.clientWidth || capability.scroller.offsetWidth,
      ),
      visualOffset: 0,
      watchers: [],
    };
    session.diagnosticRecordId = diagnostics.begin({
      action,
      backend,
      inputTime,
    });
    recoveryCfi = stableCfi || recoveryCfi;
    if (backend === 'compositor') observeCompositorSession(session);
    return {
      available: true,
      backend,
      pageWidth: session.pageWidth,
      origin: session.origin,
      canPrevious: session.canPrevious,
      canNext: session.canNext,
    };
  }

  function dragBy(pointerDistanceX: number) {
    if (!session) return null;
    const geometry = readScrollGeometry(session);
    const origin = liveOrigin(session, geometry);
    if (origin === null) return null;
    if (!activateSessionStyles(session)) return null;
    let effectiveDistanceX = clampDragDistance(pointerDistanceX, session.pageWidth);
    const direction = effectiveDistanceX < 0 ? 'next' : 'prev';
    const missingNeighbor =
      (effectiveDistanceX < 0 && !session.canNext) ||
      (effectiveDistanceX > 0 && !session.canPrevious);
    setEdgeDirection(direction);

    if (session.backend === 'compositor') {
      if (missingNeighbor) {
        effectiveDistanceX = dampBoundaryDistance(pointerDistanceX);
      }
      session.boundaryOffset = missingNeighbor ? effectiveDistanceX : 0;
      writeCompositorOffset(effectiveDistanceX);
    } else {
      if (missingNeighbor) {
        effectiveDistanceX = dampBoundaryDistance(pointerDistanceX);
        writeLogical(origin, session, geometry);
        setBoundaryOffset(effectiveDistanceX);
      } else {
        setBoundaryOffset(0);
        writeLogical(origin - effectiveDistanceX, session, geometry);
      }
      setEdgeOffset(effectiveDistanceX);
    }

    const frameTime = now();
    diagnostics.markAnimationStart(session.diagnosticRecordId, frameTime);
    diagnostics.markVisualUpdate(session.diagnosticRecordId, frameTime);
    diagnostics.frame(session.diagnosticRecordId, frameTime, 'visual-update');

    return {
      boundary: missingNeighbor,
      direction,
      effectiveDistanceX,
      progress: Math.min(1, Math.abs(effectiveDistanceX) / session.pageWidth),
    };
  }

  function isStableAt(pageDelta: number) {
    if (!session || ![-1, 0, 1].includes(pageDelta)) return false;
    const geometry = readScrollGeometry(session);
    const origin = liveOrigin(session, geometry);
    if (origin === null) return false;
    const target = origin + pageDelta * session.pageWidth;
    const visualsSettled =
      Math.abs(session.boundaryOffset) <= ALIGNMENT_EPSILON_PX &&
      Math.abs(session.visualOffset) <= ALIGNMENT_EPSILON_PX;
    return visualsSettled && (
      Math.abs(readLogical(session, geometry) - target) <= ALIGNMENT_EPSILON_PX ||
      isStableAtVisualPage(session, pageDelta)
    );
  }

  function isStableAligned() {
    if (!session) return true;
    const logical = readLogical();
    const nearest = Math.round(logical / session.pageWidth) * session.pageWidth;
    return Math.abs(logical - nearest) <= ALIGNMENT_EPSILON_PX &&
      Math.abs(session.boundaryOffset) <= ALIGNMENT_EPSILON_PX &&
      Math.abs(session.visualOffset) <= ALIGNMENT_EPSILON_PX;
  }

  function end() {
    const activeSession = session;
    if (activeSession) {
      finishDiagnostic(activeSession.diagnosticRecordId);
      sessionGeneration += 1;
      cancelPendingCompositor(
        activeSession,
        result('cancelled', activeSession.backend),
      );
      releaseSession(activeSession);
    }
    session = null;
    recoveryCfi = null;
  }

  function beginAnimationDiagnostics(pageDelta: number, options: AnimationOptions, startTime: number) {
    const activeSession = session!;
    const action = options.action || (
      activeSession.diagnosticAction && activeSession.diagnosticAction !== 'drag'
        ? activeSession.diagnosticAction
        : pageDelta === 0
          ? 'rollback'
          : 'commit'
    );
    const inputTime = Number.isFinite(options.inputTime)
      ? options.inputTime
      : startTime;

    if (
      activeSession.diagnosticRecordId !== null &&
      activeSession.diagnosticRecordId !== undefined &&
      activeSession.diagnosticAction !== action
    ) {
      finishDiagnostic(activeSession.diagnosticRecordId, inputTime);
    }

    if (activeSession.diagnosticRecordId === null || activeSession.diagnosticRecordId === undefined) {
      activeSession.diagnosticRecordId = diagnostics.begin({
        action,
        backend: activeSession.backend,
        inputTime,
      });
    }
    activeSession.diagnosticAction = action;
    if (activeSession.backend === 'compositor') {
      diagnostics.markAnimationStart(activeSession.diagnosticRecordId, startTime, {
        sampleFrames: true,
      });
    } else {
      diagnostics.markAnimationStart(activeSession.diagnosticRecordId, startTime);
    }
    return activeSession.diagnosticRecordId;
  }

  function isCurrentCompositorSession(activeSession: AdapterSession, generation: number) {
    return session === activeSession &&
      !destroyed &&
      activeSession.generation === generation &&
      sessionGeneration === generation;
  }

  function restoreCompositorVisual(activeSession: AdapterSession) {
    cancelAnimationGroup(activeSession.animations);
    restoreSessionStyles(activeSession);
    activeSession.animationTargetOffset = null;
    activeSession.visualOffset = 0;
    activeSession.boundaryOffset = 0;
    activeSession.edgeOffset = null;
  }

  function commitCompositorPage(
    activeSession: AdapterSession,
    generation: number,
    pageDelta: number,
    diagnosticRecordId: number | null,
  ) {
    return new Promise<TurnResult>((resolve) => {
      activeSession.resolveCommit = resolve;
      activeSession.commitFrameId = requestFrame((timestamp) => {
        activeSession.commitFrameId = null;
        activeSession.resolveCommit = null;
        if (!isCurrentCompositorSession(activeSession, generation)) {
          cancelAnimationGroup(activeSession.animations);
          resolve(
            activeSession.cancellationOutcome || result('cancelled', 'compositor'),
          );
          return;
        }

        const frameTime = Number.isFinite(timestamp) ? timestamp : now();
        disconnectSessionWatchers(activeSession);
        if (activeSession.manager?.ignore === true) {
          activeSession.manager.ignore = false;
        }
        const geometry = readScrollGeometry(activeSession);
        const origin = liveOrigin(activeSession, geometry);
        if (origin === null) {
          resolve(invalidateCompositorSession(activeSession, 'geometry'));
          return;
        }
        writeLogical(
          origin + pageDelta * activeSession.pageWidth,
          activeSession,
          geometry,
        );
        restoreCompositorVisual(activeSession);
        activeSession.committedDelta = pageDelta;
        finishDiagnostic(diagnosticRecordId, frameTime);
        resolve(result('completed', 'compositor'));
      });
    });
  }

  function animateCompositorTo(pageDelta: number, options: AnimationOptions = {}) {
    const activeSession = session!;
    if (
      (pageDelta === 1 && !activeSession.canNext) ||
      (pageDelta === -1 && !activeSession.canPrevious)
    ) {
      return Promise.resolve(result('unavailable', 'compositor'));
    }

    const validationReason = validateCompositorSession(activeSession);
    if (validationReason) {
      return Promise.resolve(
        invalidateCompositorSession(activeSession, validationReason),
      );
    }

    const duration = Math.max(0, Number(options.duration) || 0);
    const startTime = now();
    const from = activeSession.visualOffset;
    const targetOffset = -pageDelta * activeSession.pageWidth;
    const direction = pageDelta === 0
      ? activeSession.edgeDirection || (from < 0 ? 'next' : 'prev')
      : pageDelta > 0 ? 'next' : 'prev';
    setEdgeDirection(direction);
    activeSession.animationTargetOffset = targetOffset;
    const diagnosticRecordId = beginAnimationDiagnostics(pageDelta, options, startTime);
    const group = runAnimationGroup({
      direction,
      duration,
      from,
      to: targetOffset,
    });

    const completion = group.then(
      ({ activeSession: completedSession, generation }) => {
        if (!isCurrentCompositorSession(completedSession, generation)) {
          cancelAnimationGroup(completedSession.animations);
          return completedSession.cancellationOutcome || result('cancelled', 'compositor');
        }

        const finishedValidationReason = validateCompositorSession(completedSession);
        if (finishedValidationReason) {
          return invalidateCompositorSession(
            completedSession,
            finishedValidationReason,
          );
        }

        completedSession.visualOffset = targetOffset;
        if (pageDelta !== 0) {
          return commitCompositorPage(
            completedSession,
            generation,
            pageDelta,
            diagnosticRecordId,
          );
        }

        restoreCompositorVisual(completedSession);
        finishDiagnostic(diagnosticRecordId);
        return result('completed', 'compositor');
      },
      () => {
        if (!isCurrentCompositorSession(activeSession, activeSession.generation)) {
          return activeSession.cancellationOutcome || result('cancelled', 'compositor');
        }
        return invalidateCompositorSession(activeSession, 'animation');
      },
    );
    return Promise.race([completion, activeSession.cancellationPromise]);
  }

  function animateTo(pageDelta: number, options: AnimationOptions = {}) {
    if (!session) {
      if (compositorDisabledReason && recoveryCfi) {
        return Promise.resolve(
          result('unavailable', 'compositor', compositorDisabledReason),
        );
      }
      return Promise.resolve(result('unavailable'));
    }
    if (![-1, 0, 1].includes(pageDelta)) {
      return Promise.resolve(result('unavailable', session.backend));
    }
    if (
      (pageDelta === 1 && !session.canNext) ||
      (pageDelta === -1 && !session.canPrevious)
    ) {
      return Promise.resolve(result('unavailable', session.backend));
    }
    if (!activateSessionStyles(session)) {
      return Promise.resolve(result('unavailable'));
    }
    if (session.backend === 'compositor') {
      return animateCompositorTo(pageDelta, options);
    }

    stopAnimation();
    const duration = Math.max(0, Number(options.duration) || 0);
    const startTime = now();
    const startGeometry = readScrollGeometry(session);
    const startLogical = readLogical(session, startGeometry);
    const origin = liveOrigin(session, startGeometry);
    if (origin === null) return Promise.resolve(result('unavailable'));
    const startBoundaryOffset = session.boundaryOffset;
    const destination = origin + pageDelta * session.pageWidth;
    const startsAtDestination = pageDelta !== 0 &&
      Math.abs(startLogical - destination) <= ALIGNMENT_EPSILON_PX;
    const diagnosticRecordId = beginAnimationDiagnostics(pageDelta, options, startTime);
    setEdgeDirection(pageDelta === 0
      ? session.edgeDirection
      : pageDelta > 0 ? 'next' : 'prev');
    setEdgeOffset(origin - startLogical + startBoundaryOffset);

    return new Promise<TurnResult>((resolve) => {
      const tick = (timestamp: number) => {
        const frameTime = Number.isFinite(timestamp) ? timestamp : now();
        if (!session || destroyed) {
          animation = null;
          cancelDiagnostic(diagnosticRecordId, 'cancelled', frameTime);
          resolve(result('cancelled'));
          return;
        }

        const elapsed = now() - startTime;
        const linearProgress = duration === 0 ? 1 : Math.min(1, elapsed / duration);
        const easedProgress = easeOutCubic(linearProgress);
        const geometry = readScrollGeometry(session);
        const currentOrigin = liveOrigin(session, geometry);
        if (currentOrigin === null) {
          animation = null;
          cancelDiagnostic(diagnosticRecordId, 'geometry', frameTime);
          resolve(result('unavailable'));
          return;
        }
        const logical = currentOrigin + startLogical - origin + (destination - startLogical) * easedProgress;
        const boundaryOffset = startBoundaryOffset * (1 - easedProgress);

        writeLogical(logical, session, geometry);
        setBoundaryOffset(boundaryOffset);
        setEdgeOffset(currentOrigin - logical + boundaryOffset);
        diagnostics.markVisualUpdate(diagnosticRecordId, frameTime);
        diagnostics.frame(diagnosticRecordId, frameTime);

        if (linearProgress < 1) {
          animation!.frameId = requestFrame(tick);
          return;
        }
        if (pageDelta !== 0 && isStableAt(pageDelta)) session.committedDelta = pageDelta;

        if (startsAtDestination) {
          const reportLocation = rendition?.reportLocation;
          if (typeof reportLocation !== 'function') {
            animation = null;
            cancelDiagnostic(diagnosticRecordId, 'unavailable');
            resolve(result('unavailable'));
            return;
          }

          const activeAnimation = animation;
          Promise.resolve()
            .then(() => reportLocation.call(rendition))
            .then(
              () => {
                if (animation !== activeAnimation) return;
                animation = null;
                finishDiagnostic(diagnosticRecordId);
                resolve(result('completed'));
              },
              () => {
                if (animation !== activeAnimation) return;
                animation = null;
                cancelDiagnostic(diagnosticRecordId, 'unavailable');
                resolve(result('unavailable'));
              },
            );
          return;
        }

        animation = null;
        finishDiagnostic(diagnosticRecordId);
        resolve(result('completed'));
      };

      animation = {
        diagnosticRecordId,
        frameId: requestFrame(tick),
        resolve,
      };
    });
  }

  async function recover(stableTarget?: string | null) {
    if (session?.committedDelta !== null && session?.committedDelta !== undefined) {
      const delta = session.committedDelta;
      if (restoreContentPosition(session) && isStableAt(delta)) {
        end();
        return true;
      }
      if (!stableTarget) {
        cancel({ reason: 'recover', restoreOrigin: false });
        enhancedDisabledReason = 'recovery';
        return false;
      }
    }
    const stableCfi = stableTarget || session?.stableCfi || recoveryCfi;
    cancel({ reason: 'recover', restoreOrigin: true });
    if (!stableCfi || typeof rendition?.display !== 'function') {
      enhancedDisabledReason = 'recovery';
      return false;
    }
    try {
      await rendition.display(stableCfi);
      recoveryCfi = null;
      return true;
    } catch {
      enhancedDisabledReason = 'recovery';
      return false;
    }
  }

  function cancel(options: { reason?: string; restoreOrigin?: boolean } = {}) {
    const reason = options.reason || 'cancelled';
    stopAnimation(reason);
    const activeSession = session;
    let restored = true;
    if (activeSession) {
      recoveryCfi = activeSession.stableCfi || recoveryCfi;
      sessionGeneration += 1;
      cancelPendingCompositor(
        activeSession,
        result('cancelled', activeSession.backend),
      );
      try {
        if (options.restoreOrigin !== false) {
          restored = restoreContentPosition(activeSession);
        }
      } finally {
        cancelDiagnostic(activeSession.diagnosticRecordId, reason);
        releaseSession(activeSession);
        session = null;
      }
      return restored;
    }
    session = null;
    return restored;
  }

  function destroy() {
    cancel({ reason: 'destroy', restoreOrigin: true });
    diagnostics.destroy();
    destroyed = true;
  }

  function setPageGap(pageGap: number) {
    if (destroyed) return false;
    cancel({ reason: 'page-gap', restoreOrigin: true });
    return configureEpubPageGap(rendition, pageGap);
  }

  return {
    animateTo,
    begin,
    cancel,
    destroy,
    dragBy,
    end,
    inspect,
    isStableAligned,
    isStableAt,
    recover,
    setPageGap,
  };
}

import type { ReaderContents, PageRanges, ReadingSection, TargetMeasurement } from '../types/epub.js';
import type { ReaderSettings } from '../hooks/useReaderSettings.js';
import { sessionBook } from '../types/readerSession.js';
import type Book from 'epubjs/types/book';
interface ViewportSize { width: number; height: number }
type PaginationSettings = ReaderSettings;
interface PaginationOptions {
  applyReaderSettingsToContents: (contents: ReaderContents, settings: PaginationSettings) => void;
  arrayBuffer: ArrayBuffer;
  onLayoutInvalidated?: () => void;
  onReadingSectionComplete?: (section: ReadingSection, ranges: PageRanges) => void;
  onReadingSectionFailed?: (section: ReadingSection) => void;
  readingSections: ReadingSection[];
}
export interface PaginationRun extends PaginationOptions {
  cachedReadingSectionIds: Set<string>;
  onReadingSectionComplete: (section: ReadingSection, ranges: PageRanges) => void;
  onReadingSectionFailed: (section: ReadingSection) => void;
  prioritySectionIndex: number; settings: PaginationSettings; shouldStop: () => boolean; size: ViewportSize;
}
interface PaginationInput {
  container: { getBoundingClientRect: () => ViewportSize } | null;
  currentSectionIndex: number | null | undefined;
  settings: PaginationSettings;
}
type PaginationStatus = 'ignored' | 'cancelled' | 'cached' | 'retry-pending' | 'completed' | 'failed';
interface PaginationRequest { key: string; promise: Promise<PaginationStatus>; resolve: (status: PaginationStatus) => void; settled: boolean; token: number }
interface PaginationEnvironment { debounceMs?: number; failureRetryMs?: number; now?: () => number; paginateBook?: (options: PaginationRun) => Promise<void> }
import Epub from 'epubjs';
import { applyReaderSettingsToRendition, getReaderPageGap } from '../hooks/useReaderSettings.js';
import { measureReadingSectionPages } from './epubPageMap.js';

const DEFAULT_DEBOUNCE_MS = 160;
const DEFAULT_FAILURE_RETRY_MS = 5000;

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    let settled = false;
    let secondFrame: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
      resolve();
    };
    const timer = setTimeout(finish, 250);

    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(finish);
    });
  });
}

function readerViewportSize(container: PaginationInput['container']) {
  const rect = container?.getBoundingClientRect?.();
  const width = Math.round(Number(rect?.width));
  const height = Math.round(Number(rect?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
    return null;
  }
  return { height, width };
}

function paginationLayoutSignature(size: ViewportSize, settings: PaginationSettings) {
  return JSON.stringify({
    fontFamilyId: settings?.fontFamilyId,
    fontSize: settings?.fontSize,
    height: size.height,
    horizontalMargin: settings?.horizontalMargin,
    letterSpacing: settings?.letterSpacing,
    lineHeight: settings?.lineHeight,
    verticalMargin: settings?.verticalMargin,
    width: size.width,
  });
}

function createPageMeasurementContainer(size: ViewportSize) {
  const container = document.createElement('div');
  container.className = 'reader-epub-container';
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, {
    bottom: 'auto',
    height: `${size.height}px`,
    left: '-100000px',
    opacity: '0',
    pointerEvents: 'none',
    position: 'fixed',
    right: 'auto',
    top: '0',
    width: `${size.width}px`,
    zIndex: '-1',
  });
  document.body.appendChild(container);
  return container;
}

async function paginateBook({
  applyReaderSettingsToContents,
  arrayBuffer,
  cachedReadingSectionIds,
  onReadingSectionComplete,
  onReadingSectionFailed,
  prioritySectionIndex,
  readingSections,
  settings,
  shouldStop,
  size,
}: PaginationRun) {
  const measurementContainer = createPageMeasurementContainer(size);
  let measurementBook: Book | null = null;

  try {
    measurementBook = Epub(arrayBuffer.slice(0));
    await measurementBook.ready;
    if (shouldStop()) return;

    const renditionOptions = {
      flow: 'paginated',
      gap: getReaderPageGap(settings.horizontalMargin),
      height: size.height,
      manager: 'default',
      spread: 'none',
      width: size.width,
    };
    const measurementRendition = sessionBook(measurementBook).renderTo(measurementContainer, renditionOptions);
    measurementRendition.hooks.content.register((contents) => {
      applyReaderSettingsToContents(contents, settings);
    });
    applyReaderSettingsToRendition(measurementRendition, settings);

    const targetMeasurements = new Map<string, Promise<TargetMeasurement>>();
    const measureTarget = (target: string): Promise<TargetMeasurement> => {
      if (targetMeasurements.has(target)) return targetMeasurements.get(target)!;

      const measurement = (async () => {
        await measurementRendition.display(target);
        applyReaderSettingsToRendition(measurementRendition, settings);
        await waitForNextPaint();
        if (shouldStop()) throw new Error('Pagination cancelled');

        const location = await Promise.resolve(measurementRendition.currentLocation?.());
        const page = Number(location?.start?.displayed?.page);
        const sectionIndex = Number(location?.start?.index);
        const total = Number(location?.start?.displayed?.total);
        if (
          !Number.isInteger(sectionIndex) ||
          !Number.isFinite(page) ||
          !Number.isFinite(total) ||
          page <= 0 ||
          total <= 0
        ) {
          throw new Error('Invalid measured page location');
        }
        return { page, sectionIndex, total };
      })();
      targetMeasurements.set(target, measurement);
      return measurement;
    };

    await measureReadingSectionPages({
      cachedReadingSectionIds,
      measureCurrentReadingSectionsOnly: true,
      measureSection: async (sectionIndex) => {
        const section = measurementBook!.spine.get(sectionIndex);
        if (!section) throw new Error('Unreadable publication document');
        const measurement = await measureTarget(section.href);
        if (measurement.sectionIndex !== sectionIndex) {
          throw new Error('Invalid measured page total');
        }
        return measurement.total;
      },
      measureTarget,
      onReadingSectionComplete,
      onReadingSectionFailed,
      prioritySectionIndex,
      readingSections,
      shouldStop,
    });
  } finally {
    measurementBook?.destroy();
    measurementContainer.remove();
  }
}

function resolvedRequest(status: PaginationStatus) {
  return Promise.resolve(status);
}

export function createEpubPagination({
  applyReaderSettingsToContents,
  arrayBuffer,
  onLayoutInvalidated,
  onReadingSectionComplete,
  onReadingSectionFailed,
  readingSections,
}: PaginationOptions, environment: PaginationEnvironment = {}) {
  const debounceMs = Number.isFinite(environment.debounceMs)
    ? Math.max(0, environment.debounceMs!)
    : DEFAULT_DEBOUNCE_MS;
  const failureRetryMs = Number.isFinite(environment.failureRetryMs)
    ? Math.max(0, environment.failureRetryMs!)
    : DEFAULT_FAILURE_RETRY_MS;
  const now = typeof environment.now === 'function' ? environment.now : Date.now;
  const paginate = environment.paginateBook || paginateBook;
  let activeLayoutSignature: string | null = null;
  let automaticallyRetriedReadingSectionIds = new Set<string>();
  let cachedReadingSectionIds = new Set<string>();
  let failedReadingSectionRetryAt = new Map<string, number>();
  let destroyed = false;
  let paginationQueue = Promise.resolve();
  let paginationRequest: PaginationRequest | null = null;
  let paginationRequestToken = 0;
  let paginationTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const finishRequest = (request: PaginationRequest, status: PaginationStatus) => {
    if (request.settled) return;
    request.settled = true;
    request.resolve(status);
  };

  const cancelPendingTimer = () => {
    if (paginationTimer === null) return;
    clearTimeout(paginationTimer);
    paginationTimer = null;
    if (paginationRequest) finishRequest(paginationRequest, 'cancelled');
  };

  const cancelRetryTimer = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = (requestInput: PaginationInput, currentReadingSections: ReadingSection[]) => {
    cancelRetryTimer();
    if (destroyed) return;

    const retryCandidates = currentReadingSections.flatMap((readingSection) => {
      const retryAt = failedReadingSectionRetryAt.get(readingSection.id);
      return typeof retryAt === 'number' && Number.isFinite(retryAt) &&
        !automaticallyRetriedReadingSectionIds.has(readingSection.id)
        ? [{ id: readingSection.id, retryAt }]
        : [];
    });
    const retryAt = retryCandidates.reduce<number | null>((earliest, candidate) => (
      earliest === null ? candidate.retryAt : Math.min(earliest, candidate.retryAt)
    ), null);
    if (retryAt === null) return;
    const retryingReadingSectionIds = retryCandidates
      .filter((candidate) => candidate.retryAt === retryAt)
      .map((candidate) => candidate.id);

    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryingReadingSectionIds.forEach((readingSectionId) => {
        automaticallyRetriedReadingSectionIds.add(readingSectionId);
      });
      void request(requestInput);
    }, Math.max(0, retryAt - now()));
  };

  const request = ({ container, currentSectionIndex, settings }: PaginationInput): Promise<PaginationStatus> => {
    if (destroyed || !arrayBuffer || !Array.isArray(readingSections) || readingSections.length === 0) {
      return resolvedRequest('ignored');
    }

    const size = readerViewportSize(container);
    const prioritySectionIndex = Number(currentSectionIndex);
    if (!size || !Number.isInteger(prioritySectionIndex)) return resolvedRequest('ignored');

    const signature = paginationLayoutSignature(size, settings);
    if (signature !== activeLayoutSignature) {
      paginationRequestToken += 1;
      cancelPendingTimer();
      cancelRetryTimer();
      paginationRequest = null;
      activeLayoutSignature = signature;
      automaticallyRetriedReadingSectionIds = new Set<string>();
      cachedReadingSectionIds = new Set<string>();
      failedReadingSectionRetryAt = new Map<string, number>();
      onLayoutInvalidated?.();
    }

    const requestInput = { container, currentSectionIndex, settings };
    cancelRetryTimer();

    const currentReadingSections = readingSections.filter((readingSection) => (
      readingSection.sectionIndexes.includes(prioritySectionIndex)
    ));
    const requestTime = now();
    const pendingReadingSections = currentReadingSections.filter((readingSection) => (
      !cachedReadingSectionIds.has(readingSection.id) &&
      (failedReadingSectionRetryAt.get(readingSection.id) ?? 0) <= requestTime
    ));
    if (currentReadingSections.length === 0) {
      return resolvedRequest('cached');
    }
    if (pendingReadingSections.length === 0) {
      const allCached = currentReadingSections.every((readingSection) => (
        cachedReadingSectionIds.has(readingSection.id)
      ));
      if (!allCached) scheduleRetry(requestInput, currentReadingSections);
      return resolvedRequest(allCached ? 'cached' : 'retry-pending');
    }

    const requestKey = `${signature}:${prioritySectionIndex}`;
    if (paginationRequest?.key === requestKey) return paginationRequest.promise;

    paginationRequestToken += 1;
    cancelPendingTimer();
    const requestToken = paginationRequestToken;
    let resolveRequest!: (status: PaginationStatus) => void;
    const requestState: PaginationRequest = {
      key: requestKey,
      promise: new Promise<PaginationStatus>((resolve) => {
        resolveRequest = resolve;
      }),
      resolve: (status) => resolveRequest(status),
      settled: false,
      token: requestToken,
    };
    paginationRequest = requestState;
    paginationTimer = setTimeout(() => {
      paginationTimer = null;
      paginationQueue = paginationQueue
        .catch(() => {})
        .then(async () => {
          const shouldStop = () => destroyed || requestToken !== paginationRequestToken;
          if (shouldStop()) {
            finishRequest(requestState, 'cancelled');
            return;
          }

          try {
            const skippedReadingSectionIds = new Set(cachedReadingSectionIds);
            failedReadingSectionRetryAt.forEach((retryAt, readingSectionId) => {
              if (retryAt > requestTime) skippedReadingSectionIds.add(readingSectionId);
            });
            await paginate({
              applyReaderSettingsToContents,
              arrayBuffer,
              cachedReadingSectionIds: skippedReadingSectionIds,
              onReadingSectionComplete: (readingSection, pageRangesBySectionIndex) => {
                if (shouldStop()) return;
                automaticallyRetriedReadingSectionIds.delete(readingSection.id);
                cachedReadingSectionIds.add(readingSection.id);
                failedReadingSectionRetryAt.delete(readingSection.id);
                onReadingSectionComplete?.(readingSection, pageRangesBySectionIndex);
              },
              onReadingSectionFailed: (readingSection) => {
                if (shouldStop()) return;
                failedReadingSectionRetryAt.set(readingSection.id, now() + failureRetryMs);
                onReadingSectionFailed?.(readingSection);
              },
              prioritySectionIndex,
              readingSections,
              settings,
              shouldStop,
              size,
            });
            finishRequest(requestState, shouldStop() ? 'cancelled' : 'completed');
          } catch {
            if (!shouldStop()) {
              pendingReadingSections.forEach((readingSection) => {
                failedReadingSectionRetryAt.set(readingSection.id, now() + failureRetryMs);
                onReadingSectionFailed?.(readingSection);
              });
            }
            finishRequest(requestState, shouldStop() ? 'cancelled' : 'failed');
          } finally {
            if (paginationRequest === requestState) paginationRequest = null;
            if (!shouldStop()) scheduleRetry(requestInput, currentReadingSections);
          }
        });
    }, debounceMs);

    return requestState.promise;
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    paginationRequestToken += 1;
    cancelPendingTimer();
    cancelRetryTimer();
    if (paginationRequest) finishRequest(paginationRequest, 'cancelled');
    paginationRequest = null;
  };

  return { destroy, request };
}

import Epub from 'epubjs';
import { applyReaderSettingsToRendition, getReaderPageGap } from '../hooks/useReaderSettings.js';
import { measureReadingSectionPages } from './epubPageMap.js';

const DEFAULT_DEBOUNCE_MS = 160;
const DEFAULT_FAILURE_RETRY_MS = 5000;

function waitForNextPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 250);

    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  });
}

function readerViewportSize(container) {
  const rect = container?.getBoundingClientRect?.();
  const width = Math.round(Number(rect?.width));
  const height = Math.round(Number(rect?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
    return null;
  }
  return { height, width };
}

function paginationLayoutSignature(size, settings) {
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

function createPageMeasurementContainer(size) {
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
}) {
  const measurementContainer = createPageMeasurementContainer(size);
  let measurementBook = null;

  try {
    measurementBook = Epub(arrayBuffer.slice(0));
    await measurementBook.ready;
    if (shouldStop()) return;

    const measurementRendition = measurementBook.renderTo(measurementContainer, {
      flow: 'paginated',
      gap: getReaderPageGap(settings.horizontalMargin),
      height: size.height,
      manager: 'default',
      spread: 'none',
      width: size.width,
    });
    measurementRendition.hooks.content.register((contents) => {
      applyReaderSettingsToContents(contents, settings);
    });
    applyReaderSettingsToRendition(measurementRendition, settings);

    const targetMeasurements = new Map();
    const measureTarget = (target) => {
      if (targetMeasurements.has(target)) return targetMeasurements.get(target);

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
        const section = measurementBook.spine.get(sectionIndex);
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

function resolvedRequest(status) {
  return Promise.resolve(status);
}

export function createEpubPagination({
  applyReaderSettingsToContents,
  arrayBuffer,
  onLayoutInvalidated,
  onReadingSectionComplete,
  onReadingSectionFailed,
  readingSections,
}, environment = {}) {
  const debounceMs = Number.isFinite(environment.debounceMs)
    ? Math.max(0, environment.debounceMs)
    : DEFAULT_DEBOUNCE_MS;
  const failureRetryMs = Number.isFinite(environment.failureRetryMs)
    ? Math.max(0, environment.failureRetryMs)
    : DEFAULT_FAILURE_RETRY_MS;
  const now = typeof environment.now === 'function' ? environment.now : Date.now;
  const paginate = environment.paginateBook || paginateBook;
  let activeLayoutSignature = null;
  let automaticallyRetriedReadingSectionIds = new Set();
  let cachedReadingSectionIds = new Set();
  let failedReadingSectionRetryAt = new Map();
  let destroyed = false;
  let paginationQueue = Promise.resolve();
  let paginationRequest = null;
  let paginationRequestToken = 0;
  let paginationTimer = null;
  let retryTimer = null;

  const finishRequest = (request, status) => {
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

  const scheduleRetry = (requestInput, currentReadingSections) => {
    cancelRetryTimer();
    if (destroyed) return;

    const retryCandidates = currentReadingSections.flatMap((readingSection) => {
      const retryAt = failedReadingSectionRetryAt.get(readingSection.id);
      return Number.isFinite(retryAt) &&
        !automaticallyRetriedReadingSectionIds.has(readingSection.id)
        ? [{ id: readingSection.id, retryAt }]
        : [];
    });
    const retryAt = retryCandidates.reduce((earliest, candidate) => (
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

  const request = ({ container, currentSectionIndex, settings }) => {
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
      automaticallyRetriedReadingSectionIds = new Set();
      cachedReadingSectionIds = new Set();
      failedReadingSectionRetryAt = new Map();
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
    let resolveRequest;
    const requestState = {
      key: requestKey,
      promise: new Promise((resolve) => {
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

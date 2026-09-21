function containsSectionIndex(readingSection, sectionIndex) {
  return readingSection?.sectionIndexes?.includes(sectionIndex) || false;
}

const DEFAULT_MEASUREMENT_TIMEOUT_MS = 5000;

function measureWithin(measure, timeoutMs, shouldStop) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancellationTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(cancellationTimer);
      callback(value);
    };
    const timeout = setTimeout(() => {
      finish(reject, new Error('Reading Section measurement timed out'));
    }, timeoutMs);
    const checkCancellation = () => {
      if (shouldStop()) {
        finish(reject, new Error('Reading Section measurement cancelled'));
        return;
      }
      cancellationTimer = setTimeout(checkCancellation, 20);
    };
    cancellationTimer = setTimeout(checkCancellation, 20);

    Promise.resolve()
      .then(measure)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

export function prioritizeReadingSections(readingSections, prioritySectionIndex) {
  if (!Array.isArray(readingSections)) return [];
  const priority = readingSections.find((readingSection) => (
    containsSectionIndex(readingSection, prioritySectionIndex)
  ));
  if (!priority) return [...readingSections];

  return [
    priority,
    ...readingSections.filter((readingSection) => readingSection !== priority),
  ];
}

function normalizeTargetMeasurement(measurement) {
  const page = Math.round(Number(measurement?.page));
  const sectionIndex = Number(measurement?.sectionIndex);
  const total = Math.round(Number(measurement?.total));
  if (
    !Number.isInteger(sectionIndex) ||
    !Number.isFinite(page) ||
    !Number.isFinite(total) ||
    page <= 0 ||
    total <= 0
  ) {
    throw new Error('Invalid target page measurement');
  }
  return {
    page: Math.min(total, page),
    sectionIndex,
    total,
  };
}

async function measureReadingSectionPageRanges({
  measure,
  measureSection,
  measureTarget,
  readingSection,
}) {
  const start = normalizeTargetMeasurement(
    await measure(() => measureTarget(readingSection.startHref)),
  );
  const end = readingSection.endHref
    ? normalizeTargetMeasurement(await measure(() => measureTarget(readingSection.endHref)))
    : null;
  const sectionIndexes = [...new Set(readingSection.sectionIndexes || [])];
  if (end && end.page > 1 && !sectionIndexes.includes(end.sectionIndex)) {
    sectionIndexes.push(end.sectionIndex);
  }
  sectionIndexes.sort((first, second) => first - second);

  const pageRanges = new Map();
  for (const sectionIndex of sectionIndexes) {
    if (sectionIndex < start.sectionIndex || (end && sectionIndex > end.sectionIndex)) continue;

    let total;
    if (sectionIndex === start.sectionIndex) total = start.total;
    else if (end && sectionIndex === end.sectionIndex) total = end.total;
    else total = Math.round(Number(await measure(() => measureSection(sectionIndex))));
    if (!Number.isFinite(total) || total <= 0) throw new Error('Invalid page total');

    const startPage = sectionIndex === start.sectionIndex ? start.page : 1;
    const sharesBoundaryPage = end &&
      sectionIndex === start.sectionIndex &&
      end.sectionIndex === start.sectionIndex &&
      end.page === start.page;
    const endPage = end && sectionIndex === end.sectionIndex
      ? Math.min(total, sharesBoundaryPage ? startPage : end.page - 1)
      : total;
    if (endPage >= startPage) {
      pageRanges.set(sectionIndex, { endPage, startPage });
    }
  }

  if (pageRanges.size === 0) throw new Error('Empty Reading Section page range');
  return pageRanges;
}

export async function measureReadingSectionPages({
  cachedReadingSectionIds,
  measureCurrentReadingSectionsOnly = false,
  measurementTimeoutMs = DEFAULT_MEASUREMENT_TIMEOUT_MS,
  measureSection,
  measureTarget,
  onReadingSectionComplete,
  onReadingSectionFailed,
  prioritySectionIndex,
  readingSections,
  shouldStop = () => false,
}) {
  const uncachedReadingSections = cachedReadingSectionIds?.has
    ? readingSections?.filter((readingSection) => (
      !cachedReadingSectionIds.has(readingSection.id)
    ))
    : readingSections;
  const selectedReadingSections = measureCurrentReadingSectionsOnly
    ? uncachedReadingSections?.filter((readingSection) => (
      containsSectionIndex(readingSection, prioritySectionIndex)
    ))
    : uncachedReadingSections;
  const orderedSections = prioritizeReadingSections(
    selectedReadingSections,
    prioritySectionIndex,
  );
  const timeoutMs = Number.isFinite(measurementTimeoutMs) && measurementTimeoutMs > 0
    ? measurementTimeoutMs
    : DEFAULT_MEASUREMENT_TIMEOUT_MS;
  const measure = (measurement) => measureWithin(measurement, timeoutMs, shouldStop);

  for (const readingSection of orderedSections) {
    if (shouldStop()) return;
    let pageRangesBySectionIndex = new Map();
    let failed = false;

    if (measureTarget && readingSection.startHref) {
      try {
        pageRangesBySectionIndex = await measureReadingSectionPageRanges({
          measure,
          measureSection,
          measureTarget,
          readingSection,
        });
      } catch {
        failed = true;
      }
    } else {
      for (const sectionIndex of readingSection.sectionIndexes) {
        if (shouldStop()) return;
        try {
          const total = Number(await measure(() => measureSection(sectionIndex)));
          if (!Number.isFinite(total) || total <= 0) throw new Error('Invalid page total');
          pageRangesBySectionIndex.set(sectionIndex, {
            endPage: Math.max(1, Math.round(total)),
            startPage: 1,
          });
        } catch {
          failed = true;
          break;
        }
      }
    }

    if (shouldStop()) return;
    if (failed) {
      onReadingSectionFailed?.(readingSection);
    } else {
      onReadingSectionComplete?.(readingSection, pageRangesBySectionIndex);
    }
  }
}

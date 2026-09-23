import type { Awaitable, PageRange, ReadingSection, TargetMeasurement } from '../types/epub.js';
export type MeasureSection = (index: number) => Awaitable<number>;
export type MeasureTarget = (target: string) => Awaitable<TargetMeasurement>;
export interface MeasureReadingSectionOptions {
  cachedReadingSectionIds?: Set<string>;
  measureCurrentReadingSectionsOnly?: boolean;
  measurementTimeoutMs?: number;
  measureSection: MeasureSection;
  measureTarget?: MeasureTarget;
  onReadingSectionComplete?: (section: ReadingSection, ranges: Map<number, PageRange>) => void;
  onReadingSectionFailed?: (section: ReadingSection) => void;
  prioritySectionIndex?: number;
  readingSections: ReadingSection[];
  shouldStop?: () => boolean;
}
function containsSectionIndex(readingSection: ReadingSection, sectionIndex: number | undefined) {
  return sectionIndex !== undefined && readingSection?.sectionIndexes?.includes(sectionIndex) || false;
}

/**
 * A Reading Section that is exactly one complete publication document: its
 * measured range is always that document's own `1..total`, which the
 * foreground renderer already reports as `displayed.page/total`.
 * Evaluate against the full Reading Section list of the Book.
 */
export function isWholeDocumentReadingSection(readingSection: ReadingSection, readingSections: readonly ReadingSection[]) {
  const sectionIndexes = [...new Set(readingSection?.sectionIndexes ?? [])];
  const [sectionIndex] = sectionIndexes;
  if (sectionIndexes.length !== 1 || sectionIndex === undefined) return false;
  const { endHref, startHref } = readingSection;
  if (typeof startHref !== 'string' || !startHref || startHref.includes('#')) return false;
  if (endHref && endHref.includes('#')) return false;
  return !readingSections.some((other) => (
    other !== readingSection &&
    other.id !== readingSection.id &&
    other.sectionIndexes?.includes(sectionIndex)
  ));
}

const DEFAULT_MEASUREMENT_TIMEOUT_MS = 5000;

function measureWithin<T>(measure: () => Awaitable<T>, timeoutMs: number, shouldStop: () => boolean) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancellationTimer: ReturnType<typeof setTimeout>;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(cancellationTimer);
      complete();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Reading Section measurement timed out')));
    }, timeoutMs);
    const checkCancellation = () => {
      if (shouldStop()) {
        finish(() => reject(new Error('Reading Section measurement cancelled')));
        return;
      }
      cancellationTimer = setTimeout(checkCancellation, 20);
    };
    cancellationTimer = setTimeout(checkCancellation, 20);

    Promise.resolve()
      .then(measure)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

export function prioritizeReadingSections(readingSections: ReadingSection[] | undefined, prioritySectionIndex?: number) {
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

function normalizeTargetMeasurement(measurement: TargetMeasurement) {
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
}: { measure: <T>(callback: () => Awaitable<T>) => Promise<T>; measureSection: MeasureSection; measureTarget: MeasureTarget; readingSection: ReadingSection }) {
  const start = normalizeTargetMeasurement(
    await measure(() => measureTarget(readingSection.startHref!)),
  );
  const end = readingSection.endHref
    ? normalizeTargetMeasurement(await measure(() => measureTarget(readingSection.endHref!)))
    : null;
  const sectionIndexes = [...new Set(readingSection.sectionIndexes || [])];
  if (end && end.page > 1 && !sectionIndexes.includes(end.sectionIndex)) {
    sectionIndexes.push(end.sectionIndex);
  }
  sectionIndexes.sort((first, second) => first - second);

  const pageRanges = new Map<number, PageRange>();
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
}: MeasureReadingSectionOptions) {
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
  const measure = <T>(measurement: () => Awaitable<T>) => measureWithin(measurement, timeoutMs, shouldStop);

  for (const readingSection of orderedSections) {
    if (shouldStop()) return;
    let pageRangesBySectionIndex = new Map<number, PageRange>();
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

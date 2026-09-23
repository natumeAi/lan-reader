import type { RefObject } from 'react';
import type { PageRange, PageRanges, ReaderLocation, ReaderRendition, ReadingSection } from '../types/epub.js';
interface UpdateOptions { readingSectionId?: string | null }
interface DisplayedPosition { location: ReaderLocation | null | undefined; options?: UpdateOptions }
interface ProgressOptions {
  readingSection?: ReadingSection;
  pageRangesBySectionIndex?: PageRanges;
  readingSections?: ReadingSection[];
  pageRangesByReadingSectionId?: Map<string, PageRanges>;
}
interface ProgressContext {
  navigationPending: false;
  currentReadingSectionId: string | null;
  failedReadingSectionIds: Set<string>;
  pageRangesByReadingSectionId: Map<string, PageRanges>;
  readingSections: ReadingSection[];
}
import { useCallback, useMemo, useRef, useState } from 'react';
import { isWholeDocumentReadingSection } from '../utils/epubPageMap.js';

function getLocalPageProgress(location: ReaderLocation | null | undefined) {
  const displayed = location?.start?.displayed;
  const current = Number(displayed?.page);
  const total = Number(displayed?.total);

  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  return {
    current: Math.min(total, Math.max(1, Math.round(current))),
    total: Math.max(1, Math.round(total)),
  };
}

function normalizePageRange(pageRange: PageRange | null | undefined) {
  const startPage = Math.max(1, Math.round(Number(pageRange?.startPage)));
  const endPage = Math.round(Number(pageRange?.endPage));
  if (!Number.isFinite(startPage) || !Number.isFinite(endPage) || endPage < startPage) {
    return null;
  }
  return { endPage, startPage };
}

function matchMeasuredReadingSection(location: ReaderLocation | null | undefined, readingSection: ReadingSection | undefined, pageRangesBySectionIndex: PageRanges | null | undefined) {
  const sectionIndex = Number(location?.start?.index);
  const currentPage = Number(location?.start?.displayed?.page);
  const pageRange = normalizePageRange(pageRangesBySectionIndex?.get?.(sectionIndex));
  if (
    !readingSection ||
    !pageRangesBySectionIndex ||
    !pageRange ||
    !Number.isFinite(currentPage) ||
    currentPage < pageRange.startPage ||
    currentPage > pageRange.endPage
  ) {
    return null;
  }
  return { pageRangesBySectionIndex, readingSection };
}

function findMeasuredReadingSection(location: ReaderLocation | null | undefined, readingSections: ReadingSection[] | undefined, pageRangesByReadingSectionId: Map<string, PageRanges> | undefined) {
  if (!Array.isArray(readingSections) || !pageRangesByReadingSectionId?.get) return null;

  const sectionIndex = Number(location?.start?.index);
  if (!Number.isInteger(sectionIndex)) return null;

  for (const readingSection of readingSections) {
    const pageRangesBySectionIndex = pageRangesByReadingSectionId.get(readingSection.id);
    const measured = matchMeasuredReadingSection(
      location,
      readingSection,
      pageRangesBySectionIndex,
    );
    if (measured) return measured;
  }
  return null;
}

export function getPageProgressFromLocation(location: ReaderLocation | null | undefined, options: ProgressOptions = {}) {
  const localProgress = getLocalPageProgress(location);
  if (!localProgress) return null;

  let { pageRangesBySectionIndex, readingSection } = options;
  if (!readingSection) {
    const measured = findMeasuredReadingSection(
      location,
      options.readingSections,
      options.pageRangesByReadingSectionId,
    );
    readingSection = measured?.readingSection;
    pageRangesBySectionIndex = measured?.pageRangesBySectionIndex;
  }
  if (!readingSection) return localProgress;
  if (!pageRangesBySectionIndex?.get) return null;

  const currentSectionIndex = Number(location?.start?.index);
  const sectionIndexes = readingSection.sectionIndexes.filter((sectionIndex) => (
    pageRangesBySectionIndex.has(sectionIndex)
  ));
  let currentOffset = 0;
  let currentSectionRange = null;
  let total = 0;

  for (const sectionIndex of sectionIndexes) {
    const pageRange = normalizePageRange(pageRangesBySectionIndex.get(sectionIndex));
    if (!pageRange) return null;

    const pageCount = pageRange.endPage - pageRange.startPage + 1;
    if (sectionIndex === currentSectionIndex) {
      currentSectionRange = pageRange;
    } else if (currentSectionRange === null) {
      currentOffset += pageCount;
    }
    total += pageCount;
  }

  if (currentSectionRange === null || total <= 0) return localProgress;

  return {
    current: currentOffset + Math.min(
      currentSectionRange.endPage,
      Math.max(currentSectionRange.startPage, localProgress.current),
    ) - currentSectionRange.startPage + 1,
    total,
  };
}

async function getCurrentRenditionLocation(rendition: ReaderRendition | null) {
  const location = rendition?.currentLocation?.();
  if (!location) return null;

  return Promise.resolve(location);
}

export function usePageProgress({ renditionRef }: { renditionRef: RefObject<ReaderRendition | null> }) {
  const [pageProgress, setPageProgress] = useState<{ current: number; total: number } | null>(null);
  const pageProgressContextRef = useRef<ProgressContext | { navigationPending: true } | null>(null);
  const acceptedPositionRef = useRef<DisplayedPosition | null>(null);
  const previewPositionRef = useRef<DisplayedPosition | null>(null);

  const pageProgressUpdateFromLocation = useCallback((location: ReaderLocation | null | undefined, options: UpdateOptions = {}) => {
    if (!getLocalPageProgress(location)) {
      return { shouldUpdate: false, value: null };
    }

    const context = pageProgressContextRef.current;
    if (context?.navigationPending) return { shouldUpdate: true, value: null };
    if (!context) {
      return { shouldUpdate: true, value: getPageProgressFromLocation(location) };
    }
    if (Object.hasOwn(options, 'readingSectionId')) {
      context.currentReadingSectionId = options.readingSectionId || null;
    }

    const sectionIndex = Number(location?.start?.index);
    const candidateReadingSections = context.readingSections.filter((readingSection) => (
      readingSection.sectionIndexes.includes(sectionIndex)
    ));
    if (candidateReadingSections.length === 0) {
      return { shouldUpdate: true, value: getPageProgressFromLocation(location) };
    }
    // One complete publication document: the foreground renderer's own
    // page/total equals its measured range, so it never waits for measurement.
    const [onlyReadingSection] = candidateReadingSections;
    if (
      candidateReadingSections.length === 1 &&
      onlyReadingSection &&
      isWholeDocumentReadingSection(onlyReadingSection, context.readingSections)
    ) {
      return { shouldUpdate: true, value: getPageProgressFromLocation(location) };
    }

    const currentReadingSection = candidateReadingSections.find((readingSection) => (
      readingSection.id === context.currentReadingSectionId
    ));
    const currentPageRanges = currentReadingSection
      ? context.pageRangesByReadingSectionId.get(currentReadingSection.id)
      : null;
    const measured = matchMeasuredReadingSection(
      location,
      currentReadingSection,
      currentPageRanges,
    ) || findMeasuredReadingSection(
        location,
        candidateReadingSections,
        context.pageRangesByReadingSectionId,
      );
    if (!measured) {
      const allMeasurementsSettled = candidateReadingSections.every((readingSection) => {
        return context.failedReadingSectionIds.has(readingSection.id) ||
          context.pageRangesByReadingSectionId.has(readingSection.id);
      });
      return {
        shouldUpdate: true,
        value: allMeasurementsSettled ? getPageProgressFromLocation(location) : null,
      };
    }

    return {
      shouldUpdate: true,
      value: getPageProgressFromLocation(location, {
        pageRangesBySectionIndex: measured.pageRangesBySectionIndex,
        readingSection: measured.readingSection,
      }),
    };
  }, []);

  const applyPageProgressFromLocation = useCallback((location: ReaderLocation | null | undefined, options?: UpdateOptions) => {
    const update = pageProgressUpdateFromLocation(location, options);
    if (update.shouldUpdate) setPageProgress(update.value);
    return update.value;
  }, [pageProgressUpdateFromLocation]);

  const beginBookPageProgress = useCallback(() => {
    acceptedPositionRef.current = null;
    previewPositionRef.current = null;
    pageProgressContextRef.current = { navigationPending: true };
    setPageProgress(null);
  }, []);

  const updatePageProgressFromLocation = useCallback((location: ReaderLocation | null | undefined, options?: UpdateOptions) => {
    acceptedPositionRef.current = { location, options };
    if (!previewPositionRef.current) applyPageProgressFromLocation(location, options);
  }, [applyPageProgressFromLocation]);

  const setPageProgressPreview = useCallback((location: ReaderLocation | null, options?: UpdateOptions) => {
    previewPositionRef.current = location ? { location, options } : null;
    const displayed = previewPositionRef.current ?? acceptedPositionRef.current;
    if (displayed) applyPageProgressFromLocation(displayed.location, displayed.options);
  }, [applyPageProgressFromLocation]);

  const refreshCurrentPageProgress = useCallback((rendition = renditionRef.current) => (
    getCurrentRenditionLocation(rendition)
      .then((location) => {
        if (renditionRef.current !== rendition) return;
        // Measurement completion and snapshot saves cannot replace the visible
        // preview with the foreground's still-unaccepted navigation position.
        const displayed = previewPositionRef.current ?? acceptedPositionRef.current;
        applyPageProgressFromLocation(displayed ? displayed.location : location, displayed?.options);
      })
      .catch(() => {})
  ), [applyPageProgressFromLocation, renditionRef]);

  const setReadingSections = useCallback((readingSections: ReadingSection[], currentReadingSectionId: string | null = null) => {
    if (!Array.isArray(readingSections) || readingSections.length === 0) {
      pageProgressContextRef.current = null;
      void refreshCurrentPageProgress();
      return;
    }

    pageProgressContextRef.current = {
      currentReadingSectionId,
      failedReadingSectionIds: new Set(),
      navigationPending: false,
      pageRangesByReadingSectionId: new Map(),
      readingSections,
    };
    // Never keep a label from before these sections; re-evaluate the displayed
    // position now so a whole-document section does not wait for another turn.
    setPageProgress(null);
    void refreshCurrentPageProgress();
  }, [refreshCurrentPageProgress]);

  const invalidateReadingSectionPages = useCallback(() => {
    const context = pageProgressContextRef.current;
    if (!context || context.navigationPending) return;
    context.failedReadingSectionIds.clear();
    context.pageRangesByReadingSectionId.clear();
    setPageProgress(null);
  }, []);

  const setReadingSectionPageRanges = useCallback((readingSection: ReadingSection, pageRangesBySectionIndex: PageRanges) => {
    const context = pageProgressContextRef.current;
    if (!context || context.navigationPending || !readingSection) return;
    context.failedReadingSectionIds.delete(readingSection.id);
    context.pageRangesByReadingSectionId.set(readingSection.id, pageRangesBySectionIndex);
    void refreshCurrentPageProgress();
  }, [refreshCurrentPageProgress]);

  const failReadingSectionPageRanges = useCallback((readingSection: ReadingSection) => {
    const context = pageProgressContextRef.current;
    if (!context || context.navigationPending || !readingSection) return;
    context.pageRangesByReadingSectionId.delete(readingSection.id);
    context.failedReadingSectionIds.add(readingSection.id);
    void refreshCurrentPageProgress();
  }, [refreshCurrentPageProgress]);

  const pageProgressLabel = useMemo(() => (
    pageProgress ? `${pageProgress.current}/${pageProgress.total}` : '--/--'
  ), [pageProgress]);

  const pageProgressController = useMemo(() => ({
    beginBookPageProgress,
    failReadingSectionPageRanges,
    invalidateReadingSectionPages,
    setReadingSectionPageRanges,
    setReadingSections,
    setPageProgressPreview,
    updatePageProgressFromLocation,
  }), [
    beginBookPageProgress,
    failReadingSectionPageRanges,
    invalidateReadingSectionPages,
    setReadingSectionPageRanges,
    setReadingSections,
    setPageProgressPreview,
    updatePageProgressFromLocation,
  ]);

  return {
    pageProgressController,
    pageProgressLabel,
    refreshCurrentPageProgress,
  };
}

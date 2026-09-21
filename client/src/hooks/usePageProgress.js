import { useCallback, useMemo, useRef, useState } from 'react';

function getLocalPageProgress(location) {
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

function normalizePageRange(pageRange) {
  const startPage = Math.max(1, Math.round(Number(pageRange?.startPage)));
  const endPage = Math.round(Number(pageRange?.endPage));
  if (!Number.isFinite(startPage) || !Number.isFinite(endPage) || endPage < startPage) {
    return null;
  }
  return { endPage, startPage };
}

function matchMeasuredReadingSection(location, readingSection, pageRangesBySectionIndex) {
  const sectionIndex = Number(location?.start?.index);
  const currentPage = Number(location?.start?.displayed?.page);
  const pageRange = normalizePageRange(pageRangesBySectionIndex?.get?.(sectionIndex));
  if (
    !pageRange ||
    !Number.isFinite(currentPage) ||
    currentPage < pageRange.startPage ||
    currentPage > pageRange.endPage
  ) {
    return null;
  }
  return { pageRangesBySectionIndex, readingSection };
}

function findMeasuredReadingSection(location, readingSections, pageRangesByReadingSectionId) {
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

export function getPageProgressFromLocation(location, options = {}) {
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

async function getCurrentRenditionLocation(rendition) {
  const location = rendition?.currentLocation?.();
  if (!location) return null;

  return typeof location.then === 'function' ? location : Promise.resolve(location);
}

export function usePageProgress({ renditionRef }) {
  const [pageProgress, setPageProgress] = useState(null);
  const pageProgressContextRef = useRef(null);

  const pageProgressUpdateFromLocation = useCallback((location, options = {}) => {
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

  const applyPageProgressFromLocation = useCallback((location, options) => {
    const update = pageProgressUpdateFromLocation(location, options);
    if (update.shouldUpdate) setPageProgress(update.value);
    return update.value;
  }, [pageProgressUpdateFromLocation]);

  const beginBookPageProgress = useCallback(() => {
    pageProgressContextRef.current = { navigationPending: true };
    setPageProgress(null);
  }, []);

  const updatePageProgressFromLocation = useCallback((location, options) => {
    applyPageProgressFromLocation(location, options);
  }, [applyPageProgressFromLocation]);

  const refreshCurrentPageProgress = useCallback((rendition = renditionRef.current) => (
    getCurrentRenditionLocation(rendition)
      .then((location) => {
        if (renditionRef.current !== rendition) return;
        applyPageProgressFromLocation(location);
      })
      .catch(() => {})
  ), [applyPageProgressFromLocation, renditionRef]);

  const setReadingSections = useCallback((readingSections, currentReadingSectionId = null) => {
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
    setPageProgress(null);
  }, [refreshCurrentPageProgress]);

  const invalidateReadingSectionPages = useCallback(() => {
    const context = pageProgressContextRef.current;
    if (!context || context.navigationPending) return;
    context.failedReadingSectionIds.clear();
    context.pageRangesByReadingSectionId.clear();
    setPageProgress(null);
  }, []);

  const setReadingSectionPageRanges = useCallback((readingSection, pageRangesBySectionIndex) => {
    const context = pageProgressContextRef.current;
    if (!context || context.navigationPending || !readingSection) return;
    context.failedReadingSectionIds.delete(readingSection.id);
    context.pageRangesByReadingSectionId.set(readingSection.id, pageRangesBySectionIndex);
    void refreshCurrentPageProgress();
  }, [refreshCurrentPageProgress]);

  const failReadingSectionPageRanges = useCallback((readingSection) => {
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
    updatePageProgressFromLocation,
  }), [
    beginBookPageProgress,
    failReadingSectionPageRanges,
    invalidateReadingSectionPages,
    setReadingSectionPageRanges,
    setReadingSections,
    updatePageProgressFromLocation,
  ]);

  return {
    pageProgressController,
    pageProgressLabel,
    refreshCurrentPageProgress,
  };
}

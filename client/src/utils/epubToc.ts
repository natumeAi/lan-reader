import type { ReaderBook, ReadingSection, TocInput, TocItem } from '../types/epub.js';
function cleanLabel(label: unknown) {
  return typeof label === 'string' ? label.trim() : '';
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hrefDocument(href: string | undefined) {
  if (typeof href !== 'string') return '';
  return safeDecode(href.split('#')[0]!.split('?')[0]!);
}

function hrefSuffix(href: string) {
  if (typeof href !== 'string') return '';
  const queryIndex = href.indexOf('?');
  const fragmentIndex = href.indexOf('#');
  const suffixIndex = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), href.length);
  return href.slice(suffixIndex);
}

function normalizeDocumentPath(value: string | undefined) {
  const segments = safeDecode(value || '')
    .replaceAll('\\', '/')
    .split('/');
  const normalized: string[] = [];

  segments.forEach((segment) => {
    if (!segment || segment === '.') return;
    if (segment === '..') {
      normalized.pop();
      return;
    }
    normalized.push(segment);
  });

  return normalized.join('/');
}

function resolveFromNavigationPath(href: string, navigationPath: string) {
  const documentHref = hrefDocument(href);
  const navigationDocument = hrefDocument(navigationPath);
  if (!documentHref || !navigationDocument) return documentHref;
  if (/^[a-z][a-z\d+.-]*:/i.test(documentHref) || documentHref.startsWith('/')) {
    return documentHref;
  }

  const navigationSegments = normalizeDocumentPath(navigationDocument).split('/');
  navigationSegments.pop();
  return normalizeDocumentPath([...navigationSegments, documentHref].join('/'));
}

function findSpineSection(book: ReaderBook | undefined, href: string, navigationPath = '') {
  const documentHref = hrefDocument(href);
  if (!documentHref) return null;

  const relativeDocument = resolveFromNavigationPath(href, navigationPath);
  const candidates = [...new Set([
    documentHref,
    normalizeDocumentPath(documentHref),
    relativeDocument,
    normalizeDocumentPath(relativeDocument),
  ].filter(Boolean))];

  for (const candidate of candidates) {
    const section = book?.spine?.get?.(candidate);
    if (section) return section;
  }

  const candidateDocuments = candidates.map(normalizeDocumentPath);
  const matchingSections = (book?.spine?.spineItems || []).filter((section) => {
    const sectionDocument = normalizeDocumentPath(section?.href);
    return sectionDocument && candidateDocuments.some((candidate) => (
      sectionDocument === candidate ||
      sectionDocument.endsWith(`/${candidate}`) ||
      candidate.endsWith(`/${sectionDocument}`)
    ));
  });

  return matchingSections.length === 1 ? matchingSections[0] : null;
}

function canonicalTocHref(href: string, book: ReaderBook | undefined, navigationPath: string) {
  const section = findSpineSection(book, href, navigationPath);
  return section?.href ? `${section.href}${hrefSuffix(href)}` : href;
}

export function prepareTocItems(items: TocInput[] | undefined, parentPath = '', options: { book?: ReaderBook; navigationPath?: string } = {}): TocItem[] {
  if (!Array.isArray(items)) return [];

  const { book, navigationPath = '' } = options;

  return items.map((item, index) => {
    const chapterId = parentPath ? `${parentPath}.${index}` : `${index}`;

    return {
      ...item,
      chapterId,
      href: canonicalTocHref(item?.href || '', book, navigationPath),
      label: cleanLabel(item?.label),
      startCfi: null,
      startProgress: null,
      subitems: prepareTocItems(item?.subitems, chapterId, options),
    };
  });
}

export function flattenTocItems<T extends { subitems?: T[] }>(items: T[] | undefined): T[] {
  if (!Array.isArray(items)) return [];

  return items.flatMap((item) => [
    item,
    ...flattenTocItems(item.subitems),
  ]);
}

export function createReadingSections(items: TocInput[], book: ReaderBook): ReadingSection[] {
  const spineItems = book?.spine?.spineItems;
  if (!Array.isArray(spineItems) || spineItems.length === 0) return [];

  const seenTargets = new Set();
  const boundaries = flattenTocItems(items).flatMap((item, order) => {
    const href = item?.href || '';
    const section = book?.spine?.get?.(item?.href || '');
    if (!section || !Number.isInteger(section.index) || seenTargets.has(href)) {
      return [];
    }

    seenTargets.add(href);
    return [{
      href,
      index: section.index,
      order,
    }];
  }).sort((first, second) => first.index - second.index || first.order - second.order);

  return boundaries.map((boundary, boundaryIndex) => {
    const nextBoundary = boundaries[boundaryIndex + 1];
    const endExclusive = !nextBoundary
      ? spineItems.length
      : nextBoundary.index > boundary.index
        ? Math.min(
          spineItems.length,
          nextBoundary.index + (nextBoundary.href.includes('#') ? 1 : 0),
        )
        : Math.min(spineItems.length, boundary.index + 1);
    const sectionIndexes = [];
    for (let sectionIndex = boundary.index; sectionIndex < endExclusive; sectionIndex += 1) {
      const isBoundaryDocument = sectionIndex === boundary.index || (
        nextBoundary?.href.includes('#') && sectionIndex === nextBoundary.index
      );
      if (isBoundaryDocument || spineItems[sectionIndex]?.linear) {
        sectionIndexes.push(sectionIndex);
      }
    }

    return {
      endHref: nextBoundary?.href || null,
      id: boundary.href,
      sectionIndexes,
      startHref: boundary.href,
    };
  });
}

function compareCfis(book: ReaderBook | undefined, first: string, second: string | null | undefined) {
  try {
    const result = book?.locations?.epubcfi?.compare(first, second || '');
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

export function findCurrentTocItem<T extends TocInput & { subitems?: T[] }>(items: T[], { book, cfi, href }: { book?: ReaderBook; cfi?: string | null; href?: string } = {}) {
  const flatItems = flattenTocItems(items);
  const currentDocument = hrefDocument(href);
  let bestMatch: T | null = null;

  if (cfi) {
    flatItems.forEach((item) => {
      if (!item.startCfi) return;

      const position = compareCfis(book, item.startCfi, cfi);
      if (position === null || position > 0) return;

      if (!bestMatch) {
        bestMatch = item;
        return;
      }

      const bestPosition = compareCfis(book, item.startCfi, bestMatch.startCfi);
      // Prefer the later item when two nested entries point at the same place.
      if (bestPosition !== null && bestPosition >= 0) bestMatch = item;
    });
  }

  if (bestMatch) {
    if (!currentDocument || hrefDocument((bestMatch as T).href) === currentDocument) {
      return bestMatch;
    }

    const exactDocumentMatches = flatItems.filter((item) => (
      hrefDocument(item.href) === currentDocument
    ));
    if (exactDocumentMatches.length === 1) return exactDocumentMatches[0];
    return bestMatch;
  }

  if (!currentDocument) return null;

  return flatItems.find((item) => hrefDocument(item.href) === currentDocument) || null;
}

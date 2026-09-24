import type { ChapterProgress } from '@lan-reader/shared';
import type { ReadingSection, TocItem } from '../types/epub.js';
import { flattenTocItems } from './epubToc.js';

type Compare = (a: string, b: string) => number;
const unknown = (): ChapterProgress => ({ chapterCount: null, chapterIndex: null });
function compareExact(compare: Compare, a: string, b: string) {
  const result = compare(a, b);
  if (!Number.isFinite(result)) throw new Error('Uncomparable chapter boundary');
  return result;
}

/** Normalize once per open; incomplete in-spine targets invalidate the whole count. */
export function createChapterBoundaries(toc: TocItem[], sections: ReadingSection[], compare: Compare): string[] | null {
  const candidates = new Set(sections.map(section => section.startHref));
  const entries = flattenTocItems(toc).filter(item => item.href && candidates.has(item.href));
  if (!entries.length || entries.some(item => !item.startCfi)) return null;
  try {
    const boundaries = entries.map(item => item.startCfi!).sort((a, b) => compareExact(compare, a, b));
    return boundaries.filter((cfi, index) => index === 0 || compareExact(compare, boundaries[index - 1]!, cfi) !== 0);
  } catch { return null; }
}

/** The accepted CFI, never a display label fallback or estimated percentage. */
export function chapterProgressAt(boundaries: readonly string[] | null, cfi: string, compare: Compare): ChapterProgress {
  if (!boundaries?.length || !cfi) return unknown();
  try {
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compareExact(compare, boundaries[middle]!, cfi) <= 0) low = middle + 1;
      else high = middle;
    }
    return { chapterCount: boundaries.length, chapterIndex: low - 1 };
  } catch { return unknown(); }
}

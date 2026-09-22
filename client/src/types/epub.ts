export type Awaitable<T> = T | PromiseLike<T>;
export interface ReaderLocation { start?: { index?: number; href?: string; cfi?: string; percentage?: number; displayed?: { page?: number; total?: number } }; atStart?: boolean; atEnd?: boolean }
export interface EpubSection { index: number; href?: string; linear?: boolean }
export interface ReaderBook { spine?: { spineItems?: EpubSection[]; get?: (target: string | number) => EpubSection | null | undefined }; locations?: { epubcfi?: { compare: (a: string, b: string) => number } } }
export type ReaderRendition = import('../reader/types').ReaderEngine;
export interface TocInput {
  chapterId?: string;
  startCfi?: string | null;
  startProgress?: number | null;
  id?: string;
  href?: string;
  label?: string;
  subitems?: TocInput[];
}
export interface TocItem extends TocInput {
  chapterId: string;
  href: string;
  label: string;
  startCfi: string | null;
  startProgress: number | null;
  subitems: TocItem[];
}
export interface ReadingSection {
  id: string;
  sectionIndexes: number[];
  startHref?: string;
  endHref?: string | null;
}
export interface PageRange { startPage: number; endPage: number }
export type PageRanges = Map<number, PageRange>;
export interface TargetMeasurement { page: number; sectionIndex: number; total: number }

import type { Location } from 'epubjs/types/rendition';
import type Contents from 'epubjs/types/contents';

export type Awaitable<T> = T | PromiseLike<T>;
export type ReaderLocation = Partial<Omit<Location, 'start' | 'end'>> & {
  start?: Partial<Omit<Location['start'], 'displayed'>> & { displayed?: Partial<Location['start']['displayed']> };
  end?: Partial<Omit<Location['end'], 'displayed'>> & { displayed?: Partial<Location['end']['displayed']> };
};
export type ReaderContents = Partial<Pick<Contents, 'document' | 'cfiFromRange' | 'css' | 'addStylesheetCss'>> & { sectionIndex?: number };
export interface EpubSection {
  index: number;
  href?: string;
  linear?: boolean;
  prev?: () => EpubSection | null | undefined;
  next?: () => EpubSection | null | undefined;
  contents?: Element | null;
  document?: Document;
  load?: (request?: (path: string) => Promise<object>) => Awaitable<Element | Document>;
  cfiFromElement?: (element: Element) => string;
  unload?: () => void;
}
export interface ReaderBook {
  spine?: {
    get?: (target: string | number) => EpubSection | null | undefined;
    spineItems?: EpubSection[];
  };
  locations?: {
    epubcfi?: { compare: (first: string, second: string) => number };
    save?: () => string | string[];
    percentageFromCfi?: (cfi: string) => number;
  };
  load?: (path: string) => Promise<object>;
}
export interface EpubStyle { overflowAnchor?: string; transform?: string; willChange?: string }
export interface EpubAnimation { cancel: () => void; finished: PromiseLike<unknown>; startTime: number | CSSNumericValue | null }
/** Only geometry/style capabilities consumed by private-manager adapters. */
export interface EpubElement {
  offsetLeft?: number; offsetWidth?: number; offsetHeight?: number;
  clientWidth?: number; clientHeight?: number; scrollWidth?: number;
  scrollLeft?: number; style?: EpubStyle; isConnected?: boolean;
  classList?: Pick<DOMTokenList, 'contains'>;
  querySelector?: (selector: 'iframe') => HTMLIFrameElement | null;
  getBoundingClientRect?: () => Partial<DOMRect>;
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => EpubAnimation;
  getAnimations?: () => EpubAnimation[];
  addEventListener?: (type: string, callback: () => void) => void;
  removeEventListener?: (type: string, callback: () => void) => void;
}
export interface EpubScroller extends EpubElement { scrollLeft: number }
export interface EpubObserver { disconnect: () => void; observe: (element: EpubElement) => void }
/** Private manager members inspected against epubjs 0.3.93 sources. */
export interface EpubView {
  displayed?: boolean;
  element?: EpubElement;
  section?: EpubSection;
  display?: (...args: unknown[]) => unknown;
  contents?: ReaderContents;
  iframe?: HTMLIFrameElement;
}
export interface EpubManager {
  name?: string;
  isPaginated?: boolean;
  ignore?: boolean;
  settings?: { axis?: string; direction?: string; rtlScrollType?: string; snap?: boolean | object; gap?: number };
  container?: EpubScroller;
  layout?: { pageWidth?: number; divisor?: number; delta?: number };
  views?: {
    all?: () => EpubView[];
    _views?: EpubView[];
    first?: () => EpubView | undefined;
    displayed?: () => EpubView[];
    container?: EpubScroller;
  };
  visible?: () => EpubView[];
  q?: { enqueue: (task: () => unknown) => unknown; stop?: () => void };
  snapper?: object;
  scrollLeft?: number;
  scrollTo?: (left: number, top: number, silent?: boolean) => void;
  update?: () => unknown;
  updateLayout?: () => void;
  display?: (section: EpubSection | string, target?: string) => unknown;
  erase?: (view: EpubView, above?: boolean | EpubView[]) => unknown;
  next?: () => unknown;
  prev?: () => unknown;
  prepend?: (section: EpubSection) => EpubView;
}
export interface ReaderRendition {
  manager?: EpubManager;
  /** Pinned rendition queue, distinct from the continuous manager queue. */
  q?: { enqueue: (task: () => unknown) => unknown; stop?: () => void };
  currentLocation?: () => Awaitable<ReaderLocation | null | undefined>;
  display?: (target?: string | number) => unknown;
  next?: () => unknown;
  prev?: () => unknown;
  reportLocation?: () => unknown;
  on?: (event: string, callback: (location: ReaderLocation) => void) => unknown;
  off?: (event: string, callback: (location: ReaderLocation) => void) => unknown;
}
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

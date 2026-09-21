import type EpubBook from 'epubjs/types/book';
import type { RenditionOptions } from 'epubjs/types/rendition';
import type Themes from 'epubjs/types/themes';
import type { Awaitable, EpubView, ReaderBook, ReaderContents, ReaderLocation, ReaderRendition, TocInput } from './epub.js';

/** Runtime capabilities needed by the reader session, separate from navigation fixtures. */
export interface SessionRendition extends ReaderRendition {
  display: (target?: string | number) => Awaitable<unknown>;
  getContents: () => ReaderContents[];
  hooks: { content: { register: (callback: (contents: ReaderContents) => void) => void } };
  on: (event: string, listener: (location: ReaderLocation, view?: EpubView) => void) => unknown;
  off: (event: string, listener: (location: ReaderLocation, view?: EpubView) => void) => unknown;
  themes?: Pick<Themes, 'register' | 'select' | 'override' | 'fontSize' | 'font'>;
  resize?: () => void;
  clear?: () => void;
  destroy: () => void;
}
export interface SessionBook extends ReaderBook {
  /** Releases the Book and its renderTo rendition, as epub.js Book.destroy does. */
  destroy: () => void;
  renderTo: (container: HTMLElement, options: RenditionOptions & { gap?: number; snap?: boolean }) => SessionRendition;
  loaded: { navigation: Promise<{ toc: TocInput[] }> };
  locations: NonNullable<ReaderBook['locations']> & { generate: (breakSize: number) => Promise<unknown> };
  packaging?: { navPath?: string; ncxPath?: string };
}
/** epub.js has incorrect getContents/currentLocation declarations; private fields are local. */
export function sessionBook(book: EpubBook): SessionBook {
  return book as unknown as SessionBook;
}

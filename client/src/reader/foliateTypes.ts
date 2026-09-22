export interface NavigationTarget { index: number; anchor?: ((doc: Document) => Range | Element | number) | number }
export interface FoliateSection { id: string; cfi: string; size: number; linear?: string; createDocument(): Promise<Document> }
export interface FoliateToc { label: string; href: string; subitems?: FoliateToc[] }
export interface FoliateBook {
  sections: FoliateSection[];
  toc?: FoliateToc[];
  dir?: string;
  rendition?: { layout?: string };
  transformTarget: EventTarget;
  resolveHref(href: string): NavigationTarget;
  destroy(): void;
}
export interface FoliateLocation { cfi: string; range: Range | null; fraction: number; section?: { current: number }; tocItem?: FoliateToc }
export interface FoliateRenderer extends HTMLElement {
  page: number;
  pages: number;
  atStart: boolean;
  atEnd: boolean;
  goTo(target: NavigationTarget): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  getContents(): { doc: Document; index?: number }[];
  setStyles?(css: string): void;
}

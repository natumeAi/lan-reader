declare module 'foliate-js/epub.js' {
  export class EPUB {
    constructor(loader: { loadText: (name: string) => string | null; loadBlob: (name: string) => Blob | null; getSize: (name: string) => number });
    init(): Promise<import('./foliateTypes').FoliateBook>;
  }
}
declare module 'foliate-js/view.js' {
  export class View extends HTMLElement {
    book: import('./foliateTypes').FoliateBook;
    renderer: import('./foliateTypes').FoliateRenderer;
    isFixedLayout: boolean;
    lastLocation: import('./foliateTypes').FoliateLocation | null;
    open(book: import('./foliateTypes').FoliateBook): Promise<void>;
    close(): void;
    getCFI(index: number, range?: Range): string;
    resolveCFI(cfi: string): import('./foliateTypes').NavigationTarget;
    resolveNavigation(target: string | number): import('./foliateTypes').NavigationTarget | undefined;
    getSectionFractions(): number[];
  }
}
declare module 'foliate-js/epubcfi.js' {
  export function compare(a: string, b: string): number;
}

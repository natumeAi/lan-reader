import { EPUB } from 'foliate-js/epub.js';
import { View } from 'foliate-js/view.js';
import { compare } from 'foliate-js/epubcfi.js';
import { unzipSync, strFromU8 } from 'fflate';
import type { FoliateBook, NavigationTarget } from './foliateTypes';
import type { ReaderEngine, ReaderState, StablePosition, NavigationCommand, NavigationResult } from './types';
import type { ReaderLocation, TocItem, ReadingSection, PageRanges } from '../types/epub';
import type { ReaderSettings } from '../hooks/useReaderSettings';
import { getFoliateStyles } from '../hooks/useReaderSettings';
import { createReadingSections, findCurrentTocItem, flattenTocItems, prepareTocItems } from '../utils/epubToc';
import { createSectionPagination } from './sectionPagination';
import { protectBookDocument } from './contentSecurity';
import { createPageTurnPreview, turnAdjacentView } from './pageTurnPreview';
import { waitForFrameOrTimeout } from '../utils/animationFrame';

// Layout settlement waits two frames, each bounded by a timer so a visible page
// that delivers no frames still opens (instead of hitting the operation deadline).
const paint = async () => { await waitForFrameOrTimeout(); await waitForFrameOrTimeout(); };
// Disposal must let upstream frame callbacks drain; never race a timer here.
const drainFrames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class FoliateEngine implements ReaderEngine {
  readonly element = new View();
  state: ReaderState = 'loading';
  stable: StablePosition | null = null;
  toc: TocItem[] = [];
  readingSections: ReadingSection[] = [];
  restoreTarget: string | number = 0;
  private book: FoliateBook | null = null;
  private documentSections = new WeakMap<Document, number>();
  private epoch = 0;
  private workTail: Promise<void> = Promise.resolve();
  private locationCache: { key: string; value: ReaderLocation } | null = null;
  private settings: ReaderSettings;
  private settingsKey = '';
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private files: Record<string, Uint8Array> = {};
  private pagination: ReturnType<typeof createSectionPagination>;
  private previews: ReturnType<typeof createPageTurnPreview>;
  private observer: ResizeObserver;
  private lastDimensions = '';
  private events: { time: number; event: string; state: ReaderState; cfi: string | null; page?: number; text?: string }[] = [];
  onPosition?: (position: StablePosition) => void;
  onState?: (state: ReaderState, error?: unknown) => void;
  onPages?: (section: ReadingSection, ranges: PageRanges) => void;
  onInvalidatePages?: () => void;
  onLayoutInvalidated?: () => void;
  get direction(): 'ltr' | 'rtl' { return this.book?.dir === 'rtl' ? 'rtl' : 'ltr'; }
  constructor(private container: HTMLElement, settings: ReaderSettings) {
    this.settings = { ...settings };
    this.element.addEventListener('load', event => {
      const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail;
      if (doc && Number.isInteger(index) && index >= 0) this.documentSections.set(doc, index);
    });
    this.previews = createPageTurnPreview({
      container, createBook: () => this.createBook(), createView: () => new View(), configure: view => this.configure(view),
      snapshot: () => this.stable ? { key: `${this.layout()}:${this.stable.cfi}`, cfi: this.stable.cfi, page: this.stable.page } : null,
      available: direction => this.state === 'ready' && Boolean(this.stable) && !(direction === 'next' ? this.stable?.location.atEnd : this.stable?.location.atStart),
      onWorkStart: () => this.pagination.pause(),
      onWorkEnd: () => { if (!this.previews.busy && this.state === 'ready') this.pagination.request(); },
    });
    this.pagination = createSectionPagination({ container, createBook: () => this.createBook(), createView: () => new View(), configure: view => this.configure(view), getSnapshot: () => ({ layoutKey: this.layout(), currentSectionIndex: this.stable?.location.start?.index, readingSections: this.readingSections }), canMeasure: () => this.state === 'ready' && !this.previews.busy, onPages: (section, ranges) => this.onPages?.(section, ranges), onInvalidate: () => this.onInvalidatePages?.() });
    this.element.style.cssText = 'display:block;width:100%;height:100%;contain:layout paint;pointer-events:none;background:var(--reader-bg,#fff)';
    container.append(this.element);
    this.observer = new ResizeObserver(() => {
      const dimensions = this.dimensions();
      if (dimensions === this.lastDimensions) return;
      this.lastDimensions = dimensions;
      this.invalidatePages();
      if (this.onLayoutInvalidated && this.stable) { this.onLayoutInvalidated(); return; }
      if (this.state === 'ready') {
        this.setState('recovering');
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => { void this.resume(); }, 150);
      }
    });
    this.observer.observe(container);
  }
  private dimensions() { return `${Math.round(this.container.clientWidth)}x${Math.round(this.container.clientHeight)}`; }
  private layout() { return `${this.dimensions()}:${this.settingsKey}`; }
  private trace(event: string) {
    this.events.push({ time: Date.now(), event, state: this.state, cfi: this.stable?.cfi ?? null, page: this.stable?.page, text: this.stable?.text });
    if (this.events.length > 80) this.events.shift();
  }
  diagnostics() { return { engine: 'foliate-js@78914aef4466eb960965702401634c2cb348e9b1', state: this.state, stable: this.stable, currentCfi: this.element.lastLocation?.cfi, currentText: this.element.lastLocation?.range?.toString().slice(0, 180), events: [...this.events] }; }
  currentChapter(cfi: string, href?: string) {
    return findCurrentTocItem(this.toc, { cfi, href, book: { locations: { epubcfi: { compare } } } }) ?? null;
  }
  private setState(state: ReaderState, error?: unknown) {
    if (state === 'ready') this.element.style.visibility = '';
    if (state === 'failed') this.previews.invalidate();
    this.state = state; this.trace(state); this.onState?.(state, error);
  }
  private alive(token: number) { return token === this.epoch && this.state !== 'closed' && this.state !== 'suspended'; }
  private async settleLayout(token: number) {
    let previous = this.dimensions();
    await paint();
    for (let i = 0; i < 40; i++) {
      if (!this.alive(token)) throw new Error('Session cancelled');
      const dimensions = this.dimensions();
      if (this.container.clientWidth > 1 && this.container.clientHeight > 1 && dimensions === previous) {
        await Promise.all(this.getContents().map(c => c.document.fonts.ready));
        await paint();
        return;
      }
      previous = dimensions;
      await delay(50);
    }
    throw new Error('阅读窗口尚未稳定');
  }
  private async operation(work: (token: number) => Promise<void | boolean>): Promise<NavigationResult> {
    const token = ++this.epoch;
    this.pauseMeasurement();
    this.setState('recovering');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let boundary = false;
    const job = this.workTail.catch(() => {}).then(async () => {
      if (this.alive(token)) boundary = await work(token) === false;
    });
    this.workTail = job;
    try {
      await Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('阅读位置恢复超时')), 10000); })]);
      if (!this.alive(token)) return { kind: 'cancelled', commandId: token };
      this.setState('ready');
      if (boundary) return { kind: 'boundary', commandId: token };
      return this.stable ? { kind: 'verified', commandId: token, position: this.stable } : { kind: 'unavailable', commandId: token };
    } catch (error) {
      if (!this.alive(token)) return { kind: 'cancelled', commandId: token };
      ++this.epoch; // Late completions may never reopen persistence.
      this.setState('failed', error);
      return { kind: 'failed', commandId: token, error };
    } finally { clearTimeout(timer); }
  }
  async open(data: ArrayBuffer, target: string | number = 0) {
    await this.execute({ kind: 'open', data, target });
  }
  private async openVerified(data: ArrayBuffer, target: string | number = 0) {
    this.restoreTarget = target;
    return this.operation(async token => {
      this.files = unzipSync(new Uint8Array(data));
      const book = await this.createBook();
      if (!this.alive(token)) { book.destroy(); return; }
      this.book = book;
      await this.element.open(book);
      if (!this.alive(token)) return;
      this.configure(this.element);
      const spineItems = book.sections.map((s, index) => ({ index, href: s.id, linear: s.linear !== 'no' }));
      const metadata = { spine: { spineItems, get: (href: string | number) => typeof href === 'number' ? spineItems[href] : spineItems.find(s => s.href === href.split('#')[0]) } };
      this.toc = prepareTocItems(book.toc ?? []);
      this.readingSections = createReadingSections(this.toc, metadata);
      await this.gotoVerified(target, token);
      if (!this.alive(token)) return;
      this.commit();
      // TOC metadata uses the same section-size weighting as the reading percent.
      const fractions = this.element.getSectionFractions();
      for (const item of flattenTocItems(this.toc)) {
        if (!this.alive(token)) return;
        try {
        const resolved = this.resolve(item.href);
        if (this.element.isFixedLayout) {
          item.startCfi = book.sections[resolved.index]!.cfi;
          item.startProgress = fractions[resolved.index] ?? 0;
          continue;
        }
        const doc = await book.sections[resolved.index]!.createDocument();
        const anchor = typeof resolved.anchor === 'function' ? resolved.anchor(doc) : doc.body;
        const range = doc.createRange();
        if (anchor && typeof anchor !== 'number' && 'startContainer' in anchor) range.setStart(anchor.startContainer, anchor.startOffset);
        else range.selectNodeContents(!anchor || typeof anchor === 'number' ? doc.body : anchor);
        range.collapse(true);
        item.startCfi = this.element.getCFI(resolved.index, range);
        const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEnd(range.startContainer, range.startOffset);
        const ratio = before.toString().length / Math.max(1, doc.body.textContent?.length ?? 0);
        item.startProgress = (fractions[resolved.index] ?? 0) + ratio * ((fractions[resolved.index + 1] ?? 1) - (fractions[resolved.index] ?? 0));
        } catch { /* A malformed TOC entry must not invalidate a valid saved CFI. */ }
      }
    });
  }
  private configure(view: View) {
    const renderer = view.renderer;
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('max-column-count', '1');
    renderer.setAttribute('max-inline-size', '100000px');
    renderer.setAttribute('max-block-size', '100000px');
    // Foliate interprets this attribute as a percentage, including in its
    // geometry calculations (a pixel unit would produce invalid columns).
    renderer.setAttribute('gap', `${Math.min(40, (48 + this.settings.horizontalMargin) / Math.max(1, this.container.clientWidth) * 100)}%`);
    renderer.setAttribute('margin', `${60 + this.settings.verticalMargin}px`);
    renderer.removeAttribute('animated');
    renderer.setStyles?.(getFoliateStyles(this.settings, view.isFixedLayout));
    this.settingsKey = JSON.stringify(this.settings);
  }
  private resolve(target: string | number): NavigationTarget {
    if (typeof target === 'string' && !target.startsWith('epubcfi(')) {
      // Older epub.js records store package-relative chapterHref values.
      // Accept a unique matching spine document, never guess among duplicates.
      const hash = target.indexOf('#');
      const path = hash >= 0 ? target.slice(0, hash) : target;
      const suffix = hash >= 0 ? target.slice(hash) : '';
      const matches = this.book?.sections.filter(s => s.id === path || s.id.endsWith(`/${path}`)) ?? [];
      if (matches.length === 1) target = matches[0]!.id + suffix;
    }
    const resolved = this.element.resolveNavigation(target);
    if (!resolved || !this.book?.sections[resolved.index]) throw new Error('无法解析保存的阅读位置');
    return resolved;
  }
  getContents() {
    return (this.element.renderer?.getContents() ?? []).flatMap(c => {
      if (!c.doc) return [];
      const sectionIndex = c.index ?? this.documentSections.get(c.doc)
        ?? (this.element.isFixedLayout ? undefined : this.element.lastLocation?.section?.current);
      // Fixed spreads include blank and opposite-side documents. Never label
      // them using the active side's location when the renderer omits indices.
      return sectionIndex === undefined ? [] : [{ document: c.doc, sectionIndex, frame: c.doc.defaultView?.frameElement as HTMLIFrameElement | null }];
    });
  }
  private isFixedSectionVisible(index: number) {
    const content = this.getContents().find(c => c.sectionIndex === index);
    const frame = content?.frame;
    if (!frame?.isConnected) return false;
    const rect = frame.getBoundingClientRect();
    const viewport = this.container.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > viewport.left + 1
      && rect.left < viewport.right - 1 && rect.bottom > viewport.top && rect.top < viewport.bottom;
  }
  private targetRange(target: string) {
    const resolved = this.resolve(target);
    const content = this.getContents().find(c => c.sectionIndex === resolved.index);
    if (!content || typeof resolved.anchor !== 'function') return null;
    const anchor = resolved.anchor(content.document);
    return typeof anchor !== 'number' && 'startContainer' in anchor ? anchor : null;
  }
  isVisible(target: string) {
    try {
      if (this.element.isFixedLayout) {
        const index = this.resolve(target).index;
        if (index !== this.element.lastLocation?.section?.current || !this.isFixedSectionVisible(index)) return false;
        if (!target.includes('!')) return true;
      }
      const range = this.targetRange(target);
      if (!range) return false;
      const visible = this.element.isFixedLayout ? range.startContainer.ownerDocument?.createRange() : this.element.lastLocation?.range;
      if (this.element.isFixedLayout) visible?.selectNodeContents(range.startContainer.ownerDocument!.documentElement);
      if (!visible || visible.startContainer.ownerDocument !== range.startContainer.ownerDocument) return false;
      const frame = range.startContainer.ownerDocument?.defaultView?.frameElement;
      const f = frame?.getBoundingClientRect();
      const viewport = this.container.getBoundingClientRect();
      if (!frame || !f) return false;
      const scaleX = this.element.isFixedLayout && frame.clientWidth > 0 ? f.width / frame.clientWidth : 1;
      const scaleY = this.element.isFixedLayout && frame.clientHeight > 0 ? f.height / frame.clientHeight : 1;
      const onPage = (r: DOMRect) => r.height > 0 && r.right * scaleX + f.left > viewport.left + 1 && r.left * scaleX + f.left < viewport.right - 1 && r.bottom * scaleY + f.top > viewport.top && r.top * scaleY + f.top < viewport.bottom;
      if (range.startContainer.nodeType === 1) {
        // Element CFIs denote the start of an element, which can precede the
        // first text point in foliate's visible Range (headings and images).
        // Verify the resolved element's FIRST box, never any later column of
        // an arbitrarily long paragraph or the whole chapter.
        // An SVG element CFI resolves inside the SVG at offset zero. Its first
        // child may be formatting whitespace, which has no visible text box;
        // the replaced graphic itself is the content anchor in that case.
        const element = range.startContainer as Element;
        const node = element.matches('svg, img, image, video') ? element
          : element.childNodes[range.startOffset] ?? element;
        if (!visible.intersectsNode(node)) return false;
        const first = range.cloneRange();
        if (node.nodeType === 3) { first.setStart(node, 0); first.setEnd(node, Math.min(1, node.textContent?.length ?? 0)); }
        else first.selectNode(node);
        const rect = [...first.getClientRects()].find(r => r.height > 0);
        return Boolean(rect && onPage(rect));
      }
      // Test the saved start point, not an overlap somewhere in a long range.
      if (visible.comparePoint(range.startContainer, range.startOffset) !== 0) return false;
      const point = range.cloneRange(); point.collapse(true);
      if (point.startContainer.nodeType === 3 && point.startOffset < (point.startContainer.textContent?.length ?? 0)) point.setEnd(point.startContainer, point.startOffset + 1);
      else if (point.startContainer.nodeType === 1) {
        const child = point.startContainer.childNodes[point.startOffset];
        if (child) point.selectNode(child);
      }
      // A collapsed wrap-space has zero-width caret rects. It is still an exact
      // visible point: comparePoint above and its on-page caret geometry must
      // both agree. Never substitute another paragraph or a percentage.
      return [...point.getClientRects()].some(onPage);
    } catch { return false; }
  }
  private async gotoVerified(target: string | number, token: number) {
    await this.settleLayout(token);
    if (!this.alive(token)) return;
    const resolved = this.resolve(target);
    // renderer.goTo propagates exceptions; View.goTo intentionally swallows them.
    await this.element.renderer.goTo(resolved);
    await this.settleLayout(token);
    if (!this.alive(token)) return;
    if (this.element.lastLocation?.section?.current !== resolved.index) throw new Error('阅读位置未到达目标章节');
    if (this.element.isFixedLayout && !this.isFixedSectionVisible(resolved.index)) throw new Error('目标固定版式页面不可见');
    if (typeof target === 'string' && target.startsWith('epubcfi(')) {
      const range = this.element.isFixedLayout && !target.includes('!') ? null : this.targetRange(target);
      if (range && compare(this.element.getCFI(resolved.index, range), target) !== 0) throw new Error('保存的 CFI 无法精确往返解析');
      if (!this.isVisible(target)) throw new Error('目标内容不在当前可见页');
    }
  }
  currentLocation(): ReaderLocation | null {
    const last = this.element.lastLocation;
    if (!last || !this.book) return null;
    const index = last.section?.current ?? 0;
    const renderer = this.element.renderer;
    const page = this.element.isFixedLayout ? 1 : renderer.page;
    const total = this.element.isFixedLayout ? 1 : Math.max(1, renderer.pages - 2);
    const cacheKey = `${last.cfi}:${index}:${page}:${total}:${this.settingsKey}`;
    if (this.locationCache?.key === cacheKey) return this.locationCache.value;
    const atEnd = this.element.isFixedLayout ? index === this.book.sections.length - 1 : renderer.atEnd;
    // TOC boundaries and visible position share section-size weighting and the
    // text offset within that section. No full-book text-location generation.
    let fraction = last.fraction || 0;
    if (last.range) {
      const doc = last.range.startContainer.ownerDocument!;
      const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEnd(last.range.startContainer, last.range.startOffset);
      const boundaries = this.element.getSectionFractions();
      const ratio = before.toString().length / Math.max(1, doc.body.textContent?.length ?? 0);
      fraction = (boundaries[index] ?? 0) + ratio * ((boundaries[index + 1] ?? 1) - (boundaries[index] ?? 0));
    }
    const value = { start: { index, href: this.book.sections[index]!.id, cfi: last.cfi, displayed: { page, total }, percentage: atEnd ? 1 : Math.min(0.999999, Math.max(0, fraction)) }, atEnd, atStart: index === 0 && page === 1 };
    this.locationCache = { key: cacheKey, value };
    return value;
  }
  private commit() {
    const location = this.currentLocation();
    const last = this.element.lastLocation;
    if (!location || !last) throw new Error('没有有效阅读位置');
    let cfi = last.cfi;
    const visible = last.range;
    if (visible) {
      // Pick a point inside the actual visible range, never halfway through an
      // entire paragraph (which may span several pages).
      const walker = visible.startContainer.ownerDocument!.createTreeWalker(visible.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      if (visible.commonAncestorContainer.nodeType === 3) nodes.push(visible.commonAncestorContainer as Text);
      else { while (walker.nextNode()) if (visible.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode as Text); }
      const pieces = nodes.map(node => ({ node, start: node === visible.startContainer ? visible.startOffset : 0, end: node === visible.endContainer ? visible.endOffset : node.length })).filter(p => p.end > p.start && /\S/.test(p.node.data.slice(p.start, p.end)));
      let middle = Math.floor(pieces.reduce((sum, p) => sum + p.end - p.start, 0) / 2);
      for (const p of pieces) {
        if (middle < p.end - p.start) {
          let offset = p.start + middle;
          // Stay within the visible slice, avoiding zero-width wrap spaces in
          // newly saved CFIs without shifting historic anchors on restoration.
          for (let distance = 0; distance < p.end - p.start; distance++) {
            const next = offset + distance;
            const previous = offset - distance;
            if (next < p.end && /\S/.test(p.node.data[next]!)) { offset = next; break; }
            if (previous >= p.start && /\S/.test(p.node.data[previous]!)) { offset = previous; break; }
          }
          const anchor = visible.cloneRange(); anchor.setStart(p.node, offset); anchor.collapse(true);
          cfi = this.element.getCFI(location.start!.index!, anchor); break;
        }
        middle -= p.end - p.start;
      }
      if (!pieces.length) {
        // Image-only covers still contain XML indentation text. Save a verified
        // element CFI instead of a zero-area whitespace point. Keep checking
        // both the visible range and actual geometry, including on restoration.
        const doc = visible.startContainer.ownerDocument!;
        for (const graphic of doc.querySelectorAll('svg, img, image, video')) {
          if (!visible.intersectsNode(graphic)) continue;
          const anchor = doc.createRange(); anchor.selectNodeContents(graphic); anchor.collapse(true);
          const candidate = this.element.getCFI(location.start!.index!, anchor);
          if (this.isVisible(candidate)) { cfi = candidate; break; }
        }
      }
      if (!this.isVisible(cfi)) throw new Error('无法校验当前可见内容');
    }
    location.start!.cfi = cfi;
    this.stable = { cfi, location, text: visible?.toString().slice(0, 180) ?? '', layout: this.layout(), page: location.start!.displayed!.page! };
    this.restoreTarget = cfi;
    // The controller may still be covering the newly navigated foreground with
    // its preview. Keep that exact surface until it explicitly cancels it.
    this.previews.invalidate(true);
    this.trace('verified');
  }
  publish() { if (this.state === 'ready' && this.stable) this.onPosition?.(this.stable); }
  async display(target: string | number) {
    await this.execute({ kind: 'display', target });
  }
  async turn(direction: 'next' | 'prev') {
    await this.execute({ kind: 'turn', direction });
  }
  async execute(command: NavigationCommand): Promise<NavigationResult> {
    if (this.state === 'closed') return { kind: 'unavailable', commandId: this.epoch };
    if (command.kind === 'open') return this.openVerified(command.data, command.target);
    if (command.kind === 'turn' || command.kind === 'display') {
      if (this.state !== 'ready') return { kind: 'unavailable', commandId: this.epoch };
    }
    if (command.kind === 'turn') return this.operation(async token => {
      if (!await turnAdjacentView(this.element, this.book!, command.direction)) return false;
      await this.settleLayout(token);
      if (this.alive(token)) this.commit();
    });
    const previous = this.stable;
    this.previews.invalidate();
    return this.operation(async token => {
      if (command.kind === 'settings') {
        this.settings = { ...command.settings }; this.configure(this.element); this.invalidatePages();
      } else if (command.kind === 'restore') this.configure(this.element);
      await this.gotoVerified(command.target, token);
      if (!this.alive(token)) return;
      if (command.kind === 'restore' && previous?.cfi === command.target && previous.layout === this.layout()
        && previous.page !== this.currentLocation()?.start?.displayed?.page) throw new Error('同布局恢复后的页码与离开时不同');
      this.commit();
    });
  }
  prepareTurn(direction: 'next' | 'prev') { return this.previews.prepare(direction); }
  cancelTurnPreview() { this.previews.cancel(); if (this.state === 'ready') this.previews.warm(); }
  suspend() {
    if (this.state === 'closed' || this.state === 'suspended' || this.state === 'failed') return;
    ++this.epoch; this.pauseMeasurement(); clearTimeout(this.resizeTimer);
    this.previews.invalidate();
    this.element.style.visibility = 'hidden';
    this.setState('suspended');
  }
  async resume() {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.element.style.visibility = 'hidden';
    await this.execute({ kind: 'restore', target: this.stable?.cfi ?? this.restoreTarget });
  }
  async applySettings(settings: ReaderSettings) {
    if (JSON.stringify(settings) === this.settingsKey || this.state !== 'ready') return;
    await this.execute({ kind: 'settings', settings, target: this.stable?.cfi ?? this.restoreTarget });
  }
  private invalidatePages() { this.pagination.invalidate(); this.previews.invalidate(); }
  pauseMeasurement() { this.pagination.pause(); this.previews.pauseWarm(); }
  schedulePages() { this.pagination.request(); this.previews.warm(); }
  private async createBook() {
    const files = this.files;
      const book = await new EPUB({
        loadText: name => files[name] ? strFromU8(files[name]) : null,
        loadBlob: name => files[name] ? new Blob([files[name]!.slice().buffer as ArrayBuffer]) : null,
        getSize: name => files[name]?.length ?? 0,
      }).init();
      book.transformTarget.addEventListener('load', event => {
        const detail = (event as CustomEvent<{ isScript: boolean; allow: boolean }>).detail;
        if (detail.isScript) detail.allow = false;
      });
      book.transformTarget.addEventListener('data', event => {
        const detail = (event as CustomEvent<{ type: string; data: string | Promise<string> }>).detail;
        if (['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(detail.type)) {
          detail.data = Promise.resolve(detail.data).then(source => protectBookDocument(source, detail.type));
        }
      });
    return book;
  }
  destroy() {
    if (this.state === 'closed') return;
    ++this.epoch; this.pauseMeasurement(); clearTimeout(this.resizeTimer); this.observer.disconnect();
    this.setState('closed');
    const book = this.book;
    const release = async () => {
      // Foliate schedules style/font callbacks for the next paint. Close only
      // after the actual navigation job and those callbacks have drained.
      await drainFrames();
      try { this.element.close(); } finally { book?.destroy(); }
    };
    // Invalidate immediately, then release once. A late iframe may finish in
    // the detached element, but cannot publish or leak a new live renderer.
    void this.workTail.then(release, release);
    this.pagination.destroy(); this.previews.destroy(); this.element.remove(); this.book = null; this.files = {};
  }
}

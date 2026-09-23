import type { View } from 'foliate-js/view.js';
import { compare } from 'foliate-js/epubcfi.js';
import type { FoliateBook } from './foliateTypes';
import type { PreparedSurface, SurfaceOwner, SurfaceProvider, SurfaceRequest } from './bufferTypes';
import { turnAdjacentView } from './foliateNavigation';
import { beginReaderWork } from './diagnostics';
import { getVisiblePageTextAnchor } from './visiblePageAnchor';

interface Options {
  container: HTMLElement;
  /** Must create an independent Book with the same content-security transforms as foreground. */
  createBook: () => Promise<FoliateBook>;
  createView: () => View;
  configure: (view: View, request: SurfaceRequest) => void;
  onInvalidated?: (ownerId: string, reason: string) => void;
}
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function imageReady(image: HTMLImageElement) {
  if (!image.complete) await new Promise<void>(resolve => {
    const finish = () => { image.removeEventListener('load', finish); image.removeEventListener('error', finish); resolve(); };
    image.addEventListener('load', finish, { once: true }); image.addEventListener('error', finish, { once: true });
    if (image.complete) finish();
  });
  // Broken images are settled resources too; they do not justify an endless wait.
  if (image.naturalWidth && typeof image.decode === 'function') await image.decode().catch(() => {});
}
async function resources(view: View, onStage: (stage: string) => void, beforeFrames?: () => void) {
  onStage('fonts-images');
  const pending = view.renderer.getContents().flatMap(({ doc }) => [doc.fonts?.ready, ...Array.from(doc.images, imageReady)]);
  // One rejected font cannot release an owner while a sibling image is decoding.
  const settled = await Promise.allSettled(pending);
  beforeFrames?.();
  // Real frame callbacks must finish before motion, not merely a timeout winning.
  onStage('frames');
  await frames();
  const failed = settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

/** Verify a start point, not a later box from a multi-column paragraph. */
function visibleAnchor(view: View, cfi: string, viewport: DOMRect, sections: WeakMap<Document, number>) {
  const resolved = view.resolveNavigation(cfi);
  if (!resolved || resolved.index !== view.lastLocation?.section?.current) return false;
  const content = view.renderer.getContents().find(item => (item.index ?? sections.get(item.doc)) === resolved.index);
  const frame = content?.doc.defaultView?.frameElement;
  if (!content || !frame?.isConnected) return false;
  const box = frame.getBoundingClientRect();
  if (view.isFixedLayout && (box.width <= 0 || box.height <= 0 || box.right <= viewport.left + 1 || box.left >= viewport.right - 1 || box.bottom <= viewport.top || box.top >= viewport.bottom)) return false;
  if (view.isFixedLayout && !cfi.includes('!')) return true;
  if (typeof resolved.anchor !== 'function') return false;
  const anchor = resolved.anchor(content.doc);
  if (typeof anchor === 'number' || !('startContainer' in anchor)) return false;
  if (compare(view.getCFI(resolved.index, anchor), cfi) !== 0) return false;
  const visible = view.isFixedLayout ? content.doc.createRange() : view.lastLocation?.range;
  if (view.isFixedLayout) visible?.selectNodeContents(content.doc.documentElement);
  if (!visible || visible.startContainer.ownerDocument !== anchor.startContainer.ownerDocument) return false;
  const scaleX = view.isFixedLayout && frame.clientWidth > 0 ? box.width / frame.clientWidth : 1;
  const scaleY = view.isFixedLayout && frame.clientHeight > 0 ? box.height / frame.clientHeight : 1;
  const onPage = (rect: DOMRect) => rect.height > 0 && rect.right * scaleX + box.left > viewport.left + 1 && rect.left * scaleX + box.left < viewport.right - 1 && rect.bottom * scaleY + box.top > viewport.top && rect.top * scaleY + box.top < viewport.bottom;
  const point = anchor.cloneRange();
  if (anchor.startContainer.nodeType === 1) {
    const element = anchor.startContainer as Element;
    const node = element.matches('svg,img,image,video') ? element : element.childNodes[anchor.startOffset] ?? element;
    if (!visible.intersectsNode(node)) return false;
    if (node.nodeType === 3) { point.setStart(node, 0); point.setEnd(node, Math.min(1, node.textContent?.length ?? 0)); }
    else point.selectNode(node);
    const first = Array.from(point.getClientRects()).find(rect => rect.height > 0);
    return Boolean(first && onPage(first));
  }
  if (visible.comparePoint(anchor.startContainer, anchor.startOffset) !== 0) return false;
  point.collapse(true);
  if (point.startContainer.nodeType === 3 && point.startOffset < (point.startContainer.textContent?.length ?? 0)) point.setEnd(point.startContainer, point.startOffset + 1);
  return Array.from(point.getClientRects()).some(onPage);
}

function targetProof(view: View, viewport: DOMRect, sections: WeakMap<Document, number>) {
  const last = view.lastLocation;
  const index = last?.section?.current;
  if (!last || index === undefined) return null;
  const page = view.isFixedLayout ? 1 : view.renderer.page;
  const total = view.isFixedLayout ? 1 : view.renderer.pages - 2;
  if (page < 1 || !Number.isFinite(page) || !Number.isFinite(total) || page > total) return null;
  const candidates: string[] = [last.cfi];
  const visible = last.range;
  if (visible) {
    const textAnchor = getVisiblePageTextAnchor(visible);
    // The first visible point can belong to a preceding tiny chapter on the
    // same page. Use the foreground's anchor policy for display metadata too.
    if (textAnchor) candidates.unshift(view.getCFI(index, textAnchor));
    const doc = visible.startContainer.ownerDocument!;
    const walker = doc.createTreeWalker(visible.commonAncestorContainer, 4 /* SHOW_TEXT */);
    const nodes: Node[] = visible.commonAncestorContainer.nodeType === 3 ? [visible.commonAncestorContainer] : [];
    while (walker.nextNode()) if (visible.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const start = node === visible.startContainer ? visible.startOffset : 0;
      const end = node === visible.endContainer ? visible.endOffset : node.textContent?.length ?? 0;
      const text = node.textContent?.slice(start, end) ?? '';
      const offset = text.search(/\S/);
      if (offset < 0) continue;
      const point = doc.createRange(); point.setStart(node, start + offset); point.collapse(true);
      candidates.push(view.getCFI(index, point));
    }
    for (const graphic of doc.querySelectorAll('svg,img,image,video')) {
      if (!visible.intersectsNode(graphic)) continue;
      const point = doc.createRange(); point.selectNodeContents(graphic); point.collapse(true);
      candidates.push(view.getCFI(index, point));
    }
  }
  const cfi = candidates.find(candidate => visibleAnchor(view, candidate, viewport, sections));
  return cfi ? { sectionIndex: index, page, total, cfi } : null;
}

export function observeFoliateSurface(prepared: View, invalidate: (reason: string) => void): () => void {
  const cleanups: (() => void)[] = [];
  let active = true;
  const sizes = new WeakMap<Element, string>();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    if (!active) return;
    for (const entry of entries) {
      const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
      const before = sizes.get(entry.target); sizes.set(entry.target, size);
      if (before !== undefined && before !== size) invalidate('body-resize');
    }
  });
  cleanups.push(() => observer?.disconnect());
  for (const { doc } of prepared.renderer.getContents()) {
    if (doc.body) observer?.observe(doc.body);
    const imageChanged = (event: Event) => { if (active && (event.target as Element | null)?.localName === 'img') invalidate('image'); };
    const fontChanged = () => { if (active) invalidate('fonts'); };
    doc.addEventListener('load', imageChanged, true); doc.addEventListener('error', imageChanged, true);
    doc.fonts?.addEventListener('loadingdone', fontChanged); doc.fonts?.addEventListener('loadingerror', fontChanged);
    cleanups.push(() => {
      doc.removeEventListener('load', imageChanged, true); doc.removeEventListener('error', imageChanged, true);
      doc.fonts?.removeEventListener('loadingdone', fontChanged); doc.fonts?.removeEventListener('loadingerror', fontChanged);
    });
  }
  return () => { active = false; for (const cleanup of cleanups.splice(0)) cleanup(); };
}

/** Owns independent hidden documents, never motion or position publication. */
export function createFoliateSurfaceProvider(options: Options): SurfaceProvider {
  let sequence = 0;
  return {
    create(request): SurfaceOwner {
      const id = `foliate-surface-${++sequence}`;
      let frozen: SurfaceRequest = { ...request, key: { ...request.key }, settings: { ...request.settings } };
      let stopped = false;
      let published = false;
      let invalidated = false;
      let generation = 0;
      let view: View | undefined;
      let book: FoliateBook | undefined;
      let disposal: Promise<void> | undefined;
      let workRevision = 0; let drainedRevision = -1;
      let frameDrain: Promise<void> | undefined;
      const cleanups: (() => void)[] = [];
      const sections = new WeakMap<Document, number>();
      const diagnostics = beginReaderWork('preview');
      const unobserve = () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
      const invalidate = (reason: string, preparedGeneration: number) => {
        if (stopped || !published || preparedGeneration !== generation) return;
        ++workRevision;
        if (invalidated) return;
        invalidated = true; options.onInvalidated?.(id, reason);
      };
      const stop = () => {
        if (!stopped) { stopped = true; ++generation; ++workRevision; }
        unobserve();
      };
      const prepare = (snapshot: SurfaceRequest, preparedGeneration: number): Promise<PreparedSurface | null> => (async () => {
        const active = () => !stopped && generation === preparedGeneration;
        try {
          if (!book) {
            diagnostics?.stage('create-book');
            book = await options.createBook(); diagnostics?.bookCreated();
          }
          if (!active()) return null;
          const fresh = !view;
          if (!view) { view = options.createView(); diagnostics?.viewCreated(); }
          view.style.cssText = `display:block;position:absolute;inset:0;width:${snapshot.width}px;height:${snapshot.height}px;z-index:2;visibility:hidden;pointer-events:none;contain:layout paint;background:var(--reader-bg,#fff)`;
          view.setAttribute('aria-hidden', 'true');
          const loaded = (event: Event) => {
            const detail = (event as CustomEvent<{ doc: Document; index: number }>).detail;
            if (detail?.doc && Number.isInteger(detail.index)) sections.set(detail.doc, detail.index);
          };
          view.addEventListener('load', loaded); cleanups.push(() => view?.removeEventListener('load', loaded));
          if (fresh) {
            options.container.append(view);
            diagnostics?.stage('open-view');
            await view.open(book);
          }
          if (!active()) return null;
          diagnostics?.stage('configure');
          options.configure(view, snapshot);
          const origin = view.resolveNavigation(snapshot.cfi);
          if (!origin) { diagnostics?.fail('origin-unresolved'); return null; }
          diagnostics?.stage('origin-navigation');
          await view.renderer.goTo(origin);
          if (!active()) return null;
          diagnostics?.stage('origin-resources');
          await resources(view, stage => diagnostics?.stage(`origin-${stage}`)); if (!active()) return null;
          diagnostics?.stage('origin-proof');
          const viewport = options.container.getBoundingClientRect();
          if (!visibleAnchor(view, snapshot.cfi, viewport, sections)) { diagnostics?.fail('origin-cfi-not-visible'); return null; }
          if (!view.isFixedLayout && view.renderer.page !== snapshot.page) { diagnostics?.fail('origin-page-mismatch'); return null; }
          diagnostics?.stage('target-navigation');
          if (!await turnAdjacentView(view, book, snapshot.direction)) { diagnostics?.fail('target-boundary'); return null; }
          if (!active()) return null;
          diagnostics?.stage('target-resources');
          await resources(view, stage => diagnostics?.stage(`target-${stage}`), () => {
            // Establish ResizeObserver baselines during the same two real frames
            // that settle target resources, then verify the resulting position.
            if (view && active()) cleanups.push(observeFoliateSurface(view, reason => invalidate(reason, preparedGeneration)));
          }); if (!active()) return null;
          diagnostics?.stage('target-proof');
          const target = targetProof(view, options.container.getBoundingClientRect(), sections);
          if (!target) { diagnostics?.fail('target-not-visible'); return null; }
          published = true;
          drainedRevision = workRevision;
          diagnostics?.stage('ready');
          return { element: view, origin: snapshot.key, target };
        } catch (error) { diagnostics?.fail(error instanceof Error ? error.message : String(error)); return null; }
        finally { diagnostics?.end(); }
      })();
      let ready = prepare(frozen, generation);
      const drainWork = async () => {
        await ready;
        // Successful readiness already drained its frames. Null readiness may
        // have exited before that barrier; stop/late resources require a new one.
        while (view && drainedRevision !== workRevision) {
          const revision = workRevision;
          frameDrain ??= frames().then(() => { drainedRevision = revision; frameDrain = undefined; });
          await frameDrain;
        }
      };
      return {
        id, get ready() { return ready; },
        stop,
        retarget(request) {
          if (!stopped || !published || invalidated || !view || !book || disposal || drainedRevision !== workRevision) return false;
          unobserve();
          frozen = { ...request, key: { ...request.key }, settings: { ...request.settings } };
          stopped = false; published = false; invalidated = false;
          ++generation; ++workRevision; drainedRevision = -1;
          diagnostics?.nextPreparation();
          ready = prepare(frozen, generation);
          return true;
        },
        async drain() {
          await ready;
          if (disposal) { await disposal; return; }
          await drainWork();
          if (disposal) await disposal;
        },
        dispose() {
          if (disposal) return disposal;
          stop();
          disposal = (async () => {
            await ready;
            // Never close while navigation/fonts/images or upstream frames run.
            if (view) await frames();
            try { view?.close(); } finally {
              view?.remove();
              book?.destroy();
            }
            diagnostics?.release();
          })();
          return disposal;
        },
      };
    },
  };
}


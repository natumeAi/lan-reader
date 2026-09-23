/**
 * Visible body-text sampling for the foreground reader only.
 *
 * Only documents returned by the foreground engine's `getContents()` are
 * sampled; preview, prewarm and measurement Views are never passed here. A
 * sample clips live DOM Range fragments against everything that visually
 * bounds the foreground frame (window, foreground element, clipping ancestors
 * across shadow roots and the frame's own content box) and converts only
 * verified visible characters into canonical intervals.
 *
 * Long unspaced (e.g. Chinese) text nodes are split recursively until each
 * piece is entirely visible, entirely outside, or a single character. A single
 * character that is only partially inside the clip is not counted. Missing,
 * zero-area or otherwise unusable geometry contributes nothing; there is never
 * a whole-node, whole-chapter or percentage fallback.
 */
import type { CharacterInterval } from '@lan-reader/shared';
import { MAX_SECTION_INTERVALS, mergeCharacterIntervals } from '@lan-reader/shared';
import type { ContentDocument } from './types';
import type { CanonicalTextEntry, CanonicalTextIndex } from '../utils/canonicalText';
import { canonicalCharacterEnd, canonicalToUtf16, getCanonicalTextIndex } from '../utils/canonicalText';

export interface ClipRect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface RectLike extends ClipRect { readonly width: number; readonly height: number }

/** Verified visible canonical text of one section, before delivery filtering. */
export interface VisibleSectionSample {
  readonly sectionIndex: number;
  readonly signature: string;
  readonly sectionLength: number;
  readonly intervals: readonly CharacterInterval[];
}

export type VisibleTextOutcome =
  | { readonly kind: 'sampled'; readonly sections: readonly VisibleSectionSample[]; readonly truncated: boolean }
  | { readonly kind: 'cancelled' };

export interface VisibleTextOptions {
  /** The foreground reader element; its box bounds what can be visible. */
  readonly foreground: HTMLElement;
  /** Rechecked before, between and after work slices; `false` discards the sample. */
  readonly isCurrent: () => boolean;
  readonly measure?: (range: Range) => readonly RectLike[];
  readonly isShown?: (element: Element) => boolean;
  readonly documentClip?: (frame: HTMLIFrameElement, foreground: HTMLElement) => ClipRect | null;
  readonly yieldControl?: () => Promise<void>;
  readonly now?: () => number;
  /** Work slice before yielding, in milliseconds. */
  readonly sliceMs?: number;
  /** Upper bound of Range measurements for one sample. */
  readonly maxMeasurements?: number;
}

/** Pixel tolerance for sub-pixel rounding at clip edges. */
const EDGE_TOLERANCE = 1;
const DEFAULT_SLICE_MS = 8;
const DEFAULT_MAX_MEASUREMENTS = 20_000;

const defaultMeasure = (range: Range): readonly RectLike[] => Array.from(range.getClientRects());

function defaultIsShown(element: Element): boolean {
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return Boolean(style && style.visibility === 'visible' && style.display !== 'none');
}

const defaultYield = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

function intersect(a: ClipRect, b: ClipRect): ClipRect | null {
  const clip = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return clip.right - clip.left > 0 && clip.bottom - clip.top > 0 ? clip : null;
}

/** Padding box of an element in top-level viewport coordinates, including transforms. */
function paddingBox(element: Element): ClipRect {
  const rect = element.getBoundingClientRect();
  const html = element as HTMLElement;
  const scaleX = html.offsetWidth > 0 ? rect.width / html.offsetWidth : 1;
  const scaleY = html.offsetHeight > 0 ? rect.height / html.offsetHeight : 1;
  const left = rect.left + element.clientLeft * scaleX;
  const top = rect.top + element.clientTop * scaleY;
  return { left, top, right: left + element.clientWidth * scaleX, bottom: top + element.clientHeight * scaleY };
}

function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root && 'host' in root ? (root as ShadowRoot).host : null;
}

const CLIPPING_OVERFLOW = new Set(['hidden', 'clip', 'scroll', 'auto']);

function clipsOverflow(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return false;
  return [style.overflowX, style.overflowY, style.overflow].some(value => CLIPPING_OVERFLOW.has(value));
}

/**
 * Visible part of a frame's document in that document's own viewport
 * coordinates, or `null` when nothing of it can be visible.
 */
export function defaultDocumentClip(frame: HTMLIFrameElement, foreground: HTMLElement): ClipRect | null {
  if (!frame.isConnected || !foreground.isConnected) return null;
  if (!defaultIsShown(frame) || !defaultIsShown(foreground)) return null;
  const view = frame.ownerDocument.defaultView;
  if (!view) return null;
  let clip = intersect({ left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight }, paddingBox(foreground));
  for (let element = composedParent(frame); element && clip; element = composedParent(element)) {
    if (clipsOverflow(element)) clip = intersect(clip, paddingBox(element));
  }
  if (!clip) return null;
  const content = paddingBox(frame);
  clip = intersect(clip, content);
  if (!clip) return null;
  const rect = frame.getBoundingClientRect();
  const scaleX = frame.offsetWidth > 0 ? rect.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight > 0 ? rect.height / frame.offsetHeight : 1;
  if (!(scaleX > 0) || !(scaleY > 0)) return null;
  return {
    left: (clip.left - content.left) / scaleX,
    top: (clip.top - content.top) / scaleY,
    right: (clip.right - content.left) / scaleX,
    bottom: (clip.bottom - content.top) / scaleY,
  };
}

type Classification = 'visible' | 'outside' | 'partial';

/** Classifies a range's fragments against the clip. No positive-area geometry counts as outside. */
export function classifyFragments(rects: readonly RectLike[], clip: ClipRect): Classification {
  let positive = 0;
  let inside = 0;
  let touching = 0;
  for (const rect of rects) {
    if (!(rect.width > 0) || !(rect.height > 0) || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) continue;
    positive++;
    if (rect.left >= clip.left - EDGE_TOLERANCE && rect.right <= clip.right + EDGE_TOLERANCE
      && rect.top >= clip.top - EDGE_TOLERANCE && rect.bottom <= clip.bottom + EDGE_TOLERANCE) inside++;
    else if (Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left) > EDGE_TOLERANCE
      && Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top) > EDGE_TOLERANCE) touching++;
  }
  if (positive === 0) return 'outside';
  if (inside === positive) return 'visible';
  if (inside === 0 && touching === 0) return 'outside';
  return 'partial';
}

interface Budget { measurements: number; readonly max: number }

/** Visible canonical intervals of one text node; empty when nothing is verified. */
function visibleIntervalsOfNode(
  entry: CanonicalTextEntry,
  clip: ClipRect,
  measure: (range: Range) => readonly RectLike[],
  budget: Budget,
): CharacterInterval[] | null {
  const node = entry.node;
  if (node.data.length !== entry.utf16Length) return [];
  const starts = canonicalToUtf16(node);
  if (starts.length !== entry.length) return [];
  const range = node.ownerDocument.createRange();
  const found: CharacterInterval[] = [];
  const stack: [number, number][] = [[0, entry.length]];
  while (stack.length) {
    const [low, high] = stack.pop()!;
    if (budget.measurements >= budget.max) return null;
    budget.measurements++;
    range.setStart(node, starts[low]!);
    range.setEnd(node, canonicalCharacterEnd(node, starts, high - 1));
    const kind = classifyFragments(measure(range), clip);
    if (kind === 'visible') found.push([entry.start + low, entry.start + high]);
    else if (kind === 'partial' && high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      stack.push([middle, high], [low, middle]);
    }
  }
  return found;
}

/**
 * Samples one indexed document against a document-coordinate clip.
 * Exposed for controlled-geometry tests; production goes through `sampleVisibleText`.
 */
export async function collectVisibleIntervals(
  index: CanonicalTextIndex,
  clip: ClipRect,
  options: Pick<VisibleTextOptions, 'isCurrent' | 'measure' | 'isShown' | 'yieldControl' | 'now' | 'sliceMs'> & { budget?: Budget },
): Promise<{ intervals: CharacterInterval[]; truncated: boolean } | null> {
  const measure = options.measure ?? defaultMeasure;
  const isShown = options.isShown ?? defaultIsShown;
  const yieldControl = options.yieldControl ?? defaultYield;
  const now = options.now ?? (() => performance.now());
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
  const budget = options.budget ?? { measurements: 0, max: DEFAULT_MAX_MEASUREMENTS };
  const shown = new Map<Element, boolean>();
  const intervals: CharacterInterval[] = [];
  let sliceStart = now();
  for (const entry of index.entries) {
    if (now() - sliceStart >= sliceMs) {
      await yieldControl();
      if (!options.isCurrent()) return null;
      sliceStart = now();
    }
    const parent = entry.node.parentElement;
    if (!parent) continue;
    let visible = shown.get(parent);
    if (visible === undefined) { visible = isShown(parent); shown.set(parent, visible); }
    if (!visible) continue;
    const found = visibleIntervalsOfNode(entry, clip, measure, budget);
    if (found === null) return { intervals: mergeCharacterIntervals(intervals), truncated: true };
    intervals.push(...found);
  }
  return { intervals: mergeCharacterIntervals(intervals), truncated: false };
}

/**
 * Samples the currently visible canonical text of the given foreground
 * documents. Returns `cancelled` if `isCurrent()` turns false at any point;
 * the caller then keeps its pending observation and may retry later.
 */
export async function sampleVisibleText(
  contents: readonly ContentDocument[],
  options: VisibleTextOptions,
): Promise<VisibleTextOutcome> {
  if (!options.isCurrent()) return { kind: 'cancelled' };
  const documentClip = options.documentClip ?? defaultDocumentClip;
  const budget: Budget = { measurements: 0, max: options.maxMeasurements ?? DEFAULT_MAX_MEASUREMENTS };
  const sections: VisibleSectionSample[] = [];
  let truncated = false;
  const seen = new Set<number>();
  for (const content of contents) {
    if (seen.has(content.sectionIndex)) continue;
    const frame = content.frame;
    // Only a live frame that really hosts this document can be measured.
    if (!frame || !frame.isConnected || frame.contentDocument !== content.document) continue;
    const clip = documentClip(frame, options.foreground);
    if (!clip) continue;
    const index = getCanonicalTextIndex(content.document);
    if (index.length === 0) continue;
    const result = await collectVisibleIntervals(index, clip, { ...options, budget });
    if (!result || !options.isCurrent()) return { kind: 'cancelled' };
    truncated ||= result.truncated;
    seen.add(content.sectionIndex);
    if (result.intervals.length) {
      sections.push({
        sectionIndex: content.sectionIndex,
        signature: index.signature,
        sectionLength: index.length,
        // More fragments than the wire limit is abnormal; dropping the excess
        // can only under-count.
        intervals: result.intervals.slice(0, MAX_SECTION_INTERVALS),
      });
    }
    if (result.truncated) break;
  }
  if (!options.isCurrent()) return { kind: 'cancelled' };
  return { kind: 'sampled', sections, truncated };
}

/**
 * Canonical, layout-independent text coordinates for one spine document.
 *
 * Normalization v1 (shared `READING_TEXT_NORMALIZATION_VERSION`): a canonical
 * character is one Unicode code point of body text that is not white space, a
 * control character (Cc), a format character (Cf) or an unpaired surrogate.
 * Punctuation counts. Text inside script/style/noscript/template and inside
 * embedded SVG or MathML is not body prose and gets no coordinates.
 *
 * Coordinates never depend on CSS: text that is currently hidden keeps its
 * slots, so font, theme or viewport changes cannot shift later offsets. CSS
 * visibility only decides whether a sample may *observe* a character.
 *
 * DOM offsets are UTF-16 code units. `canonicalToUtf16` maps canonical
 * character `k` of a text node to its UTF-16 start offset; supplementary
 * characters (surrogate pairs) occupy one canonical slot and two code units.
 */
import { READING_TEXT_NORMALIZATION_VERSION } from '@lan-reader/shared';

export const CANONICAL_TEXT_VERSION = READING_TEXT_NORMALIZATION_VERSION;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const EXCLUDED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template']);
const NON_CANONICAL = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u;

/** `true` when one code point counts under normalization v1. */
export function isCanonicalCodePoint(codePoint: number): boolean {
  // Fast paths for printable ASCII and CJK Unified Ideographs, which make up
  // nearly all prose; both are always canonical.
  if (codePoint > 0x20 && codePoint < 0x7f) return true;
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return true;
  return !NON_CANONICAL.test(String.fromCodePoint(codePoint));
}

/** One indexed text node and its canonical range `[start, start + length)`. */
export interface CanonicalTextEntry {
  readonly node: Text;
  /** Canonical offset of the node's first canonical character. */
  readonly start: number;
  /** Canonical characters in the node; always positive. */
  readonly length: number;
  /** `node.data.length` when indexed; a mismatch means the text changed. */
  readonly utf16Length: number;
}

export interface CanonicalTextIndex {
  readonly version: typeof CANONICAL_TEXT_VERSION;
  readonly document: Document;
  readonly entries: readonly CanonicalTextEntry[];
  /** Canonical length of the whole section. */
  readonly length: number;
  /** Opaque `fnv1a64:<16 hex>` token over the canonical text. */
  readonly signature: string;
}

/**
 * FNV-1a 64-bit over UTF-8 bytes, computed with 16-bit limbs.
 *
 * `crypto.subtle` is unavailable on plain-HTTP LAN origins, so the signature
 * must be computable with ordinary JavaScript arithmetic.
 */
export class Fnv1a64 {
  private h0 = 0x2325;
  private h1 = 0x8422;
  private h2 = 0x9ce4;
  private h3 = 0xcbf2;

  byte(value: number) {
    this.h0 ^= value & 0xff;
    // h * 0x100000001b3 mod 2^64 = h * 0x1b3 + (h << 40).
    const t0 = this.h0 * 0x1b3;
    let t1 = this.h1 * 0x1b3;
    let t2 = this.h2 * 0x1b3 + (this.h0 << 8);
    let t3 = this.h3 * 0x1b3 + (this.h1 << 8);
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    t3 += t2 >>> 16;
    this.h0 = t0 & 0xffff;
    this.h1 = t1 & 0xffff;
    this.h2 = t2 & 0xffff;
    this.h3 = t3 & 0xffff;
  }

  /** Feeds one code point as its UTF-8 encoding. */
  codePoint(codePoint: number) {
    if (codePoint < 0x80) {
      this.byte(codePoint);
    } else if (codePoint < 0x800) {
      this.byte(0xc0 | (codePoint >> 6));
      this.byte(0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      this.byte(0xe0 | (codePoint >> 12));
      this.byte(0x80 | ((codePoint >> 6) & 0x3f));
      this.byte(0x80 | (codePoint & 0x3f));
    } else {
      this.byte(0xf0 | (codePoint >> 18));
      this.byte(0x80 | ((codePoint >> 12) & 0x3f));
      this.byte(0x80 | ((codePoint >> 6) & 0x3f));
      this.byte(0x80 | (codePoint & 0x3f));
    }
  }

  hex() {
    return [this.h3, this.h2, this.h1, this.h0]
      .map(limb => limb.toString(16).padStart(4, '0'))
      .join('');
  }
}

/** FNV-1a 64 hex digest of a string's UTF-8 bytes. */
export function fnv1a64Hex(text: string): string {
  const hash = new Fnv1a64();
  for (const character of text) hash.codePoint(character.codePointAt(0)!);
  return hash.hex();
}

/** Walks a string by code point, yielding `[codePoint, utf16Offset]`. */
function* codePoints(data: string): Generator<[number, number]> {
  for (let offset = 0; offset < data.length;) {
    const codePoint = data.codePointAt(offset)!;
    yield [codePoint, offset];
    offset += codePoint > 0xffff ? 2 : 1;
  }
}

/** Canonical characters of a string under normalization v1. */
export function countCanonicalCharacters(data: string): number {
  let count = 0;
  for (const [codePoint] of codePoints(data)) if (isCanonicalCodePoint(codePoint)) count++;
  return count;
}

const offsetCache = new WeakMap<Text, { data: string; starts: Uint32Array }>();

/**
 * UTF-16 start offset of each canonical character of `node`, in order.
 * Cached per node and recomputed if its data changed.
 */
export function canonicalToUtf16(node: Text): Uint32Array {
  const cached = offsetCache.get(node);
  if (cached && cached.data === node.data) return cached.starts;
  const offsets: number[] = [];
  for (const [codePoint, offset] of codePoints(node.data)) {
    if (isCanonicalCodePoint(codePoint)) offsets.push(offset);
  }
  const starts = Uint32Array.from(offsets);
  offsetCache.set(node, { data: node.data, starts });
  return starts;
}

/** UTF-16 end offset (exclusive) of canonical character `k` of `node`. */
export function canonicalCharacterEnd(node: Text, starts: Uint32Array, k: number): number {
  const start = starts[k]!;
  const codePoint = node.data.codePointAt(start)!;
  return start + (codePoint > 0xffff ? 2 : 1);
}

function isExcludedElement(element: Element): boolean {
  if (element.namespaceURI === SVG_NAMESPACE || element.namespaceURI === MATHML_NAMESPACE) return true;
  return EXCLUDED_ELEMENTS.has(element.localName.toLowerCase());
}

/** `true` if the text node belongs to body prose rather than embedded/inert content. */
function isEligibleTextNode(node: Text, root: Element): boolean {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (isExcludedElement(element)) return false;
    if (element === root) return true;
  }
  return false;
}

/** Builds a fresh index for the document's current body text. */
export function buildCanonicalTextIndex(document: Document): CanonicalTextIndex {
  const root = document.body ?? document.documentElement;
  const entries: CanonicalTextEntry[] = [];
  const hash = new Fnv1a64();
  let length = 0;
  if (root) {
    const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const node = current as Text;
      if (!isEligibleTextNode(node, root)) continue;
      let count = 0;
      for (const [codePoint] of codePoints(node.data)) {
        if (!isCanonicalCodePoint(codePoint)) continue;
        hash.codePoint(codePoint);
        count++;
      }
      if (count === 0) continue;
      entries.push({ node, start: length, length: count, utf16Length: node.data.length });
      length += count;
    }
  }
  return {
    version: CANONICAL_TEXT_VERSION,
    document,
    entries,
    length,
    signature: `fnv1a64:${hash.hex()}`,
  };
}

const indexCache = new WeakMap<Document, CanonicalTextIndex>();

/** `true` while every indexed node is still attached with its indexed data length. */
export function isCanonicalTextIndexCurrent(index: CanonicalTextIndex): boolean {
  const root = index.document.body ?? index.document.documentElement;
  return index.entries.every(entry => entry.node.data.length === entry.utf16Length && Boolean(root?.contains(entry.node)));
}

/**
 * Lazily indexed and cached per document. A changed body rebuilds the index,
 * producing a new signature; the server then refuses to merge its offsets
 * with coverage recorded against different text.
 */
export function getCanonicalTextIndex(document: Document): CanonicalTextIndex {
  const cached = indexCache.get(document);
  if (cached && isCanonicalTextIndexCurrent(cached)) return cached;
  const index = buildCanonicalTextIndex(document);
  indexCache.set(document, index);
  return index;
}

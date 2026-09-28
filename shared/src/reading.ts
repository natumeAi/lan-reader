/**
 * Reading Position contracts.
 *
 * A Reading Position belongs to one Book. Two imports of the same publication
 * are separate Books and keep separate positions (ADR-0004), so nothing here is
 * keyed by identifier or file name.
 */
import type { BookDto } from './book.js';
import { WireDecodeError } from './decode.js';

export interface ChapterProgress { readonly chapterCount: number | null; readonly chapterIndex: number | null }

/** Missing legacy tuples normalize to unknown; partial tuples are rejected. */
export function decodeChapterProgress(value: { chapterCount?: unknown; chapterIndex?: unknown }): ChapterProgress {
  const { chapterCount: count, chapterIndex: index } = value;
  if ((count === undefined && index === undefined) || (count === null && index === null)) return { chapterCount: null, chapterIndex: null };
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0 || typeof index !== 'number' || !Number.isSafeInteger(index) || index < -1 || index >= count) throw new WireDecodeError('Invalid chapter progress pair');
  return { chapterCount: count, chapterIndex: index };
}

/** Stored Reading Position as returned by `GET`/`PUT /api/reading/:bookId`. */
export interface ReadingPositionDto extends ChapterProgress {
  readonly bookId: number;
  readonly cfi: string | null;
  /** Fraction between 0 and 1 inclusive. `0` means opened at the start. */
  readonly progress: number;
  readonly chapterHref: string | null;
  readonly chapterLabel: string | null;
  readonly updatedAt: string;
}

/**
 * Request body of `PUT /api/reading/:bookId`.
 *
 * `progress` is required and must be a finite number in `[0, 1]`; the server
 * rejects anything else with 400. The remaining fields are optional on the wire
 * and are stored as `null` when missing.
 */
export interface ReadingPositionUpdate {
  readonly chapterCount?: number | null;
  readonly chapterIndex?: number | null;
  readonly progress: number;
  readonly cfi?: string | null;
  readonly chapterHref?: string | null;
  readonly chapterLabel?: string | null;
}

/** Entry of `GET /api/reading/recent`. */
export interface RecentReadingEntryDto {
  readonly book: BookDto;
  readonly progress: ReadingPositionDto;
}

/**
 * Entry of the snapshot's `recent` array.
 *
 * The Book itself is not repeated here; it is looked up in the snapshot's
 * `books` array by `bookId`.
 */
export interface SnapshotRecentEntry {
  readonly bookId: number;
  readonly progress: ReadingPositionDto;
}

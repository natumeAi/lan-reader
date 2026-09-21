/**
 * Reading Positions and Continue Reading.
 *
 * A Reading Position belongs to exactly one Book, so two imports of the same
 * publication keep separate positions (ADR-0004); nothing here is keyed by
 * identifier or file name.
 */
import type { ReadingPositionDto, RecentReadingEntryDto } from '@lan-reader/shared';
import type { DatabaseHandle, ReadingProgressRow, RecentReadingRow } from '../db/rows.js';
import { formatBook } from './bookLibrary.js';

export interface ListRecentReadingOptions {
  limit?: number;
}

export function getExactProgress(
  db: DatabaseHandle,
  bookId: number,
): ReadingProgressRow | null {
  return db
    .prepare<[number], ReadingProgressRow>('SELECT * FROM reading_progress WHERE book_id = ?')
    .get(bookId) ?? null;
}

// Two signatures, one implementation: a Book that was never opened has no row
// and formats to `null`, while a row the caller already holds always formats to
// a Reading Position.
export function formatProgress(row: ReadingProgressRow): ReadingPositionDto;
export function formatProgress(
  row: ReadingProgressRow | null | undefined,
): ReadingPositionDto | null;
export function formatProgress(
  row: ReadingProgressRow | null | undefined,
): ReadingPositionDto | null {
  if (!row) return null;

  return {
    bookId: row.book_id,
    cfi: row.cfi,
    progress: row.progress,
    chapterHref: row.chapter_href,
    chapterLabel: row.chapter_label,
    updatedAt: row.updated_at,
  };
}

export function listRecentReadingEntries(
  db: DatabaseHandle,
  options: ListRecentReadingOptions = {},
): RecentReadingEntryDto[] {
  const limit = options.limit ?? 10;
  const rows = db
    .prepare<[], RecentReadingRow>(
      `SELECT b.*,
              rp.book_id AS progress_book_id,
              rp.cfi AS progress_cfi,
              rp.progress AS progress_value,
              rp.chapter_href AS progress_chapter_href,
              rp.chapter_label AS progress_chapter_label,
              rp.updated_at AS progress_updated_at
       FROM reading_progress rp
       INNER JOIN books b ON b.id = rp.book_id
       ORDER BY rp.updated_at DESC, rp.book_id DESC`,
    )
    .all();
  const entries: RecentReadingEntryDto[] = [];

  for (const row of rows) {
    // A finished Book leaves Continue Reading without using up a slot.
    if (row.progress_value >= 1) continue;
    entries.push({
      book: formatBook(row),
      progress: formatProgress({
        book_id: row.progress_book_id,
        cfi: row.progress_cfi,
        progress: row.progress_value,
        chapter_href: row.progress_chapter_href,
        chapter_label: row.progress_chapter_label,
        updated_at: row.progress_updated_at,
      }),
    });
    if (entries.length === limit) break;
  }

  return entries;
}

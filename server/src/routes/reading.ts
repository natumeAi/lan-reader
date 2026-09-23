/**
 * Reading Position and reading statistics routes.
 *
 * A Reading Position belongs to one Book, so the named routes (`/recent`,
 * `/stats`, `/goals`, `/activity`) are registered before `/:bookId` and the
 * upsert below is keyed on `book_id` alone. `PUT` writes the position the
 * reader is at, which may move backwards — it is not a furthest-read marker.
 * Statistics are separate from positions and never change them.
 */
import type { Response } from 'express';
import { Router } from 'express';
import type {
  ReadingActivityBatchResponse,
  ReadingActivityOutcome,
  ReadingGoalsResponse,
  ReadingPositionResponse,
  ReadingStatsResponse,
  RecentReadingResponse,
} from '@lan-reader/shared';
import {
  READING_STATS_DAY_COUNT,
  WireDecodeError,
  decodeReadingActivityBatchEntries,
  decodeReadingActivityEvent,
  decodeReadingGoalsUpdate,
  isLocalDate,
  shiftLocalDate,
} from '@lan-reader/shared';
import type { DatabaseHandle } from '../db/rows.js';
import { badRequest, notFound } from '../http/httpError.js';
import { parseBookId, readRequestBody, requireDatabase } from '../http/requestInput.js';
import {
  formatProgress,
  getExactProgress,
  listRecentReadingEntries,
} from '../services/readingLibrary.js';
import {
  getReadingStats,
  recordReadingActivity,
  updateReadingGoals,
} from '../services/readingStats.js';

const router = Router();

/** Runs a shared decoder and turns its contract failure into a 400. */
function decodeRequest<T>(decode: () => T, code: string): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof WireDecodeError) {
      throw badRequest(error.message, code);
    }
    throw error;
  }
}

/** One record's outcome: an undecodable body is a permanent INVALID_ACTIVITY. */
function recordActivityEntry(
  db: DatabaseHandle,
  entry: { readonly id: string; readonly value: unknown },
): ReadingActivityOutcome {
  let event;
  try {
    event = decodeReadingActivityEvent(entry.value);
  } catch (error) {
    if (error instanceof WireDecodeError) {
      return { id: entry.id, status: 'rejected', reason: 'INVALID_ACTIVITY' };
    }
    throw error;
  }

  return recordReadingActivity(db, event);
}

// GET /api/reading/recent
router.get('/recent', (req, res: Response<RecentReadingResponse>, next) => {
  try {
    const db = requireDatabase(req);
    res.json({
      items: listRecentReadingEntries(db),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reading/stats?date=YYYY-MM-DD
router.get('/stats', (req, res: Response<ReadingStatsResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const date: unknown = req.query['date'];
    // The whole seven-day window must stay inside the supported calendar range,
    // or the response would carry days its own decoder rejects.
    if (!isLocalDate(date) || !isLocalDate(shiftLocalDate(date, 1 - READING_STATS_DAY_COUNT))) {
      throw badRequest('date must be a YYYY-MM-DD calendar date', 'INVALID_DATE');
    }

    res.json({ stats: getReadingStats(db, date) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/reading/goals
router.put('/goals', (req, res: Response<ReadingGoalsResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const update = decodeRequest(
      () => decodeReadingGoalsUpdate(readRequestBody(req)),
      'INVALID_READING_GOALS',
    );

    res.json({ goals: updateReadingGoals(db, update) });
  } catch (err) {
    next(err);
  }
});

// POST /api/reading/activity
//
// Every record commits on its own. An invalid envelope, an unusable id or a
// repeated id rejects the whole request before any write. An unexpected
// failure answers 500 after the earlier records committed; they are retried
// idempotently.
router.post('/activity', (req, res: Response<ReadingActivityBatchResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const entries = decodeRequest(
      () => decodeReadingActivityBatchEntries(readRequestBody(req)),
      'INVALID_ACTIVITY_BATCH',
    );

    res.json({ results: entries.map((entry) => recordActivityEntry(db, entry)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/reading/:bookId
router.get('/:bookId', (req, res: Response<ReadingPositionResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const bookId = parseBookId(req.params.bookId);
    const row = getExactProgress(db, bookId);
    const progress = formatProgress(row);

    res.json({
      progress,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/reading/:bookId
router.put('/:bookId', (req, res: Response<ReadingPositionResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const bookId = parseBookId(req.params.bookId);
    const { cfi, progress, chapterHref, chapterLabel } = readRequestBody(req);

    const progressValue = Number(progress);

    if (!Number.isFinite(progressValue) || progressValue < 0 || progressValue > 1) {
      throw badRequest('progress must be a number between 0 and 1');
    }

    // Existence only: the selected literal is never read, so the row type stays
    // the default `unknown`.
    const bookExists = db.prepare<[number]>('SELECT 1 FROM books WHERE id = ?').get(bookId);
    if (!bookExists) {
      throw notFound('Book not found', 'BOOK_NOT_FOUND');
    }

    // The three text columns are stored exactly as they arrived, so the bind
    // parameters stay `unknown`: a value SQLite cannot bind fails here just as
    // it did before.
    db.prepare<[number, unknown, number, unknown, unknown]>(`
      INSERT INTO reading_progress (book_id, cfi, progress, chapter_href, chapter_label, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
      ON CONFLICT(book_id) DO UPDATE SET
        cfi = excluded.cfi,
        progress = excluded.progress,
        chapter_href = excluded.chapter_href,
        chapter_label = excluded.chapter_label,
        updated_at = excluded.updated_at
    `).run(bookId, cfi ?? null, progressValue, chapterHref ?? null, chapterLabel ?? null);

    const row = getExactProgress(db, bookId);

    res.json({ progress: formatProgress(row) });
  } catch (err) {
    next(err);
  }
});

export default router;

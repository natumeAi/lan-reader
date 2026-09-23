/**
 * Reading statistics: goals, activity acknowledgments and dashboard totals.
 *
 * Statistics belong to one imported Book id and follow its deletion through
 * `ON DELETE CASCADE`. None of these writes touch `books`, `folders` or
 * `reading_progress`, so they never bump the library revision and never alter
 * a Reading Position.
 *
 * Each activity event commits in its own synchronous transaction:
 * verify Book → establish event identity → merge coverage → add daily totals →
 * record a qualifying completion → store the acknowledgment. A permanent
 * rejection writes nothing; an unexpected failure rolls the record back and
 * propagates, so it stays retryable and is never acknowledged.
 */
import { createHash } from 'node:crypto';
import type {
  CharacterInterval,
  CompletedBookDto,
  ReadingActivityEvent,
  ReadingActivityOutcome,
  ReadingDayDto,
  ReadingGoalsDto,
  ReadingGoalsUpdate,
  ReadingStatsDto,
  SkippedSectionCoverage,
  ViewedSectionCoverage,
} from '@lan-reader/shared';
import {
  READING_STATS_DAY_COUNT,
  countIntervalCharacters,
  decodeCharacterIntervals,
  decodeSkippedSections,
  localDateYear,
  mergeCharacterIntervals,
  shiftLocalDate,
} from '@lan-reader/shared';
import { requireQueryResult } from '../db/queryResult.js';
import type {
  CompletedBookRow,
  CountRow,
  DatabaseHandle,
  ReadingActivityEventRow,
  ReadingDayTotalRow,
  ReadingLifetimeTotalRow,
  ReadingSectionCoverageRow,
  ReadingStatsSettingsRow,
} from '../db/rows.js';
import { formatBook } from './bookLibrary.js';

const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function readSettings(db: DatabaseHandle): ReadingStatsSettingsRow {
  return requireQueryResult(
    db
      .prepare<[], ReadingStatsSettingsRow>('SELECT * FROM reading_stats_settings WHERE id = 1')
      .get(),
    'reading statistics settings',
  );
}

function formatGoals(row: ReadingStatsSettingsRow): ReadingGoalsDto {
  return {
    dailyMinutes: row.daily_goal_minutes,
    annualBooks: row.annual_book_goal,
  };
}

export function getReadingGoals(db: DatabaseHandle): ReadingGoalsDto {
  return formatGoals(readSettings(db));
}

/** Applies a validated partial goal update; an omitted goal keeps its stored value. */
export function updateReadingGoals(
  db: DatabaseHandle,
  update: ReadingGoalsUpdate,
): ReadingGoalsDto {
  db.prepare<[number | null, number | null]>(`
    UPDATE reading_stats_settings
    SET daily_goal_minutes = COALESCE(?, daily_goal_minutes),
        annual_book_goal = COALESCE(?, annual_book_goal),
        updated_at = ${NOW_ISO}
    WHERE id = 1
  `).run(update.dailyMinutes ?? null, update.annualBooks ?? null);

  return getReadingGoals(db);
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * Identity of an event's immutable payload.
 *
 * Built from the decoded values in a fixed order, so property order or ignored
 * extra properties on the wire never change it. `v1` versions this encoding.
 */
export function hashActivityPayload(event: ReadingActivityEvent): string {
  const canonical = JSON.stringify([
    'v1',
    event.bookId,
    event.localDate,
    event.occurredAt,
    event.durationMs,
    event.sections.map((section) => [
      section.sectionIndex,
      section.normalizationVersion,
      section.signature,
      section.sectionLength,
      section.intervals.map(([start, end]) => [start, end]),
    ]),
    event.completion ? [event.completion.occurredAt, event.completion.localDate] : null,
  ]);

  return createHash('sha256').update(canonical).digest('hex');
}

function readStoredIntervals(row: ReadingSectionCoverageRow): CharacterInterval[] {
  const stored: unknown = JSON.parse(row.intervals);

  return decodeCharacterIntervals(
    stored,
    `coverage of book ${row.book_id} section ${row.section_index}`,
    row.section_length,
  );
}

function readStoredSkippedSections(row: ReadingActivityEventRow): SkippedSectionCoverage[] {
  const stored: unknown = JSON.parse(row.skipped_sections);

  return decodeSkippedSections(stored, `skipped sections of event ${row.id}`);
}

interface CoverageResult {
  readonly added: number;
  readonly skipped: SkippedSectionCoverage | null;
}

/**
 * Unions one section's submitted intervals into its stored coverage.
 *
 * A section whose stored signature or length differs is skipped, never
 * rebased or opened as a second independently summed bucket.
 */
function applySectionCoverage(
  db: DatabaseHandle,
  bookId: number,
  section: ViewedSectionCoverage,
): CoverageResult {
  const row = db
    .prepare<[number, number, number], ReadingSectionCoverageRow>(`
      SELECT * FROM reading_section_coverage
      WHERE book_id = ? AND normalization_version = ? AND section_index = ?
    `)
    .get(bookId, section.normalizationVersion, section.sectionIndex);

  if (row && (row.signature !== section.signature || row.section_length !== section.sectionLength)) {
    return {
      added: 0,
      skipped: {
        sectionIndex: section.sectionIndex,
        normalizationVersion: section.normalizationVersion,
        reason: 'SIGNATURE_MISMATCH',
      },
    };
  }

  const existing = row ? readStoredIntervals(row) : [];
  const before = countIntervalCharacters(mergeCharacterIntervals(existing));
  const merged = mergeCharacterIntervals(existing, section.intervals);
  const covered = countIntervalCharacters(merged);
  const added = covered - before;

  if (!row || added > 0) {
    db.prepare<[number, number, number, string, number, string, number]>(`
      INSERT INTO reading_section_coverage (
        book_id, normalization_version, section_index, signature,
        section_length, intervals, covered_characters, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO})
      ON CONFLICT(book_id, normalization_version, section_index) DO UPDATE SET
        intervals = excluded.intervals,
        covered_characters = excluded.covered_characters,
        updated_at = excluded.updated_at
    `).run(
      bookId,
      section.normalizationVersion,
      section.sectionIndex,
      section.signature,
      section.sectionLength,
      JSON.stringify(merged),
      covered,
    );
  }

  return { added, skipped: null };
}

function recordCompletion(db: DatabaseHandle, event: ReadingActivityEvent): void {
  const { completion } = event;
  if (!completion) return;

  // The year comes from the captured local date, never from the instant or
  // the server clock. Normalized instants compare correctly as text.
  db.prepare<[number, number, string, string, string]>(`
    INSERT INTO reading_completions (book_id, year, local_date, occurred_at, event_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(book_id, year) DO UPDATE SET
      local_date = excluded.local_date,
      occurred_at = excluded.occurred_at,
      event_id = excluded.event_id
    WHERE excluded.local_date < reading_completions.local_date
       OR (excluded.local_date = reading_completions.local_date
           AND excluded.occurred_at < reading_completions.occurred_at)
  `).run(
    event.bookId,
    localDateYear(completion.localDate),
    completion.localDate,
    new Date(completion.occurredAt).toISOString(),
    event.id,
  );
}

/**
 * Records one decoded activity event atomically and returns its outcome.
 *
 * An identical retry returns the stored outcome without changing any total;
 * the same id with another payload is a terminal conflict.
 */
export function recordReadingActivity(
  db: DatabaseHandle,
  event: ReadingActivityEvent,
): ReadingActivityOutcome {
  const payloadHash = hashActivityPayload(event);

  return db.transaction((): ReadingActivityOutcome => {
    const bookExists = db.prepare<[number]>('SELECT 1 FROM books WHERE id = ?').get(event.bookId);
    if (!bookExists) {
      return { id: event.id, status: 'rejected', reason: 'BOOK_NOT_FOUND' };
    }

    const acknowledged = db
      .prepare<[string], ReadingActivityEventRow>('SELECT * FROM reading_activity_events WHERE id = ?')
      .get(event.id);
    if (acknowledged) {
      if (acknowledged.payload_hash !== payloadHash) {
        return { id: event.id, status: 'rejected', reason: 'EVENT_ID_CONFLICT' };
      }
      return {
        id: event.id,
        status: 'accepted',
        duplicate: true,
        skippedSections: readStoredSkippedSections(acknowledged),
      };
    }

    const skippedSections: SkippedSectionCoverage[] = [];
    let charactersAdded = 0;
    for (const section of event.sections) {
      const result = applySectionCoverage(db, event.bookId, section);
      charactersAdded += result.added;
      if (result.skipped) skippedSections.push(result.skipped);
    }

    if (event.durationMs > 0 || charactersAdded > 0) {
      db.prepare<[number, string, number, number]>(`
        INSERT INTO reading_daily_activity (book_id, local_date, duration_ms, characters)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(book_id, local_date) DO UPDATE SET
          duration_ms = duration_ms + excluded.duration_ms,
          characters = characters + excluded.characters
      `).run(event.bookId, event.localDate, event.durationMs, charactersAdded);
    }

    recordCompletion(db, event);

    db.prepare<[string, number, string, string, number, number, string]>(`
      INSERT INTO reading_activity_events (
        id, book_id, payload_hash, local_date, duration_ms,
        characters_added, skipped_sections, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO})
    `).run(
      event.id,
      event.bookId,
      payloadHash,
      event.localDate,
      event.durationMs,
      charactersAdded,
      JSON.stringify(skippedSections),
    );

    return { id: event.id, status: 'accepted', duplicate: false, skippedSections };
  })();
}

// ---------------------------------------------------------------------------
// Dashboard statistics
// ---------------------------------------------------------------------------

function listDays(db: DatabaseHandle, today: string): ReadingDayDto[] {
  const firstDay = shiftLocalDate(today, -(READING_STATS_DAY_COUNT - 1));
  const rows = db
    .prepare<[string, string], ReadingDayTotalRow>(`
      SELECT local_date,
             SUM(duration_ms) AS duration_ms,
             SUM(characters) AS characters
      FROM reading_daily_activity
      WHERE local_date >= ? AND local_date <= ?
      GROUP BY local_date
    `)
    .all(firstDay, today);
  const totals = new Map(rows.map((row) => [row.local_date, row]));

  return Array.from({ length: READING_STATS_DAY_COUNT }, (_, offset) => {
    const date = shiftLocalDate(firstDay, offset);
    const row = totals.get(date);
    return {
      date,
      durationMs: row?.duration_ms ?? 0,
      characters: row?.characters ?? 0,
    };
  });
}

function listYearCompletions(db: DatabaseHandle, year: number): CompletedBookDto[] {
  return db
    .prepare<[number], CompletedBookRow>(`
      SELECT b.*,
             c.local_date AS completion_local_date,
             c.occurred_at AS completion_occurred_at
      FROM reading_completions c
      INNER JOIN books b ON b.id = c.book_id
      WHERE c.year = ?
      ORDER BY c.local_date DESC, c.occurred_at DESC, c.book_id DESC
    `)
    .all(year)
    .map((row) => ({
      book: formatBook(row),
      localDate: row.completion_local_date,
      occurredAt: row.completion_occurred_at,
    }));
}

/**
 * Dashboard statistics for the reader's local `today` (a validated local date).
 *
 * The seven days and the year both derive from `today`, never from the server
 * clock or timezone. The annual count is the length of the annual list.
 */
export function getReadingStats(db: DatabaseHandle, today: string): ReadingStatsDto {
  return db.transaction((): ReadingStatsDto => {
    const settings = readSettings(db);
    const lifetime = requireQueryResult(
      db
        .prepare<[], ReadingLifetimeTotalRow>(`
          SELECT COALESCE(SUM(duration_ms), 0) AS duration_ms,
                 COALESCE(SUM(characters), 0) AS characters
          FROM reading_daily_activity
        `)
        .get(),
      'lifetime reading totals',
    );
    const completedBooks = requireQueryResult(
      db
        .prepare<[], CountRow>(`
          SELECT COUNT(*) AS value FROM (
            SELECT book_id FROM reading_completions
            UNION
            SELECT book_id FROM reading_legacy_completions
          )
        `)
        .get(),
      'completed book count',
    ).value;
    const year = localDateYear(today);
    const books = listYearCompletions(db, year);

    return {
      date: today,
      goals: formatGoals(settings),
      days: listDays(db, today),
      lifetime: {
        durationMs: lifetime.duration_ms,
        characters: lifetime.characters,
        completedBooks,
      },
      year: {
        year,
        completedCount: books.length,
        books,
      },
      trackingStartedAt: settings.tracking_started_at,
    };
  })();
}

/**
 * Period statistics for `GET /api/reading/statistics`.
 *
 * Read-only: one deferred transaction returns the range, overview, previous
 * period comparison, trend, ranking, monthly calendar and coverage from one
 * consistent snapshot. Nothing here writes, so the library revision and
 * Reading Positions never change.
 *
 * Attribution follows the captured browser-local dates of the records, never
 * acknowledgment time, the server clock or the current Reading Position:
 * - time and characters come from `reading_daily_activity` (hourly detail from
 *   `reading_hourly_activity`, a breakdown of part of the daily time);
 * - completions come from `reading_completion_observations`, one row per
 *   accepted completion event. `all` also counts known completed Books
 *   without any dated completion (`reading_legacy_completions`).
 *
 * A Book "in progress" in a range was read in it and not completed in it; a
 * completion in a later range never changes an earlier one.
 */
import type {
  ReadingStatisticsDto,
  ReadingStatisticsQuery,
  StatisticsCalendarDto,
  StatisticsComparisonDto,
  StatisticsMetricComparison,
  StatisticsMetricKey,
  StatisticsOverviewDto,
  StatisticsPeriod,
  StatisticsPeriodDimension,
  StatisticsRangeDto,
  StatisticsRankingDto,
  StatisticsTrendDto,
} from '@lan-reader/shared';
import {
  STATISTICS_METRIC_KEYS,
  STATISTICS_RANKING_LIMIT,
  countLocalDays,
  resolveStatisticsPeriod,
  shiftStatisticsAnchor,
  statisticsBucketKeys,
  statisticsTrendUnit,
} from '@lan-reader/shared';
import { requireQueryResult } from '../db/queryResult.js';
import type {
  DatabaseHandle,
  ReadingDayTotalRow,
  ReadingStatsSettingsRow,
  StatisticsBookIdRow,
  StatisticsChampionRow,
  StatisticsEarliestDateRow,
  StatisticsHourTotalRow,
  StatisticsRankingRow,
} from '../db/rows.js';
import { badRequest } from '../http/httpError.js';
import { formatBook } from './bookLibrary.js';

/** A closed local-date range, and whether undated legacy completions belong to it. */
interface StatisticsScope extends StatisticsPeriod {
  readonly includeUndated: boolean;
}

interface OverviewResult {
  readonly overview: StatisticsOverviewDto;
  readonly days: readonly ReadingDayTotalRow[];
}

function readSettings(db: DatabaseHandle): ReadingStatsSettingsRow {
  return requireQueryResult(
    db
      .prepare<[], ReadingStatsSettingsRow>('SELECT * FROM reading_stats_settings WHERE id = 1')
      .get(),
    'reading statistics settings',
  );
}

/** Earliest dated time/character or completion record, optionally not after `today`. */
function earliestRecordDate(db: DatabaseHandle, today: string | null): string | null {
  const row = requireQueryResult(
    db
      .prepare<[string | null, string | null, string | null, string | null], StatisticsEarliestDateRow>(`
        SELECT MIN(local_date) AS local_date FROM (
          SELECT local_date FROM reading_daily_activity
          WHERE ? IS NULL OR local_date <= ?
          UNION ALL
          SELECT local_date FROM reading_completion_observations
          WHERE ? IS NULL OR local_date <= ?
        )
      `)
      .get(today, today, today, today),
    'earliest statistics record',
  );
  return row.local_date;
}

function readBookIds(rows: readonly StatisticsBookIdRow[]): Set<number> {
  return new Set(rows.map((row) => row.book_id));
}

/** Known completed Books with no dated completion observation at all. */
function undatedCompletedBooks(db: DatabaseHandle): Set<number> {
  return readBookIds(
    db
      .prepare<[], StatisticsBookIdRow>(`
        SELECT l.book_id FROM reading_legacy_completions l
        WHERE NOT EXISTS (
          SELECT 1 FROM reading_completion_observations o WHERE o.book_id = l.book_id
        )
      `)
      .all(),
  );
}

function listDayTotals(db: DatabaseHandle, scope: StatisticsScope): ReadingDayTotalRow[] {
  return db
    .prepare<[string, string], ReadingDayTotalRow>(`
      SELECT local_date,
             SUM(duration_ms) AS duration_ms,
             SUM(characters) AS characters
      FROM reading_daily_activity
      WHERE local_date >= ? AND local_date <= ?
      GROUP BY local_date
      ORDER BY local_date
    `)
    .all(scope.start, scope.end);
}

function computeOverview(db: DatabaseHandle, scope: StatisticsScope): OverviewResult {
  const days = listDayTotals(db, scope);
  let durationMs = 0;
  let characters = 0;
  let readingDays = 0;
  let longestDayMs = 0;
  for (const day of days) {
    durationMs += day.duration_ms;
    characters += day.characters;
    if (day.duration_ms > 0) readingDays += 1;
    longestDayMs = Math.max(longestDayMs, day.duration_ms);
  }

  const completed = readBookIds(
    db
      .prepare<[string, string], StatisticsBookIdRow>(`
        SELECT DISTINCT book_id FROM reading_completion_observations
        WHERE local_date >= ? AND local_date <= ?
      `)
      .all(scope.start, scope.end),
  );
  if (scope.includeUndated) {
    for (const bookId of undatedCompletedBooks(db)) completed.add(bookId);
  }
  const read = readBookIds(
    db
      .prepare<[string, string], StatisticsBookIdRow>(`
        SELECT DISTINCT book_id FROM reading_daily_activity
        WHERE local_date >= ? AND local_date <= ?
          AND (duration_ms > 0 OR characters > 0)
      `)
      .all(scope.start, scope.end),
  );
  for (const bookId of completed) read.add(bookId);

  return {
    days,
    overview: {
      durationMs,
      readingDays,
      averageDailyMs: Math.round(durationMs / scope.dayCount),
      longestDayMs,
      booksRead: read.size,
      booksCompleted: completed.size,
      // Completed Books are a subset of read Books within the same range.
      booksInProgress: read.size - completed.size,
      characters,
      charactersPerMinute: durationMs === 0 ? null : Math.round(characters / (durationMs / 60_000)),
    },
  };
}

function unavailableMetrics(): Record<StatisticsMetricKey, StatisticsMetricComparison> {
  const unavailable: StatisticsMetricComparison = { kind: 'unavailable' };
  return {
    durationMs: unavailable,
    readingDays: unavailable,
    averageDailyMs: unavailable,
    longestDayMs: unavailable,
    booksRead: unavailable,
    booksCompleted: unavailable,
    booksInProgress: unavailable,
    characters: unavailable,
    charactersPerMinute: unavailable,
  };
}

/**
 * Differences to the complete previous period. The previous period is not
 * comparable when it cannot be represented or ends before statistics began:
 * the earlier of the tracking start (UTC date) and the earliest record.
 */
function compare(
  db: DatabaseHandle,
  settings: ReadingStatsSettingsRow,
  previousAnchor: string | null,
  dimension: StatisticsPeriodDimension,
  current: StatisticsOverviewDto,
): StatisticsComparisonDto {
  const previous = previousAnchor === null ? null : resolveStatisticsPeriod(dimension, previousAnchor);
  if (!previous) return { previous: null, metrics: unavailableMetrics() };

  const trackingDate = settings.tracking_started_at.slice(0, 10);
  const earliest = earliestRecordDate(db, null);
  const statisticsStart = earliest !== null && earliest < trackingDate ? earliest : trackingDate;
  if (previous.end < statisticsStart) return { previous, metrics: unavailableMetrics() };

  const before = computeOverview(db, { ...previous, includeUndated: false }).overview;
  const metrics = unavailableMetrics();
  for (const key of STATISTICS_METRIC_KEYS) {
    const now = current[key];
    const then = before[key];
    if (now !== null && then !== null) metrics[key] = { kind: 'delta', delta: now - then };
  }
  return { previous, metrics };
}

function buildTrend(
  db: DatabaseHandle,
  range: StatisticsRangeDto,
  overview: StatisticsOverviewDto,
  days: readonly ReadingDayTotalRow[],
): StatisticsTrendDto {
  const unit = statisticsTrendUnit(range.dimension);
  const keys = statisticsBucketKeys(range.dimension, range.start, range.end);
  const totals = new Map<string, number>();

  if (unit === 'hour') {
    const hours = db
      .prepare<[string], StatisticsHourTotalRow>(`
        SELECT local_hour, SUM(duration_ms) AS duration_ms
        FROM reading_hourly_activity
        WHERE local_date = ?
        GROUP BY local_hour
      `)
      .all(range.start);
    let known = 0;
    for (const hour of hours) {
      totals.set(String(hour.local_hour).padStart(2, '0'), hour.duration_ms);
      known += hour.duration_ms;
    }
    return {
      unit,
      buckets: keys.map((key) => ({ key, durationMs: totals.get(key) ?? 0 })),
      // Older events carry no hour: report them, never spread or guess them.
      unknownDurationMs: Math.max(0, overview.durationMs - known),
    };
  }

  const keyLength = unit === 'day' ? 10 : unit === 'month' ? 7 : 4;
  for (const day of days) {
    const key = day.local_date.slice(0, keyLength);
    totals.set(key, (totals.get(key) ?? 0) + day.duration_ms);
  }
  return {
    unit,
    buckets: keys.map((key) => ({ key, durationMs: totals.get(key) ?? 0 })),
    unknownDurationMs: 0,
  };
}

function buildRanking(
  db: DatabaseHandle,
  scope: StatisticsScope,
  overview: StatisticsOverviewDto,
): StatisticsRankingDto {
  // The limit applies to the displayed list only; totals come from the
  // overview, which covers every Book of the range.
  const rows = db
    .prepare<[string, string, number], StatisticsRankingRow>(`
      SELECT b.*,
             SUM(d.duration_ms) AS stat_duration_ms,
             SUM(d.characters) AS stat_characters
      FROM reading_daily_activity d
      INNER JOIN books b ON b.id = d.book_id
      WHERE d.local_date >= ? AND d.local_date <= ?
      GROUP BY d.book_id
      HAVING SUM(d.duration_ms) > 0
      ORDER BY stat_duration_ms DESC, d.book_id ASC
      LIMIT ?
    `)
    .all(scope.start, scope.end, STATISTICS_RANKING_LIMIT);

  return {
    entries: rows.map((row, index) => ({
      rank: index + 1,
      book: formatBook(row),
      durationMs: row.stat_duration_ms,
      characters: row.stat_characters,
    })),
    totals: {
      books: overview.booksRead,
      durationMs: overview.durationMs,
      characters: overview.characters,
    },
  };
}

function buildCalendar(
  db: DatabaseHandle,
  range: StatisticsRangeDto,
  days: readonly ReadingDayTotalRow[],
): StatisticsCalendarDto {
  // Each date's champion is chosen from every Book of that date.
  const champions = new Map(
    db
      .prepare<[string, string], StatisticsChampionRow>(`
        SELECT b.*,
               c.local_date AS stat_local_date,
               c.duration_ms AS stat_duration_ms
        FROM (
          SELECT book_id, local_date, duration_ms,
                 ROW_NUMBER() OVER (
                   PARTITION BY local_date
                   ORDER BY duration_ms DESC, book_id ASC
                 ) AS position
          FROM reading_daily_activity
          WHERE local_date >= ? AND local_date <= ? AND duration_ms > 0
        ) c
        INNER JOIN books b ON b.id = c.book_id
        WHERE c.position = 1
      `)
      .all(range.start, range.end)
      .map((row) => [row.stat_local_date, row]),
  );
  const totals = new Map(days.map((day) => [day.local_date, day.duration_ms]));

  return {
    days: statisticsBucketKeys('month', range.start, range.end).map((date) => {
      const champion = champions.get(date);
      return {
        date,
        durationMs: totals.get(date) ?? 0,
        champion: champion ? { book: formatBook(champion), durationMs: champion.stat_duration_ms } : null,
      };
    }),
  };
}

function resolveRange(db: DatabaseHandle, query: ReadingStatisticsQuery): StatisticsRangeDto {
  if (query.dimension === 'all') {
    const start = earliestRecordDate(db, query.today) ?? query.today;
    return {
      dimension: 'all',
      anchor: start,
      start,
      end: query.today,
      dayCount: countLocalDays(start, query.today),
      today: query.today,
      previousAnchor: null,
      nextAnchor: null,
    };
  }

  const period = query.anchor === null ? null : resolveStatisticsPeriod(query.dimension, query.anchor);
  if (!period) {
    throw badRequest('anchor must lie in a representable period', 'INVALID_STATISTICS_QUERY');
  }
  return {
    dimension: query.dimension,
    anchor: period.start,
    start: period.start,
    end: period.end,
    dayCount: period.dayCount,
    today: query.today,
    previousAnchor: shiftStatisticsAnchor(query.dimension, period.start, -1),
    nextAnchor: shiftStatisticsAnchor(query.dimension, period.start, 1),
  };
}

/** Period statistics for a validated query, read from one consistent snapshot. */
export function getReadingStatistics(
  db: DatabaseHandle,
  query: ReadingStatisticsQuery,
): ReadingStatisticsDto {
  return db.transaction((): ReadingStatisticsDto => {
    const settings = readSettings(db);
    const range = resolveRange(db, query);
    const scope: StatisticsScope = {
      start: range.start,
      end: range.end,
      dayCount: range.dayCount,
      includeUndated: range.dimension === 'all',
    };
    const { overview, days } = computeOverview(db, scope);

    return {
      range,
      overview,
      comparison:
        range.dimension === 'all'
          ? null
          : compare(db, settings, range.previousAnchor, range.dimension, overview),
      trend: buildTrend(db, range, overview, days),
      ranking: buildRanking(db, scope, overview),
      calendar: range.dimension === 'month' ? buildCalendar(db, range, days) : null,
      coverage: {
        trackingStartedAt: settings.tracking_started_at,
        detailTrackingStartedAt: settings.detail_tracking_started_at,
        undatedCompletedBooks: undatedCompletedBooks(db).size,
      },
    };
  })();
}

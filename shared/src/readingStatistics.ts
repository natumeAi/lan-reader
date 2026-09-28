/**
 * Period statistics contracts for `GET /api/reading/statistics`.
 *
 * A period is a closed range of browser-local calendar dates. Every date here
 * is a pure calendar day (`YYYY-MM-DD`): the arithmetic never consults a
 * timezone, so the server's own clock or zone cannot move a period.
 *
 * Dimensions:
 * - `day`: one date, trend in 24 hourly buckets (`"00"`–`"23"`);
 * - `week`: Monday to Sunday, 7 daily buckets;
 * - `month`: the month's actual 28–31 days, one bucket per day;
 * - `year`: 365/366 days, 12 monthly buckets (`YYYY-MM`);
 * - `all`: the earliest dated record up to the requested `today`, one bucket
 *   per calendar year (`YYYY`), contiguous and zero-filled.
 *
 * Units follow `readingStats.ts`: integer milliseconds and integer canonical
 * characters. Ranking and calendar Books are decoded by the caller's own Book
 * decoder, so there is one owner of the Book contract per workspace.
 */
import type { BookDto } from './book.js';
import { WireDecodeError, requireArray, requireRecord } from './decode.js';
import {
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  daysInMonth,
  isLocalDate,
  requireIsoInstant,
  requireLocalDate,
  requireLocalDateParts,
  requireNonNegativeInteger,
  requireSafeInteger,
  shiftLocalDate,
} from './readingStats.js';

// ---------------------------------------------------------------------------
// Dimensions and periods
// ---------------------------------------------------------------------------

export type StatisticsDimension = 'day' | 'week' | 'month' | 'year' | 'all';
/** Dimensions with a fixed calendar period and previous/next navigation. */
export type StatisticsPeriodDimension = Exclude<StatisticsDimension, 'all'>;

export const STATISTICS_DIMENSIONS: readonly StatisticsDimension[] = [
  'day',
  'week',
  'month',
  'year',
  'all',
];

/** Display cap of `ranking.entries`; totals always cover every Book of the range. */
export const STATISTICS_RANKING_LIMIT = 20;

export function isStatisticsDimension(value: unknown): value is StatisticsDimension {
  return typeof value === 'string' && (STATISTICS_DIMENSIONS as readonly string[]).includes(value);
}

/** A closed range of local dates. `dayCount` counts every calendar day in it. */
export interface StatisticsPeriod {
  readonly start: string;
  readonly end: string;
  readonly dayCount: number;
}

const DAY_MS = 86_400_000;

function utcDay(localDate: string): number {
  const [year, month, day] = requireLocalDateParts(localDate);
  return Date.UTC(year, month - 1, day);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

function monthStart(year: number, month: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-01`;
}

/** Calendar days of the closed range `[start, end]`. Both must be valid local dates. */
export function countLocalDays(start: string, end: string): number {
  return Math.round((utcDay(end) - utcDay(start)) / DAY_MS) + 1;
}

function period(start: string, end: string): StatisticsPeriod | null {
  if (!isLocalDate(start) || !isLocalDate(end)) return null;
  return { start, end, dayCount: countLocalDays(start, end) };
}

/**
 * The complete calendar period of `dimension` containing `anchor`, or `null`
 * when any of its dates lies outside 1900-01-01..9999-12-31.
 *
 * A week starts on Monday (`(weekday + 6) % 7` days before the anchor). Throws
 * `WireDecodeError` when `anchor` is not a valid local date.
 */
export function resolveStatisticsPeriod(
  dimension: StatisticsPeriodDimension,
  anchor: string,
): StatisticsPeriod | null {
  const [year, month] = requireLocalDateParts(anchor);

  switch (dimension) {
    case 'day':
      return period(anchor, anchor);
    case 'week': {
      const weekday = new Date(utcDay(anchor)).getUTCDay();
      const back = (weekday + 6) % 7;
      const start = shiftLocalDate(anchor, -back);
      return period(start, shiftLocalDate(start, 6));
    }
    case 'month':
      return period(monthStart(year, month), `${pad(year, 4)}-${pad(month, 2)}-${pad(daysInMonth(year, month), 2)}`);
    case 'year':
      return period(`${pad(year, 4)}-01-01`, `${pad(year, 4)}-12-31`);
  }
}

/**
 * The canonical anchor (first day) of the period `step` periods away from the
 * one containing `anchor`, or `null` when either period is unrepresentable.
 */
export function shiftStatisticsAnchor(
  dimension: StatisticsPeriodDimension,
  anchor: string,
  step: 1 | -1,
): string | null {
  const current = resolveStatisticsPeriod(dimension, anchor);
  if (!current) return null;

  let target: string;
  switch (dimension) {
    case 'day':
      target = shiftLocalDate(current.start, step);
      break;
    case 'week':
      target = shiftLocalDate(current.start, 7 * step);
      break;
    case 'month': {
      const [year, month] = requireLocalDateParts(current.start);
      const index = year * 12 + (month - 1) + step;
      const targetYear = Math.floor(index / 12);
      if (targetYear < MIN_CALENDAR_YEAR || targetYear > MAX_CALENDAR_YEAR) return null;
      target = monthStart(targetYear, (index % 12) + 1);
      break;
    }
    case 'year': {
      const targetYear = requireLocalDateParts(current.start)[0] + step;
      if (targetYear < MIN_CALENDAR_YEAR || targetYear > MAX_CALENDAR_YEAR) return null;
      target = `${pad(targetYear, 4)}-01-01`;
      break;
    }
  }

  if (!isLocalDate(target)) return null;
  return resolveStatisticsPeriod(dimension, target)?.start ?? null;
}

export type StatisticsTrendUnit = 'hour' | 'day' | 'month' | 'year';

export function statisticsTrendUnit(dimension: StatisticsDimension): StatisticsTrendUnit {
  switch (dimension) {
    case 'day':
      return 'hour';
    case 'week':
    case 'month':
      return 'day';
    case 'year':
      return 'month';
    case 'all':
      return 'year';
  }
}

/**
 * Trend bucket keys of a range, in order: `"00"`–`"23"` for a day, every date
 * for a week/month, `YYYY-01`–`YYYY-12` for a year and every calendar year
 * from `start` to `end` for `all`. `start`/`end` must be valid local dates.
 */
export function statisticsBucketKeys(
  dimension: StatisticsDimension,
  start: string,
  end: string,
): string[] {
  switch (dimension) {
    case 'day':
      return Array.from({ length: 24 }, (_, hour) => pad(hour, 2));
    case 'week':
    case 'month':
      return Array.from({ length: countLocalDays(start, end) }, (_, offset) =>
        shiftLocalDate(start, offset),
      );
    case 'year': {
      const year = pad(requireLocalDateParts(start)[0], 4);
      return Array.from({ length: 12 }, (_, month) => `${year}-${pad(month + 1, 2)}`);
    }
    case 'all': {
      const first = requireLocalDateParts(start)[0];
      const last = requireLocalDateParts(end)[0];
      return Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) =>
        pad(first + offset, 4),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Validated `GET /api/reading/statistics?dimension=&anchor=&today=` query. */
export interface ReadingStatisticsQuery {
  readonly dimension: StatisticsDimension;
  /** The requested anchor for a period dimension; `null` for `all` (ignored). */
  readonly anchor: string | null;
  /** The reader's browser-local today. */
  readonly today: string;
}

function readQueryString(query: Record<string, unknown>, name: string): string {
  const value = query[name];
  if (typeof value !== 'string') {
    throw new WireDecodeError(`${name} must be given exactly once`);
  }
  return value;
}

/**
 * Decodes the statistics query (e.g. an Express `req.query`). `today` is
 * required; `anchor` is required for period dimensions and must lie in a
 * representable period; `all` ignores `anchor`.
 */
export function decodeReadingStatisticsQuery(value: unknown): ReadingStatisticsQuery {
  const query = requireRecord(value, 'statistics query');
  const dimension = readQueryString(query, 'dimension');
  if (!isStatisticsDimension(dimension)) {
    throw new WireDecodeError('dimension must be day, week, month, year or all');
  }
  const today = requireLocalDate(readQueryString(query, 'today'), 'today');
  if (dimension === 'all') {
    return { dimension, anchor: null, today };
  }

  const anchor = requireLocalDate(readQueryString(query, 'anchor'), 'anchor');
  if (!resolveStatisticsPeriod(dimension, anchor)) {
    throw new WireDecodeError('anchor must lie in a representable period');
  }
  return { dimension, anchor, today };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type StatisticsMetricKey =
  | 'durationMs'
  | 'readingDays'
  | 'averageDailyMs'
  | 'longestDayMs'
  | 'booksRead'
  | 'booksCompleted'
  | 'booksInProgress'
  | 'characters'
  | 'charactersPerMinute';

export const STATISTICS_METRIC_KEYS: readonly StatisticsMetricKey[] = [
  'durationMs',
  'readingDays',
  'averageDailyMs',
  'longestDayMs',
  'booksRead',
  'booksCompleted',
  'booksInProgress',
  'characters',
  'charactersPerMinute',
];

export interface StatisticsRangeDto {
  readonly dimension: StatisticsDimension;
  /** Canonical first day of the period; for `all` the same as `start`. */
  readonly anchor: string;
  readonly start: string;
  readonly end: string;
  /** Every calendar day of the complete period, read or not. */
  readonly dayCount: number;
  readonly today: string;
  /** `null` for `all` or when the adjacent period is unrepresentable. */
  readonly previousAnchor: string | null;
  readonly nextAnchor: string | null;
}

export interface StatisticsOverviewDto {
  readonly durationMs: number;
  /** Dates whose all-Book total duration is positive. */
  readonly readingDays: number;
  /** `Math.round(durationMs / dayCount)`. */
  readonly averageDailyMs: number;
  /** Largest all-Book total of one date. */
  readonly longestDayMs: number;
  /** Books with positive time, new characters or a completion in the range. */
  readonly booksRead: number;
  /** Books with at least one completion in the range. */
  readonly booksCompleted: number;
  /** `booksRead - booksCompleted`: read in the range and not completed in it. */
  readonly booksInProgress: number;
  readonly characters: number;
  /** `null` when `durationMs` is `0`. */
  readonly charactersPerMinute: number | null;
}

export type StatisticsMetricComparison =
  | { readonly kind: 'delta'; readonly delta: number }
  | { readonly kind: 'unavailable' };

export interface StatisticsComparisonDto {
  /** The complete previous period; `null` when it is unrepresentable. */
  readonly previous: StatisticsPeriod | null;
  readonly metrics: Readonly<Record<StatisticsMetricKey, StatisticsMetricComparison>>;
}

export interface StatisticsTrendBucketDto {
  readonly key: string;
  readonly durationMs: number;
}

export interface StatisticsTrendDto {
  readonly unit: StatisticsTrendUnit;
  readonly buckets: readonly StatisticsTrendBucketDto[];
  /** Day only: known time recorded without an hour (older events). Otherwise `0`. */
  readonly unknownDurationMs: number;
}

export interface StatisticsRankingEntryDto {
  /** 1-based position. */
  readonly rank: number;
  readonly book: BookDto;
  readonly durationMs: number;
  readonly characters: number;
}

export interface StatisticsRankingDto {
  /** Positive-duration Books, longest first then lowest id; at most `STATISTICS_RANKING_LIMIT`. */
  readonly entries: readonly StatisticsRankingEntryDto[];
  /** Every Book read in the range, independent of the display cap. */
  readonly totals: {
    readonly books: number;
    readonly durationMs: number;
    readonly characters: number;
  };
}

export interface StatisticsCalendarDayDto {
  readonly date: string;
  /** All-Book total of the date. */
  readonly durationMs: number;
  /** Longest Book of the date (ties: lowest id); `null` without positive time. */
  readonly champion: { readonly book: BookDto; readonly durationMs: number } | null;
}

export interface StatisticsCalendarDto {
  readonly days: readonly StatisticsCalendarDayDto[];
}

export interface StatisticsCoverageDto {
  /** Since when durations, characters and yearly completions are recorded. */
  readonly trackingStartedAt: string;
  /** Since when hourly attribution and every completion observation are recorded. */
  readonly detailTrackingStartedAt: string | null;
  /** Known completed Books without any dated completion; counted only by `all`. */
  readonly undatedCompletedBooks: number;
}

export interface ReadingStatisticsDto {
  readonly range: StatisticsRangeDto;
  readonly overview: StatisticsOverviewDto;
  /** `null` for `all`. */
  readonly comparison: StatisticsComparisonDto | null;
  readonly trend: StatisticsTrendDto;
  readonly ranking: StatisticsRankingDto;
  /** Month only. */
  readonly calendar: StatisticsCalendarDto | null;
  readonly coverage: StatisticsCoverageDto;
}

/** `GET /api/reading/statistics` 200 body. */
export interface ReadingStatisticsResponse {
  readonly statistics: ReadingStatisticsDto;
}

// ---------------------------------------------------------------------------
// Response decoder
// ---------------------------------------------------------------------------

function requireNullableLocalDate(value: unknown, context: string): string | null {
  return value === null ? null : requireLocalDate(value, context);
}

function requireEqual<T>(actual: T, expected: T, context: string): void {
  if (actual !== expected) {
    throw new WireDecodeError(`${context} is inconsistent with the range`);
  }
}

function decodeRange(value: unknown): StatisticsRangeDto {
  const range = requireRecord(value, 'statistics.range');
  const dimension = range['dimension'];
  if (!isStatisticsDimension(dimension)) {
    throw new WireDecodeError('statistics.range.dimension is not a known dimension');
  }
  const anchor = requireLocalDate(range['anchor'], 'statistics.range.anchor');
  const start = requireLocalDate(range['start'], 'statistics.range.start');
  const end = requireLocalDate(range['end'], 'statistics.range.end');
  const today = requireLocalDate(range['today'], 'statistics.range.today');
  const dayCount = requireSafeInteger(range['dayCount'], 'statistics.range.dayCount', 1, Number.MAX_SAFE_INTEGER);
  const previousAnchor = requireNullableLocalDate(range['previousAnchor'], 'statistics.range.previousAnchor');
  const nextAnchor = requireNullableLocalDate(range['nextAnchor'], 'statistics.range.nextAnchor');

  if (dimension === 'all') {
    if (start > end) throw new WireDecodeError('statistics.range.start must not follow end');
    requireEqual(end, today, 'statistics.range.end');
    requireEqual(anchor, start, 'statistics.range.anchor');
    requireEqual(dayCount, countLocalDays(start, end), 'statistics.range.dayCount');
    requireEqual(previousAnchor, null, 'statistics.range.previousAnchor');
    requireEqual(nextAnchor, null, 'statistics.range.nextAnchor');
  } else {
    const period = resolveStatisticsPeriod(dimension, anchor);
    if (!period) throw new WireDecodeError('statistics.range.anchor is not representable');
    requireEqual(anchor, period.start, 'statistics.range.anchor');
    requireEqual(start, period.start, 'statistics.range.start');
    requireEqual(end, period.end, 'statistics.range.end');
    requireEqual(dayCount, period.dayCount, 'statistics.range.dayCount');
    requireEqual(previousAnchor, shiftStatisticsAnchor(dimension, anchor, -1), 'statistics.range.previousAnchor');
    requireEqual(nextAnchor, shiftStatisticsAnchor(dimension, anchor, 1), 'statistics.range.nextAnchor');
  }

  return { dimension, anchor, start, end, dayCount, today, previousAnchor, nextAnchor };
}

function decodeOverview(value: unknown, range: StatisticsRangeDto): StatisticsOverviewDto {
  const overview = requireRecord(value, 'statistics.overview');
  const field = (name: string) =>
    requireNonNegativeInteger(overview[name], `statistics.overview.${name}`);
  const durationMs = field('durationMs');
  const readingDays = field('readingDays');
  const averageDailyMs = field('averageDailyMs');
  const longestDayMs = field('longestDayMs');
  const booksRead = field('booksRead');
  const booksCompleted = field('booksCompleted');
  const booksInProgress = field('booksInProgress');
  const characters = field('characters');
  const charactersPerMinute =
    overview['charactersPerMinute'] === null
      ? null
      : requireNonNegativeInteger(overview['charactersPerMinute'], 'statistics.overview.charactersPerMinute');

  if (readingDays > range.dayCount) {
    throw new WireDecodeError('statistics.overview.readingDays exceeds the range');
  }
  if (longestDayMs > durationMs) {
    throw new WireDecodeError('statistics.overview.longestDayMs exceeds durationMs');
  }
  requireEqual(averageDailyMs, Math.round(durationMs / range.dayCount), 'statistics.overview.averageDailyMs');
  if (booksCompleted > booksRead || booksInProgress !== booksRead - booksCompleted) {
    throw new WireDecodeError('statistics.overview book counts are inconsistent');
  }
  if ((durationMs === 0) !== (charactersPerMinute === null)) {
    throw new WireDecodeError('statistics.overview.charactersPerMinute is null exactly when durationMs is 0');
  }

  return {
    durationMs,
    readingDays,
    averageDailyMs,
    longestDayMs,
    booksRead,
    booksCompleted,
    booksInProgress,
    characters,
    charactersPerMinute,
  };
}

function decodeMetric(value: unknown, context: string): StatisticsMetricComparison {
  const metric = requireRecord(value, context);
  if (metric['kind'] === 'unavailable') return { kind: 'unavailable' };
  if (metric['kind'] === 'delta') {
    return {
      kind: 'delta',
      delta: requireSafeInteger(metric['delta'], `${context}.delta`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    };
  }
  throw new WireDecodeError(`${context}.kind must be "delta" or "unavailable"`);
}

function decodeComparison(value: unknown, range: StatisticsRangeDto): StatisticsComparisonDto | null {
  if (range.dimension === 'all') {
    if (value !== null) throw new WireDecodeError('statistics.comparison must be null for all');
    return null;
  }
  const comparison = requireRecord(value, 'statistics.comparison');
  let previous: StatisticsPeriod | null = null;
  if (comparison['previous'] !== null) {
    const raw = requireRecord(comparison['previous'], 'statistics.comparison.previous');
    const expected = range.previousAnchor === null ? null : resolveStatisticsPeriod(range.dimension, range.previousAnchor);
    if (!expected) throw new WireDecodeError('statistics.comparison.previous must be null without a previous period');
    requireEqual(requireLocalDate(raw['start'], 'statistics.comparison.previous.start'), expected.start, 'statistics.comparison.previous.start');
    requireEqual(requireLocalDate(raw['end'], 'statistics.comparison.previous.end'), expected.end, 'statistics.comparison.previous.end');
    requireEqual(
      requireNonNegativeInteger(raw['dayCount'], 'statistics.comparison.previous.dayCount'),
      expected.dayCount,
      'statistics.comparison.previous.dayCount',
    );
    previous = expected;
  } else if (range.previousAnchor !== null) {
    throw new WireDecodeError('statistics.comparison.previous is missing');
  }

  const rawMetrics = requireRecord(comparison['metrics'], 'statistics.comparison.metrics');
  const metric = (key: StatisticsMetricKey) =>
    decodeMetric(rawMetrics[key], `statistics.comparison.metrics.${key}`);
  const metrics: Record<StatisticsMetricKey, StatisticsMetricComparison> = {
    durationMs: metric('durationMs'),
    readingDays: metric('readingDays'),
    averageDailyMs: metric('averageDailyMs'),
    longestDayMs: metric('longestDayMs'),
    booksRead: metric('booksRead'),
    booksCompleted: metric('booksCompleted'),
    booksInProgress: metric('booksInProgress'),
    characters: metric('characters'),
    charactersPerMinute: metric('charactersPerMinute'),
  };
  if (previous === null && STATISTICS_METRIC_KEYS.some((key) => metrics[key].kind !== 'unavailable')) {
    throw new WireDecodeError('statistics.comparison without a previous period must be unavailable');
  }
  return { previous, metrics };
}

function decodeTrend(value: unknown, range: StatisticsRangeDto, overview: StatisticsOverviewDto): StatisticsTrendDto {
  const trend = requireRecord(value, 'statistics.trend');
  const unit = statisticsTrendUnit(range.dimension);
  requireEqual(trend['unit'], unit, 'statistics.trend.unit');
  const keys = statisticsBucketKeys(range.dimension, range.start, range.end);
  const rawBuckets = requireArray(trend['buckets'], 'statistics.trend.buckets');
  if (rawBuckets.length !== keys.length) {
    throw new WireDecodeError(`statistics.trend.buckets must hold ${keys.length} buckets`);
  }
  const buckets = rawBuckets.map((entry, index) => {
    const context = `statistics.trend.buckets[${index}]`;
    const bucket = requireRecord(entry, context);
    requireEqual(bucket['key'], keys[index], `${context}.key`);
    return { key: keys[index] ?? '', durationMs: requireNonNegativeInteger(bucket['durationMs'], `${context}.durationMs`) };
  });
  const unknownDurationMs = requireNonNegativeInteger(trend['unknownDurationMs'], 'statistics.trend.unknownDurationMs');
  if (unit !== 'hour' && unknownDurationMs !== 0) {
    throw new WireDecodeError('statistics.trend.unknownDurationMs is only used by day');
  }
  const total = buckets.reduce((sum, bucket) => sum + bucket.durationMs, unknownDurationMs);
  requireEqual(total, overview.durationMs, 'statistics.trend total');
  return { unit, buckets, unknownDurationMs };
}

function decodeRanking(
  value: unknown,
  overview: StatisticsOverviewDto,
  decodeBook: (value: unknown) => BookDto,
): StatisticsRankingDto {
  const ranking = requireRecord(value, 'statistics.ranking');
  const rawEntries = requireArray(ranking['entries'], 'statistics.ranking.entries');
  if (rawEntries.length > STATISTICS_RANKING_LIMIT) {
    throw new WireDecodeError(`statistics.ranking.entries must hold at most ${STATISTICS_RANKING_LIMIT} entries`);
  }
  const seen = new Set<number>();
  const entries = rawEntries.map((entry, index): StatisticsRankingEntryDto => {
    const context = `statistics.ranking.entries[${index}]`;
    const record = requireRecord(entry, context);
    const rank = requireSafeInteger(record['rank'], `${context}.rank`, 1, STATISTICS_RANKING_LIMIT);
    requireEqual(rank, index + 1, `${context}.rank`);
    const book = decodeBook(record['book']);
    if (seen.has(book.id)) throw new WireDecodeError(`${context}.book repeats an earlier Book`);
    seen.add(book.id);
    return {
      rank,
      book,
      durationMs: requireSafeInteger(record['durationMs'], `${context}.durationMs`, 1, Number.MAX_SAFE_INTEGER),
      characters: requireNonNegativeInteger(record['characters'], `${context}.characters`),
    };
  });
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      previous &&
      current &&
      (current.durationMs > previous.durationMs ||
        (current.durationMs === previous.durationMs && current.book.id < previous.book.id))
    ) {
      throw new WireDecodeError('statistics.ranking.entries must be ordered by duration, then Book id');
    }
  }

  const rawTotals = requireRecord(ranking['totals'], 'statistics.ranking.totals');
  const totals = {
    books: requireNonNegativeInteger(rawTotals['books'], 'statistics.ranking.totals.books'),
    durationMs: requireNonNegativeInteger(rawTotals['durationMs'], 'statistics.ranking.totals.durationMs'),
    characters: requireNonNegativeInteger(rawTotals['characters'], 'statistics.ranking.totals.characters'),
  };
  if (totals.books < entries.length) {
    throw new WireDecodeError('statistics.ranking.totals.books is smaller than the list');
  }
  requireEqual(totals.books, overview.booksRead, 'statistics.ranking.totals.books');
  requireEqual(totals.durationMs, overview.durationMs, 'statistics.ranking.totals.durationMs');
  requireEqual(totals.characters, overview.characters, 'statistics.ranking.totals.characters');
  if (entries.reduce((sum, entry) => sum + entry.durationMs, 0) > totals.durationMs) {
    throw new WireDecodeError('statistics.ranking.entries exceed the total duration');
  }
  return { entries, totals };
}

function decodeCalendar(
  value: unknown,
  range: StatisticsRangeDto,
  decodeBook: (value: unknown) => BookDto,
): StatisticsCalendarDto | null {
  if (range.dimension !== 'month') {
    if (value !== null) throw new WireDecodeError('statistics.calendar is only used by month');
    return null;
  }
  const calendar = requireRecord(value, 'statistics.calendar');
  const keys = statisticsBucketKeys('month', range.start, range.end);
  const rawDays = requireArray(calendar['days'], 'statistics.calendar.days');
  if (rawDays.length !== keys.length) {
    throw new WireDecodeError(`statistics.calendar.days must hold ${keys.length} days`);
  }
  const days = rawDays.map((entry, index): StatisticsCalendarDayDto => {
    const context = `statistics.calendar.days[${index}]`;
    const day = requireRecord(entry, context);
    const date = requireLocalDate(day['date'], `${context}.date`);
    requireEqual(date, keys[index], `${context}.date`);
    const durationMs = requireNonNegativeInteger(day['durationMs'], `${context}.durationMs`);
    let champion: StatisticsCalendarDayDto['champion'] = null;
    if (day['champion'] !== null) {
      const raw = requireRecord(day['champion'], `${context}.champion`);
      champion = {
        book: decodeBook(raw['book']),
        durationMs: requireSafeInteger(raw['durationMs'], `${context}.champion.durationMs`, 1, Number.MAX_SAFE_INTEGER),
      };
      if (champion.durationMs > durationMs) {
        throw new WireDecodeError(`${context}.champion exceeds the day total`);
      }
    }
    if ((durationMs > 0) !== (champion !== null)) {
      throw new WireDecodeError(`${context}.champion is present exactly on days with time`);
    }
    return { date, durationMs, champion };
  });
  return { days };
}

function decodeCoverage(value: unknown): StatisticsCoverageDto {
  const coverage = requireRecord(value, 'statistics.coverage');
  return {
    trackingStartedAt: requireIsoInstant(coverage['trackingStartedAt'], 'statistics.coverage.trackingStartedAt'),
    detailTrackingStartedAt:
      coverage['detailTrackingStartedAt'] === null
        ? null
        : requireIsoInstant(coverage['detailTrackingStartedAt'], 'statistics.coverage.detailTrackingStartedAt'),
    undatedCompletedBooks: requireNonNegativeInteger(
      coverage['undatedCompletedBooks'],
      'statistics.coverage.undatedCompletedBooks',
    ),
  };
}

/**
 * Decodes the `GET /api/reading/statistics` 200 body strictly: bucket counts
 * and keys follow the range, totals match the overview, the ranking is
 * ordered and capped, and a calendar exists only for a month.
 */
export function decodeReadingStatisticsResponse(
  value: unknown,
  decodeBook: (value: unknown) => BookDto,
): ReadingStatisticsDto {
  const statistics = requireRecord(
    requireRecord(value, 'statistics response')['statistics'],
    'statistics',
  );
  const range = decodeRange(statistics['range']);
  const overview = decodeOverview(statistics['overview'], range);
  return {
    range,
    overview,
    comparison: decodeComparison(statistics['comparison'], range),
    trend: decodeTrend(statistics['trend'], range, overview),
    ranking: decodeRanking(statistics['ranking'], overview, decodeBook),
    calendar: decodeCalendar(statistics['calendar'], range, decodeBook),
    coverage: decodeCoverage(statistics['coverage']),
  };
}

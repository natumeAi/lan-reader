/**
 * Reading statistics contracts: goals, activity events and dashboard totals.
 *
 * Everything here is browser-safe and engine-independent. The server receives
 * primitive canonical text offsets, an opaque text signature and a stable event
 * identity — never prose, CFIs, DOM nodes or reader-engine objects.
 *
 * Units:
 * - durations are integer milliseconds of foreground reading time;
 * - characters are integer counts of canonical text units (normalization v1:
 *   non-whitespace Unicode code points, punctuation included, control/format
 *   characters excluded);
 * - local dates are the reading browser's calendar day, `YYYY-MM-DD`. The
 *   server never substitutes its own timezone; a year is always taken from a
 *   captured local date, never from a UTC instant.
 *
 * Statistics belong to one imported Book id, exactly like Reading Positions.
 */
import type { BookDto } from './book.js';
import {
  WireDecodeError,
  requireArray,
  requireInteger,
  requireRecord,
} from './decode.js';

// ---------------------------------------------------------------------------
// Units and bounds
// ---------------------------------------------------------------------------

/** The only canonical text normalization the server currently accepts. */
export const READING_TEXT_NORMALIZATION_VERSION = 1;

export const DEFAULT_DAILY_GOAL_MINUTES = 10;
export const MIN_DAILY_GOAL_MINUTES = 1;
export const MAX_DAILY_GOAL_MINUTES = 1440;

export const DEFAULT_ANNUAL_BOOK_GOAL = 9;
export const MIN_ANNUAL_BOOK_GOAL = 1;
export const MAX_ANNUAL_BOOK_GOAL = 9999;

/** Number of daily buckets in `GET /api/reading/stats`, ending with the requested day. */
export const READING_STATS_DAY_COUNT = 7;

/**
 * Most events one `POST /api/reading/activity` may carry.
 *
 * The server's JSON body limit is 1 MB. A single maximal event stays well
 * below it; a sender that receives 413 should retry with a smaller batch.
 */
export const MAX_ACTIVITY_BATCH_EVENTS = 50;
/** One event covers at most one local day of foreground time. */
export const MAX_ACTIVITY_DURATION_MS = 86_400_000;
export const MAX_ACTIVITY_SECTIONS = 32;
export const MAX_SECTION_INTERVALS = 256;
export const MAX_SECTION_INDEX = 100_000;
export const MAX_SECTION_LENGTH = 10_000_000;

/**
 * Stable client-generated event identity, e.g. a UUID. Retries resend the same
 * id with the same payload; the same id with another payload is a conflict.
 */
export const ACTIVITY_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Canonical text signature of one section: an opaque ASCII token compared for
 * equality only. Recommended form is `<algorithm>:<hex digest>` of the
 * canonical text. Note that `crypto.subtle` is unavailable on plain-HTTP LAN
 * origins, so the client needs a hash that works outside secure contexts.
 */
export const TEXT_SIGNATURE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const MIN_CALENDAR_YEAR = 1900;
const MAX_CALENDAR_YEAR = 9999;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Half-open canonical offsets `[start, end)` within one section. */
export type CharacterInterval = readonly [start: number, end: number];

/** Viewed canonical text of one spine section within one activity event. */
export interface ViewedSectionCoverage {
  /** Spine index of the section within its Book. */
  readonly sectionIndex: number;
  readonly normalizationVersion: typeof READING_TEXT_NORMALIZATION_VERSION;
  /** Signature of the section's canonical text; see `TEXT_SIGNATURE_PATTERN`. */
  readonly signature: string;
  /** Canonical length of the whole section, in characters. */
  readonly sectionLength: number;
  /** Nonempty list; the server merges overlapping or touching intervals. */
  readonly intervals: readonly CharacterInterval[];
}

/**
 * A qualifying "reached the end" observation.
 *
 * It keeps its own instant and captured local date so its year never follows
 * a later checkpoint, retry or delivery date.
 */
export interface ReadingCompletionObservation {
  /** ISO 8601 instant with `Z` or an explicit offset. */
  readonly occurredAt: string;
  /** Browser-local calendar date at `occurredAt`. Its year is the completion year. */
  readonly localDate: string;
}

/** One immutable activity record of `POST /api/reading/activity`. */
export interface ReadingActivityEvent {
  readonly id: string;
  readonly bookId: number;
  /** Local day to which `durationMs` and newly covered characters are attributed. */
  readonly localDate: string;
  /** ISO 8601 instant of the observation or segment end. */
  readonly occurredAt: string;
  /** Integer foreground milliseconds, `0` for observation-only records. */
  readonly durationMs: number;
  /** At most one entry per `sectionIndex`. */
  readonly sections: readonly ViewedSectionCoverage[];
  readonly completion: ReadingCompletionObservation | null;
}

/** Request body of `POST /api/reading/activity`. */
export interface ReadingActivityBatchRequest {
  readonly events: readonly ReadingActivityEvent[];
}

/** Permanent per-record rejection reasons. Unknown/5xx failures are never listed here. */
export type ReadingActivityRejectionReason =
  | 'INVALID_ACTIVITY'
  | 'BOOK_NOT_FOUND'
  | 'EVENT_ID_CONFLICT';

export type SkippedCoverageReason = 'SIGNATURE_MISMATCH';

/**
 * Coverage of one section that an accepted event could not apply because the
 * stored canonical text differs. Time and completion of the event still count.
 */
export interface SkippedSectionCoverage {
  readonly sectionIndex: number;
  readonly normalizationVersion: number;
  readonly reason: SkippedCoverageReason;
}

export interface AcceptedActivityOutcome {
  readonly id: string;
  readonly status: 'accepted';
  /** `true` when this id had already been accepted with the identical payload. */
  readonly duplicate: boolean;
  /** Stored with the acknowledgment, so a retry returns the same list. */
  readonly skippedSections: readonly SkippedSectionCoverage[];
}

export interface RejectedActivityOutcome {
  readonly id: string;
  readonly status: 'rejected';
  readonly reason: ReadingActivityRejectionReason;
}

export type ReadingActivityOutcome = AcceptedActivityOutcome | RejectedActivityOutcome;

/** `POST /api/reading/activity` 200 body: one outcome per event, in request order. */
export interface ReadingActivityBatchResponse {
  readonly results: readonly ReadingActivityOutcome[];
}

export interface ReadingGoalsDto {
  /** Daily foreground-time goal in minutes, `1`–`1440`. */
  readonly dailyMinutes: number;
  /** Books to complete per calendar year, `1`–`9999`. */
  readonly annualBooks: number;
}

/** `PUT /api/reading/goals` body. At least one field is required. */
export interface ReadingGoalsUpdate {
  readonly dailyMinutes?: number;
  readonly annualBooks?: number;
}

/** `PUT /api/reading/goals` 200 body. */
export interface ReadingGoalsResponse {
  readonly goals: ReadingGoalsDto;
}

export interface ReadingDayDto {
  readonly date: string;
  readonly durationMs: number;
  readonly characters: number;
}

export interface ReadingLifetimeDto {
  readonly durationMs: number;
  readonly characters: number;
  /** Distinct Books with a dated completion or known legacy completion. */
  readonly completedBooks: number;
}

export interface CompletedBookDto {
  readonly book: BookDto;
  /** Earliest completion local date within the year. */
  readonly localDate: string;
  readonly occurredAt: string;
}

export interface ReadingYearDto {
  readonly year: number;
  /** Always `books.length`: count and list share one membership query. */
  readonly completedCount: number;
  /** Most recent completion first. */
  readonly books: readonly CompletedBookDto[];
}

export interface ReadingStatsDto {
  /** The requested local "today". */
  readonly date: string;
  readonly goals: ReadingGoalsDto;
  /** `READING_STATS_DAY_COUNT` days, oldest first, ending with `date`; zero days included. */
  readonly days: readonly ReadingDayDto[];
  readonly lifetime: ReadingLifetimeDto;
  /** Completions of the calendar year of `date`. */
  readonly year: ReadingYearDto;
  /** ISO 8601 instant since which statistics are recorded. */
  readonly trackingStartedAt: string;
}

/** `GET /api/reading/stats?date=YYYY-MM-DD` 200 body. */
export interface ReadingStatsResponse {
  readonly stats: ReadingStatsDto;
}

// ---------------------------------------------------------------------------
// Local calendar dates
// ---------------------------------------------------------------------------

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `true` only for a real calendar date written exactly as `YYYY-MM-DD`. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  return (
    year >= MIN_CALENDAR_YEAR &&
    year <= MAX_CALENDAR_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** The browser-local calendar date of `date`, as `YYYY-MM-DD`. */
export function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function requireLocalDateParts(localDate: string): [number, number, number] {
  if (!isLocalDate(localDate)) {
    throw new WireDecodeError(`${localDate} is not a YYYY-MM-DD calendar date`);
  }
  const [year, month, day] = localDate.split('-').map(Number);
  return [year ?? 0, month ?? 0, day ?? 0];
}

/**
 * Calendar arithmetic on a local date, independent of any timezone: the date
 * is treated as a pure calendar day.
 */
export function shiftLocalDate(localDate: string, days: number): string {
  const [year, month, day] = requireLocalDateParts(localDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(shifted.getUTCFullYear()).padStart(4, '0'),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Calendar year of a local date. */
export function localDateYear(localDate: string): number {
  return requireLocalDateParts(localDate)[0];
}

/**
 * `true` for an ISO 8601 instant with seconds and `Z` or an explicit offset.
 *
 * The UTC year must also stay within the supported range, so a server that
 * normalizes an accepted instant with `toISOString()` always returns a value
 * this decoder accepts again (e.g. `9999-12-31T23:59:59-14:00` is year 10000
 * in UTC and is rejected).
 */
export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < MIN_CALENDAR_YEAR || year > MAX_CALENDAR_YEAR) return false;
  if (!isLocalDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const utcYear = new Date(time).getUTCFullYear();
  return utcYear >= MIN_CALENDAR_YEAR && utcYear <= MAX_CALENDAR_YEAR;
}

// ---------------------------------------------------------------------------
// Canonical intervals
// ---------------------------------------------------------------------------

/**
 * Union of interval lists, sorted, with overlapping and touching intervals
 * merged. Inputs are not mutated.
 */
export function mergeCharacterIntervals(
  ...lists: readonly (readonly CharacterInterval[])[]
): CharacterInterval[] {
  const all = lists
    .flat()
    .map(([start, end]): [number, number] => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];

  for (const [start, end] of all) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
}

/** Characters covered by an already merged interval list. */
export function countIntervalCharacters(intervals: readonly CharacterInterval[]): number {
  return intervals.reduce((total, [start, end]) => total + (end - start), 0);
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

function requireSafeInteger(value: unknown, context: string, min: number, max: number): number {
  const integer = requireInteger(value, context);
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    throw new WireDecodeError(`${context} must be an integer between ${min} and ${max}`);
  }
  return integer;
}

function requireNonNegativeInteger(value: unknown, context: string): number {
  return requireSafeInteger(value, context, 0, Number.MAX_SAFE_INTEGER);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new WireDecodeError(`${context} must be a string`);
  }
  return value;
}

function requireLocalDate(value: unknown, context: string): string {
  if (!isLocalDate(value)) {
    throw new WireDecodeError(`${context} must be a YYYY-MM-DD calendar date`);
  }
  return value;
}

function requireIsoInstant(value: unknown, context: string): string {
  if (!isIsoInstant(value)) {
    throw new WireDecodeError(`${context} must be an ISO 8601 instant with a timezone`);
  }
  return value;
}

function requireBoundedArray(value: unknown, context: string, max: number): unknown[] {
  const array = requireArray(value, context);
  if (array.length > max) {
    throw new WireDecodeError(`${context} must contain at most ${max} entries`);
  }
  return array;
}

/** A valid activity event id, or `null` when the value cannot identify an event. */
export function readActivityEventId(value: unknown): string | null {
  return typeof value === 'string' && ACTIVITY_EVENT_ID_PATTERN.test(value) ? value : null;
}

/**
 * Validates the `POST /api/reading/activity` envelope and every event's id,
 * leaving each event body for per-record decoding. Throws when the envelope is
 * invalid, a record has no usable id, or ids repeat: in all three cases no
 * per-record outcome could be attributed, so nothing may be written.
 */
export function decodeReadingActivityBatchEntries(
  value: unknown,
): { readonly id: string; readonly value: unknown }[] {
  const body = requireRecord(value, 'activity batch');
  const events = requireArray(body['events'], 'events');
  if (events.length === 0 || events.length > MAX_ACTIVITY_BATCH_EVENTS) {
    throw new WireDecodeError(`events must contain 1 to ${MAX_ACTIVITY_BATCH_EVENTS} entries`);
  }

  const seen = new Set<string>();
  return events.map((event, index) => {
    const id = readActivityEventId(requireRecord(event, `events[${index}]`)['id']);
    if (id === null) {
      throw new WireDecodeError(`events[${index}].id must be a valid event id`);
    }
    if (seen.has(id)) {
      throw new WireDecodeError(`events[${index}].id repeats an earlier event`);
    }
    seen.add(id);
    return { id, value: event };
  });
}

function decodeInterval(value: unknown, context: string, sectionLength: number): CharacterInterval {
  const pair = requireArray(value, context);
  if (pair.length !== 2) {
    throw new WireDecodeError(`${context} must be a [start, end] pair`);
  }
  const start = requireSafeInteger(pair[0], `${context}[0]`, 0, sectionLength - 1);
  const end = requireSafeInteger(pair[1], `${context}[1]`, 1, sectionLength);
  if (start >= end) {
    throw new WireDecodeError(`${context} must satisfy start < end`);
  }
  return [start, end];
}

/** Decodes a stored or submitted interval list against its section length. */
export function decodeCharacterIntervals(
  value: unknown,
  context: string,
  sectionLength: number,
): CharacterInterval[] {
  return requireArray(value, context).map((interval, index) =>
    decodeInterval(interval, `${context}[${index}]`, sectionLength),
  );
}

function decodeSectionCoverage(value: unknown, context: string): ViewedSectionCoverage {
  const section = requireRecord(value, context);
  const sectionIndex = requireSafeInteger(
    section['sectionIndex'],
    `${context}.sectionIndex`,
    0,
    MAX_SECTION_INDEX,
  );
  if (section['normalizationVersion'] !== READING_TEXT_NORMALIZATION_VERSION) {
    throw new WireDecodeError(
      `${context}.normalizationVersion must be ${READING_TEXT_NORMALIZATION_VERSION}`,
    );
  }
  const signature = requireString(section['signature'], `${context}.signature`);
  if (!TEXT_SIGNATURE_PATTERN.test(signature)) {
    throw new WireDecodeError(`${context}.signature is not a valid text signature`);
  }
  const sectionLength = requireSafeInteger(
    section['sectionLength'],
    `${context}.sectionLength`,
    1,
    MAX_SECTION_LENGTH,
  );
  const intervals = requireBoundedArray(
    section['intervals'],
    `${context}.intervals`,
    MAX_SECTION_INTERVALS,
  ).map((interval, index) => decodeInterval(interval, `${context}.intervals[${index}]`, sectionLength));
  if (intervals.length === 0) {
    throw new WireDecodeError(`${context}.intervals must not be empty`);
  }

  return {
    sectionIndex,
    normalizationVersion: READING_TEXT_NORMALIZATION_VERSION,
    signature,
    sectionLength,
    intervals,
  };
}

function decodeCompletion(value: unknown, context: string): ReadingCompletionObservation | null {
  if (value === null || value === undefined) return null;
  const completion = requireRecord(value, context);
  return {
    occurredAt: requireIsoInstant(completion['occurredAt'], `${context}.occurredAt`),
    localDate: requireLocalDate(completion['localDate'], `${context}.localDate`),
  };
}

/**
 * Decodes one activity event. A missing `sections` means none; a missing
 * `completion` means `null`. Everything else is required and strictly typed.
 */
export function decodeReadingActivityEvent(value: unknown): ReadingActivityEvent {
  const event = requireRecord(value, 'activity event');
  const id = readActivityEventId(event['id']);
  if (id === null) {
    throw new WireDecodeError('activity event id must be a valid event id');
  }

  const sections = (
    event['sections'] === undefined
      ? []
      : requireBoundedArray(event['sections'], 'sections', MAX_ACTIVITY_SECTIONS)
  ).map((section, index) => decodeSectionCoverage(section, `sections[${index}]`));
  const sectionIndexes = new Set(sections.map((section) => section.sectionIndex));
  if (sectionIndexes.size !== sections.length) {
    throw new WireDecodeError('sections must list each sectionIndex once');
  }

  return {
    id,
    bookId: requireSafeInteger(event['bookId'], 'bookId', 1, Number.MAX_SAFE_INTEGER),
    localDate: requireLocalDate(event['localDate'], 'localDate'),
    occurredAt: requireIsoInstant(event['occurredAt'], 'occurredAt'),
    durationMs: requireSafeInteger(event['durationMs'], 'durationMs', 0, MAX_ACTIVITY_DURATION_MS),
    sections,
    completion: decodeCompletion(event['completion'], 'completion'),
  };
}

/** Decodes a `PUT /api/reading/goals` body. Numbers must be real integers, not strings. */
export function decodeReadingGoalsUpdate(value: unknown): ReadingGoalsUpdate {
  const body = requireRecord(value, 'goals');
  const hasDaily = body['dailyMinutes'] !== undefined;
  const hasAnnual = body['annualBooks'] !== undefined;
  if (!hasDaily && !hasAnnual) {
    throw new WireDecodeError('dailyMinutes or annualBooks is required');
  }

  return {
    ...(hasDaily
      ? {
          dailyMinutes: requireSafeInteger(
            body['dailyMinutes'],
            'dailyMinutes',
            MIN_DAILY_GOAL_MINUTES,
            MAX_DAILY_GOAL_MINUTES,
          ),
        }
      : {}),
    ...(hasAnnual
      ? {
          annualBooks: requireSafeInteger(
            body['annualBooks'],
            'annualBooks',
            MIN_ANNUAL_BOOK_GOAL,
            MAX_ANNUAL_BOOK_GOAL,
          ),
        }
      : {}),
  };
}

export function decodeReadingGoals(value: unknown): ReadingGoalsDto {
  const goals = requireRecord(value, 'goals');
  return {
    dailyMinutes: requireSafeInteger(
      goals['dailyMinutes'],
      'goals.dailyMinutes',
      MIN_DAILY_GOAL_MINUTES,
      MAX_DAILY_GOAL_MINUTES,
    ),
    annualBooks: requireSafeInteger(
      goals['annualBooks'],
      'goals.annualBooks',
      MIN_ANNUAL_BOOK_GOAL,
      MAX_ANNUAL_BOOK_GOAL,
    ),
  };
}

export function decodeReadingGoalsResponse(value: unknown): ReadingGoalsDto {
  return decodeReadingGoals(requireRecord(value, 'goals response')['goals']);
}

function decodeSkippedSection(value: unknown, context: string): SkippedSectionCoverage {
  const skipped = requireRecord(value, context);
  if (skipped['reason'] !== 'SIGNATURE_MISMATCH') {
    throw new WireDecodeError(`${context}.reason is not a known skipped-coverage reason`);
  }
  return {
    sectionIndex: requireSafeInteger(
      skipped['sectionIndex'],
      `${context}.sectionIndex`,
      0,
      MAX_SECTION_INDEX,
    ),
    normalizationVersion: requireSafeInteger(
      skipped['normalizationVersion'],
      `${context}.normalizationVersion`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    reason: 'SIGNATURE_MISMATCH',
  };
}

/** Decodes a stored or received skipped-coverage list. */
export function decodeSkippedSections(value: unknown, context: string): SkippedSectionCoverage[] {
  return requireArray(value, context).map((entry, index) =>
    decodeSkippedSection(entry, `${context}[${index}]`),
  );
}

function isRejectionReason(value: unknown): value is ReadingActivityRejectionReason {
  return value === 'INVALID_ACTIVITY' || value === 'BOOK_NOT_FOUND' || value === 'EVENT_ID_CONFLICT';
}

function decodeActivityOutcome(value: unknown, context: string): ReadingActivityOutcome {
  const outcome = requireRecord(value, context);
  const id = readActivityEventId(outcome['id']);
  if (id === null) {
    throw new WireDecodeError(`${context}.id must be a valid event id`);
  }

  if (outcome['status'] === 'accepted') {
    if (typeof outcome['duplicate'] !== 'boolean') {
      throw new WireDecodeError(`${context}.duplicate must be a boolean`);
    }
    return {
      id,
      status: 'accepted',
      duplicate: outcome['duplicate'],
      skippedSections: decodeSkippedSections(outcome['skippedSections'], `${context}.skippedSections`),
    };
  }

  if (outcome['status'] === 'rejected') {
    const reason = outcome['reason'];
    if (!isRejectionReason(reason)) {
      throw new WireDecodeError(`${context}.reason is not a known rejection reason`);
    }
    return { id, status: 'rejected', reason };
  }

  throw new WireDecodeError(`${context}.status must be "accepted" or "rejected"`);
}

/** Decodes the `POST /api/reading/activity` 200 body. */
export function decodeReadingActivityBatchResponse(value: unknown): ReadingActivityBatchResponse {
  const body = requireRecord(value, 'activity response');
  return {
    results: requireArray(body['results'], 'results').map((outcome, index) =>
      decodeActivityOutcome(outcome, `results[${index}]`),
    ),
  };
}

function decodeDay(value: unknown, context: string): ReadingDayDto {
  const day = requireRecord(value, context);
  return {
    date: requireLocalDate(day['date'], `${context}.date`),
    durationMs: requireNonNegativeInteger(day['durationMs'], `${context}.durationMs`),
    characters: requireNonNegativeInteger(day['characters'], `${context}.characters`),
  };
}

/**
 * Decodes the `GET /api/reading/stats` 200 body.
 *
 * Book payloads are decoded by the caller's own Book decoder so there is one
 * owner of the Book contract per workspace.
 */
export function decodeReadingStatsResponse(
  value: unknown,
  decodeBook: (value: unknown) => BookDto,
): ReadingStatsDto {
  const stats = requireRecord(requireRecord(value, 'stats response')['stats'], 'stats');
  const date = requireLocalDate(stats['date'], 'stats.date');
  const days = requireArray(stats['days'], 'stats.days').map((day, index) =>
    decodeDay(day, `stats.days[${index}]`),
  );
  if (days.length !== READING_STATS_DAY_COUNT || days[days.length - 1]?.date !== date) {
    throw new WireDecodeError(`stats.days must hold ${READING_STATS_DAY_COUNT} days ending with stats.date`);
  }

  const lifetime = requireRecord(stats['lifetime'], 'stats.lifetime');
  const year = requireRecord(stats['year'], 'stats.year');
  const books = requireArray(year['books'], 'stats.year.books').map((entry, index) => {
    const context = `stats.year.books[${index}]`;
    const completed = requireRecord(entry, context);
    return {
      book: decodeBook(completed['book']),
      localDate: requireLocalDate(completed['localDate'], `${context}.localDate`),
      occurredAt: requireIsoInstant(completed['occurredAt'], `${context}.occurredAt`),
    };
  });
  const completedCount = requireNonNegativeInteger(
    year['completedCount'],
    'stats.year.completedCount',
  );
  if (completedCount !== books.length) {
    throw new WireDecodeError('stats.year.completedCount must equal the number of books');
  }

  return {
    date,
    goals: decodeReadingGoals(stats['goals']),
    days,
    lifetime: {
      durationMs: requireNonNegativeInteger(lifetime['durationMs'], 'stats.lifetime.durationMs'),
      characters: requireNonNegativeInteger(lifetime['characters'], 'stats.lifetime.characters'),
      completedBooks: requireNonNegativeInteger(
        lifetime['completedBooks'],
        'stats.lifetime.completedBooks',
      ),
    },
    year: {
      year: requireSafeInteger(year['year'], 'stats.year.year', MIN_CALENDAR_YEAR, MAX_CALENDAR_YEAR),
      completedCount,
      books,
    },
    trackingStartedAt: requireIsoInstant(stats['trackingStartedAt'], 'stats.trackingStartedAt'),
  };
}

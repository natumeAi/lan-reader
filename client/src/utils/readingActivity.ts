/**
 * Pure building blocks of reading-activity capture.
 *
 * - `ForegroundClock` measures eligible foreground time with a monotonic clock
 *   and discards implausible gaps (sleep, frozen timers) instead of crediting
 *   them.
 * - `splitAtLocalMidnight` attributes a measured span to browser-local days.
 * - `CoverageLedger` accumulates verified visible intervals per observation
 *   day and never resends intervals already recorded in this reader session.
 * - `createActivityEvents` / `createCompletionEvent` build immutable wire
 *   events. A completion is its own zero-duration record with the instant and
 *   local date captured at observation, never copied into duration segments.
 *
 * Nothing here reads the DOM, React or the reader engine.
 */
import type {
  CharacterInterval,
  ReadingActivityEvent,
  ViewedSectionCoverage,
} from '@lan-reader/shared';
import {
  MAX_ACTIVITY_DURATION_MS,
  MAX_ACTIVITY_SECTIONS,
  MAX_SECTION_INTERVALS,
  READING_TEXT_NORMALIZATION_VERSION,
  formatLocalDate,
  mergeCharacterIntervals,
} from '@lan-reader/shared';

/** Periodic checkpoint while foreground time is running. */
export const ACTIVITY_CHECKPOINT_INTERVAL_MS = 15_000;
/** A single checkpoint span longer than this means the page was suspended. */
export const MAX_ACTIVITY_SEGMENT_MS = 120_000;
/** Monotonic and wall clocks disagreeing by more than this means a sleep/clock jump. */
export const MAX_ACTIVITY_CLOCK_DRIFT_MS = 10_000;

export interface ActivityClockSource {
  /** Monotonic milliseconds, e.g. `performance.now()`. */
  monotonic(): number;
  /** Wall-clock epoch milliseconds, e.g. `Date.now()`. */
  wall(): number;
}

export const browserClock: ActivityClockSource = {
  monotonic: () => performance.now(),
  wall: () => Date.now(),
};

/** A measured foreground span on the wall clock. */
export interface ForegroundSpan {
  readonly startWall: number;
  readonly endWall: number;
  readonly durationMs: number;
}

export interface ForegroundClockLimits {
  readonly maxSegmentMs?: number;
  readonly maxDriftMs?: number;
}

/**
 * Accumulates foreground time between explicit start/stop/checkpoint calls.
 * Every call closes the current span exactly once; a stopped clock returns
 * nothing, so duplicate lifecycle notifications cannot add time twice.
 */
export class ForegroundClock {
  private base: { monotonic: number; wall: number } | null = null;
  private readonly maxSegmentMs: number;
  private readonly maxDriftMs: number;

  constructor(private readonly source: ActivityClockSource = browserClock, limits: ForegroundClockLimits = {}) {
    this.maxSegmentMs = limits.maxSegmentMs ?? MAX_ACTIVITY_SEGMENT_MS;
    this.maxDriftMs = limits.maxDriftMs ?? MAX_ACTIVITY_CLOCK_DRIFT_MS;
  }

  get running() { return this.base !== null; }

  /** Starts a fresh baseline; a running clock keeps its current baseline. */
  start() {
    if (!this.base) this.base = { monotonic: this.source.monotonic(), wall: this.source.wall() };
  }

  /** Closes the running span and stops. */
  stop(): ForegroundSpan | null {
    const span = this.close();
    this.base = null;
    return span;
  }

  /** Closes the running span and immediately continues from a new baseline. */
  checkpoint(): ForegroundSpan | null {
    if (!this.base) return null;
    const span = this.close();
    this.base = { monotonic: this.source.monotonic(), wall: this.source.wall() };
    return span;
  }

  private close(): ForegroundSpan | null {
    const base = this.base;
    if (!base) return null;
    const monotonic = this.source.monotonic();
    const wall = this.source.wall();
    const elapsed = monotonic - base.monotonic;
    const wallElapsed = wall - base.wall;
    // A throttled/frozen page or a sleeping device: credit nothing rather
    // than the whole unexplained gap.
    if (!(elapsed > 0) || elapsed > this.maxSegmentMs || Math.abs(wallElapsed - elapsed) > this.maxDriftMs) return null;
    return { startWall: wall - elapsed, endWall: wall, durationMs: elapsed };
  }
}

/** Foreground time attributed to one browser-local day. */
export interface DaySegment {
  readonly localDate: string;
  readonly durationMs: number;
  /** ISO instant of the segment's last moment within its day. */
  readonly occurredAt: string;
}

/** Splits a span at local midnights; each part keeps its own day and end instant. */
export function splitAtLocalMidnight(span: ForegroundSpan): DaySegment[] {
  const segments: DaySegment[] = [];
  let start = span.startWall;
  let credited = 0;
  while (start < span.endWall) {
    const day = new Date(start);
    const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const end = Math.min(span.endWall, nextMidnight);
    // Round cumulatively so the parts always sum to the rounded whole.
    const total = Math.round(end - span.startWall);
    const durationMs = Math.min(MAX_ACTIVITY_DURATION_MS, total - credited);
    credited = total;
    if (durationMs > 0) {
      segments.push({
        localDate: formatLocalDate(day),
        durationMs,
        occurredAt: new Date(end === nextMidnight ? end - 1 : end).toISOString(),
      });
    }
    start = end;
  }
  return segments;
}

/** `first` minus `second`; both lists may be unmerged. */
export function subtractIntervals(
  first: readonly CharacterInterval[],
  second: readonly CharacterInterval[],
): CharacterInterval[] {
  const removed = mergeCharacterIntervals(second);
  const result: CharacterInterval[] = [];
  for (const [start, end] of mergeCharacterIntervals(first)) {
    let cursor = start;
    for (const [removeStart, removeEnd] of removed) {
      if (removeEnd <= cursor) continue;
      if (removeStart >= end) break;
      if (removeStart > cursor) result.push([cursor, removeStart]);
      cursor = Math.max(cursor, removeEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

/** One verified observation of a section's visible canonical text. */
export interface SectionObservation {
  readonly sectionIndex: number;
  readonly signature: string;
  readonly sectionLength: number;
  readonly intervals: readonly CharacterInterval[];
}

interface PendingSection { signature: string; sectionLength: number; intervals: CharacterInterval[] }
interface PendingDay { sections: Map<number, PendingSection>; lastObservedWall: number }

/** Coverage of one local day, ready to attach to that day's event(s). */
export interface DayCoverage {
  readonly localDate: string;
  readonly occurredAt: string;
  readonly sections: readonly ViewedSectionCoverage[];
}

const sectionKey = (section: { sectionIndex: number; signature: string; sectionLength: number }) =>
  `${section.sectionIndex}|${section.signature}|${section.sectionLength}`;

/**
 * Per reader-session coverage accumulator. Intervals are grouped by the local
 * day on which they were observed. Anything already handed out by `drain()`
 * is subtracted from later observations of the same section text, so revisits
 * and reflow do not grow payloads (the server's union is still authoritative).
 */
export class CoverageLedger {
  private readonly recorded = new Map<string, CharacterInterval[]>();
  private readonly pending = new Map<string, PendingDay>();

  /** Adds an observation; returns the number of newly pending characters. */
  observe(observations: readonly SectionObservation[], observedWall: number): number {
    const localDate = formatLocalDate(new Date(observedWall));
    let added = 0;
    for (const observation of observations) {
      const fresh = subtractIntervals(observation.intervals, this.recorded.get(sectionKey(observation)) ?? []);
      if (!fresh.length) continue;
      let day = this.pending.get(localDate);
      if (!day) { day = { sections: new Map(), lastObservedWall: observedWall }; this.pending.set(localDate, day); }
      day.lastObservedWall = Math.max(day.lastObservedWall, observedWall);
      let section = day.sections.get(observation.sectionIndex);
      if (section && (section.signature !== observation.signature || section.sectionLength !== observation.sectionLength)) {
        // The section's text changed within the day: keep only the current text.
        section = undefined;
      }
      const before = section ? section.intervals.reduce((sum, [s, e]) => sum + e - s, 0) : 0;
      const intervals = mergeCharacterIntervals(section?.intervals ?? [], fresh);
      const after = intervals.reduce((sum, [s, e]) => sum + e - s, 0);
      day.sections.set(observation.sectionIndex, { signature: observation.signature, sectionLength: observation.sectionLength, intervals });
      added += after - before;
    }
    return added;
  }

  get hasPending() { return this.pending.size > 0; }

  /** Hands out all pending coverage by day and marks it recorded. */
  drain(): DayCoverage[] {
    const days: DayCoverage[] = [];
    for (const [localDate, day] of this.pending) {
      const sections: ViewedSectionCoverage[] = [];
      for (const [sectionIndex, section] of day.sections) {
        const key = sectionKey({ sectionIndex, ...section });
        this.recorded.set(key, mergeCharacterIntervals(this.recorded.get(key) ?? [], section.intervals));
        for (let offset = 0; offset < section.intervals.length; offset += MAX_SECTION_INTERVALS) {
          sections.push({
            sectionIndex,
            normalizationVersion: READING_TEXT_NORMALIZATION_VERSION,
            signature: section.signature,
            sectionLength: section.sectionLength,
            intervals: section.intervals.slice(offset, offset + MAX_SECTION_INTERVALS),
          });
        }
      }
      days.push({ localDate, occurredAt: new Date(day.lastObservedWall).toISOString(), sections });
    }
    this.pending.clear();
    return days;
  }
}

/** Stable, URL-safe event identity (`crypto.randomUUID` needs a secure context). */
export function createActivityEventId(): string {
  const bytes = new Uint8Array(12);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const random = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `ra-${Date.now().toString(36)}-${random}`;
}

/** Splits sections so that no event carries a sectionIndex twice or more than the wire limit. */
function sectionGroups(sections: readonly ViewedSectionCoverage[]): ViewedSectionCoverage[][] {
  const groups: ViewedSectionCoverage[][] = [];
  for (const section of sections) {
    let group = groups.find(candidate => candidate.length < MAX_ACTIVITY_SECTIONS
      && !candidate.some(existing => existing.sectionIndex === section.sectionIndex));
    if (!group) { group = []; groups.push(group); }
    group.push(section);
  }
  return groups;
}

/**
 * Builds the immutable events of one checkpoint: one per day segment, with
 * that day's coverage attached, plus zero-duration events for coverage
 * observed on a day without a time segment (or beyond per-event limits).
 */
export function createActivityEvents(
  bookId: number,
  segments: readonly DaySegment[],
  coverage: readonly DayCoverage[],
  createId: () => string = createActivityEventId,
): ReadingActivityEvent[] {
  const events: ReadingActivityEvent[] = [];
  const coverageByDay = new Map(coverage.map(day => [day.localDate, day]));
  for (const segment of segments) {
    const day = coverageByDay.get(segment.localDate);
    coverageByDay.delete(segment.localDate);
    const [first = [], ...rest] = day ? sectionGroups(day.sections) : [];
    events.push({ id: createId(), bookId, localDate: segment.localDate, occurredAt: segment.occurredAt, durationMs: segment.durationMs, sections: first, completion: null });
    for (const group of rest) events.push({ id: createId(), bookId, localDate: segment.localDate, occurredAt: segment.occurredAt, durationMs: 0, sections: group, completion: null });
  }
  for (const day of coverageByDay.values()) {
    for (const group of sectionGroups(day.sections)) {
      events.push({ id: createId(), bookId, localDate: day.localDate, occurredAt: day.occurredAt, durationMs: 0, sections: group, completion: null });
    }
  }
  return events;
}

/** A qualifying completion, captured with its own instant and local date. */
export function createCompletionEvent(
  bookId: number,
  observedWall: number,
  createId: () => string = createActivityEventId,
): ReadingActivityEvent {
  const observed = new Date(observedWall);
  const occurredAt = observed.toISOString();
  const localDate = formatLocalDate(observed);
  return { id: createId(), bookId, localDate, occurredAt, durationMs: 0, sections: [], completion: { occurredAt, localDate } };
}

export type AcceptedReason = 'opened' | 'navigation' | 'layout-restored' | 'snapshot';

export interface CompletionInput {
  readonly reason: AcceptedReason;
  readonly atEnd: boolean;
  /** End state of the previous accepted position in this reader session; `null` when none. */
  readonly previousAtEnd: boolean | null;
  /** Whether the Book had any saved (server or pending) position when this engine opened. */
  readonly hadSavedPosition: boolean;
  /** Whether an earlier engine of this reader session already opened. */
  readonly openedBefore: boolean;
}

/**
 * Completion needs a visible end reached while reading:
 * - `navigation` from a verified non-final page to the final page (turns,
 *   TOC/slider jumps);
 * - `opened` only for the first healthy display of a Book with no saved
 *   position whose first page is final (a one-page Book).
 * Restores, reflow (`layout-restored`) and forced captures (`snapshot`) never
 * qualify.
 */
export function qualifiesForCompletion(input: CompletionInput): boolean {
  if (!input.atEnd) return false;
  if (input.reason === 'navigation') return input.previousAtEnd === false;
  if (input.reason === 'opened') return !input.hadSavedPosition && !input.openedBefore;
  return false;
}

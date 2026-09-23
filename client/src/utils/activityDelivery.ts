/**
 * App-owned reading-activity delivery.
 *
 * One coordinator per App outlives every ReaderView, so records captured by a
 * closed reader are still delivered. Protocol:
 *
 * 1. `record()` persists each immutable event (exact JSON payload) before any
 *    send, then schedules delivery.
 * 2. Delivery is single-flight. A batch holds at most
 *    `MAX_ACTIVITY_BATCH_EVENTS` records and a bounded body; the body is the
 *    stored payload strings joined verbatim, so retries are byte-identical.
 * 3. Per-record outcomes: `accepted` (including duplicate retries) removes the
 *    record; `rejected` moves it to the rejected store and counts as a
 *    surfaced permanent error. Records the response does not mention, and
 *    every transient failure (network, 5xx, undecodable response), stay
 *    queued for retry with backoff. Records added while a batch is in flight
 *    are untouched by that batch's response.
 * 4. A 400 envelope rejection cannot be attributed; the batch is retried one
 *    record at a time and only a single record that is still refused is
 *    rejected. A 413 halves the batch.
 * 5. Accepted outcomes that skip a section's coverage (`SIGNATURE_MISMATCH`)
 *    suspend future coverage of that section text; time keeps recording.
 */
import type { ReadingActivityBatchResponse, ReadingActivityEvent } from '@lan-reader/shared';
import {
  MAX_ACTIVITY_BATCH_EVENTS,
  decodeReadingActivityEvent,
  isRecord,
  readActivityEventId,
} from '@lan-reader/shared';
import type { ActivityRecordStore, RejectedActivityRecord, StoredActivityRecord } from './activityOutbox';

/** What a reader session needs from the delivery owner. */
export interface ReadingActivitySink {
  /** Persists immutable events and schedules their delivery. */
  record(events: readonly ReadingActivityEvent[]): void;
  /** Requests delivery now (e.g. reader close); `keepalive` bounds the request for page exit. */
  flush(options?: { keepalive?: boolean }): void;
  /** `true` when the server refused to merge this section text's coverage. */
  isCoverageSuspended(bookId: number, sectionIndex: number, signature: string): boolean;
}

/** Low-frequency delivery state for the dashboard (child 4). */
export interface ReadingActivityStatus {
  /** Epoch ms of the latest batch with at least one accepted record; `null` before any. */
  readonly lastAcceptedAt: number | null;
  /** Records persisted (or held in memory) and not yet acknowledged. */
  readonly pendingCount: number;
  /** Records the server permanently rejected; they are not counted as recorded activity. */
  readonly permanentErrorCount: number;
  /** `false` when records are only held in memory and would be lost on reload. */
  readonly isDurable: boolean;
  /** Message of the latest transient failure, cleared after a successful batch. */
  readonly lastError: string | null;
  readonly isDelivering: boolean;
}

export interface ActivityDeliveryStore extends ActivityRecordStore {
  readonly durable: boolean;
}

export interface ActivityDeliveryOptions {
  readonly store: ActivityDeliveryStore;
  readonly send: (body: string, options: { keepalive: boolean }) => Promise<ReadingActivityBatchResponse>;
  readonly now?: () => number;
  /** Delay after `record()` before delivery, coalescing bursts. */
  readonly debounceMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Storage of suspended section texts; `null` keeps them in memory only. */
  readonly suspensionStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export interface ActivityDelivery extends ReadingActivitySink {
  /** Installs page lifecycle/online listeners and starts delivering; returns the stop function. */
  start(): () => void;
  /** Delivers now, clearing any retry backoff. */
  deliver(options?: { keepalive?: boolean }): Promise<void>;
  getStatus(): ReadingActivityStatus;
  subscribe(listener: () => void): () => void;
  /** Resolves when pending writes and delivery work have settled (tests, diagnostics). */
  settled(): Promise<void>;
}

export const ACTIVITY_SUSPENSION_STORAGE_KEY = 'epub-reader:reading-activity-suspended-coverage:v1';
/** Request body bound for normal batches, below the server's 1 MB JSON limit. */
export const MAX_ACTIVITY_BATCH_BYTES = 900_000;
/** Keepalive requests are limited to 64 KiB of in-flight body by browsers. */
export const MAX_KEEPALIVE_BATCH_BYTES = 60_000;
const MAX_SUSPENSIONS = 500;

const statusOf = (error: unknown) => (isRecord(error) && typeof error['status'] === 'number' ? error['status'] : 0);
const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : '无法同步阅读记录');
const byteLength = (text: string) => new TextEncoder().encode(text).length;

function defaultSuspensionStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Takes the longest prefix within the record and byte limits (at least one record). */
function takeBatch(records: readonly StoredActivityRecord[], maxEvents: number, maxBytes: number) {
  const batch: StoredActivityRecord[] = [];
  let bytes = 12;
  for (const record of records) {
    const size = byteLength(record.payload) + 1;
    if (batch.length && (batch.length >= maxEvents || bytes + size > maxBytes)) break;
    batch.push(record);
    bytes += size;
    if (batch.length >= maxEvents) break;
  }
  return batch;
}

export const batchBody = (records: readonly StoredActivityRecord[]) => `{"events":[${records.map(record => record.payload).join(',')}]}`;

export function createActivityDelivery(options: ActivityDeliveryOptions): ActivityDelivery {
  const { store, send } = options;
  const now = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? 1000;
  const retryBaseMs = options.retryBaseMs ?? 5000;
  const retryMaxMs = options.retryMaxMs ?? 300_000;
  const suspensionStorage = options.suspensionStorage === undefined ? defaultSuspensionStorage() : options.suspensionStorage;
  const listeners = new Set<() => void>();
  const writes = new Set<Promise<void>>();
  let status: ReadingActivityStatus = { lastAcceptedAt: null, pendingCount: 0, permanentErrorCount: 0, isDurable: store.durable, lastError: null, isDelivering: false };
  let worker: Promise<void> | null = null;
  let rerun: { keepalive: boolean } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = retryBaseMs;
  let seq = 0;
  let started = 0;

  const suspensions = new Set<string>();
  try {
    const stored: unknown = JSON.parse(suspensionStorage?.getItem(ACTIVITY_SUSPENSION_STORAGE_KEY) ?? 'null');
    if (Array.isArray(stored)) for (const key of stored) if (typeof key === 'string') suspensions.add(key);
  } catch { /* A corrupt list only means coverage is offered to the server again. */ }
  const suspensionKey = (bookId: number, sectionIndex: number, signature: string) => `${bookId}:${sectionIndex}:${signature}`;

  const publish = (patch: Partial<ReadingActivityStatus>) => {
    const next = { ...status, ...patch, isDurable: store.durable };
    if ((Object.keys(next) as (keyof ReadingActivityStatus)[]).every(key => next[key] === status[key])) return;
    status = next;
    for (const listener of listeners) listener();
  };
  const refreshCounts = async () => {
    try {
      const counts = await store.counts();
      publish({ pendingCount: counts.pending, permanentErrorCount: counts.rejected });
    } catch { publish({}); }
  };

  const suspend = (record: StoredActivityRecord, sectionIndex: number) => {
    let event: ReadingActivityEvent;
    try { event = decodeReadingActivityEvent(JSON.parse(record.payload)); } catch { return; }
    const section = event.sections.find(candidate => candidate.sectionIndex === sectionIndex);
    if (!section) return;
    suspensions.add(suspensionKey(record.bookId, sectionIndex, section.signature));
    while (suspensions.size > MAX_SUSPENSIONS) suspensions.delete(suspensions.values().next().value!);
    try { suspensionStorage?.setItem(ACTIVITY_SUSPENSION_STORAGE_KEY, JSON.stringify([...suspensions])); } catch { /* memory only */ }
  };

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleRetry = () => {
    clearRetry();
    if (!started) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryMaxMs, retryDelay * 2);
    retryTimer = setTimeout(() => { retryTimer = null; void run(false); }, delay);
  };

  /** One delivery pass: returns `false` when it stopped on a transient failure. */
  const pass = async (keepalive: boolean): Promise<boolean> => {
    let maxEvents = MAX_ACTIVITY_BATCH_EVENTS;
    const unanswered = new Set<string>();
    // Ids this pass already settled. If a durable remove/reject failed, the
    // store can still list them; never resend them within the same pass.
    const settledIds = new Set<string>();
    while (true) {
      const records = (await store.list()).filter(record => !unanswered.has(record.id) && !settledIds.has(record.id));
      if (!records.length) return unanswered.size === 0;
      const batch = takeBatch(records, maxEvents, keepalive ? MAX_KEEPALIVE_BATCH_BYTES : MAX_ACTIVITY_BATCH_BYTES);
      let response: ReadingActivityBatchResponse;
      try {
        response = await send(batchBody(batch), { keepalive });
      } catch (error) {
        const code = statusOf(error);
        if (code === 400 && batch.length > 1) { maxEvents = 1; continue; }
        if (code === 413 && batch.length > 1) { maxEvents = Math.max(1, Math.floor(batch.length / 2)); continue; }
        if ((code === 400 || code === 413) && batch.length === 1) {
          const rejected: RejectedActivityRecord = { ...batch[0]!, reason: code === 400 ? 'INVALID_ACTIVITY_BATCH' : 'PAYLOAD_TOO_LARGE', rejectedAt: now() };
          settledIds.add(rejected.id);
          await store.reject([rejected]);
          continue;
        }
        publish({ lastError: messageOf(error) });
        return false;
      }
      const byId = new Map(batch.map(record => [record.id, record]));
      const accepted: string[] = [];
      const rejected: RejectedActivityRecord[] = [];
      for (const outcome of response.results) {
        const record = byId.get(outcome.id);
        if (!record) continue;
        byId.delete(outcome.id);
        if (outcome.status === 'accepted') {
          accepted.push(record.id);
          for (const skipped of outcome.skippedSections) suspend(record, skipped.sectionIndex);
        } else {
          rejected.push({ ...record, reason: outcome.reason, rejectedAt: now() });
        }
      }
      // Never loop on records the server did not answer; retry them later.
      for (const id of byId.keys()) unanswered.add(id);
      for (const id of accepted) settledIds.add(id);
      for (const record of rejected) settledIds.add(record.id);
      await store.remove(accepted);
      await store.reject(rejected);
      retryDelay = retryBaseMs;
      publish({ lastError: null, ...(accepted.length ? { lastAcceptedAt: now() } : {}) });
      await refreshCounts();
      if (keepalive) return true;
    }
  };

  const run = (keepalive: boolean): Promise<void> => {
    if (worker) {
      rerun = { keepalive: Boolean(rerun?.keepalive) || keepalive };
      return worker;
    }
    clearRetry();
    publish({ isDelivering: true });
    const current = (async () => {
      let ok: boolean;
      try { ok = await pass(keepalive); } catch (error) { ok = false; publish({ lastError: messageOf(error) }); }
      await refreshCounts();
      if (!ok) scheduleRetry();
    })().finally(() => {
      worker = null;
      publish({ isDelivering: false });
      const again = rerun;
      rerun = null;
      if (again && retryTimer === null) void run(again.keepalive);
    });
    worker = current;
    return current;
  };

  const schedule = () => {
    if (!started || debounceTimer !== null || retryTimer !== null) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; void run(false); }, debounceMs);
  };

  const deliverNow = (keepalive = false) => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    retryDelay = retryBaseMs;
    if (worker) { rerun = { keepalive: Boolean(rerun?.keepalive) || keepalive }; clearRetry(); return worker; }
    return run(keepalive);
  };

  let seqBase = now() * 1000;
  return {
    record(events) {
      const records: StoredActivityRecord[] = [];
      for (const event of events) {
        if (readActivityEventId(event.id) === null) continue;
        // Serialized once; this exact string is what every retry sends.
        records.push({ id: event.id, bookId: event.bookId, seq: seqBase + seq++, payload: JSON.stringify(event), createdAt: now() });
      }
      if (!records.length) return;
      publish({ pendingCount: status.pendingCount + records.length });
      const write = store.put(records).catch(() => { publish({ lastError: '阅读记录未能保存到本地' }); }).then(refreshCounts);
      writes.add(write);
      void write.finally(() => { writes.delete(write); schedule(); });
    },
    flush(flushOptions = {}) { void deliverNow(Boolean(flushOptions.keepalive)); },
    isCoverageSuspended(bookId, sectionIndex, signature) { return suspensions.has(suspensionKey(bookId, sectionIndex, signature)); },
    start() {
      const token = ++started;
      seqBase = Math.max(seqBase, now() * 1000);
      const onOnline = () => { void deliverNow(); };
      const onPageShow = () => { void deliverNow(); };
      const onPageHide = () => { void deliverNow(true); };
      const win = window;
      const doc = document;
      const onVisibility = () => { if (doc.visibilityState === 'visible') void deliverNow(); };
      win.addEventListener('online', onOnline);
      win.addEventListener('pageshow', onPageShow);
      win.addEventListener('pagehide', onPageHide);
      doc.addEventListener('visibilitychange', onVisibility);
      void refreshCounts().then(() => { if (started === token) void deliverNow(); });
      return () => {
        win.removeEventListener('online', onOnline);
        win.removeEventListener('pageshow', onPageShow);
        win.removeEventListener('pagehide', onPageHide);
        doc.removeEventListener('visibilitychange', onVisibility);
        if (started !== token) return;
        started = 0;
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = null;
        clearRetry();
      };
    },
    deliver(deliverOptions = {}) { return deliverNow(Boolean(deliverOptions.keepalive)); },
    getStatus() { return status; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async settled() {
      while (writes.size || worker) {
        await Promise.all([...writes]);
        if (worker) await worker;
      }
    },
  };
}

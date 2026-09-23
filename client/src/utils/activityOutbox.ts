/**
 * Durable storage for immutable reading-activity records.
 *
 * Separate from the reading-position outbox (`epub-reader:pending-reading-progress:v1`),
 * whose latest-position overwrite semantics would lose disjoint activity.
 * Every activity record is stored individually under its event id together
 * with the exact serialized payload, so a retry sends byte-identical JSON.
 *
 * IndexedDB `epub-reader-reading-activity` version 1:
 * - store `pending`  (keyPath `id`): records awaiting acknowledgment;
 * - store `rejected` (keyPath `id`): records the server permanently rejected,
 *   kept out of the retry queue and counted as a surfaced permanent error.
 *
 * `ResilientActivityStore` keeps each new record in memory until the durable
 * write confirms it. When IndexedDB is unavailable or a write fails, records
 * stay in memory and the store reports `durable === false`; that fallback is
 * never presented as durable persistence.
 */
import { ACTIVITY_EVENT_ID_PATTERN, isRecord } from '@lan-reader/shared';

export const ACTIVITY_DATABASE_NAME = 'epub-reader-reading-activity';
export const ACTIVITY_DATABASE_VERSION = 1;
const PENDING_STORE = 'pending';
const REJECTED_STORE = 'rejected';

export interface StoredActivityRecord {
  readonly id: string;
  readonly bookId: number;
  /** Creation order within and across sessions. */
  readonly seq: number;
  /** Exact JSON of the event as first serialized; never re-serialized. */
  readonly payload: string;
  readonly createdAt: number;
}

export interface RejectedActivityRecord extends StoredActivityRecord {
  readonly reason: string;
  readonly rejectedAt: number;
}

export interface ActivityRecordCounts { readonly pending: number; readonly rejected: number }

export interface ActivityRecordStore {
  put(records: readonly StoredActivityRecord[]): Promise<void>;
  list(): Promise<StoredActivityRecord[]>;
  remove(ids: readonly string[]): Promise<void>;
  /** Moves records out of the pending queue into the rejected store. */
  reject(records: readonly RejectedActivityRecord[]): Promise<void>;
  counts(): Promise<ActivityRecordCounts>;
}

/** Validates one stored value; malformed rows are ignored rather than sent. */
export function decodeStoredActivityRecord(value: unknown): StoredActivityRecord | null {
  if (!isRecord(value)) return null;
  const { id, bookId, seq, payload, createdAt } = value;
  if (typeof id !== 'string' || !ACTIVITY_EVENT_ID_PATTERN.test(id)) return null;
  if (typeof bookId !== 'number' || !Number.isSafeInteger(bookId) || bookId <= 0) return null;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  if (typeof payload !== 'string' || !payload) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return { id, bookId, seq, payload, createdAt };
}

const bySeq = (a: StoredActivityRecord, b: StoredActivityRecord) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function createMemoryActivityStore(): ActivityRecordStore {
  const pending = new Map<string, StoredActivityRecord>();
  const rejected = new Map<string, RejectedActivityRecord>();
  return {
    async put(records) { for (const record of records) pending.set(record.id, record); },
    async list() { return [...pending.values()].sort(bySeq); },
    async remove(ids) { for (const id of ids) pending.delete(id); },
    async reject(records) { for (const record of records) { pending.delete(record.id); rejected.set(record.id, record); } },
    async counts() { return { pending: pending.size, rejected: rejected.size }; },
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Activity outbox request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Activity outbox transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Activity outbox transaction was aborted'));
  });
}

/** IndexedDB-backed store. Every method rejects when IndexedDB is unusable. */
export function createIndexedDbActivityStore(factory: IDBFactory | undefined = globalThis.indexedDB): ActivityRecordStore {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) { reject(new Error('IndexedDB is not available')); return; }
      const request = factory.open(ACTIVITY_DATABASE_NAME, ACTIVITY_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PENDING_STORE)) db.createObjectStore(PENDING_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(REJECTED_STORE)) db.createObjectStore(REJECTED_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Let a future schema upgrade (e.g. another tab) proceed; the next call reopens.
        db.onversionchange = () => { db.close(); database = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to open activity outbox'));
      request.onblocked = () => reject(new Error('Activity outbox upgrade is blocked'));
    }).catch((error: unknown) => { database = null; throw error; });
    return database;
  };
  const write = async (stores: string[], work: (transaction: IDBTransaction) => void) => {
    const transaction = (await open()).transaction(stores, 'readwrite');
    const done = transactionDone(transaction);
    work(transaction);
    await done;
  };
  return {
    put: records => write([PENDING_STORE], transaction => {
      const store = transaction.objectStore(PENDING_STORE);
      for (const record of records) store.put({ ...record });
    }),
    async list() {
      const transaction = (await open()).transaction(PENDING_STORE, 'readonly');
      const values = await requestResult<unknown[]>(transaction.objectStore(PENDING_STORE).getAll());
      return values.map(decodeStoredActivityRecord).filter((record): record is StoredActivityRecord => record !== null).sort(bySeq);
    },
    remove: ids => write([PENDING_STORE], transaction => {
      const store = transaction.objectStore(PENDING_STORE);
      for (const id of ids) store.delete(id);
    }),
    reject: records => write([PENDING_STORE, REJECTED_STORE], transaction => {
      const pending = transaction.objectStore(PENDING_STORE);
      const rejected = transaction.objectStore(REJECTED_STORE);
      for (const record of records) { pending.delete(record.id); rejected.put({ ...record }); }
    }),
    async counts() {
      const transaction = (await open()).transaction([PENDING_STORE, REJECTED_STORE], 'readonly');
      const [pending, rejected] = await Promise.all([
        requestResult(transaction.objectStore(PENDING_STORE).count()),
        requestResult(transaction.objectStore(REJECTED_STORE).count()),
      ]);
      return { pending, rejected };
    },
  };
}

/**
 * Durable store with a memory fallback.
 *
 * A record is listed from the moment `put` is called. It leaves memory only
 * once the durable write confirms it, and any durable failure switches the
 * store to non-durable mode for the rest of the session.
 */
export class ResilientActivityStore implements ActivityRecordStore {
  private readonly memory = new Map<string, StoredActivityRecord>();
  private readonly memoryRejected = new Map<string, RejectedActivityRecord>();
  private durableFailed: boolean;

  constructor(private readonly durableStore: ActivityRecordStore | null) {
    this.durableFailed = durableStore === null;
  }

  /** `true` while durable storage is available and no write has failed this session. */
  get durable() { return !this.durableFailed; }

  private fail() { this.durableFailed = true; }

  async put(records: readonly StoredActivityRecord[]) {
    for (const record of records) this.memory.set(record.id, record);
    if (this.durableFailed || !this.durableStore || !records.length) return;
    try {
      await this.durableStore.put(records);
      for (const record of records) {
        if (this.memory.get(record.id) === record) this.memory.delete(record.id);
      }
    } catch { this.fail(); }
  }

  async list() {
    let durable: StoredActivityRecord[] = [];
    if (this.durableStore) {
      try { durable = await this.durableStore.list(); } catch { this.fail(); }
    }
    const merged = new Map<string, StoredActivityRecord>();
    for (const record of durable) merged.set(record.id, record);
    for (const record of this.memory.values()) merged.set(record.id, record);
    return [...merged.values()].sort(bySeq);
  }

  async remove(ids: readonly string[]) {
    for (const id of ids) this.memory.delete(id);
    if (!this.durableStore || !ids.length) return;
    // A failed durable delete only means an already acknowledged record may be
    // resent; the server answers it as an idempotent duplicate.
    try { await this.durableStore.remove(ids); } catch { this.fail(); }
  }

  async reject(records: readonly RejectedActivityRecord[]) {
    for (const record of records) this.memory.delete(record.id);
    if (!records.length) return;
    if (this.durableStore && !this.durableFailed) {
      try { await this.durableStore.reject(records); return; } catch { this.fail(); }
    }
    for (const record of records) this.memoryRejected.set(record.id, record);
    // Keep it out of the durable retry queue even when the move failed.
    if (this.durableStore) { try { await this.durableStore.remove(records.map(record => record.id)); } catch { /* retried as a duplicate rejection */ } }
  }

  async counts() {
    let durable: ActivityRecordCounts = { pending: 0, rejected: 0 };
    let durableIds: Set<string> | null = null;
    if (this.durableStore) {
      try {
        durable = await this.durableStore.counts();
        if (this.memory.size) durableIds = new Set((await this.durableStore.list()).map(record => record.id));
      } catch { this.fail(); }
    }
    const memoryOnly = [...this.memory.keys()].filter(id => !durableIds?.has(id)).length;
    return { pending: durable.pending + memoryOnly, rejected: durable.rejected + this.memoryRejected.size };
  }
}

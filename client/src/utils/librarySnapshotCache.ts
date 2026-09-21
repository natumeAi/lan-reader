import { requireRecord } from '@lan-reader/shared';
import { decodeLibrarySnapshot } from '../api/decoders.js';
import type { CachedSnapshotRecord } from '../types/library.js';
const DATABASE_NAME = 'epub-reader-library-cache';
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = 'snapshots';
const LATEST_SNAPSHOT_KEY = 'latest';

let databasePromise: Promise<IDBDatabase> | null = null;

function openSnapshotDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }

    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open snapshot cache'));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise;
}

function runSnapshotRequest<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openSnapshotDatabase().then((database) => new Promise<T | null>((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, mode);
    const store = transaction.objectStore(SNAPSHOT_STORE);
    const request = action(store);
    let result: T | null = null;

    request.onsuccess = () => {
      result = request.result ?? null;
    };
    request.onerror = () => reject(request.error || new Error('Snapshot cache request failed'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(
      transaction.error || new Error('Snapshot cache transaction failed'),
    );
    transaction.onabort = () => reject(
      transaction.error || new Error('Snapshot cache transaction was aborted'),
    );
  }));
}

export async function loadCachedLibrarySnapshot() {
  const value: unknown = await runSnapshotRequest<unknown>('readonly', (store) => store.get(LATEST_SNAPSHOT_KEY));
  if (value == null) return null;
  const record = requireRecord(value, 'cached snapshot');
  return { etag: typeof record['etag'] === 'string' ? record['etag'] : null, snapshot: decodeLibrarySnapshot(record['snapshot']) };
}

export async function saveCachedLibrarySnapshot({ etag, snapshot }: CachedSnapshotRecord) {
  await runSnapshotRequest(
    'readwrite',
    (store) => store.put({
      key: LATEST_SNAPSHOT_KEY,
      etag: etag || null,
      savedAt: Date.now(),
      snapshot,
    }),
  );
}

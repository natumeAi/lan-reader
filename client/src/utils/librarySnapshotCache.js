const DATABASE_NAME = 'epub-reader-library-cache';
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = 'snapshots';
const LATEST_SNAPSHOT_KEY = 'latest';

let databasePromise = null;

function openSnapshotDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
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

function runSnapshotRequest(mode, action) {
  return openSnapshotDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, mode);
    const store = transaction.objectStore(SNAPSHOT_STORE);
    const request = action(store);
    let result = null;

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
  return runSnapshotRequest(
    'readonly',
    (store) => store.get(LATEST_SNAPSHOT_KEY),
  );
}

export async function saveCachedLibrarySnapshot({ etag, snapshot }) {
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

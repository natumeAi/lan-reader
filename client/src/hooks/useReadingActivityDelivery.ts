import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { postReadingActivity } from '../api/readingApi.js';
import type { ActivityDelivery, ReadingActivityStatus } from '../utils/activityDelivery.js';
import { createActivityDelivery } from '../utils/activityDelivery.js';
import { ResilientActivityStore, createIndexedDbActivityStore } from '../utils/activityOutbox.js';

/** Creates the default coordinator: IndexedDB records with a memory fallback. */
export function createDefaultActivityDelivery(): ActivityDelivery {
  const durable = globalThis.indexedDB ? createIndexedDbActivityStore(globalThis.indexedDB) : null;
  return createActivityDelivery({
    store: new ResilientActivityStore(durable),
    send: (body, { keepalive }) => postReadingActivity(body, { keepalive }),
  });
}

/**
 * App-owned activity delivery. One coordinator per App instance survives every
 * reader close; it starts listening/delivering on mount and stops on unmount.
 * The App does not subscribe to its status, so deliveries never re-render the
 * shell or an open reader.
 */
export function useReadingActivityDelivery(create: () => ActivityDelivery = createDefaultActivityDelivery): ActivityDelivery {
  const [delivery] = useState(create);
  useEffect(() => delivery.start(), [delivery]);
  return delivery;
}

const idleStatus: ReadingActivityStatus = {
  lastAcceptedAt: null,
  pendingCount: 0,
  permanentErrorCount: 0,
  isDurable: false,
  lastError: null,
  isDelivering: false,
};

/**
 * Low-frequency delivery status for a consumer such as the home dashboard:
 * `lastAcceptedAt` changes when the server accepts activity (refresh signal),
 * `permanentErrorCount` surfaces rejected records and `isDurable` tells whether
 * pending records survive a reload.
 */
export function useReadingActivityStatus(delivery: ActivityDelivery | null | undefined): ReadingActivityStatus {
  const subscribe = useCallback((listener: () => void) => delivery?.subscribe(listener) ?? (() => {}), [delivery]);
  const getSnapshot = useCallback(() => delivery?.getStatus() ?? idleStatus, [delivery]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

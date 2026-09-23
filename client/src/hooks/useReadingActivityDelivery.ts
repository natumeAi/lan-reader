import { useEffect, useState } from 'react';
import { postReadingActivity } from '../api/readingApi.js';
import type { ActivityDelivery } from '../utils/activityDelivery.js';
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
 * shell or an open reader; only `useReadingDashboard` subscribes, and only while
 * 首页 is shown with no reader over it.
 */
export function useReadingActivityDelivery(create: () => ActivityDelivery = createDefaultActivityDelivery): ActivityDelivery {
  const [delivery] = useState(create);
  useEffect(() => delivery.start(), [delivery]);
  return delivery;
}

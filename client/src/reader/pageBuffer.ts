import type { PositionKey, PreparedSurface, SurfaceLease, SurfaceOwner, SurfaceProvider, SurfaceRequest } from './bufferTypes';
import { samePositionKey } from './bufferTypes';

interface Entry {
  key: string; request: SurfaceRequest; owner: SurfaceOwner;
  state: 'loading' | 'ready' | 'stale' | 'idle' | 'retiring'; leases: number; working: boolean;
  prepared: PreparedSurface | null; ready: Promise<boolean>; parking?: Promise<void>; disposal?: Promise<void>;
}
const requestKey = (request: SurfaceRequest) => JSON.stringify([
  request.key.sessionId, request.key.positionRevision, request.key.layoutGeneration, request.key.appearanceGeneration,
  request.cfi, request.page, request.width, request.height, request.direction, request.readingDirection, request.settings,
]);
const freezeRequest = (request: SurfaceRequest): SurfaceRequest => Object.freeze({
  ...request, key: Object.freeze({ ...request.key }), settings: Object.freeze({ ...request.settings }),
});

/** Logical neighbors; all loading/leased/retiring owners share the same budget. */
export function createPageBuffer(provider: SurfaceProvider) {
  const entries = new Set<Entry>();
  const reservations = new Set<string>();
  let draining = 0;
  let destroyed = false; let motion = false; let warmToken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: { key: PositionKey; cfi: string } | null = null;
  const stopWarm = () => { ++warmToken; clearTimeout(timer); timer = undefined; };
  const compatible = (left: SurfaceRequest, right: SurfaceRequest) => left.key.sessionId === right.key.sessionId
    && left.key.layoutGeneration === right.key.layoutGeneration
    && left.key.appearanceGeneration === right.key.appearanceGeneration
    && left.width === right.width && left.height === right.height
    && left.readingDirection === right.readingDirection
    && JSON.stringify(left.settings) === JSON.stringify(right.settings);
  const dispose = (entry: Entry) => {
    if (entry.disposal || entry.leases || motion || entry.parking) return;
    entry.state = 'retiring';
    entry.disposal = Promise.resolve().then(() => { entry.owner.stop(); return entry.owner.dispose(); })
      .then(() => { entries.delete(entry); });
    // Keep the rejected disposal and its budget reservation. Optional callers
    // need no rejection event; stopAndDrain still observes the actual failure.
    void entry.disposal.catch(() => {});
  };
  const retireOrPark = (entry: Entry) => {
    if (entry.leases || motion || entry.parking || entry.disposal) return;
    if (!entry.prepared || !entry.owner.retarget || destroyed) { dispose(entry); return; }
    entry.working = true;
    entry.parking = Promise.resolve().then(() => entry.owner.drain()).then(() => {
      entry.working = false;
      entry.parking = undefined;
      if (destroyed || entry.state !== 'stale') { dispose(entry); return; }
      entry.prepared = null;
      entry.state = 'idle';
    }, () => {
      entry.working = false;
      entry.parking = undefined;
      dispose(entry);
    });
  };
  const find = (key: string) => [...entries].find(entry => entry.key === key && (entry.state === 'loading' || entry.state === 'ready'));
  const start = (entry: Entry, snapshot: SurfaceRequest) => {
    entry.ready = (async () => {
      let prepared: PreparedSurface | null;
      try { prepared = await entry.owner.ready; await entry.owner.drain(); } catch { prepared = null; }
      entry.working = false;
      if (destroyed || entry.state !== 'loading' || !prepared || !samePositionKey(prepared.origin, snapshot.key)) {
        if (entry.state !== 'retiring') entry.state = 'stale';
        retireOrPark(entry); return false;
      }
      entry.prepared = Object.freeze({ ...prepared, origin: Object.freeze({ ...prepared.origin }), target: Object.freeze({ ...prepared.target }) });
      entry.state = 'ready'; return true;
    })();
    return entry.ready;
  };
  const prepare = async (request: SurfaceRequest): Promise<boolean> => {
    if (destroyed || (current && (!samePositionKey(request.key, current.key) || request.cfi !== current.cfi))) return false;
    const key = requestKey(request);
    const existing = find(key); if (existing) return existing.ready;
    if (motion || draining || reservations.has(key)) return false;
    const snapshot = freezeRequest(request);
    // A committed turn releases its preview only in Controller.finish(). The
    // next input can arrive while that owner is still draining the stop frames.
    // Reuse that exact budget slot instead of opening another Book beside it.
    const parking = [...entries].find(entry => entry.state === 'stale' && entry.parking && compatible(entry.request, snapshot));
    if (parking?.parking) {
      await parking.parking;
      if (destroyed || motion || draining || reservations.has(key)
        || (current && (!samePositionKey(snapshot.key, current.key) || snapshot.cfi !== current.cfi))) return false;
      const concurrent = find(key); if (concurrent) return concurrent.ready;
    }
    for (const entry of entries) if (entry.state === 'idle' && !compatible(entry.request, snapshot)) dispose(entry);
    if (entries.size + reservations.size >= 2) {
      // Layout/session changes can leave both budget slots occupied by owners
      // whose old proofs are already stopped. Wait for those physical releases
      // before admitting the new request; a leased owner still keeps its slot.
      const obsolete = [...entries].filter(entry => !compatible(entry.request, snapshot)
        && !entry.leases && (entry.parking || entry.disposal));
      await Promise.allSettled(obsolete.map(async entry => {
        if (entry.parking) await entry.parking;
        if (entry.state === 'idle' && !compatible(entry.request, snapshot)) dispose(entry);
        if (entry.disposal) await entry.disposal;
      }));
      if (destroyed || motion || draining || reservations.has(key)
        || (current && (!samePositionKey(snapshot.key, current.key) || snapshot.cfi !== current.cfi))) return false;
      const concurrent = find(key); if (concurrent) return concurrent.ready;
    }
    const idle = [...entries].find(entry => entry.state === 'idle' && compatible(entry.request, snapshot));
    if (idle) {
      // Reserve the existing slot during a potentially reentrant provider call.
      idle.state = 'retiring'; idle.working = true; idle.prepared = null;
      reservations.add(key);
      let reused = false;
      try { reused = idle.owner.retarget?.(snapshot) === true; }
      catch { /* A failed transfer retires this physical owner. */ }
      finally { reservations.delete(key); }
      if (reused) {
        idle.key = key; idle.request = snapshot; idle.state = 'loading';
        return start(idle, snapshot);
      }
      idle.working = false; idle.state = 'stale'; dispose(idle);
      // A rejected reuse may still leave room for one independent owner.
    }
    // Retiring owners remain in this set until actual resource release completes.
    if (entries.size + reservations.size >= 2) return false;
    let owner: SurfaceOwner;
    reservations.add(key);
    try { owner = provider.create(snapshot); } catch { return false; }
    finally { reservations.delete(key); }
    const entry: Entry = { key, request: snapshot, owner, state: 'loading', leases: 0, working: true, prepared: null, ready: Promise.resolve(false) };
    entries.add(entry);
    return start(entry, snapshot);
  };
  const acquire = (request: SurfaceRequest): SurfaceLease | null => {
    if (destroyed || (current && (!samePositionKey(request.key, current.key) || request.cfi !== current.cfi))) return null;
    const entry = find(requestKey(request));
    if (!entry?.prepared || entry.state !== 'ready' || entry.working) return null;
    ++entry.leases; let released = false;
    return {
      id: entry.owner.id, prepared: entry.prepared, request: entry.request,
      release() {
        if (released) return; released = true; --entry.leases;
        if (entry.state === 'stale') retireOrPark(entry);
      },
    };
  };
  const invalidate = () => {
    stopWarm();
    for (const entry of entries) {
      if (entry.state === 'retiring') continue;
      entry.state = 'stale';
      entry.owner.stop();
      if (!entry.leases) retireOrPark(entry);
    }
  };
  const stopAndDrain = async () => {
    stopWarm();
    draining++;
    try {
      // A provider factory may synchronously request this barrier before its
      // owner has returned. Finish that registration before snapshotting owners.
      await Promise.resolve();
      // Do not stop the demanded owner: its readiness proof remains valid.
      const settled = await Promise.allSettled([...entries].map(async entry => {
        let failure: { error: unknown } | null = null;
        try { await entry.ready; await entry.owner.drain(); }
        catch (error) { failure = { error }; }
        if (entry.state === 'stale') retireOrPark(entry);
        if (entry.parking) await entry.parking;
        try { if (entry.disposal) await entry.disposal; }
        catch (error) { failure ??= { error }; }
        if (failure) throw failure.error;
      }));
      const failure = settled.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally { draining--; }
  };
  return {
    prepare, acquire, invalidate, stopWarm, stopAndDrain,
    isCurrentOwner(id: string) {
      const origin = current;
      return !destroyed && Boolean(origin && [...entries].some(entry => entry.owner.id === id
        && (entry.state === 'loading' || entry.state === 'ready')
        && samePositionKey(entry.request.key, origin.key) && entry.request.cfi === origin.cfi));
    },
    setCurrent(key: PositionKey, cfi: string) { current = { key: { ...key }, cfi }; },
    get busy() { return draining > 0 || reservations.size > 0 || [...entries].some(entry => entry.working || entry.state === 'retiring'); },
    beginMotion() {
      if (destroyed || draining || reservations.size || [...entries].some(entry => entry.working || entry.state === 'retiring' || entry.state === 'stale')) return false;
      stopWarm(); motion = true; return true;
    },
    endMotion() {
      motion = false;
      for (const entry of entries) if (entry.state === 'stale') retireOrPark(entry);
    },
    warm(requests: SurfaceRequest[]) {
      stopWarm(); if (destroyed || motion) return;
      const token = warmToken;
      timer = setTimeout(() => {
        timer = undefined;
        void (async () => {
          for (const request of requests) {
            if (destroyed || motion || token !== warmToken) return;
            await prepare(request);
          }
        })();
      }, 350);
    },
    snapshot() {
      const neighbors = [...entries].filter(entry => current && samePositionKey(entry.request.key, current.key) && entry.request.cfi === current.cfi);
      const slot = (direction: 'next' | 'prev') => {
        const entry = neighbors.find(candidate => candidate.request.direction === direction && candidate.state !== 'retiring');
        return entry ? { state: entry.state, id: entry.owner.id, leases: entry.leases } : { state: 'empty' as const, id: null, leases: 0 };
      };
      return { current: current ? { ...current, key: { ...current.key } } : null, previous: slot('prev'), next: slot('next'), owners: entries.size + reservations.size, retiring: [...entries].filter(entry => entry.state === 'retiring').length, activeLeases: [...entries].reduce((sum, entry) => sum + entry.leases, 0), motion };
    },
    async destroy() {
      destroyed = true; motion = false; invalidate();
      await stopAndDrain();
    },
  };
}
export type PageBuffer = ReturnType<typeof createPageBuffer>;

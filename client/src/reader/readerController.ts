import type { ReaderSession, StablePosition, NavigationCommand, NavigationResult } from './types';
import type { PositionKey, SurfaceLease, SurfaceRequest } from './bufferTypes';
import { samePositionKey } from './bufferTypes';
import type { ReaderSettings } from '../hooks/useReaderSettings';
import type { ReaderLocation } from '../types/epub';
import { createPageRenderer } from './pageRenderer';
import type { PageRendererBinding } from './pageRenderer';
import { createPageTurnEngine } from './pageTurnEngine';
import type { GestureSnapshot, GestureInput, GestureMoveResult } from './pageTurnEngine';
import { PAGE_TURN_RULES, getSettleDuration, getTapZone, easeOutCubic } from '../utils/pageTurnGesture';
import { createPageTurnDiagnostics, readPageTurnDebugConfig } from '../utils/pageTurnDiagnostics';

type Direction = 'next' | 'prev';
export type ReaderPhase = 'idle' | 'tracking' | 'dragging' | 'preparing' | 'settling' | 'committing' | 'recovering' | 'suspended' | 'failed';
export interface AcceptedPosition { reason: 'opened' | 'navigation' | 'layout-restored' | 'snapshot'; position: StablePosition; revision: number }
/** `source` only labels diagnostics; admission and motion never depend on it. */
export interface TurnCommandOptions { action?: string; inputTime?: number; source?: 'keyboard' | 'tap' | 'command' }
export interface TurnResult { kind: 'committed' | 'boundary' | 'cancelled' | 'failed' | 'blocked' | 'queue-full' | 'no-turn' | 'rebound'; reason?: string }
export const TURN_QUEUE_CAPACITY = 8;
interface Options {
  onAccepted?: (event: AcceptedPosition) => void;
  /** Display-only metadata when the verified preview becomes dominant; null restores accepted metadata. */
  onPageDisplayed?: (location: ReaderLocation | null) => void;
  diagnostics?: ReturnType<typeof createPageTurnDiagnostics>;
  preparationTimeoutMs?: number;
}
interface InputOptions {
  disabled?: boolean; reducedMotion?: boolean;
  onCenterTap?: () => void; onTap?: (point: { clientX: number; clientY: number }) => boolean;
  onReleasePointer?: (id: number) => void;
  onPageTurnCommitted?: () => Promise<void>;
}
interface Snapshot extends GestureSnapshot { left: number; height: number }
interface Intent {
  direction: Direction | null; options: TurnCommandOptions; interaction: number | null;
  queueRecord: number | null; resolve: (result: TurnResult) => void; promise: Promise<TurnResult>;
  result: TurnResult | null; committed?: boolean;
}
/** One leased neighbor; `sign` is its physical side (LTR next: -1, to the right of current). */
interface Side { direction: Direction; sign: -1 | 1; element: HTMLElement; lease: SurfaceLease }
/**
 * One motion admission: the leases of every neighbor bound with the foreground.
 * `demand` is the direction that must be leased (null: pointerdown pre-admission
 * of already ready neighbors); `pending` lists directions this admission may
 * still bind and is empty once admission ended.
 */
interface Pair { width: number; rtl: boolean; demand: Direction | null; pending: Set<Direction>; sides: Partial<Record<Direction, Side>>; ready: Promise<Pair | null> }
const DIRECTIONS = ['next', 'prev'] as const;
const sideSign = (direction: Direction, rtl: boolean): -1 | 1 => (direction === 'next') !== rtl ? -1 : 1;
let nextSessionId = 0;
const copyPosition = (position: StablePosition): StablePosition => ({
  ...position, location: { ...position.location, start: position.location.start ? {
    ...position.location.start, displayed: position.location.start.displayed ? { ...position.location.start.displayed } : undefined,
  } : undefined },
});

/** One session owns input admission, candidates, acceptance and rollback. */
export function createReaderController(session: ReaderSession, options: Options = {}) {
  const { engine, foreground, buffer, pagination } = session;
  const sessionId = ++nextSessionId;
  let layoutGeneration = 0; let appearanceGeneration = 0; let optionalEpoch = 0;
  let quiet: Promise<boolean> | null = null; let motionReady = false;
  const diagnostics = options.diagnostics ?? createPageTurnDiagnostics({ enabled: readPageTurnDebugConfig().enabled });
  const renderer = createPageRenderer();
  const listeners = new Set<() => void>();
  let ui: { phase: ReaderPhase; direction: Direction | null; queueDepth: number } = { phase: 'idle', direction: null, queueDepth: 0 };
  let input: InputOptions = {};
  let disposed = false; let suspended = false; let command = 0; let revision = 0;
  let committed = engine.stable ? copyPosition(engine.stable) : null;
  let capturedRevision = -1;
  let pair: Pair | null = null;
  let displayingPreview = false;
  let binding: { pair: Pair | null; value: PageRendererBinding } | null = null;
  let record: number | null = null;
  let frame: number | null = null;
  let navigation: Promise<NavigationResult> | null = null;
  let recovery: Promise<void> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let requestedSettings: ReaderSettings | null = null;
  let settingsWork: Promise<void> | null = null;
  let resumeWork: Promise<void> | null = null;
  let lifecycle = 0;
  // Diagnostic id of the latest started logical input; null whenever diagnostics are disabled.
  let interaction: number | null = null;
  const queue: Intent[] = [];
  let activeIntent: Intent | null = null;
  let viewportCache: Snapshot | null = null;
  // `visual` is the rendered distance; `drawn` marks the first drag-frame write, `readyMarked` the diagnostic readiness at lock.
  type Pointer = { id: number; snapshot: Snapshot; gesture: ReturnType<typeof createPageTurnEngine>; latest: GestureMoveResult | null; visual: number; start: number; interaction: number | null; boundaryPending?: boolean; catchUp?: { from: number; startTime: number | null }; drawn?: boolean; readyMarked?: boolean; intent?: Intent };
  let pointer: Pointer | null = null;
  let pendingPointer: { pointer: Pointer; intent: Intent; sample: GestureInput } | null = null;
  const publishQueue = () => { ui = { ...ui, queueDepth: queue.length }; for (const listener of listeners) listener(); };
  const setPhase = (phase: ReaderPhase, direction: Direction | null = ui.direction) => {
    if (ui.phase === phase && ui.direction === direction) return;
    ui = { phase, direction, queueDepth: queue.length }; for (const listener of listeners) listener();
  };
  // Control work (preparation, drains, motion admission, optional-work
  // resumption, React-facing labels and handoff) runs in ordinary tasks. Never
  // in a frame: Chromium dispatches coalesced pointermoves inside the rendering
  // frame, and preparation/WAAPI promises can resolve from frame callbacks.
  const controlTasks: (() => void)[] = [];
  let controlTimer: ReturnType<typeof setTimeout> | undefined;
  const runControl = () => {
    controlTimer = undefined;
    // Tasks posted while this batch runs wait for the next task.
    for (const task of controlTasks.splice(0)) task();
  };
  const postControl = (task: () => void) => {
    controlTasks.push(task);
    controlTimer ??= setTimeout(runControl, 0);
  };
  /** Resolves in a fresh control task; awaiting it leaves any frame microtask checkpoint. */
  const controlTask = () => new Promise<void>(resolve => { postControl(resolve); });
  // Optional-work resumption token; every stop invalidates a pending resumption.
  let optionalRun = 0;
  const alive = (version: number) => !disposed && !suspended && version === command;
  const snapshot = (): Snapshot => {
    const location = committed?.location ?? engine.currentLocation();
    const rect = foreground.getBoundingClientRect();
    viewportCache = { width: foreground.clientWidth, height: foreground.clientHeight, left: rect.left, direction: engine.direction ?? 'ltr', canPrev: !location?.atStart, canNext: !location?.atEnd };
    return { ...viewportCache };
  };
  const key = (): PositionKey => ({ sessionId, positionRevision: revision, layoutGeneration, appearanceGeneration });
  const slotState = (direction: Direction) => buffer.snapshot()[direction === 'next' ? 'next' : 'previous'].state;
  const ownTurnHandoff = () => engine.state === 'recovering' && activeIntent !== null && ui.phase === 'committing';
  // Diagnostic-only classification; callers evaluate it only when diagnostics are enabled.
  const blockReason = (source: 'gesture' | 'navigation' = 'gesture') => disposed || suspended || (engine.state !== 'ready' && !ownTurnHandoff()) || recovery || settingsWork || resumeWork
    || resizeTimer !== undefined || ui.phase === 'recovering' || ui.phase === 'suspended' || ui.phase === 'failed'
    ? 'not-ready' : source === 'gesture' && input.disabled ? 'disabled' : 'busy';
  const stopOptional = () => { ++optionalRun; diagnostics.deferUserTiming(); session.setOptionalWorkAllowed(false); buffer.stopWarm(); pagination.pause(); };
  const clearPair = () => {
    const previous = pair; pair = null; renderer.release(); binding = null;
    if (pointer) pointer.catchUp = undefined;
    if (displayingPreview) { displayingPreview = false; options.onPageDisplayed?.(null); }
    buffer.endMotion();
    if (previous) for (const direction of DIRECTIONS) previous.sides[direction]?.lease.release();
    ++optionalEpoch; quiet = null; motionReady = false;
  };
  const bounded = (work: Promise<unknown>) => new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => resolve(false), options.preparationTimeoutMs ?? 2500);
    void work.then(value => { clearTimeout(timeout); resolve(value !== false); }, () => { clearTimeout(timeout); resolve(false); });
  });
  const ensureMotion = () => {
    if (quiet) return quiet;
    stopOptional();
    const epoch = optionalEpoch;
    // A timeout declines animation; it never releases or discounts an owner.
    quiet = bounded(Promise.all([pagination.stopAndDrain(), buffer.stopAndDrain()])).then(drained => {
      if (epoch !== optionalEpoch || disposed || suspended) return false;
      motionReady = drained; return drained;
    });
    return quiet;
  };
  // Drain before motion. Outstanding owner/measurement work can settle on frame
  // callbacks, so admission then resumes in a control task. A drain started
  // with nothing outstanding settles in this task's microtasks and needs no hop.
  const drainForMotion = async () => {
    const immediate = !quiet && buffer.quiet && pagination.quiet === true;
    const drained = await ensureMotion();
    if (drained && !immediate) await controlTask();
    return drained;
  };
  const invalidateResources = () => {
    ++layoutGeneration; ++optionalEpoch; quiet = null; motionReady = false;
    buffer.invalidate(); pagination.invalidate();
  };
  const resetVisual = () => {
    if (frame !== null) cancelAnimationFrame(frame); frame = null;
    const previous = pointer; previous?.gesture.cancel(); pointer = null;
    if (previous) input.onReleasePointer?.(previous.id);
    clearPair();
  };
  const idle = () => {
    if (activeIntent) return;
    if (!disposed && !suspended && !navigation && !recovery && !settingsWork && !resumeWork && resizeTimer === undefined && ui.phase !== 'failed') {
      diagnostics.flushUserTiming();
      if (queue.length) { advanceQueue(); return; }
      setPhase('idle', null); session.setOptionalWorkAllowed(true);
      // idle() also runs from settle-finish and navigation continuations. Warm
      // requests read viewport geometry, so resume optional work from a control
      // task; any input that stops optional work before it runs wins.
      const run = optionalRun;
      postControl(() => {
        if (run !== optionalRun || disposed || suspended || pointer || queue.length || activeIntent || ui.phase !== 'idle') return;
        ++optionalRun;
        if (committed) {
          const viewport = { width: foreground.clientWidth, height: foreground.clientHeight };
          const requests = (['next', 'prev'] as const).filter(direction => direction === 'next' ? !committed!.location.atEnd : !committed!.location.atStart)
            .map(direction => session.createRequest(committed!, key(), direction, viewport));
          buffer.warm(requests);
        }
        pagination.request();
      });
    }
  };
  const accept = (position: StablePosition, reason: AcceptedPosition['reason']) => {
    committed = copyPosition(position);
    if (reason !== 'layout-restored') { revision++; capturedRevision = -1; }
    buffer.invalidate(); buffer.setCurrent(key(), committed.cfi);
    options.onAccepted?.({ reason, position: copyPosition(committed), revision });
  };
  const execute = (request: NavigationCommand) => {
    const pending = engine.execute(request); navigation = pending;
    void pending.then(() => { if (navigation === pending) navigation = null; }, () => { if (navigation === pending) navigation = null; });
    return pending;
  };
  const restore = async (origin: StablePosition, version: number) => {
    stopOptional(); invalidateResources();
    const result = await execute({ kind: 'restore', target: origin.cfi });
    if (!alive(version)) return;
    if (result.kind === 'verified') {
      // The engine verified the requested origin exactly. A reflow can change
      // its newly sampled visible midpoint without invalidating that restore.
      // Rollback restores page/layout metadata but never manufactures a save.
      accept(result.position, 'layout-restored'); idle();
    } else setPhase('failed', null);
  };
  const recover = (pending: Promise<NavigationResult>, origin: StablePosition | null) => {
    if (recovery) return recovery;
    setPhase('recovering', null);
    const version = command;
    recovery = (async () => {
      try {
        await pending.catch(() => undefined);
        if (!alive(version)) return;
        if (origin) await restore(origin, version); else setPhase('failed', null);
      } catch { if (alive(version)) setPhase('failed', null); }
      finally { recovery = null; idle(); }
    })();
    return recovery;
  };
  const cancel = (reason = 'cancelled') => {
    if (disposed) return Promise.resolve();
    if (pointer?.intent) resolveIntent(pointer.intent, { kind: 'cancelled', reason });
    clearIntents('cancelled', reason);
    // Repeated cancellation shares the same rollback. Only a lifecycle stop
    // invalidates a recovery that is already restoring the committed origin.
    if (!recovery || suspended || disposed) ++command;
    diagnostics.close(record, { cancelReason: reason }); record = null;
    resetVisual();
    // After motion stopped; an input that already has its result keeps it.
    diagnostics.resolveInteraction(interaction, 'cancelled', reason);
    // Cancellation has stopped renderer motion, including failed/suspended exits
    // that never return through idle(). Flush in a control task, not a frame.
    const cancelledVersion = command;
    postControl(() => {
      if (command === cancelledVersion && !disposed && !pointer && !activeIntent && ui.phase !== 'settling' && ui.phase !== 'dragging') diagnostics.flushUserTiming();
    });
    if (navigation) return recover(navigation, committed);
    if (!recovery) idle();
    return recovery ?? Promise.resolve();
  };
  const bind = (nextPair: Pair | null) => {
    if (binding?.pair === nextPair) return binding.value;
    const neighbors = nextPair ? DIRECTIONS.flatMap(direction => {
      const side = nextPair.sides[direction];
      return side ? [{ element: side.element, sign: side.sign }] : [];
    }) : [];
    const value = renderer.bind({ current: foreground, width: nextPair?.width ?? 0, neighbors });
    binding = { pair: nextPair, value }; return value;
  };
  // Motion admission, always outside frames: the drained buffer locks
  // preparation/disposal, then the renderer binds will-change/visibility and
  // places the surfaces at the distance already shown. Frames never admit.
  // A pointerdown pre-admission places at 0 before any motion: `visible` false.
  const place = (nextPair: Pair | null, distance: number, visible = true) => {
    if (binding?.pair !== nextPair) {
      if (!motionReady || !buffer.beginMotion()) return false;
      bind(nextPair);
    }
    binding!.value.update(distance);
    if (visible) {
      diagnostics.markVisualUpdate(record); diagnostics.startPhase(record, 'motion');
      if (pointer) diagnostics.startPhase(record, 'drag');
    }
    return true;
  };
  // The binding already covers this drag target: a bound side, or any binding
  // for the damped boundary distance (a missing side stays hidden).
  const covers = (latest: GestureMoveResult | null) => {
    const bound = binding;
    if (!bound || latest?.phase !== 'dragging' || !latest.direction) return false;
    return latest.boundary || Boolean(bound.pair?.sides[latest.direction]);
  };
  // The only drag frame work: read the latest numeric sample and move the
  // already bound surfaces. No preparation, drain, binding, geometry or React.
  const scheduleDragFrame = (current: Pointer) => {
    if (frame !== null) return;
    frame = requestAnimationFrame(time => {
      frame = null; if (pointer !== current || disposed || suspended) return;
      const latest = current.latest; const bound = binding;
      // A target outside the binding waits for syncDrag() to rebind outside frames.
      if (!bound || !covers(latest)) return;
      let distance = latest!.visualDistance;
      if (current.catchUp && bound.pair) {
        current.catchUp.startTime ??= time;
        const progress = Math.min(1, Math.max(0, (time - current.catchUp.startTime) / PAGE_TURN_RULES.dragCatchUpDurationMs));
        distance = current.catchUp.from + (distance - current.catchUp.from) * easeOutCubic(progress);
        if (progress === 1) { current.catchUp = undefined; diagnostics.endPhase(record, 'catch-up'); }
      }
      bound.value.update(distance); current.visual = distance;
      if (!current.drawn) {
        // A pre-admitted binding was placed before this drag record existed.
        current.drawn = true;
        diagnostics.markVisualUpdate(record); diagnostics.startPhase(record, 'motion'); diagnostics.startPhase(record, 'drag');
      }
      // A held finger emits no more pointermoves. Finish a late preview's short
      // catch-up on real frames, always following the latest input position.
      if (current.catchUp) scheduleDragFrame(current);
    });
  };
  /**
   * Leases neighbors of the accepted origin and admits them to motion together.
   * `demand` must be leased; null pre-admits only neighbors that are ready now
   * (pointerdown) and never prepares. During a gesture every other reachable,
   * already ready neighbor is leased too, so a warm reversal only changes
   * transforms. Discrete turns lease only their demand.
   */
  const prepare = (demand: Direction | null, ruler: Snapshot): Promise<Pair | null> => {
    // A drag waits for a pending side. A released turn toward a side that is
    // only pending opportunistically behind another (cold) demand does not:
    // that admission would not lease it without a pointer, and waiting for the
    // cold side delays a ready turn.
    if (pair && (demand === null || pair.sides[demand]
      || (pair.pending.has(demand) && (pointer !== null || pair.demand === null || pair.demand === demand)))) return pair.ready;
    const origin = committed; const requestKey = key();
    const viewport = { width: ruler.width, height: ruler.height };
    const gesture = demand === null || pointer !== null;
    const requests: Partial<Record<Direction, SurfaceRequest>> = {};
    if (origin) {
      for (const direction of DIRECTIONS) {
        const reachable = direction === 'next' ? ruler.canNext : ruler.canPrev;
        if (direction === demand || (gesture && reachable)) requests[direction] = session.createRequest(origin, requestKey, direction, viewport);
      }
    }
    // Read-only: only these other neighbors can join this admission.
    const warm = DIRECTIONS.filter(direction => {
      const request = direction === demand ? undefined : requests[direction];
      return request !== undefined && buffer.isReady(request);
    });
    if (demand === null && !warm.length) return Promise.resolve(null);
    clearPair(); stopOptional();
    if (pointer) pointer.visual = 0;
    const nextPair: Pair = { width: ruler.width, rtl: ruler.direction === 'rtl', demand, pending: new Set(demand ? [demand, ...warm] : warm), sides: {}, ready: Promise.resolve(null) };
    pair = nextPair;
    const prepareRecord = record; const prepareInteraction = interaction;
    diagnostics.startPhase(prepareRecord, 'prepare');
    const demandRequest = demand ? requests[demand] : undefined;
    if (!origin) { nextPair.pending.clear(); return nextPair.ready; }
    const wasReady = demandRequest ? buffer.isReady(demandRequest) : true;
    const started = performance.now();
    // Diagnostics: the demand, or each neighbor a pre-admission may lease.
    const preparations = diagnostics.enabled
      ? (demand ? [demand] : warm).map(direction => ({ direction, index: diagnostics.startPreparation(prepareInteraction, direction, slotState(direction), started) }))
      : [];
    const stale = () => disposed || suspended || pair !== nextPair || !samePositionKey(requestKey, key());
    const lease = (direction: Direction) => {
      const request = requests[direction];
      const acquired = request ? buffer.acquire(request) : null;
      if (acquired) nextPair.sides[direction] = { direction, sign: sideSign(direction, nextPair.rtl), element: acquired.prepared.element, lease: acquired };
      return acquired !== null;
    };
    const releaseSides = () => {
      for (const direction of DIRECTIONS) nextPair.sides[direction]?.lease.release();
      nextPair.sides = {};
    };
    let leased = false;
    nextPair.ready = (async () => {
      const prepared = demandRequest ? await bounded(buffer.prepare(demandRequest)) : true;
      // Provider readiness and drains settle on real frame callbacks. Drain and
      // admit from control tasks, never from those frames' microtasks. An
      // already ready exact proof resolved within this control task.
      if (!wasReady) await controlTask();
      if (!prepared) return null;
      if (stale()) return null;
      diagnostics.startPhase(prepareRecord, 'drain');
      const drained = await drainForMotion();
      diagnostics.endPhase(prepareRecord, 'drain');
      if (!drained || stale() || !motionReady || engine.state !== 'ready') return null;
      if (demand && !lease(demand)) return null;
      // Opportunistic: only lease a neighbor that is still ready, never prepare it.
      if (demand === null || pointer) for (const direction of warm) if (buffer.isReady(requests[direction]!)) lease(direction);
      if (!nextPair.sides.next && !nextPair.sides.prev) return null;
      const current = pointer;
      const latest = current?.latest;
      const following = Boolean(current && latest?.phase === 'dragging' && latest.direction && (latest.boundary || nextPair.sides[latest.direction]));
      if (!place(nextPair, following ? current!.visual : 0, demand !== null || following)) { releaseSides(); return null; }
      if (following) {
        // Cached pages follow input directly. Only a cold preview (or a slow
        // resource-drain barrier) bridges the missing motion instead of jumping.
        if (!latest!.boundary && !input.reducedMotion && (!wasReady || performance.now() - started > 32)) {
          current!.catchUp = { from: current!.visual, startTime: null };
          diagnostics.startPhase(record, 'catch-up');
          for (const entry of preparations) if (entry.direction === latest!.direction) diagnostics.markCatchUp(prepareInteraction, entry.index);
        }
        scheduleDragFrame(current!);
      }
      diagnostics.markMilestone(record, 'neighborReady');
      leased = true;
      return nextPair;
    })().catch(() => null).finally(() => {
      nextPair.pending.clear();
      diagnostics.endPhase(prepareRecord, 'prepare');
      for (const { direction, index } of preparations) {
        diagnostics.endPreparation(prepareInteraction, index, leased && nextPair.sides[direction] ? 'ready' : stale() ? 'stale' : 'unavailable');
      }
      // The drag turned toward a side this admission did not bind (locked
      // elsewhere during a pre-admission, or an opportunistic side went stale):
      // reconcile from a control task. A failed demand is never retried here.
      const current = pointer; const latest = current?.latest;
      if (current && pair === nextPair && latest?.phase === 'dragging' && latest.direction && !latest.boundary
        && !nextPair.sides[latest.direction] && latest.direction !== demand) postControl(() => { syncDrag(current); });
    });
    return nextPair.ready;
  };
  // Control task: reconcile the latest drag target with preparation and binding.
  const syncDrag = (current: Pointer) => {
    const latest = current.latest;
    if (pointer !== current || disposed || suspended || latest?.phase !== 'dragging' || !latest.direction) return;
    setPhase('dragging', latest.direction);
    if (!latest.boundary) {
      const direction = latest.direction;
      const bound = Boolean(pair && binding?.pair === pair && pair.sides[direction]);
      const pending = Boolean(pair?.pending.has(direction));
      if ((bound || pending) && diagnostics.enabled && !current.readyMarked) {
        current.readyMarked = true; diagnostics.markInteractionReady(current.interaction, slotState(direction));
      }
      // A bound side needs only frames; a pending one waits for its admission.
      if (bound) scheduleDragFrame(current);
      else if (!pending) void prepare(direction, current.snapshot);
      return;
    }
    // Any binding damps the boundary distance; a missing side stays hidden.
    if (binding) { scheduleDragFrame(current); return; }
    current.catchUp = undefined;
    // An unadmitted pair cannot move: drop it and bounce with no neighbor.
    if (pair) { clearPair(); current.visual = 0; }
    if (current.boundaryPending) return;
    current.boundaryPending = true;
    const drainRecord = record;
    diagnostics.startPhase(drainRecord, 'drain');
    void drainForMotion().then(drained => {
      diagnostics.endPhase(drainRecord, 'drain');
      current.boundaryPending = false;
      if (!drained || pointer !== current || !current.latest?.boundary || pair) return;
      if (place(null, current.visual)) scheduleDragFrame(current);
    });
  };
  const showPreviewPage = (nextPair: Pair | null, direction: Direction) => {
    const lease = nextPair?.sides[direction]?.lease;
    if (!lease || pair !== nextPair || !samePositionKey(lease.request.key, key())) return false;
    if (!displayingPreview) {
      const { sectionIndex, page, total, cfi } = lease.prepared.target;
      displayingPreview = true;
      // Marks the display-only React label update: a control task that can run
      // inside the settle window, never inside a frame callback.
      diagnostics.markMilestone(record, 'previewLabel');
      options.onPageDisplayed?.({ start: { index: sectionIndex, cfi, displayed: { page, total } } });
    }
    return true;
  };
  const animate = async (from: number, to: number, duration: number, nextPair: Pair | null, onProgress?: (distance: number) => boolean) => {
    if (input.reducedMotion) return 'finished' as const;
    const version = command; const epoch = optionalEpoch;
    if (!motionReady) {
      const drainRecord = record;
      diagnostics.startPhase(drainRecord, 'drain');
      const drained = await drainForMotion();
      diagnostics.endPhase(drainRecord, 'drain');
      if (!drained) return 'cancelled' as const;
    }
    if (!alive(version) || epoch !== optionalEpoch || !motionReady || (nextPair && pair !== nextPair)) return 'cancelled' as const;
    if (!buffer.beginMotion()) return 'cancelled' as const;
    const animationRecord = record; const time = document.timeline?.currentTime;
    const motion = bind(nextPair);
    let progressFrame: number | null = null;
    const reportProgress = () => {
      progressFrame = null;
      if (!onProgress || !alive(version) || epoch !== optionalEpoch || binding?.value !== motion) return;
      const progress = motion.progress;
      // Read the actual WAAPI clock, so delayed starts and paused animations do
      // not advance the label on a wall-clock timer. The keyframes use this curve.
      if (progress !== null && onProgress(from + (to - from) * easeOutCubic(progress))) return;
      progressFrame = requestAnimationFrame(reportProgress);
    };
    try {
      const completion = motion.settle(from, to, duration, typeof time === 'number' ? time : null, () => {
        diagnostics.markVisualUpdate(animationRecord); diagnostics.startPhase(animationRecord, 'motion');
        diagnostics.startPhase(animationRecord, 'settle');
        diagnostics.markAnimationStart(animationRecord, undefined, { sampleFrames: true });
      });
      if (onProgress) reportProgress();
      return await completion;
    } finally {
      if (progressFrame !== null) cancelAnimationFrame(progressFrame);
      diagnostics.endPhase(animationRecord, 'settle');
      diagnostics.endPhase(animationRecord, 'motion');
    }
  };
  // Panels disable gestures, but may themselves request programmatic navigation.
  // Both paths still require a ready, idle session with no outstanding work.
  const admissible = (source: 'gesture' | 'navigation' = 'gesture') => !disposed && !suspended && (source === 'navigation' || !input.disabled) && !pointer && !activeIntent && !queue.length && !navigation && !recovery && !settingsWork && !resumeWork && resizeTimer === undefined && ui.phase === 'idle' && engine.state === 'ready';
  const admit = (source: 'gesture' | 'navigation' = 'gesture') => {
    diagnostics.countInput('received');
    if (!admissible(source)) { diagnostics.countInput('rejected'); return false; }
    diagnostics.countInput('accepted'); return true;
  };
  // A non-ready engine is expected during this controller's own turn handoff.
  // Display/open/recovery operations never acquire a turn intent and cannot queue.
  const canQueue = () => !disposed && !suspended && !input.disabled && !recovery && !settingsWork && !resumeWork
    && resizeTimer === undefined && !['recovering', 'suspended', 'failed'].includes(ui.phase)
    && (engine.state === 'ready' || ownTurnHandoff())
    && (activeIntent !== null || pointer !== null || queue.length > 0 || ui.phase === 'settling');
  const newIntent = (direction: Direction | null, commandOptions: TurnCommandOptions, id: number | null): Intent => {
    let resolve!: (result: TurnResult) => void;
    const promise = new Promise<TurnResult>(done => { resolve = done; });
    return { direction, options: commandOptions, interaction: id, queueRecord: null, resolve, promise, result: null };
  };
  const endQueueWait = (intent: Intent) => {
    diagnostics.endPhase(intent.queueRecord, 'queue'); diagnostics.close(intent.queueRecord); intent.queueRecord = null;
  };
  const resolveIntent = (intent: Intent, result: TurnResult) => {
    if (intent.result) return;
    // Acceptance is irreversible even if a post-commit callback fails or a
    // lifecycle cancellation arrives while that callback is still pending.
    if (intent.committed) result = { kind: 'committed' };
    intent.result = result;
    diagnostics.resolveInteraction(intent.interaction, result.kind === 'queue-full' ? 'overflow' : result.kind, result.reason);
    endQueueWait(intent); intent.resolve(result);
  };
  const clearIntents = (kind: 'cancelled' | 'failed', reason: string, current = true) => {
    const pending = pendingPointer; pendingPointer = null;
    if (pending) { pending.pointer.gesture.cancel(); input.onReleasePointer?.(pending.pointer.id); }
    const waiting = queue.splice(0);
    for (const intent of waiting) resolveIntent(intent, { kind, reason });
    if (current && activeIntent) { resolveIntent(activeIntent, { kind, reason }); activeIntent = null; }
    if (waiting.length) publishQueue();
  };
  const cancelPendingPointer = (reason: string) => {
    const pending = pendingPointer; if (!pending) return;
    pendingPointer = null; pending.pointer.gesture.cancel(); input.onReleasePointer?.(pending.pointer.id);
    const index = queue.indexOf(pending.intent); if (index !== -1) queue.splice(index, 1);
    resolveIntent(pending.intent, { kind: 'cancelled', reason }); publishQueue();
  };
  const enqueue = (intent: Intent) => {
    queue.push(intent);
    diagnostics.markQueued(intent.interaction, queue.length);
    intent.queueRecord = diagnostics.begin({ action: 'queue', inputTime: intent.options.inputTime, interactionId: intent.interaction });
    diagnostics.startPhase(intent.queueRecord, 'queue');
    publishQueue(); stopOptional();
  };
  const runIntent = (intent: Intent, distance = 0, frozen?: Snapshot) => {
    activeIntent = intent; diagnostics.endPhase(intent.queueRecord, 'queue');
    void performTurn(intent.direction!, intent.options, distance, frozen, intent.interaction, intent.queueRecord).then(result => {
      resolveIntent(intent, result);
      if (activeIntent !== intent) return;
      activeIntent = null;
      if (result.kind === 'failed' || result.kind === 'cancelled') clearIntents(result.kind, result.reason ?? result.kind);
      idle();
    });
  };
  const advanceQueue = () => {
    if (activeIntent || pointer || !queue.length) return;
    if (engine.state !== 'ready') { clearIntents('failed', 'not-ready'); return; }
    const intent = queue.shift()!; publishQueue();
    if (pendingPointer?.intent === intent) {
      const pending = pendingPointer; pendingPointer = null;
      const current = pending.pointer;
      current.snapshot = snapshot(); current.gesture.rebase(current.snapshot);
      if (diagnostics.enabled) diagnostics.markInteractionStart(current.interaction, key(), { width: current.snapshot.width, height: current.snapshot.height });
      current.latest = current.gesture.move(pending.sample);
      pointer = current; interaction = current.interaction;
      // Promotion starts a held gesture at its new origin; it has no turn yet.
      endQueueWait(intent); current.intent = intent;
      setPhase('tracking', null); stopOptional(); void prepare(null, current.snapshot);
      if (current.latest.phase === 'dragging') {
        record = diagnostics.begin({ action: 'drag', backend: 'foliate-paired-views', inputTime: current.start, interactionId: current.interaction });
        diagnostics.markAnimationStart(record, undefined, { sampleFrames: true });
        syncDrag(current);
      }
    } else runIntent(intent);
  };
  const turnPage = (next: Direction, commandOptions: TurnCommandOptions = {}, distance = 0, frozen?: Snapshot, gestureInteraction?: number | null): Promise<TurnResult> => {
    diagnostics.countInput('received');
    const immediate = admissible(); const queued = !immediate && canQueue();
    const full = queued && queue.length >= TURN_QUEUE_CAPACITY;
    if ((!immediate && !queued) || full) {
      diagnostics.countInput('rejected');
      const reason = full ? 'queue-full' : blockReason();
      if (gestureInteraction !== undefined) diagnostics.resolveInteraction(gestureInteraction, full ? 'overflow' : 'blocked', reason);
      else if (diagnostics.enabled) diagnostics.blockInteraction({ source: commandOptions.source ?? 'command', inputTime: commandOptions.inputTime, phaseAtInput: ui.phase, direction: next }, reason);
      return Promise.resolve({ kind: full ? 'queue-full' : 'blocked', reason });
    }
    diagnostics.countInput('accepted');
    const id = gestureInteraction !== undefined ? gestureInteraction : diagnostics.enabled
      ? diagnostics.beginInteraction({ source: commandOptions.source ?? 'command', inputTime: commandOptions.inputTime, phaseAtInput: ui.phase, direction: next }) : null;
    const intent = newIntent(next, commandOptions, id);
    if (immediate) runIntent(intent, distance, frozen); else enqueue(intent);
    return intent.promise;
  };
  const finish = (version: number, turnRecord: number | null) => {
    diagnostics.endPhase(turnRecord, 'busy'); diagnostics.close(turnRecord);
    if (alive(version)) { record = null; resetVisual(); diagnostics.flushUserTiming(); idle(); }
  };
  const commitNavigation = async (request: NavigationCommand, version: number, turnRecord: number | null, turnInteraction: number | null) => {
    buffer.endMotion();
    setPhase('committing'); diagnostics.startPhase(turnRecord, 'handoff');
    const origin = committed;
    // A shown preview is the only page this turn may accept: the engine
    // verifies it in the foreground after its single adjacent navigation.
    const lease = request.kind === 'turn' ? pair?.sides[request.direction]?.lease : undefined;
    const proof = lease?.prepared.target;
    let turnCommand = request;
    if (request.kind === 'turn' && lease && proof) {
      if (!origin || !samePositionKey(lease.request.key, key())) {
        // Stale preview: the foreground has not moved, so there is nothing to restore.
        diagnostics.endPhase(turnRecord, 'handoff');
        diagnostics.resolveInteraction(turnInteraction, 'failed', 'proof-stale');
        clearIntents('failed', 'proof-stale', false);
        return { kind: 'failed' as const, reason: 'proof-stale' };
      }
      turnCommand = { ...request, expectedTarget: { origin: origin.cfi, layout: origin.layout, sectionIndex: proof.sectionIndex, page: proof.page, total: proof.total, cfi: proof.cfi } };
    }
    const proven = turnCommand.kind === 'turn' && turnCommand.expectedTarget !== undefined;
    const result = await execute(turnCommand);
    if (!alive(version)) return { kind: 'cancelled' as const };
    diagnostics.endPhase(turnRecord, 'handoff');
    if (result.kind === 'verified' && (!proven || (samePositionKey(lease!.request.key, key()) && result.position.location.start?.index === proof!.sectionIndex && result.position.page === proof!.page))) {
      diagnostics.markMilestone(turnRecord, 'engineVerified');
      diagnostics.startPhase(turnRecord, 'accept');
      if (request.kind === 'turn' && activeIntent) activeIntent.committed = true;
      accept(result.position, 'navigation');
      diagnostics.markMilestone(turnRecord, 'committed'); diagnostics.countInput('committed');
      diagnostics.resolveInteraction(turnInteraction, 'committed');
      await input.onPageTurnCommitted?.();
      diagnostics.endPhase(turnRecord, 'accept');
      return { kind: 'committed' as const };
    } else {
      // After a shown preview, boundary/unavailable are proof conflicts too:
      // restore the verified origin under the cover, never a compensating turn.
      const conflict = proven && (result.kind === 'boundary' || result.kind === 'unavailable');
      const reason = result.kind === 'mismatch' ? `proof-${result.reason}` : result.kind === 'verified' ? 'proof-mismatch' : conflict ? `proof-${result.kind}` : result.kind;
      const kind = result.kind === 'cancelled' ? 'cancelled' as const : result.kind === 'boundary' && !conflict ? 'boundary' as const : 'failed' as const;
      diagnostics.resolveInteraction(turnInteraction, kind, reason);
      if (conflict || (result.kind !== 'boundary' && result.kind !== 'unavailable')) {
        clearIntents('failed', reason, false);
        setPhase('recovering'); if (origin) await restore(origin, version); else setPhase('failed');
      }
      return { kind, reason };
    }
  };
  const performTurn = async (next: Direction, commandOptions: TurnCommandOptions = {}, distance = 0, frozen?: Snapshot, gestureInteraction?: number | null, queuedRecord: number | null = null): Promise<TurnResult> => {
    const version = ++command; const ruler = frozen ?? snapshot();
    const boundary = next === 'next' ? !ruler.canNext : !ruler.canPrev;
    const turnInteraction = gestureInteraction !== undefined ? gestureInteraction : diagnostics.enabled
      ? diagnostics.beginInteraction({ source: commandOptions.source ?? 'command', inputTime: commandOptions.inputTime, phaseAtInput: ui.phase, origin: key(), viewport: { width: ruler.width, height: ruler.height } })
      : null;
    interaction = turnInteraction;
    if (diagnostics.enabled) {
      diagnostics.markInteractionStart(turnInteraction, key(), { width: ruler.width, height: ruler.height });
      diagnostics.setInteractionDirection(turnInteraction, next);
      if (!boundary) diagnostics.markInteractionReady(turnInteraction, slotState(next));
    }
    stopOptional(); setPhase('preparing', next);
    const turnRecord = queuedRecord ?? diagnostics.begin({ action: commandOptions.action ?? 'tap-' + next, backend: 'foliate-paired-views', inputTime: commandOptions.inputTime, interactionId: turnInteraction }); record = turnRecord;
    diagnostics.startPhase(turnRecord, 'busy');
    // Preparation results and WAAPI completion resolve from frame callbacks;
    // finishing resumes in a control task. Reduced motion awaits neither.
    const framed = !input.reducedMotion;
    try {
      const reduced = !boundary && !framed;
      let nextPair = !boundary && !reduced ? await prepare(next, ruler) : null;
      // A cancellation already recorded its own result; the first result wins.
      if (!alive(version) || engine.state !== 'ready') { diagnostics.resolveInteraction(turnInteraction, 'failed', 'not-ready'); return { kind: alive(version) ? 'failed' : 'cancelled', reason: 'not-ready' }; }
      // A pre-admission whose side for this direction went stale cannot animate it.
      if (nextPair && !nextPair.sides[next]) { clearPair(); nextPair = null; }
      const side = nextPair?.sides[next];
      if (turnInteraction !== null && !boundary && !nextPair) diagnostics.markFallback(turnInteraction, reduced ? 'reduced-motion' : 'prepare-unavailable');
      setPhase('settling', next);
      if (boundary) {
        if (pair) clearPair();
        if (await animate(distance, 0, PAGE_TURN_RULES.settleDurationMinMs, null) === 'cancelled') { diagnostics.resolveInteraction(turnInteraction, 'cancelled', 'motion-cancelled'); return { kind: 'cancelled', reason: 'motion-cancelled' }; }
      } else if (nextPair && side) {
        const settlePair = nextPair;
        place(settlePair, distance); diagnostics.markMilestone(turnRecord, 'neighborReady');
        const target = side.sign * ruler.width;
        // A reversal can release from the opposite side: the remaining distance may exceed one width.
        const duration = commandOptions.action === 'release' ? getSettleDuration(Math.abs(target - distance), ruler.width) : PAGE_TURN_RULES.tapDurationMs;
        if (await animate(distance, target, duration, settlePair, visibleDistance => {
          if (Math.abs(visibleDistance) < ruler.width / 2 || Math.sign(visibleDistance) !== side.sign) return false;
          // The label is a React update: the progress frame only posts it.
          postControl(() => { showPreviewPage(settlePair, next); });
          return true;
        }) === 'cancelled') { diagnostics.resolveInteraction(turnInteraction, 'cancelled', 'motion-cancelled'); return { kind: 'cancelled', reason: 'motion-cancelled' }; }
      }
      if (!alive(version) || engine.state !== 'ready') { diagnostics.resolveInteraction(turnInteraction, 'failed', 'not-ready'); return { kind: alive(version) ? 'failed' : 'cancelled', reason: 'not-ready' }; }
      if (!boundary) {
        binding?.value.holdIncoming();
        // Handoff starts in the settle's completion (inside the finishing
        // frame, motion already over, the incoming page covering): the engine's
        // first frame wait then still catches this frame; a control-task hop
        // here cost one frame per turn (S2 re-measurement). Only navigation
        // starts here; release and parking stay in control tasks. The label was
        // normally posted by the progress frame already; this fallback (frames
        // skipped) must precede acceptance, which invalidates the preview key.
        showPreviewPage(nextPair, next);
        if (input.reducedMotion) clearPair();
        return await commitNavigation({ kind: 'turn', direction: next }, version, turnRecord, turnInteraction);
      }
      return { kind: 'boundary', reason: next === 'next' ? 'at-end' : 'at-start' };
    } catch {
      if (alive(version)) {
        diagnostics.close(turnRecord, { cancelReason: 'navigation-error' }); setPhase('failed');
        diagnostics.resolveInteraction(turnInteraction, 'failed', 'navigation-error');
      }
      return { kind: alive(version) ? 'failed' : 'cancelled', reason: 'navigation-error' };
    }
    // Releasing the pair clears the label (React) and starts parking; never
    // from a settle or navigation continuation that resumed inside a frame.
    finally { if (framed) await controlTask(); finish(version, turnRecord); }
  };
  const navigateTo = async (target: string) => {
    if (!admit('navigation')) {
      if (diagnostics.enabled) diagnostics.blockInteraction({ source: 'navigation', phaseAtInput: ui.phase }, blockReason('navigation'));
      return;
    }
    const navigationInteraction = diagnostics.enabled ? diagnostics.beginInteraction({ source: 'navigation', phaseAtInput: ui.phase, origin: key() }) : null;
    interaction = navigationInteraction;
    const version = ++command; stopOptional(); clearPair();
    const turnRecord = diagnostics.begin({ action: 'navigation', backend: 'foliate-paired-views', interactionId: navigationInteraction }); record = turnRecord;
    diagnostics.startPhase(turnRecord, 'busy');
    try { await commitNavigation({ kind: 'display', target }, version, turnRecord, navigationInteraction); }
    catch { if (alive(version)) { setPhase('failed'); diagnostics.resolveInteraction(navigationInteraction, 'failed', 'navigation-error'); } }
    finally { finish(version, turnRecord); }
  };
  const applySettings = (settings: ReaderSettings): Promise<void> => {
    if (disposed) return Promise.resolve();
    requestedSettings = { ...settings };
    if (settingsWork) return settingsWork;
    settingsWork = (async () => {
      await cancel('settings');
      stopOptional(); ++appearanceGeneration; invalidateResources();
      while (requestedSettings && !disposed && !suspended && committed) {
        const requested: ReaderSettings = requestedSettings; requestedSettings = null;
        const version = ++command; setPhase('recovering', null);
        const result = await execute({ kind: 'settings', settings: requested, target: committed.cfi });
        if (!alive(version)) {
          requestedSettings ??= requested;
          if (disposed || suspended) return;
          if (recovery) await recovery;
          continue;
        }
        if (result.kind !== 'verified') { setPhase('failed'); return; }
        if (!requestedSettings) accept(result.position, 'layout-restored');
      }
      idle();
    })().catch(() => { if (!disposed && !suspended) setPhase('failed'); }).finally(() => { settingsWork = null; idle(); });
    return settingsWork;
  };
  const resume = async () => {
    if (disposed || !committed) return;
    const currentLifecycle = ++lifecycle;
    suspended = false;
    const current = () => !disposed && !suspended && lifecycle === currentLifecycle;
    const previous = resumeWork;
    const pending = (async () => {
      if (previous) await previous;
      if (!current()) return;
      if (navigation) await navigation.catch(() => undefined);
      if (!current()) return;
      if (recovery) await recovery;
      if (!current()) return;
      const version = ++command; setPhase('recovering', null);
      try { await restore(committed!, version); } catch { if (alive(version)) setPhase('failed'); }
      if (!current()) return;
      if (requestedSettings) await applySettings(requestedSettings);
    })().finally(() => { if (resumeWork === pending) { resumeWork = null; idle(); } });
    resumeWork = pending;
    return pending;
  };
  engine.onLayoutInvalidated = () => {
    viewportCache = null; void cancel('layout'); setPhase('recovering', null);
    stopOptional(); invalidateResources();
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { resizeTimer = undefined; void resume(); }, 150);
  };

  return {
    get snapshot() { return ui; }, get committed() { return committed ? copyPosition(committed) : null; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure(next: InputOptions) {
      const disable = next.disabled && !input.disabled;
      input = next;
      // Loading/error/settings UI disables gestures as well. It must not cancel
      // the very open/recovery operation that will make the reader available.
      if (disable && ['tracking', 'dragging', 'preparing', 'settling', 'committing'].includes(ui.phase)) void cancel('disabled');
    },
    async open(data: ArrayBuffer, target: string | number = 0) {
      const version = ++command; setPhase('recovering');
      const result = await execute({ kind: 'open', data, target });
      if (!alive(version)) return result;
      if (result.kind === 'verified') { accept(result.position, 'opened'); idle(); } else setPhase('failed');
      return result;
    },
    turnPage, navigateTo, cancel, applySettings, resume,
    suspend() { suspended = true; ++lifecycle; void cancel('background'); stopOptional(); invalidateResources(); clearTimeout(resizeTimer); resizeTimer = undefined; engine.suspend(); setPhase('suspended', null); },
    capture() {
      if (!committed || disposed) return false;
      if (capturedRevision !== revision) { capturedRevision = revision; options.onAccepted?.({ reason: 'snapshot', position: copyPosition(committed), revision }); }
      return true;
    },
    pointerDown(id: number, sample: GestureInput, details?: { pointerType?: string }) {
      const immediate = admissible();
      const waiting = !immediate && !pointer && !pendingPointer && canQueue() && viewportCache !== null;
      if ((!immediate && !waiting) || (waiting && queue.length >= TURN_QUEUE_CAPACITY)) {
        if (diagnostics.enabled) diagnostics.blockInteraction({ source: 'pointer', pointerType: details?.pointerType, inputTime: sample.time, phaseAtInput: ui.phase }, waiting ? 'queue-full' : blockReason());
        return false;
      }
      // No transformed geometry or old-origin boundary decisions while waiting.
      const ruler = waiting ? { ...viewportCache!, canPrev: true, canNext: true } : snapshot();
      const gesture = createPageTurnEngine(ruler); gesture.begin(sample);
      const gestureInteraction = diagnostics.enabled
        ? diagnostics.beginInteraction({ source: 'pointer', pointerType: details?.pointerType, inputTime: sample.time, phaseAtInput: ui.phase, origin: key(), viewport: { width: ruler.width, height: ruler.height } })
        : null;
      const current = { id, snapshot: ruler, gesture, latest: null, visual: 0, start: sample.time, interaction: gestureInteraction };
      if (waiting) {
        const intent = newIntent(null, { source: 'tap', inputTime: sample.time }, gestureInteraction);
        pendingPointer = { pointer: current, intent, sample };
        enqueue(intent); return true;
      }
      pointer = current;
      interaction = gestureInteraction;
      stopOptional(); setPhase('tracking', null);
      // A discrete event: admit the neighbors that are ready now while the page
      // is still stationary, so a warm lock or reversal only moves transforms.
      void prepare(null, ruler);
      return true;
    },
    pointerMove(id: number, sample: GestureInput) {
      if (pendingPointer?.pointer.id === id) {
        const pending = pendingPointer; pending.sample = sample;
        const motion = pending.pointer.gesture.move(sample); pending.pointer.latest = motion;
        if (motion.phase === 'cancelled') { cancelPendingPointer('vertical'); return false; }
        return motion.phase === 'dragging';
      }
      const current = pointer; if (!current || current.id !== id) return false;
      const previous = current.latest;
      const motion = current.gesture.move(sample); current.latest = motion;
      if (motion.phase === 'cancelled') { void cancel('vertical'); return false; }
      if (motion.phase !== 'dragging') return false;
      if (record === null) { record = diagnostics.begin({ action: 'drag', backend: 'foliate-paired-views', inputTime: sample.time, interactionId: current.interaction }); diagnostics.markAnimationStart(record, undefined, { sampleFrames: true }); }
      const retarget = previous?.phase !== 'dragging' || previous.direction !== motion.direction || previous.boundary !== motion.boundary;
      if (retarget && previous?.direction !== motion.direction) diagnostics.setInteractionDirection(current.interaction, motion.direction);
      // Chromium dispatches coalesced pointermoves inside the rendering frame:
      // only record the sample here. A target the binding already covers needs
      // only its frame, even across a warm reversal; direction lock, reversal
      // and boundary changes still reconcile (phase, preparation) from a
      // control task, never a frame.
      if (covers(motion)) scheduleDragFrame(current);
      if (retarget) postControl(() => { syncDrag(current); });
      return true;
    },
    pointerUp(id: number, sample: GestureInput) {
      if (pendingPointer?.pointer.id === id) {
        const pending = pendingPointer; pendingPointer = null;
        const result = pending.pointer.gesture.release(sample); input.onReleasePointer?.(id);
        const zone = result.kind === 'tap' ? getTapZone(sample.x, pending.pointer.snapshot.left, pending.pointer.snapshot.width) : null;
        const next = result.kind === 'commit' ? result.direction : zone && zone !== 'center' ? zone : null;
        if (next) {
          pending.intent.direction = next; pending.intent.options.action = result.kind === 'commit' ? 'release' : 'tap-' + next;
          diagnostics.setInteractionDirection(pending.intent.interaction, next);
          diagnostics.countInput('received'); diagnostics.countInput('accepted');
        } else {
          const index = queue.indexOf(pending.intent); if (index !== -1) queue.splice(index, 1);
          resolveIntent(pending.intent, { kind: result.kind === 'rebound' ? 'rebound' : 'no-turn', reason: zone === 'center' ? 'center' : 'hold' }); publishQueue();
        }
        return pending.intent.promise;
      }
      const current = pointer; if (!current || current.id !== id) return;
      const result = current.gesture.release(sample); pointer = null;
      if (frame !== null) cancelAnimationFrame(frame); frame = null; input.onReleasePointer?.(id);
      diagnostics.endPhase(record, 'motion'); diagnostics.endPhase(record, 'drag'); diagnostics.close(record); record = null;
      const releaseTurn = (next: Direction, commandOptions: TurnCommandOptions, distance = 0) => {
        diagnostics.countInput('received'); diagnostics.countInput('accepted');
        const intent = current.intent ?? newIntent(next, commandOptions, current.interaction);
        intent.direction = next; intent.options = commandOptions;
        runIntent(intent, distance, current.snapshot); return intent.promise;
      };
      const noTurn = (kind: 'no-turn' | 'rebound', reason?: string) => {
        if (current.intent) resolveIntent(current.intent, { kind, reason });
        else diagnostics.resolveInteraction(current.interaction, kind, reason);
      };
      if (result.kind === 'tap') {
        // Only a tap zone turn consumes the pre-admission; any other tap
        // releases it before idle so no motion lock survives.
        if (!queue.length && !current.intent) setPhase('idle', null);
        if (!current.intent && !queue.length && input.onTap?.({ clientX: sample.x, clientY: sample.y })) { clearPair(); noTurn('no-turn', 'image'); idle(); return; }
        const zone = getTapZone(sample.x, current.snapshot.left, current.snapshot.width);
        if (zone === 'center') { clearPair(); noTurn('no-turn', 'center'); idle(); if (!current.intent) input.onCenterTap?.(); }
        else return releaseTurn(zone, { inputTime: current.start });
      } else if (result.kind === 'commit') {
        // A bound side settles from the rendered distance, even from the
        // opposite side after a velocity-led reversal: every neighbor moves.
        const sign = sideSign(result.direction, current.snapshot.direction === 'rtl');
        const bound = Boolean(pair?.sides[result.direction] && binding?.pair === pair);
        const distance = bound || (Math.sign(current.visual) === sign && !pair) ? current.visual : 0;
        return releaseTurn(result.direction, { action: 'release', inputTime: current.start }, distance);
      } else if (result.kind === 'rebound') {
        if (current.intent) activeIntent = current.intent;
        const version = ++command; setPhase('settling', result.direction);
        diagnostics.setInteractionDirection(current.interaction, result.direction);
        record = diagnostics.begin({ action: 'rebound', backend: 'foliate-paired-views', inputTime: sample.time, interactionId: current.interaction }); const reboundRecord = record;
        diagnostics.startPhase(record, 'busy');
        const prepared = pair && binding?.pair === pair ? pair : null; if (!prepared && pair) clearPair();
        void animate(current.visual, 0, getSettleDuration(Math.abs(current.visual), current.snapshot.width), prepared).finally(async () => {
          // The settle ends inside a frame; release and resume from a control task.
          await controlTask();
          finish(version, reboundRecord);
          // Resolve a reservation only after stationary cleanup. A lifecycle
          // cancellation that already completed it keeps its first result.
          noTurn('rebound');
          if (current.intent && activeIntent === current.intent) { activeIntent = null; idle(); }
        });
      } else { resetVisual(); noTurn('no-turn', 'hold'); idle(); }
      return current.intent?.promise;
    },
    /** Cancels only the tracked gesture; another pointer's cancellation never touches a running turn. */
    pointerCancel(id: number, reason = 'pointercancel') {
      if (pendingPointer?.pointer.id === id) { cancelPendingPointer(reason); return Promise.resolve(); }
      if (pointer?.id !== id) return Promise.resolve();
      return cancel(reason);
    },
    destroy() {
      if (disposed) return;
      if (pointer?.intent) resolveIntent(pointer.intent, { kind: 'cancelled', reason: 'destroy' });
      clearIntents('cancelled', 'destroy'); disposed = true; ++command; ++lifecycle; clearTimeout(resizeTimer); resizeTimer = undefined; resetVisual();
      stopOptional(); buffer.invalidate();
      engine.onLayoutInvalidated = undefined; diagnostics.destroy(); listeners.clear();
    },
  };
}
export type ReaderController = ReturnType<typeof createReaderController>;

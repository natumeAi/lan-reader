import type { ReaderSession, StablePosition, NavigationCommand, NavigationResult } from './types';
import type { PositionKey, SurfaceLease } from './bufferTypes';
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
  onReleasePointer?: () => void;
  onPageTurnCommitted?: () => Promise<void>;
}
interface Snapshot extends GestureSnapshot { left: number; height: number }
interface Pair { direction: Direction; width: number; sign: -1 | 1; element: HTMLElement | null; ready: Promise<Pair | null>; lease?: SurfaceLease }
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
  let ui: { phase: ReaderPhase; direction: Direction | null } = { phase: 'idle', direction: null };
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
  let pointer: { id: number; snapshot: Snapshot; gesture: ReturnType<typeof createPageTurnEngine>; latest: GestureMoveResult | null; visual: number; start: number; boundaryPending?: boolean; catchUp?: { from: number; startTime: number | null } } | null = null;
  const setPhase = (phase: ReaderPhase, direction: Direction | null = ui.direction) => {
    if (ui.phase === phase && ui.direction === direction) return;
    ui = { phase, direction }; for (const listener of listeners) listener();
  };
  const alive = (version: number) => !disposed && !suspended && version === command;
  const snapshot = (): Snapshot => {
    const location = committed?.location ?? engine.currentLocation();
    const rect = foreground.getBoundingClientRect();
    return { width: foreground.clientWidth, height: foreground.clientHeight, left: rect.left, direction: engine.direction ?? 'ltr', canPrev: !location?.atStart, canNext: !location?.atEnd };
  };
  const key = (): PositionKey => ({ sessionId, positionRevision: revision, layoutGeneration, appearanceGeneration });
  const stopOptional = () => { session.setOptionalWorkAllowed(false); buffer.stopWarm(); pagination.pause(); };
  const clearPair = () => {
    const previous = pair; pair = null; renderer.release(); binding = null;
    if (pointer) pointer.catchUp = undefined;
    if (displayingPreview) { displayingPreview = false; options.onPageDisplayed?.(null); }
    buffer.endMotion(); previous?.lease?.release();
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
  const invalidateResources = () => {
    ++layoutGeneration; ++optionalEpoch; quiet = null; motionReady = false;
    buffer.invalidate(); pagination.invalidate();
  };
  const resetVisual = () => {
    if (frame !== null) cancelAnimationFrame(frame); frame = null;
    pointer?.gesture.cancel(); pointer = null; input.onReleasePointer?.(); clearPair();
  };
  const idle = () => {
    if (!disposed && !suspended && !navigation && !recovery && !settingsWork && !resumeWork && resizeTimer === undefined && ui.phase !== 'failed') {
      setPhase('idle', null); session.setOptionalWorkAllowed(true);
      if (committed) {
        const viewport = { width: foreground.clientWidth, height: foreground.clientHeight };
        const requests = (['next', 'prev'] as const).filter(direction => direction === 'next' ? !committed!.location.atEnd : !committed!.location.atStart)
          .map(direction => session.createRequest(committed!, key(), direction, viewport));
        buffer.warm(requests);
      }
      pagination.request();
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
    // Repeated cancellation shares the same rollback. Only a lifecycle stop
    // invalidates a recovery that is already restoring the committed origin.
    if (!recovery || suspended || disposed) ++command;
    diagnostics.cancel(record, reason); record = null;
    resetVisual();
    if (navigation) return recover(navigation, committed);
    if (!recovery) idle();
    return recovery ?? Promise.resolve();
  };
  const bind = (nextPair: Pair | null) => {
    if (binding?.pair === nextPair) return binding.value;
    const value = renderer.bind({ current: foreground, incoming: nextPair?.element, width: nextPair?.width ?? 0, sign: nextPair?.sign ?? 1 });
    binding = { pair: nextPair, value }; return value;
  };
  const update = (nextPair: Pair | null, distance: number) => {
    if (!motionReady || !buffer.beginMotion()) return false;
    bind(nextPair).update(distance); diagnostics.markVisualUpdate(record);
    diagnostics.startPhase(record, 'motion');
    return true;
  };
  const scheduleDragFrame = (current: NonNullable<typeof pointer>) => {
    if (frame !== null) return;
    frame = requestAnimationFrame(time => {
      frame = null; if (pointer !== current || disposed || suspended) return;
      const latest = current.latest; if (!latest?.direction) return;
      if (latest.boundary) {
        if (pair) clearPair();
        if (!current.boundaryPending) {
          current.boundaryPending = true;
          void ensureMotion().then(drained => {
            current.boundaryPending = false;
            if (!drained || pointer !== current || !current.latest?.boundary) return;
            const distance = current.latest.visualDistance;
            if (update(null, distance)) current.visual = distance;
          });
        }
        return;
      }
      if (!pair?.element || pair.direction !== latest.direction) return;
      let distance = latest.visualDistance;
      if (current.catchUp) {
        current.catchUp.startTime ??= time;
        const progress = Math.min(1, Math.max(0, (time - current.catchUp.startTime) / PAGE_TURN_RULES.dragCatchUpDurationMs));
        distance = current.catchUp.from + (distance - current.catchUp.from) * easeOutCubic(progress);
        if (progress === 1) current.catchUp = undefined;
      }
      if (update(pair, distance)) current.visual = distance;
      // A held finger emits no more pointermoves. Finish a late preview's short
      // catch-up on real frames, always following the latest input position.
      if (current.catchUp) scheduleDragFrame(current);
    });
  };
  const prepare = (next: Direction, ruler: Snapshot) => {
    if (pair?.direction === next) return pair.ready;
    clearPair(); stopOptional();
    if (pointer) pointer.visual = 0;
    const nextPair: Pair = { direction: next, width: ruler.width, sign: (next === 'next') !== (ruler.direction === 'rtl') ? -1 : 1, element: null, ready: Promise.resolve(null) };
    pair = nextPair;
    const prepareRecord = record;
    diagnostics.startPhase(prepareRecord, 'prepare');
    const origin = committed;
    if (!origin) return nextPair.ready;
    const request = session.createRequest(origin, key(), next, { width: ruler.width, height: ruler.height });
    const wasReady = buffer.snapshot()[next === 'next' ? 'next' : 'previous'].state === 'ready';
    const started = performance.now();
    nextPair.ready = (async () => {
      if (!await bounded(buffer.prepare(request))) return null;
      if (disposed || suspended || pair !== nextPair || !samePositionKey(request.key, key())) return null;
      if (!await ensureMotion()) return null;
      if (disposed || suspended || pair !== nextPair || engine.state !== 'ready' || !samePositionKey(request.key, key())) return null;
      const lease = buffer.acquire(request); if (!lease) return null;
      nextPair.lease = lease; nextPair.element = lease.prepared.element;
      const current = pointer;
      const latest = current?.latest;
      if (current && latest?.phase === 'dragging' && latest.direction === next && !latest.boundary) {
        // Cached pages follow input directly. Only a cold preview (or a slow
        // resource-drain barrier) bridges the missing motion instead of jumping.
        if (!input.reducedMotion && (!wasReady || performance.now() - started > 32)) {
          current.catchUp = { from: current.visual, startTime: null };
        }
        update(nextPair, current.visual);
        scheduleDragFrame(current);
      } else update(nextPair, 0);
      diagnostics.markMilestone(record, 'neighborReady');
      return nextPair;
    })().catch(() => null).finally(() => diagnostics.endPhase(prepareRecord, 'prepare'));
    return nextPair.ready;
  };
  const showPreviewPage = (nextPair: Pair | null) => {
    const lease = nextPair?.lease;
    if (!lease || pair !== nextPair || !samePositionKey(lease.request.key, key())) return false;
    if (!displayingPreview) {
      const { sectionIndex, page, total, cfi } = lease.prepared.target;
      displayingPreview = true;
      options.onPageDisplayed?.({ start: { index: sectionIndex, cfi, displayed: { page, total } } });
    }
    return true;
  };
  const animate = async (from: number, to: number, duration: number, nextPair: Pair | null, onProgress?: (distance: number) => boolean) => {
    if (input.reducedMotion) return 'finished' as const;
    const version = command; const epoch = optionalEpoch;
    if (!motionReady && !await ensureMotion()) return 'cancelled' as const;
    if (!alive(version) || epoch !== optionalEpoch || (nextPair && pair !== nextPair)) return 'cancelled' as const;
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
        diagnostics.markAnimationStart(animationRecord, undefined, { sampleFrames: true });
      });
      if (onProgress) reportProgress();
      return await completion;
    } finally {
      if (progressFrame !== null) cancelAnimationFrame(progressFrame);
      diagnostics.endPhase(animationRecord, 'motion');
    }
  };
  // Panels disable gestures, but may themselves request programmatic navigation.
  // Both paths still require a ready, idle session with no outstanding work.
  const admissible = (source: 'gesture' | 'navigation' = 'gesture') => !disposed && !suspended && (source === 'navigation' || !input.disabled) && !pointer && !navigation && !recovery && !settingsWork && !resumeWork && resizeTimer === undefined && ui.phase === 'idle' && engine.state === 'ready';
  const admit = (source: 'gesture' | 'navigation' = 'gesture') => {
    diagnostics.countInput('received');
    if (!admissible(source)) { diagnostics.countInput('rejected'); return false; }
    diagnostics.countInput('accepted'); return true;
  };
  const finish = (version: number, turnRecord: number | null) => {
    diagnostics.endPhase(turnRecord, 'busy'); diagnostics.finish(turnRecord);
    if (alive(version)) { record = null; resetVisual(); idle(); }
  };
  const commitNavigation = async (request: NavigationCommand, version: number, turnRecord: number | null) => {
    buffer.endMotion();
    setPhase('committing'); diagnostics.startPhase(turnRecord, 'handoff');
    const origin = committed;
    const result = await execute(request);
    if (!alive(version)) return;
    diagnostics.endPhase(turnRecord, 'handoff');
    const proof = pair?.lease?.prepared.target;
    if (result.kind === 'verified' && (request.kind !== 'turn' || !proof || (samePositionKey(pair!.lease!.request.key, key()) && result.position.location.start?.index === proof.sectionIndex && result.position.page === proof.page))) {
      diagnostics.markMilestone(turnRecord, 'engineVerified');
      accept(result.position, 'navigation');
      diagnostics.markMilestone(turnRecord, 'committed'); diagnostics.countInput('committed');
      await input.onPageTurnCommitted?.();
    } else if (result.kind !== 'boundary' && result.kind !== 'unavailable') {
      setPhase('recovering'); if (origin) await restore(origin, version); else setPhase('failed');
    }
  };
  const turnPage = async (next: Direction, commandOptions: { action?: string; inputTime?: number } = {}, distance = 0, frozen?: Snapshot) => {
    if (!admit()) return;
    const version = ++command; const ruler = frozen ?? snapshot();
    stopOptional(); setPhase('preparing', next);
    const turnRecord = diagnostics.begin({ action: commandOptions.action ?? 'tap-' + next, backend: 'foliate-paired-views', inputTime: commandOptions.inputTime }); record = turnRecord;
    diagnostics.startPhase(turnRecord, 'busy');
    try {
      const boundary = next === 'next' ? !ruler.canNext : !ruler.canPrev;
      const nextPair = !boundary && !input.reducedMotion ? await prepare(next, ruler) : null;
      if (!alive(version) || engine.state !== 'ready') return;
      setPhase('settling', next);
      if (boundary) {
        if (pair) clearPair();
        if (await animate(distance, 0, PAGE_TURN_RULES.settleDurationMinMs, null) === 'cancelled') return;
      } else if (nextPair) {
        update(nextPair, distance); diagnostics.markMilestone(turnRecord, 'neighborReady');
        const duration = commandOptions.action === 'release' ? getSettleDuration(ruler.width - Math.abs(distance), ruler.width) : PAGE_TURN_RULES.tapDurationMs;
        if (await animate(distance, nextPair.sign * ruler.width, duration, nextPair, visibleDistance => (
          Math.abs(visibleDistance) >= ruler.width / 2 && showPreviewPage(nextPair)
        )) === 'cancelled') return;
      }
      if (!alive(version) || engine.state !== 'ready') return;
      if (!boundary) {
        binding?.value.holdIncoming();
        // Completion is also a fallback when the browser skips frame callbacks.
        showPreviewPage(nextPair);
        if (input.reducedMotion) clearPair();
        await commitNavigation({ kind: 'turn', direction: next }, version, turnRecord);
      }
    } catch { if (alive(version)) { diagnostics.cancel(turnRecord, 'navigation-error'); setPhase('failed'); } }
    finally { finish(version, turnRecord); }
  };
  const navigateTo = async (target: string) => {
    if (!admit('navigation')) return;
    const version = ++command; stopOptional(); clearPair();
    const turnRecord = diagnostics.begin({ action: 'navigation', backend: 'foliate-paired-views' }); record = turnRecord;
    diagnostics.startPhase(turnRecord, 'busy');
    try { await commitNavigation({ kind: 'display', target }, version, turnRecord); }
    catch { if (alive(version)) setPhase('failed'); }
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
    void cancel('layout'); setPhase('recovering', null);
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
    pointerDown(id: number, sample: GestureInput) {
      if (!admissible()) return false;
      const ruler = snapshot(); const gesture = createPageTurnEngine(ruler); gesture.begin(sample);
      pointer = { id, snapshot: ruler, gesture, latest: null, visual: 0, start: sample.time };
      stopOptional(); setPhase('tracking', null); return true;
    },
    pointerMove(id: number, sample: GestureInput) {
      const current = pointer; if (!current || current.id !== id) return false;
      const motion = current.gesture.move(sample); current.latest = motion;
      if (motion.phase === 'cancelled') { void cancel('vertical'); return false; }
      if (motion.phase !== 'dragging') return false;
      if (record === null) { record = diagnostics.begin({ action: 'drag', backend: 'foliate-paired-views', inputTime: sample.time }); diagnostics.markAnimationStart(record, undefined, { sampleFrames: true }); }
      setPhase('dragging', motion.direction);
      // Start loading on direction lock; waiting for rAF first adds latency
      // before any of the real document/font/frame work can even begin.
      if (!motion.boundary && motion.direction) void prepare(motion.direction, current.snapshot);
      else current.catchUp = undefined;
      scheduleDragFrame(current);
      return true;
    },
    pointerUp(id: number, sample: GestureInput) {
      const current = pointer; if (!current || current.id !== id) return;
      const result = current.gesture.release(sample); pointer = null;
      if (frame !== null) cancelAnimationFrame(frame); frame = null; input.onReleasePointer?.();
      diagnostics.endPhase(record, 'motion'); diagnostics.finish(record); record = null;
      setPhase('idle', null);
      if (result.kind === 'tap') {
        idle();
        if (input.onTap?.({ clientX: sample.x, clientY: sample.y })) return;
        const zone = getTapZone(sample.x, current.snapshot.left, current.snapshot.width);
        if (zone === 'center') input.onCenterTap?.(); else void turnPage(zone, { inputTime: current.start }, 0, current.snapshot);
      } else if (result.kind === 'commit') {
        const sign = (result.direction === 'next') !== (current.snapshot.direction === 'rtl') ? -1 : 1;
        const distance = Math.sign(current.visual) === sign && (!pair || pair.direction === result.direction) ? current.visual : 0;
        void turnPage(result.direction, { action: 'release', inputTime: sample.time }, distance, current.snapshot);
      } else if (result.kind === 'rebound') {
        const version = ++command; setPhase('settling', result.direction);
        record = diagnostics.begin({ action: 'rebound', backend: 'foliate-paired-views', inputTime: sample.time }); const reboundRecord = record;
        diagnostics.startPhase(record, 'busy');
        const prepared = pair?.element ? pair : null; if (!prepared && pair) clearPair();
        void animate(current.visual, 0, getSettleDuration(Math.abs(current.visual), current.snapshot.width), prepared).finally(() => finish(version, reboundRecord));
      } else { resetVisual(); idle(); }
    },
    destroy() {
      if (disposed) return;
      disposed = true; ++command; ++lifecycle; clearTimeout(resizeTimer); resizeTimer = undefined; resetVisual();
      stopOptional(); buffer.invalidate();
      engine.onLayoutInvalidated = undefined; diagnostics.destroy(); listeners.clear();
    },
  };
}
export type ReaderController = ReturnType<typeof createReaderController>;

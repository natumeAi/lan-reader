export interface DebugConfig { enabled: boolean; forceBackend: 'scroll' | 'compositor' | null }
type FrameSampleSource = 'animation-frame' | 'visual-update';
/** Application work spans, never compositor presentation. 'queue' is reserved for the planned input FIFO. */
export type TurnPhase = 'prepare' | 'drain' | 'drag' | 'catch-up' | 'motion' | 'settle' | 'handoff' | 'accept' | 'busy' | 'queue';
type TurnMilestone = 'neighborReady' | 'previewLabel' | 'engineVerified' | 'committed';
type InputOutcome = 'received' | 'accepted' | 'rejected' | 'committed';
type Direction = 'next' | 'prev';
export type InteractionSource = 'pointer' | 'keyboard' | 'tap' | 'command' | 'navigation';
/** 'queued' and 'overflow' are reserved for the planned input FIFO and are never recorded yet. */
export type InteractionResult = 'committed' | 'boundary' | 'rebound' | 'cancelled' | 'failed' | 'blocked' | 'no-turn' | 'queued' | 'overflow';
type StartedResult = Exclude<InteractionResult, 'blocked' | 'queued' | 'overflow'>;
export type InteractionFallback = 'reduced-motion' | 'prepare-unavailable';
type PreparationOutcome = 'ready' | 'unavailable' | 'stale';
interface OriginKey { positionRevision: number; layoutGeneration: number; appearanceGeneration: number }
interface PhaseSpan { phase: TurnPhase; start: number; end: number | null }
interface DiagnosticRecord {
  id: number; interactionId: number | null;
  action: string | null; backend: string | null; inputTime: number;
  firstVisualTime: number | null; animationStartTime: number | null; endTime: number | null;
  frameTimestamps: number[]; omittedFrameSamples: number; cancelReason: string | null; samplerFrameId: number | null;
  frameSampleSource: FrameSampleSource | 'mixed' | null;
  phases: PhaseSpan[]; omittedPhaseSpans: number;
  /** Starts dropped at the span cap and not yet ended, so their end cannot close an older span. */
  omittedOpenPhases: Partial<Record<TurnPhase, number>>;
  milestones: Partial<Record<TurnMilestone, number>>;
  summary: ReturnType<typeof summarizePageTurnFrames> | null;
}
interface Preparation { direction: Direction; slotAtStart: string; outcome: PreparationOutcome | null; catchUp: boolean; start: number; end: number | null }
interface Interaction {
  id: number; source: InteractionSource; pointerType: string | null;
  /** Raw pointerdown/keydown/command timestamp; never reset by later records. */
  inputTime: number; phaseAtInput: string; direction: Direction | null;
  /** Buffer slot state of the required direction: first drag direction lock, else turn entry (a tap's direction is known only at pointerup). */
  readyAtInput: string | null; readyAtStart: string | null;
  preparations: Preparation[]; omittedPreparations: number;
  fallback: InteractionFallback | null;
  origin: OriginKey | null; viewport: { width: number; height: number } | null;
  queueDepth: number;
  result: InteractionResult | null; reason: string | null; resultTime: number | null;
  records: number[];
}
export interface InteractionInput {
  source: InteractionSource; phaseAtInput: string; pointerType?: string | null; inputTime?: number;
  direction?: Direction | null; origin?: OriginKey | null; viewport?: { width: number; height: number } | null;
}
interface InteractionState { entry: Interaction; open: number; linked: DiagnosticRecord[] }
type UserTiming = Pick<Performance, 'measure' | 'clearMeasures'>;
interface DiagnosticsEnvironment {
  cancelAnimationFrame?: typeof cancelAnimationFrame; enabled?: boolean;
  now?: () => number; requestAnimationFrame?: typeof requestAnimationFrame;
  target?: object | null; userTiming?: UserTiming | null;
}
export const PAGE_TURN_DEBUG_STORAGE_KEY = 'epub-reader:page-turn-debug';
export const PAGE_TURN_DIAGNOSTIC_LIMITS = Object.freeze({
  records: 200, interactions: 1000, frameSamplesPerRecord: 2048, preparationsPerInteraction: 16, phaseSpansPerRecord: 256,
});
// Distinguishes controllers (and reopened books) in one page; allocated only when enabled.
let nextDiagnosticsInstance = 0;

const DIAGNOSTICS_FACADE_NAME = '__EPUB_READER_PAGE_TURN_DIAGNOSTICS__';
const TARGET_REFRESH_RATE_HZ = 120;
// Accommodate sub-millisecond scheduler jitter without hiding a missed 120 Hz
// interval. This is an explicit comparison target, not a detected display rate.
const FRAME_BUDGET_TOLERANCE_MS = 0.5;

function roundToTwo(value: number) {
  return Math.round(value * 100) / 100;
}

function readTimestamp(now: () => number, value?: number | null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  try {
    const current = now();
    return Number.isFinite(current) ? current : 0;
  } catch {
    return 0;
  }
}

/**
 * User Timing name of the nth span (1-based) of `phase` in a record of one
 * diagnostics instance; trace clocks align by these names. Interaction and
 * record ids restart per instance, so the instance prefix keeps a reopened
 * book in the same page from reusing names.
 */
export function pageTurnMeasureName(instanceId: number, interactionId: number, recordId: number, phase: TurnPhase, occurrence = 1) {
  return `lr:s${instanceId}:i${interactionId}:r${recordId}:${phase}${occurrence > 1 ? `#${occurrence}` : ''}`;
}

const emptyInteractionCounts = () => ({
  received: 0, started: 0, blocked: 0, queued: 0, overflow: 0,
  committed: 0, boundary: 0, rebound: 0, cancelled: 0, failed: 0, 'no-turn': 0, fallback: 0,
});

// Percentiles are computed on export, never while a record is still sampling motion.
function exportRecord(record: DiagnosticRecord) {
  const { samplerFrameId, summary: cachedSummary, omittedOpenPhases, ...terminalRecord } = record;
  void samplerFrameId; void cachedSummary; void omittedOpenPhases; // Internal handles do not belong in debug records.
  const summary = record.summary ??= summarizePageTurnFrames(record);
  return {
    ...terminalRecord,
    ...summary,
    firstVisualMeasurement: 'application-style-or-animation-write' as const,
    truncated: record.omittedFrameSamples > 0,
    phases: record.phases.map(span => ({ ...span })),
    milestones: { ...record.milestones },
    frameTimestamps: [...record.frameTimestamps],
    frameIntervalsMs: [...summary.frameIntervalsMs],
  };
}
export type PageTurnRecord = ReturnType<typeof exportRecord>;

function copyInteraction({ entry }: InteractionState) {
  return {
    ...entry,
    preparations: entry.preparations.map(item => ({ ...item })),
    origin: entry.origin && { ...entry.origin },
    viewport: entry.viewport && { ...entry.viewport },
    records: [...entry.records],
  };
}
export type PageTurnInteraction = ReturnType<typeof copyInteraction>;

export function readPageTurnDebugConfig(storage?: Pick<Storage, 'getItem'> | null): DebugConfig {
  try {
    const source = storage === undefined ? globalThis.sessionStorage : storage;
    const parsed: unknown = JSON.parse(source?.getItem(PAGE_TURN_DEBUG_STORAGE_KEY) || 'null');
    const config = parsed && typeof parsed === 'object' ? parsed : {};
    const backend = 'forceBackend' in config ? config.forceBackend : null;
    const forceBackend = backend === 'scroll' || backend === 'compositor' ? backend : null;

    return {
      enabled: 'enabled' in config && config.enabled === true,
      forceBackend,
    };
  } catch {
    return { enabled: false, forceBackend: null };
  }
}

export function summarizePageTurnFrames(record: Partial<Pick<DiagnosticRecord, 'inputTime' | 'firstVisualTime' | 'frameSampleSource'>> & { frameTimestamps?: readonly number[] } = {}) {
  const frameTimestamps = Array.isArray(record.frameTimestamps)
    ? record.frameTimestamps
    : [];
  const intervals = [];

  for (let index = 1; index < frameTimestamps.length; index += 1) {
    const previous = frameTimestamps[index - 1]!;
    const current = frameTimestamps[index]!;
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;

    const interval = current - previous;
    if (interval >= 0) intervals.push(interval);
  }

  const elapsed = intervals.reduce((total, interval) => total + interval, 0);
  const sortedIntervals = [...intervals].sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedIntervals.length * 0.95) - 1);
  let consecutiveOver33_4Ms = 0;
  let maxConsecutiveFramesOver33_4Ms = 0;

  for (const interval of intervals) {
    if (interval > 33.4) {
      consecutiveOver33_4Ms += 1;
      maxConsecutiveFramesOver33_4Ms = Math.max(
        maxConsecutiveFramesOver33_4Ms,
        consecutiveOver33_4Ms,
      );
    } else {
      consecutiveOver33_4Ms = 0;
    }
  }

  const hasInputLatency = Number.isFinite(record.inputTime)
    && Number.isFinite(record.firstVisualTime);

  return {
    // Retain averageFps for existing consumers, but label what it measures:
    // rAF/visual-update callbacks cannot measure compositor presentation.
    frameRateMeasurement: 'main-thread-sample-cadence' as const,
    frameSampleSource: record.frameSampleSource ?? 'unspecified' as const,
    frameSampleCount: frameTimestamps.filter(Number.isFinite).length,
    frameIntervalCount: intervals.length,
    maxFrameIntervalMs: sortedIntervals.length > 0
      ? roundToTwo(sortedIntervals[sortedIntervals.length - 1]!)
      : 0,
    targetRefreshRateHz: TARGET_REFRESH_RATE_HZ,
    targetFrameIntervalMs: roundToTwo(1000 / TARGET_REFRESH_RATE_HZ),
    frameBudgetToleranceMs: FRAME_BUDGET_TOLERANCE_MS,
    intervalsOverTargetBudget: intervals.filter((interval) => (
      interval > 1000 / TARGET_REFRESH_RATE_HZ + FRAME_BUDGET_TOLERANCE_MS
    )).length,
    averageFps: elapsed > 0 ? roundToTwo((intervals.length * 1000) / elapsed) : 0,
    inputLatencyMs: hasInputLatency
      ? roundToTwo(record.firstVisualTime! - record.inputTime!)
      : null,
    frameIntervalsMs: intervals.map(roundToTwo),
    p95FrameIntervalMs: sortedIntervals.length > 0
      ? roundToTwo(sortedIntervals[p95Index]!)
      : 0,
    framesOver20Ms: intervals.filter((interval) => interval > 20).length,
    maxConsecutiveFramesOver33_4Ms,
  };
}

export function createPageTurnDiagnostics({
  cancelAnimationFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  enabled = false,
  now = () => globalThis.performance?.now?.() ?? 0,
  requestAnimationFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  target = globalThis.window,
  userTiming = globalThis.performance,
}: DiagnosticsEnvironment = {}) {
  const activeRecords = new Map<number, DiagnosticRecord>();
  const completedRecords: DiagnosticRecord[] = [];
  const interactions = new Map<number, InteractionState>();
  // Counts logical turnPage commands, not pointermove events or drag previews.
  const inputCounts = { received: 0, accepted: 0, rejected: 0, committed: 0 };
  // Logical inputs: received = started + blocked; each started input gets at most one result.
  const interactionCounts = emptyInteractionCounts();
  const omitted = { records: 0, interactions: 0 };
  const timing = enabled && typeof userTiming?.measure === 'function' && typeof userTiming.clearMeasures === 'function' ? userTiming : null;
  const instance = enabled ? ++nextDiagnosticsInstance : 0;
  const userTimingStatus: 'available' | 'unavailable' = timing ? 'available' : 'unavailable';
  let destroyed = false;
  let nextRecordId = 1;
  let nextInteractionId = 1;
  let facade: object | null = null;

  function getActiveRecord(recordId: number | null | undefined) {
    if (!enabled || destroyed) return null;
    return recordId == null ? null : activeRecords.get(recordId) || null;
  }
  function getInteraction(interactionId: number | null | undefined) {
    if (!enabled || destroyed || interactionId == null) return null;
    return interactions.get(interactionId) ?? null;
  }

  function stopSampler(record: DiagnosticRecord) {
    if (record.samplerFrameId === null) return;

    try {
      cancelAnimationFrame?.(record.samplerFrameId);
    } catch {
      // Debug sampling must not affect reader behavior.
    }
    record.samplerFrameId = null;
  }

  function scheduleSample(recordId: number, record: DiagnosticRecord) {
    if (record.samplerFrameId !== null || typeof requestAnimationFrame !== 'function') return;

    try {
      record.samplerFrameId = requestAnimationFrame((timestamp) => {
        if (activeRecords.get(recordId) !== record || destroyed) return;

        record.samplerFrameId = null;
        frame(recordId, timestamp);
        scheduleSample(recordId!, record);
      });
    } catch {
      record.samplerFrameId = null;
    }
  }

  // Called only after an interaction's result and its last linked record close,
  // so it never runs inside motion. Each measure is cleared once the trace has it.
  function emitUserTiming(state: InteractionState) {
    const linked = state.linked;
    state.linked = [];
    if (!timing) return;
    for (const record of linked) {
      const occurrences = new Map<TurnPhase, number>();
      for (const span of record.phases) {
        const occurrence = (occurrences.get(span.phase) ?? 0) + 1;
        occurrences.set(span.phase, occurrence);
        if (span.end === null) continue;
        const name = pageTurnMeasureName(instance, state.entry.id, record.id, span.phase, occurrence);
        try {
          timing.measure(name, { start: span.start, end: span.end });
          timing.clearMeasures(name);
        } catch {
          // Optional trace alignment must never affect reading.
        }
      }
    }
  }

  function begin({ action = null, backend = null, inputTime, interactionId = null }: { action?: string | null; backend?: string | null; inputTime?: number; interactionId?: number | null } = {}) {
    if (!enabled || destroyed) return null;

    const recordId = nextRecordId;
    nextRecordId += 1;
    const record: DiagnosticRecord = {
      id: recordId,
      interactionId,
      action,
      backend,
      inputTime: readTimestamp(now, inputTime),
      firstVisualTime: null,
      animationStartTime: null,
      endTime: null,
      frameTimestamps: [],
      omittedFrameSamples: 0,
      frameSampleSource: null,
      cancelReason: null,
      samplerFrameId: null,
      phases: [],
      omittedPhaseSpans: 0,
      omittedOpenPhases: {},
      milestones: {},
      summary: null,
    };
    activeRecords.set(recordId, record);
    const state = getInteraction(interactionId);
    if (state) {
      state.entry.records.push(recordId);
      state.linked.push(record);
      state.open += 1;
    }
    return recordId;
  }

  function markVisualUpdate(recordId: number | null | undefined, timestamp?: number) {
    const record = getActiveRecord(recordId);
    if (!record || record.firstVisualTime !== null) return;
    record.firstVisualTime = readTimestamp(now, timestamp);
  }

  // These spans measure application work, never compositor presentation.
  function startPhase(recordId: number | null | undefined, phase: TurnPhase, timestamp?: number) {
    const record = getActiveRecord(recordId);
    // A dropped catch-up stays unfinished; a later catch-up opens its own span.
    if (!record || (phase !== 'catch-up' && (record.omittedOpenPhases[phase]
      || record.phases.some(span => span.phase === phase && span.end === null)))) return;
    // Bounded: count spans past the cap (e.g. repeated reversals) instead of keeping them.
    if (record.phases.length >= PAGE_TURN_DIAGNOSTIC_LIMITS.phaseSpansPerRecord) {
      record.omittedPhaseSpans += 1;
      record.omittedOpenPhases[phase] = (record.omittedOpenPhases[phase] ?? 0) + 1;
      return;
    }
    record.phases.push({ phase, start: readTimestamp(now, timestamp), end: null });
  }
  function endPhase(recordId: number | null | undefined, phase: TurnPhase, timestamp?: number) {
    const record = getActiveRecord(recordId);
    if (!record) return;
    // The latest start of this phase was dropped at the cap: it owns this end.
    const dropped = record.omittedOpenPhases[phase];
    if (dropped) { record.omittedOpenPhases[phase] = dropped - 1; return; }
    const phases = record.phases;
    for (let index = phases.length - 1; index >= 0; index -= 1) {
      const span = phases[index]!;
      if (span.phase === phase && span.end === null) { span.end = readTimestamp(now, timestamp); return; }
    }
  }
  function markMilestone(recordId: number | null | undefined, milestone: TurnMilestone, timestamp?: number) {
    const record = getActiveRecord(recordId);
    if (record) record.milestones[milestone] ??= readTimestamp(now, timestamp);
  }
  function countInput(outcome: InputOutcome) {
    if (enabled && !destroyed) inputCounts[outcome]++;
  }
  function getInputCounts() { return { ...inputCounts }; }

  function markAnimationStart(recordId: number | null | undefined, timestamp?: number, options: { sampleFrames?: boolean } = {}) {
    const record = getActiveRecord(recordId);
    if (!record) return;

    if (record.animationStartTime === null) {
      record.animationStartTime = readTimestamp(now, timestamp);
    }
    if (options?.sampleFrames === true) scheduleSample(recordId!, record);
  }

  function frame(recordId: number | null | undefined, timestamp: number, source: FrameSampleSource = 'animation-frame') {
    const record = getActiveRecord(recordId);
    if (!record || !Number.isFinite(timestamp)) return;
    // Keep the first samples; later ones are counted so the export is marked truncated.
    if (record.frameTimestamps.length >= PAGE_TURN_DIAGNOSTIC_LIMITS.frameSamplesPerRecord) {
      record.omittedFrameSamples += 1;
      return;
    }
    record.frameSampleSource = record.frameSampleSource === null
      ? source
      : record.frameSampleSource === source ? source : 'mixed';
    record.frameTimestamps.push(timestamp);
  }

  function closeRecord(recordId: number | null | undefined, { cancelReason, endTime }: { cancelReason?: string; endTime?: number } = {}) {
    const record = getActiveRecord(recordId);
    if (!record) return null;

    stopSampler(record);
    activeRecords.delete(record.id);
    record.endTime = readTimestamp(now, endTime);
    if (cancelReason !== undefined) record.cancelReason = cancelReason;
    completedRecords.push(record);
    if (completedRecords.length > PAGE_TURN_DIAGNOSTIC_LIMITS.records) {
      omitted.records += completedRecords.splice(0, completedRecords.length - PAGE_TURN_DIAGNOSTIC_LIMITS.records).length;
    }
    const state = getInteraction(record.interactionId);
    if (state) {
      state.open = Math.max(0, state.open - 1);
      if (state.open === 0 && state.entry.result !== null) emitUserTiming(state);
    }
    return record;
  }

  /** Stores the raw terminal record without summarizing it. */
  function close(recordId: number | null | undefined, options?: { cancelReason?: string; endTime?: number }) {
    closeRecord(recordId, options);
  }

  function finish(recordId: number | null | undefined, endTime?: number) {
    const record = closeRecord(recordId, { endTime });
    return record && exportRecord(record);
  }

  function cancel(recordId: number | null | undefined, cancelReason = 'cancelled', endTime?: number) {
    const record = closeRecord(recordId, { cancelReason, endTime });
    return record && exportRecord(record);
  }

  function createInteraction(input: InteractionInput) {
    const { origin, viewport } = input;
    const state: InteractionState = {
      entry: {
        id: nextInteractionId++,
        source: input.source,
        pointerType: input.pointerType ?? null,
        inputTime: readTimestamp(now, input.inputTime),
        phaseAtInput: input.phaseAtInput,
        direction: input.direction ?? null,
        readyAtInput: null,
        readyAtStart: null,
        preparations: [],
        omittedPreparations: 0,
        fallback: null,
        origin: origin ? { positionRevision: origin.positionRevision, layoutGeneration: origin.layoutGeneration, appearanceGeneration: origin.appearanceGeneration } : null,
        viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
        queueDepth: 0,
        result: null,
        reason: null,
        resultTime: null,
        records: [],
      },
      open: 0,
      linked: [],
    };
    interactions.set(state.entry.id, state);
    interactionCounts.received += 1;
    if (interactions.size > PAGE_TURN_DIAGNOSTIC_LIMITS.interactions) {
      // Evict the oldest finished interaction; unfinished ones keep their slot.
      for (const [id, item] of interactions) {
        if (item.entry.result === null || item.open > 0) continue;
        interactions.delete(id);
        omitted.interactions += 1;
        break;
      }
    }
    return state;
  }

  function beginInteraction(input: InteractionInput) {
    if (!enabled || destroyed) return null;
    const state = createInteraction(input);
    interactionCounts.started += 1;
    return state.entry.id;
  }

  /** A rejected logical input: received and blocked, never started. */
  function blockInteraction(input: InteractionInput, reason: string) {
    if (!enabled || destroyed) return null;
    const { entry } = createInteraction(input);
    entry.result = 'blocked';
    entry.reason = reason;
    entry.resultTime = readTimestamp(now);
    interactionCounts.blocked += 1;
    return entry.id;
  }

  /** The first result wins; User Timing waits until every linked record has closed. */
  function resolveInteraction(interactionId: number | null | undefined, result: StartedResult, reason: string | null = null, timestamp?: number) {
    const state = getInteraction(interactionId);
    if (!state || state.entry.result !== null) return;
    state.entry.result = result;
    state.entry.reason = reason;
    state.entry.resultTime = readTimestamp(now, timestamp);
    interactionCounts[result] += 1;
    if (state.open === 0) emitUserTiming(state);
  }

  function setInteractionDirection(interactionId: number | null | undefined, direction: Direction | null) {
    const state = getInteraction(interactionId);
    if (state) state.entry.direction = direction;
  }

  function markInteractionReady(interactionId: number | null | undefined, slotState: string) {
    const state = getInteraction(interactionId);
    if (!state) return;
    state.entry.readyAtStart = slotState;
    state.entry.readyAtInput ??= slotState;
  }

  function markFallback(interactionId: number | null | undefined, fallback: InteractionFallback) {
    const state = getInteraction(interactionId);
    if (!state || state.entry.fallback !== null) return;
    state.entry.fallback = fallback;
    interactionCounts.fallback += 1;
  }

  function startPreparation(interactionId: number | null | undefined, direction: Direction, slotAtStart: string, timestamp?: number) {
    const state = getInteraction(interactionId);
    if (!state) return null;
    state.entry.readyAtInput ??= slotAtStart;
    if (state.entry.preparations.length >= PAGE_TURN_DIAGNOSTIC_LIMITS.preparationsPerInteraction) {
      state.entry.omittedPreparations += 1;
      return null;
    }
    return state.entry.preparations.push({ direction, slotAtStart, outcome: null, catchUp: false, start: readTimestamp(now, timestamp), end: null }) - 1;
  }

  function getPreparation(interactionId: number | null | undefined, index: number | null) {
    return index === null ? undefined : getInteraction(interactionId)?.entry.preparations[index];
  }

  function endPreparation(interactionId: number | null | undefined, index: number | null, outcome: PreparationOutcome, timestamp?: number) {
    const preparation = getPreparation(interactionId, index);
    if (!preparation || preparation.outcome !== null) return;
    preparation.outcome = outcome;
    preparation.end = readTimestamp(now, timestamp);
  }

  function markCatchUp(interactionId: number | null | undefined, index: number | null) {
    const preparation = getPreparation(interactionId, index);
    if (preparation) preparation.catchUp = true;
  }

  function getRecords() {
    return completedRecords.map(exportRecord);
  }
  function getInteractions() {
    return [...interactions.values()].map(copyInteraction);
  }
  function getInteractionCounts() { return { ...interactionCounts }; }
  function getOmitted() { return { ...omitted }; }

  function clear() {
    completedRecords.splice(0, completedRecords.length);
    inputCounts.received = inputCounts.accepted = inputCounts.rejected = inputCounts.committed = 0;
    interactions.clear();
    Object.assign(interactionCounts, emptyInteractionCounts());
    omitted.records = omitted.interactions = 0;
  }

  function destroy() {
    if (destroyed) return;

    for (const record of activeRecords.values()) stopSampler(record);
    activeRecords.clear();
    clear();
    destroyed = true;

    try {
      if (facade && target && Reflect.get(target, DIAGNOSTICS_FACADE_NAME) === facade) {
        Reflect.deleteProperty(target, DIAGNOSTICS_FACADE_NAME);
      }
    } catch {
      // A debug facade must never make teardown fail.
    }
  }

  if (enabled && target) {
    facade = Object.freeze({
      getRecords, getInputCounts, getInteractions, getInteractionCounts, getOmitted, clear,
      userTiming: userTimingStatus, instance,
    });
    try {
      Object.defineProperty(target, DIAGNOSTICS_FACADE_NAME, {
        configurable: true,
        value: facade,
        writable: false,
      });
    } catch {
      facade = null;
    }
  }

  return {
    /** False when disabled or destroyed; callers guard costly diagnostic reads with it. */
    get enabled() { return enabled && !destroyed; },
    userTiming: userTimingStatus,
    /** Measure-name prefix id; 0 when disabled. */
    instance,
    begin,
    markVisualUpdate,
    markAnimationStart,
    startPhase,
    endPhase,
    markMilestone,
    countInput,
    getInputCounts,
    frame,
    close,
    finish,
    cancel,
    getRecords,
    beginInteraction,
    blockInteraction,
    resolveInteraction,
    setInteractionDirection,
    markInteractionReady,
    markFallback,
    startPreparation,
    endPreparation,
    markCatchUp,
    getInteractions,
    getInteractionCounts,
    getOmitted,
    clear,
    destroy,
  };
}

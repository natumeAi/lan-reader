export interface DebugConfig { enabled: boolean; forceBackend: 'scroll' | 'compositor' | null }
type FrameSampleSource = 'animation-frame' | 'visual-update';
export type TurnPhase = 'prepare' | 'motion' | 'handoff' | 'busy';
type TurnMilestone = 'neighborReady' | 'engineVerified' | 'committed';
type InputOutcome = 'received' | 'accepted' | 'rejected' | 'committed';
interface PhaseSpan { phase: TurnPhase; start: number; end: number | null }
interface DiagnosticRecord {
  action: string | null; backend: string | null; inputTime: number;
  firstVisualTime: number | null; animationStartTime: number | null; endTime: number | null;
  frameTimestamps: number[]; cancelReason: string | null; samplerFrameId: number | null;
  frameSampleSource: FrameSampleSource | 'mixed' | null;
  phases: PhaseSpan[];
  milestones: Partial<Record<TurnMilestone, number>>;
}
type TerminalRecord = Omit<DiagnosticRecord, 'samplerFrameId' | 'frameTimestamps' | 'frameSampleSource'> & Omit<ReturnType<typeof summarizePageTurnFrames>, 'frameIntervalsMs'> & { frameTimestamps: readonly number[]; frameIntervalsMs: readonly number[] };
type DiagnosticFacade = { getRecords: () => ReturnType<typeof copyRecord>[]; getInputCounts: () => Record<InputOutcome, number>; clear: () => void };
interface DiagnosticsEnvironment {
  cancelAnimationFrame?: typeof cancelAnimationFrame; enabled?: boolean;
  now?: () => number; requestAnimationFrame?: typeof requestAnimationFrame;
  target?: object | null;
}
export const PAGE_TURN_DEBUG_STORAGE_KEY = 'epub-reader:page-turn-debug';

const DIAGNOSTICS_FACADE_NAME = '__EPUB_READER_PAGE_TURN_DIAGNOSTICS__';
const MAX_COMPLETED_RECORDS = 200;
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

function copyRecord(record: TerminalRecord) {
  return {
    ...record,
    frameTimestamps: [...record.frameTimestamps],
    frameIntervalsMs: [...record.frameIntervalsMs],
    phases: record.phases.map(span => ({ ...span })),
    milestones: { ...record.milestones },
  };
}

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
}: DiagnosticsEnvironment = {}) {
  const activeRecords = new Map<number, DiagnosticRecord>();
  const completedRecords: TerminalRecord[] = [];
  // Counts logical turnPage commands, not pointermove events or drag previews.
  const inputCounts = { received: 0, accepted: 0, rejected: 0, committed: 0 };
  let destroyed = false;
  let nextRecordId = 1;
  let facade: DiagnosticFacade | null = null;

  function getActiveRecord(recordId: number | null | undefined) {
    if (!enabled || destroyed) return null;
    return recordId == null ? null : activeRecords.get(recordId) || null;
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

  function begin({ action = null, backend = null, inputTime }: { action?: string | null; backend?: string | null; inputTime?: number } = {}) {
    if (!enabled || destroyed) return null;

    const recordId = nextRecordId;
    nextRecordId += 1;
    activeRecords.set(recordId, {
      action,
      backend,
      inputTime: readTimestamp(now, inputTime),
      firstVisualTime: null,
      animationStartTime: null,
      endTime: null,
      frameTimestamps: [],
      frameSampleSource: null,
      cancelReason: null,
      samplerFrameId: null,
      phases: [],
      milestones: {},
    });
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
    if (!record || record.phases.some(span => span.phase === phase && span.end === null)) return;
    record.phases.push({ phase, start: readTimestamp(now, timestamp), end: null });
  }
  function endPhase(recordId: number | null | undefined, phase: TurnPhase, timestamp?: number) {
    const span = getActiveRecord(recordId)?.phases.slice().reverse().find(span => span.phase === phase && span.end === null);
    if (span) span.end = readTimestamp(now, timestamp);
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
    record.frameSampleSource = record.frameSampleSource === null
      ? source
      : record.frameSampleSource === source ? source : 'mixed';
    record.frameTimestamps.push(timestamp);
  }

  function finish(recordId: number | null | undefined, endTime?: number) {
    const record = getActiveRecord(recordId);
    if (!record) return null;

    stopSampler(record);
    activeRecords.delete(recordId!);
    record.endTime = readTimestamp(now, endTime);

    const { samplerFrameId, ...terminalRecord } = record;
    void samplerFrameId; // Internal sampler handles do not belong in debug records.
    const summary = summarizePageTurnFrames(terminalRecord);
    const completedRecord = Object.freeze({
      ...terminalRecord,
      ...summary,
      firstVisualMeasurement: 'application-style-or-animation-write' as const,
      phases: terminalRecord.phases.map(span => ({ ...span })),
      milestones: { ...terminalRecord.milestones },
      frameTimestamps: Object.freeze([...terminalRecord.frameTimestamps]),
      frameIntervalsMs: Object.freeze([...summary.frameIntervalsMs]),
    });

    completedRecords.push(completedRecord);
    if (completedRecords.length > MAX_COMPLETED_RECORDS) {
      completedRecords.splice(0, completedRecords.length - MAX_COMPLETED_RECORDS);
    }

    return copyRecord(completedRecord);
  }

  function cancel(recordId: number | null | undefined, cancelReason = 'cancelled', endTime?: number) {
    const record = getActiveRecord(recordId);
    if (!record) return null;

    record.cancelReason = cancelReason;
    return finish(recordId, endTime);
  }

  function getRecords() {
    return completedRecords.map(copyRecord);
  }

  function clear() {
    completedRecords.splice(0, completedRecords.length);
    inputCounts.received = inputCounts.accepted = inputCounts.rejected = inputCounts.committed = 0;
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
    facade = Object.freeze({ getRecords, getInputCounts, clear });
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
    begin,
    markVisualUpdate,
    markAnimationStart,
    startPhase,
    endPhase,
    markMilestone,
    countInput,
    getInputCounts,
    frame,
    finish,
    cancel,
    getRecords,
    clear,
    destroy,
  };
}

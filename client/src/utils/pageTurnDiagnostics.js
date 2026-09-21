export const PAGE_TURN_DEBUG_STORAGE_KEY = 'epub-reader:page-turn-debug';

const DIAGNOSTICS_FACADE_NAME = '__EPUB_READER_PAGE_TURN_DIAGNOSTICS__';
const MAX_COMPLETED_RECORDS = 200;

function roundToTwo(value) {
  return Math.round(value * 100) / 100;
}

function readTimestamp(now, value) {
  if (Number.isFinite(value)) return value;

  try {
    const current = now();
    return Number.isFinite(current) ? current : 0;
  } catch {
    return 0;
  }
}

function copyRecord(record) {
  return {
    ...record,
    frameTimestamps: [...record.frameTimestamps],
    frameIntervalsMs: [...record.frameIntervalsMs],
  };
}

export function readPageTurnDebugConfig(storage) {
  try {
    const source = storage === undefined ? globalThis.sessionStorage : storage;
    const parsed = JSON.parse(source?.getItem(PAGE_TURN_DEBUG_STORAGE_KEY) || 'null');
    const forceBackend = ['scroll', 'compositor'].includes(parsed?.forceBackend)
      ? parsed.forceBackend
      : null;

    return {
      enabled: parsed?.enabled === true,
      forceBackend,
    };
  } catch {
    return { enabled: false, forceBackend: null };
  }
}

export function summarizePageTurnFrames(record = {}) {
  const frameTimestamps = Array.isArray(record.frameTimestamps)
    ? record.frameTimestamps
    : [];
  const intervals = [];

  for (let index = 1; index < frameTimestamps.length; index += 1) {
    const previous = frameTimestamps[index - 1];
    const current = frameTimestamps[index];
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
    averageFps: elapsed > 0 ? roundToTwo((intervals.length * 1000) / elapsed) : 0,
    inputLatencyMs: hasInputLatency
      ? roundToTwo(record.firstVisualTime - record.inputTime)
      : null,
    frameIntervalsMs: intervals.map(roundToTwo),
    p95FrameIntervalMs: sortedIntervals.length > 0
      ? roundToTwo(sortedIntervals[p95Index])
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
} = {}) {
  const activeRecords = new Map();
  const completedRecords = [];
  let destroyed = false;
  let nextRecordId = 1;
  let facade = null;

  function getActiveRecord(recordId) {
    if (!enabled || destroyed) return null;
    return activeRecords.get(recordId) || null;
  }

  function stopSampler(record) {
    if (record.samplerFrameId === null) return;

    try {
      cancelAnimationFrame?.(record.samplerFrameId);
    } catch {
      // Debug sampling must not affect reader behavior.
    }
    record.samplerFrameId = null;
  }

  function scheduleSample(recordId, record) {
    if (record.samplerFrameId !== null || typeof requestAnimationFrame !== 'function') return;

    try {
      record.samplerFrameId = requestAnimationFrame((timestamp) => {
        if (activeRecords.get(recordId) !== record || destroyed) return;

        record.samplerFrameId = null;
        markVisualUpdate(recordId, timestamp);
        frame(recordId, timestamp);
        scheduleSample(recordId, record);
      });
    } catch {
      record.samplerFrameId = null;
    }
  }

  function begin({ action = null, backend = null, inputTime } = {}) {
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
      cancelReason: null,
      samplerFrameId: null,
    });
    return recordId;
  }

  function markVisualUpdate(recordId, timestamp) {
    const record = getActiveRecord(recordId);
    if (!record || record.firstVisualTime !== null) return;
    record.firstVisualTime = readTimestamp(now, timestamp);
  }

  function markAnimationStart(recordId, timestamp, options = {}) {
    const record = getActiveRecord(recordId);
    if (!record) return;

    if (record.animationStartTime === null) {
      record.animationStartTime = readTimestamp(now, timestamp);
    }
    if (options?.sampleFrames === true) scheduleSample(recordId, record);
  }

  function frame(recordId, timestamp) {
    const record = getActiveRecord(recordId);
    if (!record || !Number.isFinite(timestamp)) return;
    record.frameTimestamps.push(timestamp);
  }

  function finish(recordId, endTime) {
    const record = getActiveRecord(recordId);
    if (!record) return null;

    stopSampler(record);
    activeRecords.delete(recordId);
    record.endTime = readTimestamp(now, endTime);

    const { samplerFrameId: _samplerFrameId, ...terminalRecord } = record;
    const summary = summarizePageTurnFrames(terminalRecord);
    const completedRecord = Object.freeze({
      ...terminalRecord,
      ...summary,
      frameTimestamps: Object.freeze([...terminalRecord.frameTimestamps]),
      frameIntervalsMs: Object.freeze([...summary.frameIntervalsMs]),
    });

    completedRecords.push(completedRecord);
    if (completedRecords.length > MAX_COMPLETED_RECORDS) {
      completedRecords.splice(0, completedRecords.length - MAX_COMPLETED_RECORDS);
    }

    return copyRecord(completedRecord);
  }

  function cancel(recordId, cancelReason = 'cancelled', endTime) {
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
  }

  function destroy() {
    if (destroyed) return;

    for (const record of activeRecords.values()) stopSampler(record);
    activeRecords.clear();
    clear();
    destroyed = true;

    try {
      if (facade && target?.[DIAGNOSTICS_FACADE_NAME] === facade) {
        delete target[DIAGNOSTICS_FACADE_NAME];
      }
    } catch {
      // A debug facade must never make teardown fail.
    }
  }

  if (enabled && target) {
    facade = Object.freeze({ getRecords, clear });
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
    frame,
    finish,
    cancel,
    getRecords,
    clear,
    destroy,
  };
}

export const PROGRESS_OUTBOX_KEY = 'epub-reader:pending-reading-progress:v1';
const OUTBOX_VERSION = 1;

function optionalString(value) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : undefined;
}

function clampProgress(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(1, Math.max(0, numericValue));
}

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function sanitizeProgressRecord(value) {
  if (!value || !Number.isInteger(value.bookId) || value.bookId <= 0) return null;

  const progress = Number(value.progress);
  const cfi = optionalString(value.cfi);
  const chapterHref = optionalString(value.chapterHref);
  const chapterLabel = optionalString(value.chapterLabel);

  if (
    !Number.isFinite(progress) ||
    progress < 0 ||
    progress > 1 ||
    cfi === undefined ||
    chapterHref === undefined ||
    chapterLabel === undefined
  ) {
    return null;
  }

  return {
    bookId: value.bookId,
    cfi,
    progress,
    chapterHref,
    chapterLabel,
  };
}

export function selectProgressForRelocation({
  atEnd = false,
  cfi,
  lastValidProgress,
  locations,
  locationsReady,
}) {
  if (atEnd === true) return 1;

  const fallback = clampProgress(lastValidProgress);
  if (!locationsReady) return fallback;

  try {
    const percentage = locations?.percentageFromCfi?.(cfi);
    return Number.isFinite(percentage) ? clampProgress(percentage, fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function readProgressOutbox(storage = defaultStorage()) {
  if (!storage) return {};

  try {
    const parsed = JSON.parse(storage.getItem(PROGRESS_OUTBOX_KEY));
    if (parsed?.version !== OUTBOX_VERSION || !parsed.records || typeof parsed.records !== 'object') {
      return {};
    }

    return Object.values(parsed.records).reduce((records, candidate) => {
      const record = sanitizeProgressRecord(candidate);
      if (record) records[record.bookId] = record;
      return records;
    }, {});
  } catch {
    return {};
  }
}

export function writeProgressOutbox(records, storage = defaultStorage()) {
  if (!storage) return false;

  try {
    const sanitizedRecords = Object.values(records || {}).reduce((result, candidate) => {
      const record = sanitizeProgressRecord(candidate);
      if (record) result[record.bookId] = record;
      return result;
    }, {});

    if (Object.keys(sanitizedRecords).length === 0) {
      storage.removeItem(PROGRESS_OUTBOX_KEY);
    } else {
      storage.setItem(PROGRESS_OUTBOX_KEY, JSON.stringify({
        version: OUTBOX_VERSION,
        records: sanitizedRecords,
      }));
    }
    return true;
  } catch {
    return false;
  }
}

export function isSameProgressSnapshot(first, second) {
  return Boolean(
    first &&
    second &&
    first.bookId === second.bookId &&
    first.cfi === second.cfi &&
    first.progress === second.progress &&
    first.chapterHref === second.chapterHref &&
    first.chapterLabel === second.chapterLabel,
  );
}

export function formatReadingPosition(progress) {
  if (progress === null || progress === undefined || progress === '') {
    return {
      accessibleDescription: null,
      barWidth: 0,
      label: null,
      percent: null,
      state: 'unread',
    };
  }

  const numericProgress = Number(progress);
  if (!Number.isFinite(numericProgress)) {
    return {
      accessibleDescription: null,
      barWidth: 0,
      label: null,
      percent: null,
      state: 'unread',
    };
  }

  const boundedProgress = Math.min(1, Math.max(0, numericProgress));
  if (boundedProgress === 1) {
    return {
      accessibleDescription: '已读完',
      barWidth: 100,
      label: null,
      percent: 100,
      state: 'finished',
    };
  }

  const percent = Math.min(99, Math.max(0, Math.round(boundedProgress * 100)));
  return {
    accessibleDescription: `已读 ${percent}%`,
    barWidth: Math.min(99, boundedProgress * 100),
    label: `${percent}%`,
    percent,
    state: 'reading',
  };
}

export function formatBookCardAriaLabel(label, progress) {
  const presentation = formatReadingPosition(progress);
  return presentation.accessibleDescription
    ? `${label}，${presentation.accessibleDescription}`
    : label;
}

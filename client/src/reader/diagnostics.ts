import type { FoliateEngine } from './foliateEngine';
import type { ReaderSettings } from '../hooks/useReaderSettings';
import { readPageTurnDebugConfig } from '../utils/pageTurnDiagnostics';

type WorkKind = 'preview' | 'measurement';
interface PreparationRecord {
  start: number; workEnd: number | null; stage: string | null; failure: string | null;
}
interface WorkRecord {
  id: number; kind: WorkKind; start: number; workEnd: number | null;
  released: number | null; bookCreated: number | null; viewCreated: number | null;
  stage: string | null; failure: string | null;
  preparations: PreparationRecord[]; omittedPreparations: number;
}
const workRecords: WorkRecord[] = [];
let nextWorkId = 0;
const MAX_PREPARATIONS_PER_OWNER = 500;
/** Retain pending releases: canceling publication does not stop hidden work. */
export function beginReaderWork(kind: WorkKind) {
  if (!readPageTurnDebugConfig().enabled) return undefined;
  const first: PreparationRecord = { start: performance.now(), workEnd: null, stage: null, failure: null };
  const record: WorkRecord = { id: ++nextWorkId, kind, start: first.start, workEnd: null, released: null, bookCreated: null, viewCreated: null, stage: null, failure: null, preparations: [first], omittedPreparations: 0 };
  let current = first;
  workRecords.push(record);
  while (workRecords.length > 500) {
    const index = workRecords.findIndex(item => item.released !== null);
    if (index < 0) break;
    workRecords.splice(index, 1);
  }
  return {
    stage(value: string) { current.stage = value; if (current === first) record.stage = value; },
    fail(reason: string) { current.failure = reason; if (current === first) record.failure = reason; },
    bookCreated() { record.bookCreated ??= performance.now(); },
    viewCreated() { record.viewCreated ??= performance.now(); },
    end() {
      current.workEnd ??= performance.now();
      if (current === first) record.workEnd ??= current.workEnd;
    },
    nextPreparation() {
      current = { start: performance.now(), workEnd: null, stage: null, failure: null };
      record.preparations.push(current);
      if (record.preparations.length > MAX_PREPARATIONS_PER_OWNER) {
        record.preparations.shift(); record.omittedPreparations++;
      }
    },
    release() { record.released ??= performance.now(); },
  };
}
export function getReaderWorkDiagnostics() {
  return workRecords.map(record => ({ ...record, preparations: record.preparations.map(preparation => ({ ...preparation })) }));
}

/** User-requested local export; nothing is uploaded or sent automatically. */
export function exportReaderDiagnostics(engine: FoliateEngine | null, settings: ReaderSettings) {
  const pageTurns = Reflect.get(window, '__EPUB_READER_PAGE_TURN_DIAGNOSTICS__') as {
    getRecords?: () => unknown; getInputCounts?: () => unknown;
  } | undefined;
  const report = {
    createdAt: new Date().toISOString(),
    schemaVersion: 2,
    measurement: 'Main-thread callback timing; not presented display FPS or an iPhone test result',
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
    settings,
    position: engine?.diagnostics(),
    pageTurns: pageTurns?.getRecords?.() ?? [],
    turnCommandCounts: pageTurns?.getInputCounts?.() ?? null,
    backgroundWork: getReaderWorkDiagnostics(),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `reader-diagnostics-${Date.now()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

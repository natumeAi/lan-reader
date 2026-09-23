import type { FoliateEngine } from './foliateEngine';
import type { ReaderSettings } from '../hooks/useReaderSettings';
import { readPageTurnDebugConfig } from '../utils/pageTurnDiagnostics';

type WorkKind = 'preview' | 'measurement';
interface WorkRecord {
  id: number; kind: WorkKind; start: number; workEnd: number | null;
  released: number | null; bookCreated: number | null; viewCreated: number | null;
  stage: string | null; failure: string | null;
}
const workRecords: WorkRecord[] = [];
let nextWorkId = 0;
/** Retain pending releases: canceling publication does not stop hidden work. */
export function beginReaderWork(kind: WorkKind) {
  if (!readPageTurnDebugConfig().enabled) return undefined;
  const record: WorkRecord = { id: ++nextWorkId, kind, start: performance.now(), workEnd: null, released: null, bookCreated: null, viewCreated: null, stage: null, failure: null };
  workRecords.push(record);
  while (workRecords.length > 500) {
    const index = workRecords.findIndex(item => item.released !== null);
    if (index < 0) break;
    workRecords.splice(index, 1);
  }
  return {
    stage(value: string) { record.stage = value; },
    fail(reason: string) { record.failure = reason; },
    bookCreated() { record.bookCreated ??= performance.now(); },
    viewCreated() { record.viewCreated ??= performance.now(); },
    end() { record.workEnd ??= performance.now(); },
    release() { record.released ??= performance.now(); },
  };
}
export function getReaderWorkDiagnostics() {
  return workRecords.map(record => ({ ...record }));
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

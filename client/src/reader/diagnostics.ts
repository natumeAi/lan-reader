import type { FoliateEngine } from './foliateEngine';
import type { ReaderSettings } from '../hooks/useReaderSettings';

/** User-requested local export; nothing is uploaded or sent automatically. */
export function exportReaderDiagnostics(engine: FoliateEngine | null, settings: ReaderSettings) {
  const report = {
    createdAt: new Date().toISOString(),
    measurement: 'Main-thread callback timing; not presented display FPS or an iPhone test result',
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
    settings,
    position: engine?.diagnostics(),
    pageTurns: (Reflect.get(window, '__EPUB_READER_PAGE_TURN_DIAGNOSTICS__') as { getRecords?: () => unknown } | undefined)?.getRecords?.() ?? [],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `reader-diagnostics-${Date.now()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

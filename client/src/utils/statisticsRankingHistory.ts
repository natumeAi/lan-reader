import { isRecord } from '@lan-reader/shared';
import { IMAGE_VIEWER_HISTORY_KEY, READER_BOOK_HISTORY_KEY } from './readerHistoryState.js';

export const STATISTICS_RANKING_HISTORY_KEY = '__epubReaderStatisticsRanking';
const HISTORY_SETTLE_MS = 500;

export function rankingHistoryToken(state: unknown): string | null {
  return isRecord(state) && typeof state[STATISTICS_RANKING_HISTORY_KEY] === 'string'
    ? state[STATISTICS_RANKING_HISTORY_KEY] : null;
}

export function withoutRankingHistory(state: unknown) {
  const next = isRecord(state) ? { ...state } : {};
  delete next[STATISTICS_RANKING_HISTORY_KEY];
  return next;
}

/** One owned, same-document entry. Never traverse an entry belonging to another UI. */
export function createRankingHistory(
  token: string,
  onLeave: () => void,
  onSettled: () => void,
) {
  let pushed = false;
  let requested = false;
  let settled = false;
  let timer: number | undefined;
  const initial = window.history.state;
  const readerValue = isRecord(initial) ? initial[READER_BOOK_HISTORY_KEY] : undefined;
  const imageValue = isRecord(initial) ? initial[IMAGE_VIEWER_HISTORY_KEY] : undefined;
  const ownsCurrent = () => {
    const state: unknown = window.history.state;
    return isRecord(state) && rankingHistoryToken(state) === token
      && state[READER_BOOK_HISTORY_KEY] === readerValue && state[IMAGE_VIEWER_HISTORY_KEY] === imageValue;
  };
  const clearMarker = () => {
    try {
      // Other owners may copy unknown keys. Removing our token is safe even
      // then; traversing their entry is not. Keep every reader/image key intact.
      if (rankingHistoryToken(window.history.state) === token) {
        window.history.replaceState(withoutRankingHistory(window.history.state), '', window.location.href);
      }
    } catch { /* History may be unavailable; the UI still closes. */ }
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    onSettled();
  };
  const handlePop = () => {
    if (settled || ownsCurrent()) return;
    onLeave();
    settle();
  };
  window.addEventListener('popstate', handlePop);
  try {
    window.history.pushState({ ...withoutRankingHistory(window.history.state), [STATISTICS_RANKING_HISTORY_KEY]: token }, '', window.location.href);
    pushed = true;
  } catch { /* No entry to consume when history writes fail. */ }

  return {
    close() {
      if (requested || settled) return;
      requested = true;
      if (!pushed || !ownsCurrent()) { settle(); return; }
      // Normally retain the interaction lock until popstate. The bounded UI
      // fallback cannot cancel an accepted browser traversal: an exceptionally
      // late traversal can still move history after this owner has settled.
      timer = window.setTimeout(() => { clearMarker(); settle(); }, HISTORY_SETTLE_MS);
      try { window.history.back(); } catch { clearMarker(); settle(); }
    },
    dispose() {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('popstate', handlePop);
      // Teardown cannot safely schedule a traversal underneath the next screen.
      clearMarker();
    },
  };
}

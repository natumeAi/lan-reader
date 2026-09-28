import type { ReadingStatisticsDto } from '@lan-reader/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { requestFrameOrTimeout } from '../utils/animationFrame.js';
import { createRankingHistory, rankingHistoryToken, withoutRankingHistory } from '../utils/statisticsRankingHistory.js';

export const RANKING_MOTION_MS = 260;
type RankingPhase = 'preparing' | 'open' | 'closing';
interface RankingSession {
  generation: number;
  statistics: ReadingStatisticsDto;
  title: string;
  opener: HTMLElement;
  scrollX: number;
  scrollY: number;
  phase: RankingPhase;
  historySettled: boolean;
}

/** App owns the frozen snapshot and interaction block through the entire exit. */
export function useStatisticsRanking(reducedMotion: boolean) {
  const [session, setSession] = useState<RankingSession | null>(null);
  const current = useRef<RankingSession | null>(null);
  const generation = useRef(0);
  const history = useRef<ReturnType<typeof createRankingHistory> | null>(null);
  const restore = useRef<RankingSession | null>(null);
  const publish = useCallback((next: RankingSession | null) => {
    current.current = next;
    setSession(next);
  }, []);
  const close = useCallback(() => {
    const active = current.current;
    if (!active || active.phase === 'closing') return;
    publish({ ...active, phase: 'closing' });
    history.current?.close();
  }, [publish]);
  const open = useCallback((statistics: ReadingStatisticsDto, title: string, opener: HTMLElement) => {
    if (current.current) return;
    const id = ++generation.current;
    publish({ generation: id, statistics, title, opener, scrollX: window.scrollX, scrollY: window.scrollY,
      phase: reducedMotion ? 'open' : 'preparing', historySettled: false });
    history.current = createRankingHistory(`ranking-${Date.now()}-${id}`, close, () => {
      const active = current.current;
      if (active?.generation === id) publish({ ...active, historySettled: true });
    });
  }, [close, publish, reducedMotion]);

  useLayoutEffect(() => {
    if (!session || session.phase !== 'preparing') return;
    const id = session.generation;
    const enter = () => {
      const active = current.current;
      if (active?.generation === id && active.phase === 'preparing') publish({ ...active, phase: 'open' });
    };
    if (reducedMotion) { enter(); return; }
    let cancelSecond = () => {};
    const cancelFirst = requestFrameOrTimeout(() => { cancelSecond = requestFrameOrTimeout(enter); });
    return () => { cancelFirst(); cancelSecond(); };
  }, [publish, reducedMotion, session]);

  const closingGeneration = session?.phase === 'closing' ? session.generation : null;
  const [animatedExit, setAnimatedExit] = useState<number | null>(null);
  useEffect(() => {
    if (closingGeneration === null) return;
    const timer = window.setTimeout(() => setAnimatedExit(closingGeneration), reducedMotion ? 0 : RANKING_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [closingGeneration, reducedMotion]);
  useLayoutEffect(() => {
    if (!session || session.phase !== 'closing' || !session.historySettled || animatedExit !== session.generation) return;
    restore.current = session;
    history.current?.dispose();
    history.current = null;
    publish(null);
  }, [animatedExit, publish, session]);
  useLayoutEffect(() => {
    if (session || !restore.current) return;
    const previous = restore.current;
    restore.current = null;
    window.scrollTo({ left: previous.scrollX, top: previous.scrollY, behavior: 'instant' });
    if (previous.opener.isConnected) previous.opener.focus({ preventScroll: true });
  }, [session]);

  useEffect(() => {
    // A reload/Forward cannot revive a stale detail without its snapshot.
    const clearStale = () => {
      if (current.current || !rankingHistoryToken(window.history.state)) return;
      try { window.history.replaceState(withoutRankingHistory(window.history.state), '', window.location.href); } catch { /* optional history */ }
    };
    clearStale();
    window.addEventListener('popstate', clearStale);
    return () => {
      window.removeEventListener('popstate', clearStale);
      history.current?.dispose();
      history.current = null;
    };
  }, []);
  return { session, open, close };
}

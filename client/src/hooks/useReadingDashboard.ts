import type { ReadingGoalsDto, ReadingGoalsUpdate, ReadingStatsDto } from '@lan-reader/shared';
import type { ReadingActivityStatus } from '../utils/activityDelivery.js';
import type { GoalKind } from '../utils/readingStatsFormat.js';
import { formatLocalDate } from '@lan-reader/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getReadingStats, updateReadingGoals } from '../api/readingApi.js';
import { errorMessage, isAbortError } from '../api/transport.js';
import { msUntilNextLocalMidnight } from '../utils/readingStatsFormat.js';

/** The part of the App-owned activity delivery the dashboard observes. */
export interface DashboardDeliverySource {
  getStatus(): ReadingActivityStatus;
  subscribe(listener: () => void): () => void;
}

export interface UseReadingDashboardOptions {
  /** 首页 is the shown main view and no reader covers it. Refresh work runs only while true. */
  active: boolean;
  delivery?: DashboardDeliverySource | null;
  fetchStats?: (date: string, options: { signal: AbortSignal }) => Promise<ReadingStatsDto>;
  saveGoals?: (update: ReadingGoalsUpdate) => Promise<ReadingGoalsDto>;
  now?: () => Date;
}

export interface ReadingDashboard {
  /** Last valid response; kept across failed background refreshes. `null` until the first success. */
  stats: ReadingStatsDto | null;
  /** Browser-local today, as last requested. */
  today: string;
  /** A request is in flight. */
  isRefreshing: boolean;
  /** Message of the latest failed request, cleared by the next success. */
  error: string;
  /** Delivery warning for the dashboard, or `''`. */
  deliveryNotice: string;
  goalDialog: GoalKind | null;
  openGoalDialog: (kind: GoalKind) => void;
  closeGoalDialog: () => void;
  refresh: () => void;
  /** Requests a refresh if the dashboard is shown; entering 首页 refreshes anyway. */
  invalidate: () => void;
  /** Resolves once the server saved the goals; rejects with a user-facing Error. */
  saveGoals: (update: ReadingGoalsUpdate) => Promise<void>;
}

const defaultFetchStats = (date: string, options: { signal: AbortSignal }) => getReadingStats(date, options);
const defaultNow = () => new Date();

function deliveryNoticeOf(status: ReadingActivityStatus): string {
  if (status.permanentErrorCount > 0) {
    return `有 ${status.permanentErrorCount} 条阅读记录被服务器拒绝，未计入统计`;
  }
  if (!status.isDurable && status.pendingCount > 0) {
    return '阅读记录暂存于内存，尚未同步；刷新或关闭页面前请保持联网';
  }
  return '';
}

/**
 * Single owner of the 首页 statistics: the decoded stats response, its request
 * generation/cancellation, goal saves, the goal dialog and every refresh trigger
 * (entering 首页, accepted activity, reader close via `active`, deletion via
 * `invalidate`, local day change). Separate from the library snapshot and cache.
 */
export function useReadingDashboard({
  active,
  delivery = null,
  fetchStats = defaultFetchStats,
  saveGoals: saveGoalsRequest = updateReadingGoals,
  now = defaultNow,
}: UseReadingDashboardOptions): ReadingDashboard {
  const [stats, setStats] = useState<ReadingStatsDto | null>(null);
  const [today, setToday] = useState(() => formatLocalDate(now()));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [deliveryNotice, setDeliveryNotice] = useState('');
  const [goalDialog, setGoalDialog] = useState<GoalKind | null>(null);

  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const requestedDateRef = useRef<string | null>(null);
  /** Bumped by every applied goal save; a fetch started earlier cannot publish older goals. */
  const goalsRevisionRef = useRef(0);
  const savedGoalsRef = useRef<ReadingGoalsDto | null>(null);
  const saveIdRef = useRef(0);
  const acceptedSeenRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const optionsRef = useRef({ delivery, fetchStats, now, saveGoalsRequest });
  optionsRef.current = { delivery, fetchStats, now, saveGoalsRequest };

  const cancelRequest = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    setIsRefreshing(false);
  }, []);

  const refresh = useCallback(() => {
    const { delivery: source, fetchStats: fetchRequest, now: clock } = optionsRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    const goalsRevision = goalsRevisionRef.current;
    const date = formatLocalDate(clock());
    requestedDateRef.current = date;
    acceptedSeenRef.current = source?.getStatus().lastAcceptedAt ?? acceptedSeenRef.current;
    setToday(date);
    setIsRefreshing(true);

    const isCurrent = () => mountedRef.current && requestIdRef.current === requestId;
    void fetchRequest(date, { signal: controller.signal }).then((next) => {
      if (!isCurrent()) return;
      const savedGoals = savedGoalsRef.current;
      setStats(goalsRevision !== goalsRevisionRef.current && savedGoals ? { ...next, goals: savedGoals } : next);
      setError('');
    }, (cause: unknown) => {
      if (!isCurrent() || isAbortError(cause)) return;
      setError(errorMessage(cause, '无法加载阅读统计'));
    }).finally(() => {
      if (!isCurrent()) return;
      controllerRef.current = null;
      setIsRefreshing(false);
    });
  }, []);

  const invalidate = useCallback(() => {
    if (activeRef.current) refresh();
  }, [refresh]);

  const saveGoals = useCallback(async (update: ReadingGoalsUpdate) => {
    const saveId = ++saveIdRef.current;
    const goals = await optionsRef.current.saveGoalsRequest(update);
    if (!mountedRef.current || saveId !== saveIdRef.current) return;
    goalsRevisionRef.current += 1;
    savedGoalsRef.current = goals;
    setStats((current) => (current ? { ...current, goals } : current));
  }, []);

  const openGoalDialog = useCallback((kind: GoalKind) => setGoalDialog(kind), []);
  const closeGoalDialog = useCallback(() => setGoalDialog(null), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  // Entering 首页 (including a reader closing over it) refreshes; while shown, accepted
  // activity and a local day change refresh too. Nothing runs while hidden, so reading and
  // the bookshelf are never re-rendered by statistics work.
  useEffect(() => {
    activeRef.current = active;
    if (!active) return undefined;

    refresh();

    const source = optionsRef.current.delivery;
    const onDeliveryStatus = () => {
      if (!source) return;
      const status = source.getStatus();
      setDeliveryNotice(deliveryNoticeOf(status));
      const acceptedAt = status.lastAcceptedAt;
      if (acceptedAt !== null && acceptedAt !== acceptedSeenRef.current) refresh();
    };
    const unsubscribe = source?.subscribe(onDeliveryStatus);
    onDeliveryStatus();

    const refreshIfDayChanged = () => {
      if (formatLocalDate(optionsRef.current.now()) !== requestedDateRef.current) refresh();
    };
    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMidnight = () => {
      // A little past midnight so the new local date is certain on a drifting clock.
      midnightTimer = setTimeout(() => {
        refreshIfDayChanged();
        scheduleMidnight();
      }, msUntilNextLocalMidnight(optionsRef.current.now()) + 1000);
    };
    scheduleMidnight();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshIfDayChanged();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      activeRef.current = false;
      // A goal editor belongs to the shown 首页; if it is hidden (for example by an active
      // reader restore), the editor closes so it cannot keep blocking the main navigation.
      setGoalDialog(null);
      unsubscribe?.();
      if (midnightTimer !== null) clearTimeout(midnightTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      cancelRequest();
    };
  }, [active, cancelRequest, delivery, refresh]);

  return {
    stats,
    today,
    isRefreshing,
    error,
    deliveryNotice,
    goalDialog,
    openGoalDialog,
    closeGoalDialog,
    refresh,
    invalidate,
    saveGoals,
  };
}

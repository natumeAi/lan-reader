import type {
  ReadingStatisticsDto,
  ReadingStatisticsQuery,
  StatisticsDimension,
  StatisticsPeriod,
} from '@lan-reader/shared';
import type { DashboardDeliverySource } from './useReadingDashboard.js';
import { formatLocalDate, resolveStatisticsPeriod, shiftStatisticsAnchor } from '@lan-reader/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getReadingStatistics } from '../api/readingApi.js';
import { errorMessage, isAbortError } from '../api/transport.js';
import { msUntilNextLocalMidnight } from '../utils/readingStatsFormat.js';
import { formatStatisticsTitle, statisticsDeliveryNoticeOf } from '../utils/statisticsFormat.js';

/** The chosen dimension and a local date inside the chosen period. */
export interface StatisticsSelection {
  dimension: StatisticsDimension;
  /**
   * Any date of the shown period. Kept when switching dimensions (the new dimension shows
   * its period containing this date) and while `all` is shown, so returning keeps context.
   */
  anchor: string;
}

export type FetchReadingStatistics = (
  query: ReadingStatisticsQuery,
  options: { signal: AbortSignal },
) => Promise<ReadingStatisticsDto>;

export interface UseReadingStatisticsOptions {
  /** 统计 is the shown main view and no reader covers it. Refresh work runs only while true. */
  active: boolean;
  delivery?: DashboardDeliverySource | null;
  fetchStatistics?: FetchReadingStatistics;
  now?: () => Date;
}

export type ReadingStatisticsStatus = 'loading' | 'ready' | 'error';

export interface ReadingStatisticsState {
  selection: StatisticsSelection;
  /** The selected complete period, computed locally; `null` for `all`. */
  period: StatisticsPeriod | null;
  /** Title of the selection, correct before its data arrives. */
  title: string;
  /** Browser-local today, as last requested. */
  today: string;
  /** Latest valid response for exactly the current selection, otherwise `null`. */
  statistics: ReadingStatisticsDto | null;
  /** `ready` with matching data; `error` when the current selection has none and failed. */
  status: ReadingStatisticsStatus;
  isRefreshing: boolean;
  /** Latest failure for the current selection (also set while older matching data is kept). */
  error: string;
  /** Delivery warning and pending synchronization status, or `''`. */
  deliveryNotice: string;
  canGoPrevious: boolean;
  canGoNext: boolean;
  selectDimension: (dimension: StatisticsDimension) => void;
  goPrevious: () => void;
  goNext: () => void;
  retry: () => void;
  /** Requests a refresh if 统计 is shown; entering it refreshes anyway. */
  invalidate: () => void;
}

const defaultNow = () => new Date();
const defaultFetchStatistics: FetchReadingStatistics = (query, options) => getReadingStatistics(query, options);

function periodOf(selection: StatisticsSelection): StatisticsPeriod | null {
  return selection.dimension === 'all' ? null : resolveStatisticsPeriod(selection.dimension, selection.anchor);
}

/**
 * Identity of what the page shows. Period dimensions are keyed by their canonical first
 * day, so two anchors in the same period share data; `all` has no anchor.
 */
function selectionKeyOf(selection: StatisticsSelection): string {
  const period = periodOf(selection);
  return `${selection.dimension}|${period?.start ?? ''}`;
}

function queryOf(selection: StatisticsSelection, today: string): ReadingStatisticsQuery {
  const period = periodOf(selection);
  return { dimension: selection.dimension, anchor: period?.start ?? null, today };
}

/** Recently shown periods whose last valid response may be shown again while revalidating. */
const CACHED_SELECTIONS = 12;

function withCached(
  cache: ReadonlyMap<string, ReadingStatisticsDto>,
  key: string,
  statistics: ReadingStatisticsDto,
): ReadonlyMap<string, ReadingStatisticsDto> {
  const next = new Map(cache);
  next.delete(key);
  next.set(key, statistics);
  while (next.size > CACHED_SELECTIONS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

interface KeyedError {
  key: string;
  message: string;
}

/**
 * Single owner of the 统计 page data: the dimension/anchor selection, the decoded period
 * response keyed by that selection, request cancellation and generation, errors and every
 * refresh trigger (entering 统计, accepted activity, deletion via `invalidate`, `online`,
 * a local day change). The selection lives for the App session, so switching main views
 * keeps it; a page reload starts again on the current month.
 */
export function useReadingStatistics({
  active,
  delivery = null,
  fetchStatistics = defaultFetchStatistics,
  now = defaultNow,
}: UseReadingStatisticsOptions): ReadingStatisticsState {
  const [selection, setSelection] = useState<StatisticsSelection>(() => ({
    dimension: 'month',
    anchor: formatLocalDate(now()),
  }));
  const [today, setToday] = useState(() => formatLocalDate(now()));
  // Responses by selection key. Only the current key's entry is ever shown.
  const [cache, setCache] = useState<ReadonlyMap<string, ReadingStatisticsDto>>(() => new Map());
  const [failure, setFailure] = useState<KeyedError | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deliveryNotice, setDeliveryNotice] = useState('');

  const selectionRef = useRef(selection);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const requestedDateRef = useRef<string | null>(null);
  const acceptedSeenRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  const enteredRef = useRef(false);
  const mountedRef = useRef(true);
  const optionsRef = useRef({ delivery, fetchStatistics, now });
  optionsRef.current = { delivery, fetchStatistics, now };

  const cancelRequest = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    setIsRefreshing(false);
  }, []);

  const refresh = useCallback(() => {
    const { delivery: source, fetchStatistics: fetchRequest, now: clock } = optionsRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    const date = formatLocalDate(clock());
    requestedDateRef.current = date;
    acceptedSeenRef.current = source?.getStatus().lastAcceptedAt ?? acceptedSeenRef.current;
    setToday(date);
    setIsRefreshing(true);

    const requested = selectionRef.current;
    const key = selectionKeyOf(requested);
    // Both checks: a newer request supersedes this one, and a result for another
    // selection must never be published under the current title.
    const isCurrent = () =>
      mountedRef.current && requestIdRef.current === requestId && selectionKeyOf(selectionRef.current) === key;
    void fetchRequest(queryOf(requested, date), { signal: controller.signal }).then((statistics) => {
      if (!isCurrent()) return;
      setCache((current) => withCached(current, key, statistics));
      setFailure(null);
    }, (cause: unknown) => {
      if (!isCurrent() || isAbortError(cause)) return;
      setFailure({ key, message: errorMessage(cause, '无法加载阅读统计') });
    }).finally(() => {
      if (!isCurrent()) return;
      controllerRef.current = null;
      setIsRefreshing(false);
    });
  }, []);

  const applySelection = useCallback((next: StatisticsSelection) => {
    if (selectionKeyOf(next) === selectionKeyOf(selectionRef.current)) {
      selectionRef.current = next;
      setSelection(next);
      return;
    }
    selectionRef.current = next;
    setSelection(next);
    if (activeRef.current) {
      refresh();
    } else {
      // A hidden page does no work; entering it requests the new selection.
      cancelRequest();
    }
  }, [cancelRequest, refresh]);

  const selectDimension = useCallback((dimension: StatisticsDimension) => {
    const current = selectionRef.current;
    if (current.dimension === dimension) return;
    // The new dimension shows its period containing the current anchor. Only an
    // unrepresentable period at the calendar edge falls back to today.
    const anchor = dimension === 'all' || resolveStatisticsPeriod(dimension, current.anchor)
      ? current.anchor
      : formatLocalDate(optionsRef.current.now());
    applySelection({ dimension, anchor });
  }, [applySelection]);

  const shiftPeriod = useCallback((step: 1 | -1) => {
    const current = selectionRef.current;
    if (current.dimension === 'all') return;
    const anchor = shiftStatisticsAnchor(current.dimension, current.anchor, step);
    if (anchor === null) return;
    applySelection({ dimension: current.dimension, anchor });
  }, [applySelection]);

  const goPrevious = useCallback(() => shiftPeriod(-1), [shiftPeriod]);
  const goNext = useCallback(() => shiftPeriod(1), [shiftPeriod]);

  const retry = useCallback(() => {
    if (activeRef.current) refresh();
  }, [refresh]);

  // A deletion changes every period: other cached periods are dropped rather than shown
  // with a removed Book, and the current one keeps its data until the refresh replaces it.
  const invalidate = useCallback(() => {
    const key = selectionKeyOf(selectionRef.current);
    setCache((current) => {
      const kept = current.get(key);
      return kept ? new Map([[key, kept]]) : new Map();
    });
    if (activeRef.current) refresh();
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  // Entering 统计 (including a reader closing over it) refreshes; while shown, accepted
  // activity, reconnecting and a local day change refresh too. A day change only updates
  // `today`: the anchor the user is browsing never jumps back. Nothing runs while hidden.
  useEffect(() => {
    activeRef.current = active;
    if (!active) return undefined;

    if (!enteredRef.current) {
      // The first entry shows the month of that moment, even if App mounted on an earlier
      // local date; later entries keep whatever the session has browsed.
      enteredRef.current = true;
      const initial: StatisticsSelection = { dimension: 'month', anchor: formatLocalDate(optionsRef.current.now()) };
      if (selectionKeyOf(initial) !== selectionKeyOf(selectionRef.current)) {
        selectionRef.current = initial;
        setSelection(initial);
      }
    }
    refresh();

    const source = optionsRef.current.delivery;
    const onDeliveryStatus = () => {
      if (!source) return;
      const status = source.getStatus();
      setDeliveryNotice(statisticsDeliveryNoticeOf(status));
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
    const onOnline = () => refresh();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);

    return () => {
      activeRef.current = false;
      unsubscribe?.();
      if (midnightTimer !== null) clearTimeout(midnightTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      cancelRequest();
    };
  }, [active, cancelRequest, delivery, refresh]);

  const key = selectionKeyOf(selection);
  const statistics = cache.get(key) ?? null;
  const error = failure?.key === key ? failure.message : '';
  const status: ReadingStatisticsStatus = statistics
    ? 'ready'
    : error && !isRefreshing ? 'error' : 'loading';
  const period = useMemo(() => periodOf(selection), [selection]);
  const canGoPrevious = selection.dimension !== 'all' &&
    shiftStatisticsAnchor(selection.dimension, selection.anchor, -1) !== null;
  const canGoNext = selection.dimension !== 'all' &&
    shiftStatisticsAnchor(selection.dimension, selection.anchor, 1) !== null;

  return {
    selection,
    period,
    title: formatStatisticsTitle(selection.dimension, period),
    today,
    statistics,
    status,
    isRefreshing,
    error,
    deliveryNotice,
    canGoPrevious,
    canGoNext,
    selectDimension,
    goPrevious,
    goNext,
    retry,
    invalidate,
  };
}

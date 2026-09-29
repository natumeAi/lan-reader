/**
 * Presentation helpers for the 统计 page: period titles, overview values and change lines,
 * the trend chart's value axis and its (possibly sparse) bucket labels.
 *
 * Pure functions only. Values come from the decoded `ReadingStatisticsDto` or from the
 * shared period arithmetic; nothing here reads the network, storage or the reader.
 */
import type {
  StatisticsCalendarDayDto,
  StatisticsDimension,
  StatisticsMetricComparison,
  StatisticsMetricKey,
  StatisticsPeriod,
} from '@lan-reader/shared';
import type { ReadingActivityStatus } from './activityDelivery.js';
import { deliveryNoticeOf, formatSpokenDuration } from './readingStatsFormat.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

function dateParts(localDate: string) {
  const [year = 0, month = 0, day = 0] = localDate.split('-').map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function wholeSeconds(durationMs: number) {
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs / SECOND_MS) : 0;
}

export interface StatisticsCalendarCell {
  day: StatisticsCalendarDayDto;
  dayNumber: number;
  accessible: string;
}

/** Lay out the decoded month's complete days, Monday first, with empty edge cells. */
export function buildCalendarWeeks(days: readonly StatisticsCalendarDayDto[]): (StatisticsCalendarCell | null)[][] {
  const first = days[0];
  if (!first) return [];
  const leading = (dateParts(first.date).weekday + 6) % 7;
  const cells: (StatisticsCalendarCell | null)[] = Array.from({ length: leading }, () => null);
  for (const day of days) {
    const date = dateParts(day.date);
    const dateLabel = `${date.year}年${date.month}月${date.day}日`;
    const champion = day.champion;
    const duration = champion && champion.durationMs < SECOND_MS
      ? '不足 1 秒'
      : formatSpokenDuration(champion?.durationMs ?? 0);
    cells.push({
      day,
      dayNumber: date.day,
      accessible: champion
        ? `${dateLabel}，${champion.book.title || '未命名书籍'}，${duration}`
        : dateLabel,
    });
  }
  while (cells.length % 7) cells.push(null);
  const weeks: (StatisticsCalendarCell | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** The statistics page also names durable records still awaiting server confirmation. */
export function statisticsDeliveryNoticeOf(status: ReadingActivityStatus): string {
  const warning = deliveryNoticeOf(status);
  const pending = status.isDurable && status.pendingCount > 0
    ? `有 ${status.pendingCount} 条阅读记录${status.isDelivering ? '正在同步' : '待同步'}，统计可能尚未更新${status.isDelivering ? '' : '；联网后自动重试'}`
    : '';
  return [warning, pending].filter(Boolean).join('；');
}

// ---------------------------------------------------------------------------
// Period titles and navigation labels
// ---------------------------------------------------------------------------

/**
 * Title of a period: `2026年9月28日`, `9月28日到10月4日` (both ends with a year when the
 * week crosses one), `2026年9月`, `2026年` and `全部时间` for `all`.
 */
export function formatStatisticsTitle(dimension: StatisticsDimension, period: StatisticsPeriod | null): string {
  if (dimension === 'all' || !period) return '全部时间';
  const start = dateParts(period.start);
  switch (dimension) {
    case 'day':
      return `${start.year}年${start.month}月${start.day}日`;
    case 'week': {
      const end = dateParts(period.end);
      if (start.year !== end.year) {
        return `${start.year}年${start.month}月${start.day}日到${end.year}年${end.month}月${end.day}日`;
      }
      return `${start.month}月${start.day}日到${end.month}月${end.day}日`;
    }
    case 'month':
      return `${start.year}年${start.month}月`;
    case 'year':
      return `${start.year}年`;
  }
}

const PERIOD_NOUN: Record<Exclude<StatisticsDimension, 'all'>, string> = {
  day: '天',
  week: '周',
  month: '月',
  year: '年',
};

/** Accessible names of the previous/next buttons, e.g. `上一月` / `下一月`. */
export function periodNavigationLabels(dimension: Exclude<StatisticsDimension, 'all'>) {
  const noun = PERIOD_NOUN[dimension];
  return { previous: `上一${noun}`, next: `下一${noun}` };
}

// ---------------------------------------------------------------------------
// Overview values and change lines
// ---------------------------------------------------------------------------

/** A number shown large with a smaller unit after it, e.g. `{ value: '56', unit: '秒' }`. */
export interface ValuePart {
  value: string;
  unit: string;
}

/** One decimal, floored, without a trailing `.0`. */
function oneDecimal(value: number) {
  const rounded = Math.floor(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Duration split into value/unit pairs, floored to whole seconds: `56 秒`, `12 分钟`,
 * `12 分 30 秒`, `1 小时`, `1 小时 5 分`. Seconds are dropped from an hour on.
 */
export function durationParts(durationMs: number): ValuePart[] {
  const total = wholeSeconds(durationMs);
  if (total < 60) return [{ value: String(total), unit: '秒' }];
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds === 0
      ? [{ value: String(minutes), unit: '分钟' }]
      : [{ value: String(minutes), unit: '分' }, { value: String(seconds), unit: '秒' }];
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes === 0
    ? [{ value: String(hours), unit: '小时' }]
    : [{ value: String(hours), unit: '小时' }, { value: String(minutes), unit: '分' }];
}

function characterParts(characters: number): ValuePart[] {
  const count = Number.isFinite(characters) && characters > 0 ? Math.floor(characters) : 0;
  if (count < 10_000) return [{ value: String(count), unit: '字' }];
  if (count < 100_000_000) return [{ value: oneDecimal(count / 10_000), unit: '万字' }];
  return [{ value: oneDecimal(count / 100_000_000), unit: '亿字' }];
}

function countParts(count: number, unit: string): ValuePart[] {
  return [{ value: String(Math.max(0, Math.floor(count))), unit }];
}

type MetricKind = 'duration' | 'days' | 'books' | 'characters' | 'speed';

const METRIC_KIND: Record<StatisticsMetricKey, MetricKind> = {
  durationMs: 'duration',
  readingDays: 'days',
  averageDailyMs: 'duration',
  longestDayMs: 'duration',
  booksRead: 'books',
  booksCompleted: 'books',
  booksInProgress: 'books',
  characters: 'characters',
  charactersPerMinute: 'speed',
};

/**
 * Value of one overview metric. A `null` speed (no reading time in the period) is shown as
 * `0 字/分钟`: a display convention only, the decoded DTO keeps its `null`.
 */
export function metricValueParts(key: StatisticsMetricKey, value: number | null): ValuePart[] {
  const amount = value ?? 0;
  switch (METRIC_KIND[key]) {
    case 'duration':
      return durationParts(amount);
    case 'days':
      return countParts(amount, '天');
    case 'books':
      return countParts(amount, '本');
    case 'characters':
      return characterParts(amount);
    case 'speed':
      return countParts(amount, '字/分钟');
  }
}

export function joinValueParts(parts: readonly ValuePart[]): string {
  return parts.map((part) => (part.unit ? `${part.value} ${part.unit}` : part.value)).join(' ');
}

export interface MetricChange {
  /** Visual direction marker. */
  symbol: '↑' | '↓' | '—';
  /** Visible text after the marker: a magnitude or `持平`. */
  text: string;
  /** Complete sentence for assistive technology. */
  spoken: string;
}

/** `— 持平`: equal in both periods, e.g. the 记录笔记 placeholder (always 0 against 0). */
export function flatMetricChange(): MetricChange {
  return { symbol: '—', text: '持平', spoken: '与上一周期持平' };
}

/**
 * Change line against the complete previous period. A measured `delta` is shown as is:
 * only an exact zero is `持平`, and a non-zero duration difference below one second reads
 * `<1秒` rather than looking flat. Without comparable data (`unavailable`) the previous
 * period is taken as zero, so `current` (the overview value) is the increase and a zero or
 * `null` (no reading time) current value is `持平`. This is a display convention only:
 * neither the comparison nor the overview value is rewritten.
 */
export function formatMetricChange(
  key: StatisticsMetricKey,
  comparison: StatisticsMetricComparison,
  current: number | null,
): MetricChange {
  const delta = comparison.kind === 'delta' ? comparison.delta : current ?? 0;
  if (delta === 0) return flatMetricChange();
  const magnitude = Math.abs(delta);
  const text = METRIC_KIND[key] === 'duration' && magnitude < SECOND_MS
    ? '<1秒'
    : joinValueParts(metricValueParts(key, magnitude));
  return delta > 0
    ? { symbol: '↑', text, spoken: `比上一周期增加 ${text}` }
    : { symbol: '↓', text, spoken: `比上一周期减少 ${text}` };
}

// ---------------------------------------------------------------------------
// Trend value axis
// ---------------------------------------------------------------------------

/** Tick steps below an hour; from an hour on the step is a 1/2/3/5 × 10ⁿ hour count. */
const SUB_HOUR_STEPS_MS = [
  1, 2, 5, 10, 15, 30,
].map((seconds) => seconds * SECOND_MS).concat([
  1, 2, 5, 10, 15, 30,
].map((minutes) => minutes * MINUTE_MS));

export const TREND_AXIS_SEGMENTS = 4;

export interface TrendAxis {
  /** Top of the plot; a multiple of `step`. */
  maxMs: number;
  step: number;
  /** `0, step, …, maxMs` from bottom to top. */
  ticks: number[];
}

function hourStep(minimumMs: number) {
  const hours = minimumMs / HOUR_MS;
  for (let magnitude = 1; ; magnitude *= 10) {
    for (const factor of [1, 2, 3, 5]) {
      if (factor * magnitude >= hours) return factor * magnitude * HOUR_MS;
    }
  }
}

/**
 * Value axis scaled only by the largest bucket (never by a goal): the smallest readable
 * step whose four segments reach the maximum. An all-zero range uses a one-minute axis.
 */
export function buildTrendAxis(maxBucketMs: number): TrendAxis {
  const maximum = Number.isFinite(maxBucketMs) && maxBucketMs > 0 ? maxBucketMs : 0;
  const minimumStep = maximum > 0 ? maximum / TREND_AXIS_SEGMENTS : 15 * SECOND_MS;
  const step = SUB_HOUR_STEPS_MS.find((candidate) => candidate >= minimumStep) ?? hourStep(minimumStep);
  const ticks = Array.from({ length: TREND_AXIS_SEGMENTS + 1 }, (_, index) => index * step);
  return { maxMs: step * TREND_AXIS_SEGMENTS, step, ticks };
}

/** Axis tick text: `0`, `45 秒`, `1 分钟`, `1 分 30 秒`, `2 小时`, `1 小时 30 分`. */
export function formatAxisDuration(durationMs: number): string {
  if (!(durationMs > 0)) return '0';
  return joinValueParts(durationParts(durationMs));
}

// ---------------------------------------------------------------------------
// Trend bucket labels
// ---------------------------------------------------------------------------

export interface TrendBucketLabel {
  /** Short text under the bar; kept for every bucket even when not shown. */
  text: string;
  /** Whether the short text is shown; sparse labels never remove a bucket. */
  visible: boolean;
  /** Exact bucket and duration for assistive technology. */
  accessible: string;
}

/** At most this many year labels are shown for `all` before thinning. */
const MAX_YEAR_LABELS = 8;

/**
 * Indices of labelled buckets: every `stride` from the first, plus the last. A regular
 * label too close to the last one is dropped so the two never collide.
 */
function strideLabels(count: number, stride: number, minimumGap: number): Set<number> {
  const shown = new Set<number>();
  if (count === 0) return shown;
  const last = count - 1;
  for (let index = 0; index < count; index += stride) {
    if (index === 0 || last - index >= minimumGap) shown.add(index);
  }
  shown.add(last);
  return shown;
}

/**
 * Labels of the decoded trend buckets in order. Day buckets `00`–`23` show every six
 * hours and the last; a week shows 一…日; a month shows 1, 6, 11, … and its last day;
 * a year shows 1–12; `all` shows every year up to eight and thins beyond that.
 */
export function trendBucketLabels(
  dimension: StatisticsDimension,
  buckets: readonly { key: string; durationMs: number }[],
): TrendBucketLabel[] {
  const count = buckets.length;
  let shown: Set<number>;
  switch (dimension) {
    case 'day':
      shown = strideLabels(count, 6, 3);
      break;
    case 'month':
      shown = strideLabels(count, 5, 3);
      break;
    case 'all':
      shown = count <= MAX_YEAR_LABELS
        ? new Set(buckets.map((_, index) => index))
        : strideLabels(count, Math.ceil(count / (MAX_YEAR_LABELS - 1)), 2);
      break;
    case 'week':
    case 'year':
      shown = new Set(buckets.map((_, index) => index));
      break;
  }

  return buckets.map((bucket, index) => {
    // A drawn sub-second bar must not be announced as a measured zero.
    const spoken = bucket.durationMs > 0 && bucket.durationMs < SECOND_MS
      ? '不足 1 秒'
      : formatSpokenDuration(bucket.durationMs);
    let text: string;
    let name: string;
    switch (dimension) {
      case 'day': {
        const hour = Number(bucket.key);
        text = String(hour);
        name = `${hour}:00–${hour + 1}:00`;
        break;
      }
      case 'week': {
        const { month, day, weekday } = dateParts(bucket.key);
        text = WEEKDAYS[weekday] ?? '';
        name = `${month}月${day}日 周${text}`;
        break;
      }
      case 'month': {
        const { month, day } = dateParts(bucket.key);
        text = String(day);
        name = `${month}月${day}日`;
        break;
      }
      case 'year': {
        const [year = '', month = ''] = bucket.key.split('-');
        text = String(Number(month));
        name = `${Number(year)}年${Number(month)}月`;
        break;
      }
      case 'all':
        text = String(Number(bucket.key));
        name = `${text}年`;
        break;
    }
    return { text, visible: shown.has(index), accessible: `${name}：${spoken}` };
  });
}

/**
 * Notice for time recorded before hourly attribution existed. `null` when every known
 * second of the day has an hour. The gap is never described as time not read.
 */
export function hourlyGapNotice(unknownDurationMs: number, bucketTotalMs: number): string | null {
  if (!(unknownDurationMs > 0)) return null;
  if (bucketTotalMs <= 0) return '历史记录没有小时明细';
  const amount = unknownDurationMs < SECOND_MS ? '不足 1 秒' : formatSpokenDuration(unknownDurationMs);
  return `另有 ${amount} 未记录具体小时`;
}

/**
 * Presentation helpers for the 首页 reading dashboard: duration/character units,
 * goal progress, seven-day chart projection and goal input validation.
 *
 * Pure functions only. Values come from the decoded `ReadingStatsDto`; nothing
 * here reads the network, storage or the reader.
 */
import type { ReadingDayDto } from '@lan-reader/shared';
import {
  MAX_ANNUAL_BOOK_GOAL,
  MAX_DAILY_GOAL_MINUTES,
  MIN_ANNUAL_BOOK_GOAL,
  MIN_DAILY_GOAL_MINUTES,
} from '@lan-reader/shared';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

function wholeSeconds(durationMs: number) {
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs / SECOND_MS) : 0;
}

/** Stopwatch form for today's time: `m:ss` below an hour, `h:mm:ss` from an hour on. */
export function formatClockDuration(durationMs: number): string {
  const total = wholeSeconds(durationMs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** One decimal, without a trailing `.0`. */
function oneDecimal(value: number) {
  const rounded = Math.floor(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Summary unit for 累计时长: 秒 below a minute, 分钟 below an hour, then 小时. */
export function formatTotalDuration(durationMs: number): string {
  const total = wholeSeconds(durationMs);
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
  const hours = total / 3600;
  return hours < 100 ? `${oneDecimal(hours)} 小时` : `${Math.floor(hours)} 小时`;
}

/** Exact spoken duration, e.g. `1 小时 5 分 3 秒`, for accessible chart values. */
export function formatSpokenDuration(durationMs: number): string {
  const total = wholeSeconds(durationMs);
  if (total === 0) return '0 秒';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [
    hours ? `${hours} 小时` : '',
    minutes ? `${minutes} 分` : '',
    seconds ? `${seconds} 秒` : '',
  ].filter(Boolean).join(' ');
}

/** 累计字数: `N 字` below ten thousand, then `x.y 万字` / `x.y 亿字`. */
export function formatCharacterCount(characters: number): string {
  const count = Number.isFinite(characters) && characters > 0 ? Math.floor(characters) : 0;
  if (count < 10_000) return `${count} 字`;
  if (count < 100_000_000) return `${oneDecimal(count / 10_000)} 万字`;
  return `${oneDecimal(count / 100_000_000)} 亿字`;
}

/** Visual gauge fraction `0..1`; the time text keeps counting past the goal. */
export function goalProgressFraction(durationMs: number, dailyGoalMinutes: number): number {
  const goalMs = dailyGoalMinutes * MINUTE_MS;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !(goalMs > 0)) return 0;
  return Math.min(1, durationMs / goalMs);
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

export interface ReadingChartBar {
  date: string;
  durationMs: number;
  isToday: boolean;
  /** Bar height as a fraction `0..1` of the plot; `0` is drawn as the flat zero dash. */
  heightFraction: number;
  /** Short visible label under the bar: `M/D`, e.g. `9/23`; today is emphasized by the card. */
  shortLabel: string;
  /** Exact date and duration for assistive technology, e.g. `9月23日 周三（今天）：5 分 2 秒`. */
  accessibleLabel: string;
}

function calendarParts(localDate: string) {
  const [year = 0, month = 0, day = 0] = localDate.split('-').map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/**
 * Projects the seven decoded days into bars. The scale is the larger of the
 * busiest day and the daily goal, so reaching the goal fills the plot and a
 * single short session is not exaggerated to full height.
 */
export function buildReadingChart(
  days: readonly ReadingDayDto[],
  today: string,
  dailyGoalMinutes: number,
): ReadingChartBar[] {
  const scale = Math.max(dailyGoalMinutes * MINUTE_MS, ...days.map((day) => day.durationMs), 1);
  return days.map((day) => {
    const { month, day: dayOfMonth, weekday } = calendarParts(day.date);
    const isToday = day.date === today;
    const weekdayName = WEEKDAYS[weekday] ?? '';
    return {
      date: day.date,
      durationMs: day.durationMs,
      isToday,
      heightFraction: day.durationMs > 0 ? Math.min(1, day.durationMs / scale) : 0,
      shortLabel: `${month}/${dayOfMonth}`,
      accessibleLabel: `${month}月${dayOfMonth}日 周${weekdayName}${isToday ? '（今天）' : ''}：${formatSpokenDuration(day.durationMs)}`,
    };
  });
}

export type GoalKind = 'daily' | 'annual';

export const GOAL_BOUNDS: Record<GoalKind, { min: number; max: number; unit: string }> = {
  daily: { min: MIN_DAILY_GOAL_MINUTES, max: MAX_DAILY_GOAL_MINUTES, unit: '分钟' },
  annual: { min: MIN_ANNUAL_BOOK_GOAL, max: MAX_ANNUAL_BOOK_GOAL, unit: '本' },
};

export type GoalInputResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * Parses a goal field. Only plain decimal integers within the shared bounds are
 * accepted; blanks, decimals, signs, exponents and out-of-range values are
 * refused with a message and never reach the server.
 */
export function parseGoalInput(kind: GoalKind, raw: string): GoalInputResult {
  const { min, max } = GOAL_BOUNDS[kind];
  const range = `请输入 ${min}–${max} 之间的整数`;
  const text = raw.trim();
  if (!text) return { ok: false, message: range };
  if (!/^\d+$/.test(text)) return { ok: false, message: range };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) return { ok: false, message: range };
  return { ok: true, value };
}

/** Milliseconds until the next browser-local midnight (at least 1 ms). */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

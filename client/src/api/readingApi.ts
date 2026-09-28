import type { ReadingGoalsUpdate, ReadingPositionUpdate, ReadingStatisticsDto, ReadingStatisticsQuery } from '@lan-reader/shared';
import { WireDecodeError, decodeReadingActivityBatchResponse, decodeReadingGoalsResponse, decodeReadingStatisticsResponse, decodeReadingStatsResponse, resolveStatisticsPeriod } from '@lan-reader/shared';
import { request, jsonBody } from './transport.js';
import { decodeBook, decodeProgress, decodeRecent } from './decoders.js';
export const getReadingProgress = (bookId: number) => request(`/api/reading/${bookId}`, decodeProgress, { errorMessage: '无法加载阅读进度' });
export const listRecentReading = () => request('/api/reading/recent', decodeRecent, { errorMessage: '无法加载最近阅读' });
export const saveReadingProgress = (bookId: number, { cfi, progress, chapterHref, chapterLabel, chapterCount, chapterIndex }: ReadingPositionUpdate, options: { keepalive?: boolean; signal?: AbortSignal } = {}) => request(`/api/reading/${bookId}`, decodeProgress, { method: 'PUT', ...jsonBody({ cfi, progress, chapterHref, chapterLabel, chapterCount, chapterIndex }), keepalive: Boolean(options.keepalive), signal: options.signal, errorMessage: '无法保存阅读进度' });
/**
 * POST /api/reading/activity with a pre-serialized body.
 *
 * The caller builds `body` by joining stored event payload strings, so every
 * retry of a record sends exactly the bytes first persisted for it. The
 * response is decoded by the shared contract decoder.
 */
export const postReadingActivity = (body: string, options: { keepalive?: boolean; signal?: AbortSignal } = {}) => request('/api/reading/activity', decodeReadingActivityBatchResponse, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: Boolean(options.keepalive), signal: options.signal, errorMessage: '无法同步阅读记录' });
/** GET /api/reading/stats for the browser-local `date` (YYYY-MM-DD); Books use the client decoder. */
export const getReadingStats = (date: string, options: { signal?: AbortSignal; bookId?: number | null } = {}) => request(`/api/reading/stats?date=${encodeURIComponent(date)}${options.bookId == null ? '' : `&bookId=${options.bookId}`}`, value => decodeReadingStatsResponse(value, decodeBook), { signal: options.signal, errorMessage: '无法加载阅读统计' });
/** PUT /api/reading/goals; resolves with the authoritative saved goals. */
export const updateReadingGoals = (update: ReadingGoalsUpdate) => request('/api/reading/goals', decodeReadingGoalsResponse, { method: 'PUT', ...jsonBody(update), errorMessage: status => status === 400 ? '目标数值无效，未保存' : '无法保存阅读目标' });
/** A response for another dimension, period or today must never be shown under this query's title. */
function requireRequestedRange(statistics: ReadingStatisticsDto, { dimension, anchor, today }: ReadingStatisticsQuery): ReadingStatisticsDto {
  const { range } = statistics;
  const start = dimension === 'all' || anchor === null ? null : resolveStatisticsPeriod(dimension, anchor)?.start ?? null;
  if (range.dimension !== dimension || range.today !== today || (start !== null && range.start !== start)) {
    throw new WireDecodeError('statistics range does not match the request');
  }
  return statistics;
}
/**
 * GET /api/reading/statistics for one browser-local period. `all` sends no anchor; the
 * shared decoder checks buckets and totals, then the range must be the requested one.
 */
export const getReadingStatistics = (query: ReadingStatisticsQuery, options: { signal?: AbortSignal } = {}) => {
  const { dimension, anchor, today } = query;
  const params = new URLSearchParams({ dimension });
  if (dimension !== 'all' && anchor !== null) params.set('anchor', anchor);
  params.set('today', today);
  return request(`/api/reading/statistics?${params.toString()}`, value => requireRequestedRange(decodeReadingStatisticsResponse(value, decodeBook), query), { signal: options.signal, errorMessage: '无法加载阅读统计' });
};

import type { ReadingPositionUpdate } from '@lan-reader/shared';
import { decodeReadingActivityBatchResponse } from '@lan-reader/shared';
import { request, jsonBody } from './transport.js';
import { decodeProgress, decodeRecent } from './decoders.js';
export const getReadingProgress = (bookId: number) => request(`/api/reading/${bookId}`, decodeProgress, { errorMessage: '无法加载阅读进度' });
export const listRecentReading = () => request('/api/reading/recent', decodeRecent, { errorMessage: '无法加载最近阅读' });
export const saveReadingProgress = (bookId: number, { cfi, progress, chapterHref, chapterLabel }: ReadingPositionUpdate, options: { keepalive?: boolean; signal?: AbortSignal } = {}) => request(`/api/reading/${bookId}`, decodeProgress, { method: 'PUT', ...jsonBody({ cfi, progress, chapterHref, chapterLabel }), keepalive: Boolean(options.keepalive), signal: options.signal, errorMessage: '无法保存阅读进度' });
/**
 * POST /api/reading/activity with a pre-serialized body.
 *
 * The caller builds `body` by joining stored event payload strings, so every
 * retry of a record sends exactly the bytes first persisted for it. The
 * response is decoded by the shared contract decoder.
 */
export const postReadingActivity = (body: string, options: { keepalive?: boolean; signal?: AbortSignal } = {}) => request('/api/reading/activity', decodeReadingActivityBatchResponse, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: Boolean(options.keepalive), signal: options.signal, errorMessage: '无法同步阅读记录' });

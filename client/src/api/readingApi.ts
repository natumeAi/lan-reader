import type { ReadingPositionUpdate } from '@lan-reader/shared';
import { request, jsonBody } from './transport.js';
import { decodeProgress, decodeRecent } from './decoders.js';
export const getReadingProgress = (bookId: number) => request(`/api/reading/${bookId}`, decodeProgress, { errorMessage: '无法加载阅读进度' });
export const listRecentReading = () => request('/api/reading/recent', decodeRecent, { errorMessage: '无法加载最近阅读' });
export const saveReadingProgress = (bookId: number, { cfi, progress, chapterHref, chapterLabel }: ReadingPositionUpdate, options: { keepalive?: boolean; signal?: AbortSignal } = {}) => request(`/api/reading/${bookId}`, decodeProgress, { method: 'PUT', ...jsonBody({ cfi, progress, chapterHref, chapterLabel }), keepalive: Boolean(options.keepalive), signal: options.signal, errorMessage: '无法保存阅读进度' });

import { requireRecord } from '@lan-reader/shared';
import type { LibrarySnapshot } from '@lan-reader/shared';
import { requestResponse, decodeResponse } from './transport.js';
import { decodeLibrarySnapshot } from './decoders.js';
export type SnapshotResponse = { notModified: true; etag: string | null; snapshot: null } | { notModified: false; etag: string | null; snapshot: LibrarySnapshot };
export async function getLibrarySnapshot(options: { etag?: string | null; signal?: AbortSignal } = {}): Promise<SnapshotResponse> {
  const headers: Record<string, string> = {};
  if (options.etag) headers['If-None-Match'] = options.etag;
  const response = await requestResponse('/api/library/snapshot', { cache: 'no-store', headers, signal: options.signal, errorMessage: '无法加载书库' });
  if (response.status === 304) return { etag: options.etag ?? null, notModified: true, snapshot: null };
  return { etag: response.headers.get('ETag'), notModified: false, snapshot: await decodeResponse(response, value => decodeLibrarySnapshot(requireRecord(value, 'response')['snapshot'])) };
}

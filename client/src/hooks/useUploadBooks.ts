import type { ChangeEvent } from 'react';
import type { LoadShelfOptions } from './useShelfData.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/transport.js';
import { uploadBook } from '../api/booksApi.js';

export interface UploadEntry {
  id: string;
  file: File;
  fileName: string;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed';
  bookId: number | null;
  error: string | null;
}

export function isEpubFile(file: File): boolean {
  return /\.epub$/i.test(file.name) || file.type === 'application/epub+zip';
}

interface UploadQueue {
  entries: UploadEntry[];
  completed: number;
  total: number;
}
const noop = () => {};

/** One worker owns the sequential queue, including files appended during an upload. */
export function useUploadBooks({ loadShelf = noop }: {
  loadShelf?: (options: LoadShelfOptions) => unknown;
} = {}) {
  const [queue, setQueue] = useState<UploadQueue>({ entries: [], completed: 0, total: 0 });
  const queueRef = useRef(queue);
  const workerRef = useRef<Promise<void> | null>(null);
  const lifetimeRef = useRef(0);
  const mountedRef = useRef(true);
  const nextIdRef = useRef(0);
  const loadShelfRef = useRef(loadShelf);
  loadShelfRef.current = loadShelf;

  const publish = useCallback((next: UploadQueue) => {
    queueRef.current = next;
    if (mountedRef.current) setQueue(next);
  }, []);

  const startWorker = useCallback((): Promise<void> => {
    if (workerRef.current) return workerRef.current;
    const lifetime = lifetimeRef.current;
    const isCurrent = () => mountedRef.current && lifetimeRef.current === lifetime;
    const run = async () => {
      while (isCurrent()) {
        const entry = queueRef.current.entries.find(item => item.status === 'queued');
        if (!entry) break;
        const updateEntry = (changes: Partial<UploadEntry>, completed = 0) => {
          const current = queueRef.current;
          publish({ ...current, completed: current.completed + completed,
            entries: current.entries.map(item => item.id === entry.id ? { ...item, ...changes } : item) });
        };
        updateEntry({ status: 'uploading' });
        try {
          const { book } = await uploadBook(entry.file);
          if (!isCurrent()) return;
          updateEntry({ status: 'uploaded', bookId: book.id }, 1);
          // A failed refresh must not make a committed import retryable (that would duplicate it).
          try { await loadShelfRef.current({ background: true, allowCached: false }); } catch { /* wait for later revalidation */ }
        } catch (error) {
          if (!isCurrent()) return;
          updateEntry({ status: 'failed', error: errorMessage(error, '上传失败') }, 1);
        }
      }
    };
    const worker = run().finally(() => {
      if (workerRef.current === worker) workerRef.current = null;
    });
    workerRef.current = worker;
    return worker;
  }, [publish]);

  const enqueue = useCallback((files: readonly File[]): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    const entries: UploadEntry[] = files.filter(isEpubFile).map(file => ({
      id: `upload:${++nextIdRef.current}`, file, fileName: file.name || '未命名文件',
      status: 'queued', bookId: null, error: null,
    }));
    if (!entries.length) return Promise.resolve();
    const current = queueRef.current;
    const pending = current.entries.some(item => item.status === 'queued' || item.status === 'uploading');
    publish({ entries: [...current.entries, ...entries], completed: pending ? current.completed : 0,
      total: (pending ? current.total : 0) + entries.length });
    return startWorker();
  }, [publish, startWorker]);

  const retryUpload = useCallback((id: string): Promise<void> => {
    const current = queueRef.current;
    const entry = current.entries.find(item => item.id === id && item.status === 'failed');
    if (!entry || !mountedRef.current) return Promise.resolve();
    const pending = current.entries.some(item => item.status === 'queued' || item.status === 'uploading');
    publish({ entries: [...current.entries.filter(item => item.id !== id),
      { ...entry, status: 'queued', error: null, bookId: null }],
      completed: pending ? current.completed : 0, total: (pending ? current.total : 0) + 1 });
    return startWorker();
  }, [publish, startWorker]);

  const removeUpload = useCallback((id: string) => {
    const current = queueRef.current;
    publish({ ...current, entries: current.entries.filter(item => item.id !== id || item.status !== 'failed') });
  }, [publish]);

  /** Acknowledge only books in the published shelf, never a deferred snapshot/catalog. */
  const acknowledgeUploads = useCallback((ids: readonly string[]) => {
    const current = queueRef.current;
    publish({ ...current, entries: current.entries.filter(item => item.status !== 'uploaded' || !ids.includes(item.id)) });
  }, [publish]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    return enqueue(files);
  }, [enqueue]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifetimeRef.current += 1;
      workerRef.current = null;
      queueRef.current = { entries: [], completed: 0, total: 0 };
    };
  }, []);

  const isUploading = queue.entries.some(item => item.status === 'queued' || item.status === 'uploading');
  return { enqueue, handleFileChange, retryUpload, removeUpload, acknowledgeUploads,
    uploadEntries: queue.entries, isUploading,
    uploadProgress: isUploading ? `正在上传 ${Math.min(queue.completed + 1, queue.total)}/${queue.total}` : '' };
}

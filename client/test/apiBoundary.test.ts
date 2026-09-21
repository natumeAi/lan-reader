import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteBook, uploadBook } from '../src/api/booksApi.js';
import { listFolderBooks, renameFolder } from '../src/api/foldersApi.js';
import { getLibrarySnapshot } from '../src/api/libraryApi.js';
import { saveReadingProgress } from '../src/api/readingApi.js';
import { ApiError, decodeResponse } from '../src/api/transport.js';
import { decodeLibrarySnapshot } from '../src/api/decoders.js';
import { readProgressOutbox, PROGRESS_OUTBOX_KEY } from '../src/utils/readingProgress.js';

const book = {
  id: 1, folderId: null, title: 'Book', fileName: 'book.epub', fileSize: 1,
  sortOrder: 0, createdAt: '2026-09-21', updatedAt: '2026-09-21',
};

test('upload preserves FormData and decodes the L6 BookDto response', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/books');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers, undefined, 'browser owns the multipart boundary');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file') instanceof File, true);
    return Response.json({ book }, { status: 201 });
  });
  const result = await uploadBook(new File(['fixture'], 'book.epub'));
  assert.equal(result.book.fileName, 'book.epub');
  assert.equal('file_name' in result.book, false);
});

test('upload error text and status remain available in one ApiError shape', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'EPUB 文件无效或已损坏' }, { status: 400 }));
  await assert.rejects(uploadBook(new File([], 'bad.epub')), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.message, 'EPUB 文件无效或已损坏');
    return true;
  });
});

test('304 preserves its ETag and never reads a nonexistent body', async (t) => {
  const response = new Response(null, { status: 304 });
  const json = t.mock.method(response, 'json', () => { throw new Error('304 body read'); });
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), '"library-7"');
    assert.equal(options.cache, 'no-store');
    return response;
  });
  assert.deepEqual(await getLibrarySnapshot({ etag: '"library-7"' }), {
    notModified: true, etag: '"library-7"', snapshot: null,
  });
  assert.equal(json.mock.callCount(), 0);
});

test('reading save retains keepalive, AbortSignal, JSON fields and error status', async (t) => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.signal, signal);
    assert.equal(options.keepalive, true);
    assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json');
    assert.equal(options.body, JSON.stringify({ cfi: 'cfi', progress: 0.2, chapterHref: null, chapterLabel: 'Chapter' }));
    return Response.json({ error: 'gone' }, { status: 404 });
  });
  await assert.rejects(saveReadingProgress(1, { cfi: 'cfi', progress: 0.2, chapterHref: null, chapterLabel: 'Chapter' }, { signal, keepalive: true }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.message, '无法保存阅读进度');
    return true;
  });
});

test('cancellation keeps the native AbortError and endpoint-specific messages remain intact', async (t) => {
  const signal = new AbortController().signal;
  const abort = new DOMException('cancelled', 'AbortError');
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.signal, signal);
    throw abort;
  });
  await assert.rejects(listFolderBooks(1, { signal }), error => error === abort);
  fetch.mock.mockImplementation(async () => Response.json({ error: 'other' }, { status: 404 }));
  await assert.rejects(deleteBook(1), { message: '书籍不存在', status: 404 });
});

test('rename always supplies name including empty input and validates returned records', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.body, '{"name":""}');
    return Response.json({ folder: { id: 1, name: '新建文件夹', sortOrder: 0, bookCount: 0, previewBooks: [], createdAt: '', updatedAt: '' } });
  });
  assert.equal((await renameFolder(1, '')).folder.name, '新建文件夹');
});

test('cancelling while the response body streams preserves AbortError', async (t) => {
  const abort = new DOMException('cancelled while reading body', 'AbortError');
  const response = Response.json({ book });
  t.mock.method(response, 'json', async () => { throw abort; });
  await assert.rejects(decodeResponse(response, value => value), error => error === abort);

  const failedResponse = Response.json({ error: 'upload failed' }, { status: 400 });
  t.mock.method(failedResponse, 'json', async () => { throw abort; });
  t.mock.method(globalThis, 'fetch', async () => failedResponse);
  await assert.rejects(uploadBook(new File([], 'book.epub')), error => error === abort);
});

test('malformed JSON, invalid records and network failures reject at the transport boundary', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{invalid', { status: 200 }));
  await assert.rejects(deleteBook(1), { name: 'ApiError', status: 200 });
  fetch.mock.mockImplementation(async () => Response.json({ book: { ...book, title: [] } }));
  await assert.rejects(deleteBook(1), { name: 'ApiError', status: 200 });
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  await assert.rejects(deleteBook(1), { name: 'ApiError', status: 0, message: 'offline' });
});

test('snapshot normalization rejects malformed nested cache fields without unchecked casts', () => {
  const snapshot = { schemaVersion: 1, version: 1, books: [book], folders: [], shelf: [], recent: [] };
  assert.equal(decodeLibrarySnapshot(snapshot).books[0]?.author, null);
  assert.throws(() => decodeLibrarySnapshot({ ...snapshot, books: [{ ...book, title: {} }] }), /string/);
  assert.throws(() => decodeLibrarySnapshot({ ...snapshot, folders: [{ id: 1, bookIds: 'invalid' }] }), /array/);
  assert.throws(() => decodeLibrarySnapshot({ ...snapshot, recent: [{ bookId: 1, progress: null }] }), /object/);
});

test('pending position storage discards malformed entries while retaining valid legacy records', () => {
  const storage = {
    getItem(key: string) {
      assert.equal(key, PROGRESS_OUTBOX_KEY);
      return JSON.stringify({ version: 1, records: { a: { bookId: 2, progress: 0.3 }, b: { bookId: 3, progress: 9 }, c: null } });
    },
    setItem() {}, removeItem() {},
  };
  assert.deepEqual(readProgressOutbox(storage), { 2: { bookId: 2, progress: 0.3, cfi: null, chapterHref: null, chapterLabel: null } });
});

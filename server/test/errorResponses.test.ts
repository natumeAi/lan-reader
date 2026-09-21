/**
 * The body every failure leaves the application with.
 *
 * Step 2 replaced ad-hoc `new Error()` + `.status` assignments with `HttpError`
 * and moved the error handler into `createApp`. The handler still has to accept
 * anything error-like — `HttpError`, `InvalidEpubError`, multer's `MulterError`
 * and a driver error with no status at all — and it still has to expose `code`
 * only below 500 and never leak a message from a 500.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/database.js';
import type { DatabaseHandle } from '../src/db/rows.js';
import { readErrorCode } from '../src/http/httpError.js';
import { createApp } from '../src/app.js';
import { withServer } from './support/http.js';

/** The error a statement raises, so a test can inspect what the handler sees. */
function driverErrorFor(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('the statement was expected to fail');
}

function createLibrary(): DatabaseHandle {
  const db = initializeDatabase(new Database(':memory:'));

  db.prepare<[number, string, string, string, number, number]>(`
    INSERT INTO books (id, title, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 'Book 1', '1.epub', 'data/books/1.epub', 1024, 1000);

  return db;
}

function epubUpload(fileName: string, contents: string, field = 'file'): FormData {
  const form = new FormData();

  form.append(
    field,
    new File([Buffer.from(contents)], fileName, { type: 'application/epub+zip' }),
  );

  return form;
}

test('HttpError statuses below 500 answer with their own message and no code', async () => {
  const db = createLibrary();

  await withServer(createApp({ db }), async (baseUrl) => {
    const badRequest = await fetch(`${baseUrl}/api/books/abc`);
    assert.equal(badRequest.status, 400);
    assert.deepEqual(await badRequest.json(), {
      error: 'book id must be a positive integer',
    });

    const notFound = await fetch(`${baseUrl}/api/books/999`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: 'Book not found' });

    const conflict = await fetch(`${baseUrl}/api/books/order`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds: [999] }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'Book order is out of date' });

    const missing = await fetch(`${baseUrl}/api/nothing-here`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Not Found' });
  });

  db.close();
});

test('a server without a database answers 503 and names the cause', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const unavailable = await fetch(`${baseUrl}/api/books`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'Database is not configured' });

    // `/api/health` is the one database-aware route that must stay 200.
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      service: 'epub-reader-server',
      database: 'unconfigured',
    });
  });
});

test('error codes reach the client whenever the status stays below 500', async () => {
  const db = createLibrary();

  await withServer(createApp({ db }), async (baseUrl) => {
    const unknownBook = await fetch(`${baseUrl}/api/reading/999`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: 0.5 }),
    });
    assert.equal(unknownBook.status, 404);
    assert.deepEqual(await unknownBook.json(), {
      error: 'Book not found',
      code: 'BOOK_NOT_FOUND',
    });

    // InvalidEpubError: its own class, but the same 400 + code contract.
    const invalidEpub = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: epubUpload('broken.epub', 'this is not a ZIP archive'),
    });
    assert.equal(invalidEpub.status, 400);
    assert.deepEqual(await invalidEpub.json(), {
      error: 'EPUB 文件无效或已损坏',
      code: 'INVALID_EPUB',
    });

    // MulterError: not an HttpError at all, and still handled the same way.
    const unexpectedField = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: epubUpload('book.epub', 'PK', 'cover'),
    });
    assert.equal(unexpectedField.status, 400);
    assert.deepEqual(await unexpectedField.json(), {
      error: 'Unexpected file field',
      code: 'LIMIT_UNEXPECTED_FILE',
    });

    // The route's own multipart rejection keeps its message and carries no code.
    const wrongExtension = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: epubUpload('notes.txt', 'plain text'),
    });
    assert.equal(wrongExtension.status, 400);
    assert.deepEqual(await wrongExtension.json(), {
      error: 'Only EPUB files are supported',
    });

    const withoutFile = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: new FormData(),
    });
    assert.equal(withoutFile.status, 400);
    assert.deepEqual(await withoutFile.json(), { error: 'EPUB file is required' });
  });

  db.close();
});

test('a 500 hides both the message and the code it was raised with', async (t) => {
  const db = createLibrary();
  // The catalog query joins `folders`; without the table the driver raises a
  // SqliteError, which carries a `code` (SQLITE_ERROR) but no status.
  db.exec('DROP TABLE folders');
  assert.equal(
    readErrorCode(driverErrorFor(() => db.prepare('SELECT * FROM folders').get())),
    'SQLITE_ERROR',
    'the 500 below is only meaningful while the driver error carries a code',
  );

  const loggedCalls: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]): void => {
    loggedCalls.push(args);
  });

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books/catalog`);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
  });

  assert.equal(loggedCalls.length, 1, 'a 500 has to be logged exactly once');
  assert.equal(loggedCalls[0]?.[0], 'GET /api/books/catalog');

  db.close();
});

test('a 500 raised by the application itself reports nothing but the status', async (t) => {
  const db = initializeDatabase(new Database(':memory:'));
  // A file_path outside the data directory can only come from a hand-edited
  // database; reading it raises `internalError`, which has no code to leak.
  db.prepare<[number, string, string, string, number, number]>(`
    INSERT INTO books (id, title, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 'Escaped', '1.epub', 'outside/1.epub', 1024, 1000);

  t.mock.method(console, 'error', (): void => {
    // The handler logs the stack of every 500; the test does not need it.
  });

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books/1/file`);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
  });

  db.close();
});

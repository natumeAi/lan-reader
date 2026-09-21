/**
 * The one intentional behaviour change of step 2.
 *
 * Express 5 leaves `req.body` undefined when no JSON body was parsed. The
 * pre-migration routes read a field off it straight away, so a request with no
 * body at all raised a TypeError and surfaced as 500 — while the very same
 * request with `{}` was answered 400 by the validation. Section 10 of the
 * migration plan measured that; `readRequestBody` now treats a missing body as
 * the empty object, so both requests get the same 400.
 *
 * Every affected route is pinned below, together with its `{}` counterpart, so
 * the two can never drift apart again. `express.json()`'s own parse errors are
 * deliberately not intercepted and keep passing through untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/database.js';
import type { DatabaseHandle } from '../src/db/rows.js';
import { createApp } from '../src/app.js';
import { readJsonRecord, readRecord, withServer } from './support/http.js';

function createLibrary(): DatabaseHandle {
  const db = initializeDatabase(new Database(':memory:'));

  db.prepare<[number, string, string, string, number, number]>(`
    INSERT INTO books (id, title, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 'Book 1', '1.epub', 'data/books/1.epub', 1024, 1000);

  return db;
}

function jsonRequest(body: unknown): RequestInit {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('routes that read a body answer 400 whether the body is missing or empty', async () => {
  const db = createLibrary();

  await withServer(createApp({ db }), async (baseUrl) => {
    const cases = [
      {
        error: 'bookIds must be an array',
        method: 'PATCH',
        path: '/api/books/order',
      },
      {
        error: 'items must be an array',
        method: 'PATCH',
        path: '/api/folders/shelf/order',
      },
      {
        error: 'sourceBookId must be a positive integer',
        method: 'POST',
        path: '/api/folders',
      },
      {
        error: 'progress must be a number between 0 and 1',
        method: 'PUT',
        path: '/api/reading/1',
      },
    ];

    for (const { error, method, path } of cases) {
      const withoutBody = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(withoutBody.status, 400, `${method} ${path} without a body`);
      assert.deepEqual(await withoutBody.json(), { error });

      const withEmptyBody = await fetch(`${baseUrl}${path}`, {
        method,
        ...jsonRequest({}),
      });
      assert.equal(withEmptyBody.status, 400, `${method} ${path} with {}`);
      assert.deepEqual(await withEmptyBody.json(), { error });
    }
  });

  db.close();
});

test('renaming requires a name key and never resets a Folder on a missing body', async () => {
  const db = createLibrary();

  await withServer(createApp({ db }), async (baseUrl) => {
    // Validate the patch before any mutation, even when the Folder is absent.
    const missingFolder = await fetch(`${baseUrl}/api/folders/1`, { method: 'PATCH' });
    assert.equal(missingFolder.status, 400);
    assert.deepEqual(await missingFolder.json(), { error: 'name is required' });

    db.prepare<[string, number]>(
      'INSERT INTO folders (id, name, sort_order) VALUES (1, ?, ?)',
    ).run('技术', 1000);

    for (const body of [undefined, {}]) {
      const rejected = await fetch(`${baseUrl}/api/folders/1`, {
        method: 'PATCH',
        ...(body === undefined ? {} : jsonRequest(body)),
      });
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), { error: 'name is required' });
      const unchanged = await readJsonRecord(await fetch(`${baseUrl}/api/folders/1`));
      assert.equal(readRecord(unchanged['folder'], 'folder')['name'], '技术');
    }

    const existingFolder = await fetch(`${baseUrl}/api/folders/1`, {
      method: 'PATCH',
      ...jsonRequest({ name: '' }),
    });
    assert.equal(existingFolder.status, 200);
    assert.equal(
      readRecord((await readJsonRecord(existingFolder))['folder'], 'folder')['name'],
      '新建文件夹',
    );

    const namedMissing = await fetch(`${baseUrl}/api/folders/99`, {
      method: 'PATCH',
      ...jsonRequest({ name: '有效名称' }),
    });
    assert.equal(namedMissing.status, 404);
    assert.deepEqual(await namedMissing.json(), { error: 'Folder not found' });
  });

  db.close();
});

test('a JSON body the parser rejects still fails as a parse error', async () => {
  const db = createLibrary();

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books/order`, {
      method: 'PATCH',
      ...jsonRequest(null),
    });
    const body = await readJsonRecord(response);

    assert.equal(response.status, 400);
    assert.equal(typeof body['error'], 'string');
    assert.notEqual(
      body['error'],
      'bookIds must be an array',
      'express.json() has to answer before the route validation runs',
    );
  });

  db.close();
});

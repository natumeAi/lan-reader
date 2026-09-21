/**
 * What a failed upload leaves behind.
 *
 * `POST /api/books` stages the file first and only publishes it once the
 * archive validated and the row was written. Every failure before that point
 * has to remove the staged file, the published file and any cover that was
 * generated for it — otherwise a rejected upload silently fills the data
 * directory. The files here are hand-built: no real book is ever imported.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { CountRow, DatabaseHandle } from '../src/db/rows.js';
import { readJsonRecord, withServer } from './support/http.js';

const testDataDir = mkdtempSync(path.join(tmpdir(), 'epub-reader-upload-cleanup-'));
process.env.EPUB_DATA_DIR = testDataDir;
// Read once, at import time, by `routes/books.ts`. 1/128 MiB is exactly 8192
// bytes — multer only accepts an integer byte limit — so a modest buffer is
// enough to make it reject the request for being too large.
process.env.EPUB_UPLOAD_MAX_MB = '0.0078125';

const { default: Database } = await import('better-sqlite3');
const { initializeDatabase } = await import('../src/db/database.js');
const { booksDir, coversDir, stagingDir } = await import('../src/services/fileStorage.js');
const { createApp } = await import('../src/app.js');

after(() => {
  const resolvedTestDataDir = path.resolve(testDataDir);
  assert.ok(resolvedTestDataDir.startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  rmSync(resolvedTestDataDir, { force: true, recursive: true });
});

function entriesIn(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : [];
}

function bookCount(db: DatabaseHandle): number {
  const row = db.prepare<[], CountRow>('SELECT COUNT(*) AS value FROM books').get();

  assert.ok(row);

  return row.value;
}

function assertNothingLeftBehind(db: DatabaseHandle): void {
  assert.deepEqual(entriesIn(stagingDir), [], 'the staging directory must be empty');
  assert.deepEqual(entriesIn(booksDir), [], 'no file may be published');
  assert.deepEqual(entriesIn(coversDir), [], 'no cover may be generated');
  assert.equal(bookCount(db), 0, 'no Book row may be written');
}

function upload(fileName: string, contents: Buffer | string): FormData {
  const form = new FormData();

  form.append(
    'file',
    new File([Buffer.from(contents)], fileName, { type: 'application/epub+zip' }),
  );

  return form;
}

test('a file that is not a readable EPUB archive leaves nothing behind', async () => {
  const db = initializeDatabase(new Database(':memory:'));

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: upload('pretend.epub', 'PLAIN TEXT, not a ZIP archive'),
    });
    const body = await readJsonRecord(response);

    assert.equal(response.status, 400);
    assert.equal(body['code'], 'INVALID_EPUB');
    assertNothingLeftBehind(db);
  });

  db.close();
});

test('a file the filter rejects is never staged at all', async () => {
  const db = initializeDatabase(new Database(':memory:'));

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: upload('notes.txt', 'plain text'),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Only EPUB files are supported' });
    assertNothingLeftBehind(db);
  });

  db.close();
});

test('an upload multer aborts for being too large removes its partial file', async () => {
  const db = initializeDatabase(new Database(':memory:'));

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: upload('too-large.epub', Buffer.alloc(32 * 1024, 0x61)),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'File too large',
      code: 'LIMIT_FILE_SIZE',
    });
    assertNothingLeftBehind(db);
  });

  db.close();
});

test('a request without a file keeps the data directory untouched', async () => {
  const db = initializeDatabase(new Database(':memory:'));

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      body: new FormData(),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'EPUB file is required' });
    assertNothingLeftBehind(db);
  });

  db.close();
});

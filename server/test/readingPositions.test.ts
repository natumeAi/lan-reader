import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/database.js';
import type { DatabaseHandle } from '../src/db/rows.js';
import { createApp } from '../src/app.js';
import { listeningPort, readJsonRecord, readRecord } from './support/http.js';

function insertEquivalentBook(db: DatabaseHandle, id: number): void {
  db.prepare<[number, string, string, string, string, number, number]>(`
    INSERT INTO books (
      id, title, identifier, file_name, file_path, file_size, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Import ${id}`,
    'shared-identifier',
    'same.epub',
    `data/books/${id}.epub`,
    2048,
    id * 1000,
  );
}

async function withServer(
  db: DatabaseHandle,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    await action(`http://127.0.0.1:${listeningPort(server)}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

test('GET reading position never resumes an equivalent imported Book', async () => {
  const db = initializeDatabase(new Database(':memory:'));
  insertEquivalentBook(db, 1);
  insertEquivalentBook(db, 2);
  db.prepare(`
    INSERT INTO reading_progress (book_id, cfi, progress, updated_at)
    VALUES (1, 'epubcfi(/6/2)', 0.4, '2026-08-11 02:00:00')
  `).run();

  await withServer(db, async (baseUrl) => {
    const first = await readJsonRecord(await fetch(`${baseUrl}/api/reading/1`));
    const second = await readJsonRecord(await fetch(`${baseUrl}/api/reading/2`));
    const firstProgress = readRecord(first['progress'], 'GET /api/reading/1 progress');

    assert.equal(firstProgress['bookId'], 1);
    assert.equal(firstProgress['progress'], 0.4);
    assert.equal(second['progress'], null);
  });

  db.close();
});

test('saving one equivalent imported Book never hides the other position', async () => {
  const db = initializeDatabase(new Database(':memory:'));
  insertEquivalentBook(db, 1);
  insertEquivalentBook(db, 2);
  db.prepare(`
    INSERT INTO reading_progress (book_id, cfi, progress, updated_at)
    VALUES
      (1, 'epubcfi(/6/2)', 0.2, '2026-08-11 01:00:00'),
      (2, 'epubcfi(/6/4)', 0.8, '2026-08-11 02:00:00')
  `).run();

  await withServer(db, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/reading/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cfi: 'epubcfi(/6/6)', progress: 0.3 }),
    });
    assert.equal(response.status, 200);

    const first = await readJsonRecord(await fetch(`${baseUrl}/api/reading/1`));
    const second = await readJsonRecord(await fetch(`${baseUrl}/api/reading/2`));
    assert.equal(readRecord(first['progress'], 'book 1 progress')['progress'], 0.3);
    assert.equal(readRecord(second['progress'], 'book 2 progress')['progress'], 0.8);
  });

  db.close();
});

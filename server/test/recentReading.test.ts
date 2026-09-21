import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/database.js';
import type { DatabaseHandle } from '../src/db/rows.js';
import { listRecentReadingEntries } from '../src/services/readingLibrary.js';

interface CreateBookOptions {
  id: number;
  title: string;
  progress: number;
  updatedAt: string;
  fileName?: string;
  fileSize?: number;
  identifier?: string | null;
}

function createBook(db: DatabaseHandle, {
  id,
  title,
  progress,
  updatedAt,
  fileName = `${id}.epub`,
  fileSize = id * 100,
  identifier = null,
}: CreateBookOptions): void {
  db.prepare<[number, string, string | null, string, string, number, number]>(`
    INSERT INTO books (id, title, identifier, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, identifier, fileName, `data/books/${id}.epub`, fileSize, id * 1000);
  db.prepare<[number, number, string]>(`
    INSERT INTO reading_progress (book_id, progress, updated_at)
    VALUES (?, ?, ?)
  `).run(id, progress, updatedAt);
}

test('recent reading omits Books at 100% progress without consuming the limit', () => {
  const db = initializeDatabase(new Database(':memory:'));

  createBook(db, {
    id: 1,
    title: 'Completed Book',
    progress: 1,
    updatedAt: '2026-08-11 02:00:00',
  });
  createBook(db, {
    id: 2,
    title: 'In-progress Book',
    progress: 0.75,
    updatedAt: '2026-08-11 01:00:00',
  });

  const entries = listRecentReadingEntries(db, { limit: 1 });

  assert.deepEqual(entries.map((entry) => entry.book.id), [2]);
  db.close();
});

test('a completed Book becomes eligible for Continue Reading after moving backward', () => {
  const db = initializeDatabase(new Database(':memory:'));
  createBook(db, {
    id: 1,
    title: 'Returned Book',
    progress: 1,
    updatedAt: '2026-08-11 02:00:00',
  });

  assert.deepEqual(listRecentReadingEntries(db), []);

  db.prepare(`
    UPDATE reading_progress
    SET progress = 0.6, updated_at = '2026-08-11 03:00:00'
    WHERE book_id = 1
  `).run();

  const [entry] = listRecentReadingEntries(db);
  assert.ok(entry, 'the Book moved backward and has to be listed again');
  assert.equal(entry.book.id, 1);
  assert.equal(entry.progress.progress, 0.6);
  db.close();
});

test('recent reading keeps equivalent imported Books as independent entries', () => {
  const db = initializeDatabase(new Database(':memory:'));

  createBook(db, {
    id: 1,
    title: 'First import',
    identifier: 'shared-identifier',
    fileName: 'same.epub',
    fileSize: 2048,
    progress: 0.25,
    updatedAt: '2026-08-11 01:00:00',
  });
  createBook(db, {
    id: 2,
    title: 'Second import',
    identifier: 'shared-identifier',
    fileName: 'same.epub',
    fileSize: 2048,
    progress: 0.75,
    updatedAt: '2026-08-11 02:00:00',
  });

  const entries = listRecentReadingEntries(db);

  assert.deepEqual(entries.map((entry) => entry.book.id), [2, 1]);
  assert.deepEqual(entries.map((entry) => entry.progress.progress), [0.75, 0.25]);
  db.close();
});

/**
 * A database that predates this step still opens.
 *
 * The fixtures below are built from the historical migrations themselves — 001,
 * then 002, 003 and 005 — inside an in-memory database, so a real data volume
 * is never touched. What matters is that the forward-only runner recognises
 * what is already applied, upgrades what is not, stays idempotent, and leaves
 * an existing Reading Position attached to the Book it was written for
 * (ADR-0004): two imports of the same publication must not share a position.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initializeDatabase, runMigrations } from '../src/db/database.js';
import type { CountRow, DatabaseHandle, SchemaMigrationRow } from '../src/db/rows.js';
import { listCatalogBooks } from '../src/services/bookLibrary.js';
import { buildLibrarySnapshot, getLibraryRevision } from '../src/services/librarySnapshot.js';
import { getExactProgress } from '../src/services/readingLibrary.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);
const allMigrations = [
  '001_initial_library_schema.sql',
  '002_add_reader_settings.sql',
  '003_add_book_file_mtime.sql',
  '005_add_cover_thumbnails_and_library_revision.sql',
];

/** The bookkeeping table as the running server creates it. */
const schemaMigrationsDdl = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

function createHistoricalDatabase(appliedMigrations: string[]): DatabaseHandle {
  const db = new Database(':memory:');

  db.exec(schemaMigrationsDdl);

  const recordMigration = db.prepare<[string]>(
    'INSERT INTO schema_migrations (name) VALUES (?)',
  );

  for (const fileName of appliedMigrations) {
    db.exec(readFileSync(path.join(migrationsDir, fileName), 'utf8'));
    recordMigration.run(fileName);
  }

  return db;
}

function appliedMigrationNames(db: DatabaseHandle): string[] {
  return db
    .prepare<[], SchemaMigrationRow>('SELECT name FROM schema_migrations ORDER BY name ASC')
    .all()
    .map((row) => row.name);
}

function tableColumns(db: DatabaseHandle, table: 'books' | 'reading_progress'): string[] {
  const rows = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();

  return rows.map((row) => row.name);
}

function tableExists(db: DatabaseHandle, table: string): boolean {
  const row = db
    .prepare<[string], CountRow>(
      "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);

  assert.ok(row);

  return row.value === 1;
}

/** Two imports of the same publication, only the first one ever opened. */
function seedEquivalentImports(db: DatabaseHandle): void {
  const insertBook = db.prepare<[number, string, string, number, number]>(`
    INSERT INTO books (id, title, identifier, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, 'shared-identifier', 'same.epub', ?, ?, ?)
  `);

  insertBook.run(1, 'First import', 'data/books/1.epub', 2048, 1000);
  insertBook.run(2, 'Second import', 'data/books/2.epub', 2048, 2000);
  db.prepare(`
    INSERT INTO reading_progress (book_id, cfi, progress, updated_at)
    VALUES (1, 'epubcfi(/6/2)', 0.4, '2026-08-11 02:00:00')
  `).run();
}

function assertPositionsStayWithTheirBook(db: DatabaseHandle): void {
  const opened = getExactProgress(db, 1);
  assert.ok(opened);
  assert.equal(opened.progress, 0.4);
  assert.equal(opened.cfi, 'epubcfi(/6/2)');
  assert.equal(opened.updated_at, '2026-08-11 02:00:00');
  assert.equal(getExactProgress(db, 2), null);

  assert.deepEqual(
    listCatalogBooks(db).map((book) => book.readingProgress),
    [0.4, null],
  );
}

test('a database still on the initial schema is upgraded in place', () => {
  const db = createHistoricalDatabase(['001_initial_library_schema.sql']);
  seedEquivalentImports(db);

  assert.deepEqual(appliedMigrationNames(db), ['001_initial_library_schema.sql']);
  assert.equal(tableColumns(db, 'books').includes('file_mtime_ms'), false);
  assert.equal(tableExists(db, 'library_revision'), false);

  initializeDatabase(db);

  assert.deepEqual(appliedMigrationNames(db), allMigrations);
  for (const column of [
    'file_mtime_ms',
    'cover_thumbnail_small_path',
    'cover_thumbnail_large_path',
    'cover_thumbnail_version',
  ]) {
    assert.ok(tableColumns(db, 'books').includes(column), `books.${column} is missing`);
  }
  assert.ok(tableExists(db, 'reader_settings'));
  assert.ok(tableExists(db, 'library_revision'));

  assertPositionsStayWithTheirBook(db);

  const snapshot = buildLibrarySnapshot(db);
  assert.equal(snapshot.books.length, 2);
  assert.deepEqual(snapshot.shelf.map((item) => `${item.type}:${item.id}`), [
    'book:1',
    'book:2',
  ]);
  assert.deepEqual(snapshot.recent.map((entry) => entry.bookId), [1]);
  assert.ok(Number.isInteger(getLibraryRevision(db)));

  db.close();
});

test('a fully migrated database is left alone, however often the runner runs', () => {
  const db = createHistoricalDatabase(allMigrations);
  seedEquivalentImports(db);

  const revisionBefore = getLibraryRevision(db);

  runMigrations(db);
  runMigrations(db);
  initializeDatabase(db);

  assert.deepEqual(appliedMigrationNames(db), allMigrations);
  assert.equal(
    appliedMigrationNames(db).length,
    new Set(appliedMigrationNames(db)).size,
    'a migration must never be recorded twice',
  );
  assert.deepEqual(tableColumns(db, 'reading_progress'), [
    'book_id',
    'cfi',
    'progress',
    'chapter_href',
    'chapter_label',
    'updated_at',
  ]);
  assertPositionsStayWithTheirBook(db);
  assert.equal(getLibraryRevision(db), revisionBefore, 'no data may be rewritten');

  db.close();
});

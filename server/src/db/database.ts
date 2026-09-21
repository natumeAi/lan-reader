import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseHandle, SchemaMigrationRow } from './rows.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..', '..');
// Resolved next to this module, so it is `src/db/migrations` while developing
// and `dist/db/migrations` once compiled. The build copies the SQL across.
const migrationsDir = path.join(currentDir, 'migrations');

export const defaultDatabasePath = path.join(serverRoot, 'data', 'library.sqlite');

export interface OpenDatabaseOptions {
  databasePath?: string;
}

/**
 * `DATABASE_PATH` is read here and nowhere else; it is independent of
 * `EPUB_DATA_DIR`, which `services/fileStorage.ts` resolves on its own.
 */
export function resolveDatabasePath(
  databasePath: string | undefined = process.env.DATABASE_PATH,
): string {
  return databasePath ? path.resolve(databasePath) : defaultDatabasePath;
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseHandle {
  const databasePath = resolveDatabasePath(options.databasePath);

  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function initializeDatabase(db: DatabaseHandle): DatabaseHandle {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  runMigrations(db);

  return db;
}

/**
 * Forward-only migrations: every `.sql` file that is not recorded in
 * `schema_migrations` is applied in file-name order, each inside its own
 * transaction. There is no down path.
 */
export function runMigrations(db: DatabaseHandle): void {
  const appliedMigrations = new Set(
    db
      .prepare<[], SchemaMigrationRow>('SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name),
  );

  const migrationFiles = readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  const applyMigration = db.transaction((fileName: string, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(fileName);
  });

  for (const fileName of migrationFiles) {
    if (appliedMigrations.has(fileName)) {
      continue;
    }

    const sql = readFileSync(path.join(migrationsDir, fileName), 'utf8');
    applyMigration(fileName, sql);
  }
}

export function createDatabase(options: OpenDatabaseOptions = {}): DatabaseHandle {
  return initializeDatabase(openDatabase(options));
}

export function checkDatabase(db: DatabaseHandle): 'ok' {
  db.prepare('SELECT 1 AS ok').get();
  return 'ok';
}

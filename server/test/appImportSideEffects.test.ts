/**
 * Importing the application must do nothing.
 *
 * Before step 2, `app.js` created the cover and staging directories and swept
 * stale uploads while it was being imported, and it exported a ready-made
 * application. Anything that merely loaded the module — a test, a tool, a type
 * check with a runtime import — wrote to the data directory. All of that now
 * lives in `server.ts`, so this test points the environment at a directory that
 * does not exist and proves it is still not there afterwards.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const runDirectory = mkdtempSync(path.join(tmpdir(), 'epub-reader-import-'));
const dataDir = path.join(runDirectory, 'data-that-must-not-be-created');
const databasePath = path.join(runDirectory, 'library-that-must-not-be-opened.sqlite');

process.env.EPUB_DATA_DIR = dataDir;
process.env.DATABASE_PATH = databasePath;

const { default: Database } = await import('better-sqlite3');
const { initializeDatabase } = await import('../src/db/database.js');
const { createApp } = await import('../src/app.js');
// `server.ts` pulls in the watcher and the cover backfill as well; importing it
// must stay as inert as importing the application alone.
await import('../src/server.js');

after(() => {
  assert.ok(path.resolve(runDirectory).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  rmSync(runDirectory, { force: true, recursive: true });
});

function activeTimerCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

function assertStorageUntouched(): void {
  assert.equal(existsSync(dataDir), false, 'no storage directory may be created');
  assert.equal(existsSync(path.join(dataDir, 'covers')), false);
  assert.equal(existsSync(path.join(dataDir, 'staging')), false);
  assert.equal(existsSync(path.join(dataDir, 'books')), false);
  assert.equal(existsSync(databasePath), false, 'no database may be opened');
  assert.deepEqual(readdirSync(runDirectory), [], 'the run directory has to stay empty');
}

test('importing the application creates no directory and opens no database', () => {
  assertStorageUntouched();
});

test('building an application starts no background task', () => {
  const timersBeforeApp = activeTimerCount();
  const app = createApp();
  const timersAfterApp = activeTimerCount();

  assert.equal(
    timersAfterApp,
    timersBeforeApp,
    'createApp() must not schedule the cover thumbnail backfill',
  );
  assert.equal(typeof app.listen, 'function');
  assertStorageUntouched();
});

test('building an application around a database still writes nothing', () => {
  const db = initializeDatabase(new Database(':memory:'));
  const timersBeforeApp = activeTimerCount();

  createApp({ db });

  assert.equal(activeTimerCount(), timersBeforeApp);
  assertStorageUntouched();
  db.close();
});

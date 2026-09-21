/**
 * Starting and stopping a real server.
 *
 * `startServer` owns the database, the storage directories, the directory
 * watcher, the cover backfill and the listener, and hands back one `close()`
 * for all of them. Shutdown has to survive being triggered twice — a signal
 * handler and a test teardown can both fire — and the database must be released
 * last, after the background tasks that query it have stopped.
 *
 * The listener binds port 0 so the operating system picks a free port and the
 * manual smoke ports stay untouched.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { listeningPort, readJsonRecord } from './support/http.js';

const runDirectory = mkdtempSync(path.join(tmpdir(), 'epub-reader-lifecycle-'));
const dataDir = path.join(runDirectory, 'data');
const databasePath = path.join(runDirectory, 'library.sqlite');

process.env.EPUB_DATA_DIR = dataDir;
process.env.DATABASE_PATH = databasePath;

const { startServer } = await import('../src/server.js');

after(() => {
  assert.ok(path.resolve(runDirectory).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  rmSync(runDirectory, { force: true, recursive: true });
});

test('a started server serves requests and prepares its storage', async () => {
  const runningServer = await startServer({ port: 0, host: '127.0.0.1' });

  try {
    const port = listeningPort(runningServer.server);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);

    assert.equal(response.status, 200);
    assert.equal((await readJsonRecord(response))['database'], 'ok');
    assert.equal(runningServer.db.open, true);
    // Unlike importing the application, starting one does create its layout.
    assert.ok(existsSync(path.join(dataDir, 'covers', 'thumbnails')));
    assert.ok(existsSync(path.join(dataDir, 'staging')));
    assert.ok(existsSync(path.join(dataDir, 'books')));
    assert.ok(existsSync(databasePath));
  } finally {
    await runningServer.close();
  }
});

test('close() releases the background tasks before the database, once', async (t) => {
  const runningServer = await startServer({ port: 0, host: '127.0.0.1' });
  const port = listeningPort(runningServer.server);

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

  let httpServerClosed = false;
  let databaseCloseCount = 0;
  let httpServerWasClosedFirst = false;
  runningServer.server.once('close', () => {
    httpServerClosed = true;
  });

  const closeDatabase = runningServer.db.close.bind(runningServer.db);
  t.mock.method(runningServer.db, 'close', () => {
    databaseCloseCount += 1;
    httpServerWasClosedFirst = httpServerClosed;
    return closeDatabase();
  });

  const closingStartedAt = Date.now();
  const firstClose = runningServer.close();
  const secondClose = runningServer.close();

  assert.equal(firstClose, secondClose, 'a repeated close must return the first promise');
  await firstClose;
  await secondClose;
  await runningServer.close();

  assert.equal(databaseCloseCount, 1, 'the database must never be closed twice');
  assert.equal(runningServer.db.open, false);
  assert.equal(
    httpServerWasClosedFirst,
    true,
    'the listener is closed before the database is released',
  );
  // `close()` awaits the cover thumbnail backfill, which is still sitting in its
  // start delay; a shutdown that released the database first would return at
  // once instead of waiting for it.
  assert.ok(
    Date.now() - closingStartedAt >= 1000,
    'shutdown has to await the pending cover thumbnail backfill',
  );

  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/api/health`),
    'the port must be free again once close() resolved',
  );
});

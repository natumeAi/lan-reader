/**
 * Starting and stopping a running server.
 *
 * `app.ts` only describes the application; everything with an effect — opening
 * the database, preparing the storage directories, starting the directory
 * watcher and the cover backfill, binding the port — happens here, in one
 * explicit order. The handle that comes back owns all of it, so a caller (the
 * process entry point, or a test) can shut the whole thing down again.
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createDatabase } from './db/database.js';
import type { DatabaseHandle } from './db/rows.js';
import { createApp } from './app.js';
import { startBookDirectoryWatcher } from './services/bookDirectoryWatcher.js';
import { startCoverThumbnailBackfill } from './services/coverThumbnailBackfill.js';
import { describeUnservableDataDir, initializeStorage } from './services/fileStorage.js';

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** Overrides `DATABASE_PATH`; see `db/database.ts`. */
  databasePath?: string;
}

export interface ServerHandle {
  app: Express;
  server: Server;
  db: DatabaseHandle;
  /**
   * Stops the background tasks, the listener and the database, in that order.
   *
   * Safe to call more than once: every call after the first returns the same
   * promise, so the database is never closed twice and nothing runs against a
   * closed connection.
   */
  close(): Promise<void>;
}

/**
 * Binds the port and resolves once the server is listening.
 *
 * The `error` listener is removed as soon as the socket is up, so a failure
 * that happens later is not swallowed by this promise.
 */
function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const port = options.port ?? 3000;
  const host = options.host ?? '0.0.0.0';
  const db = createDatabase({ databasePath: options.databasePath });

  initializeStorage();

  // Reported once, at startup, because the symptom is a 404 on a Book that is
  // demonstrably on disk — which reads as a bug in the route rather than as a
  // property of the path it was told to use.
  const unservableDataDir = describeUnservableDataDir();

  if (unservableDataDir) {
    console.warn(unservableDataDir);
  }

  const bookDirectoryWatcher = startBookDirectoryWatcher(db);
  const coverThumbnailBackfill = startCoverThumbnailBackfill(db);
  const app = createApp({ db });

  let server: Server;

  try {
    server = await listen(app, port, host);
  } catch (error) {
    // The port is taken, or the host is unusable. The watcher, the backfill and
    // the database are already running at this point, so they have to be
    // released here — otherwise a caller that retries on another port leaks a
    // file watcher and an open connection per attempt.
    await Promise.all([bookDirectoryWatcher.close(), coverThumbnailBackfill.close()]);
    db.close();
    throw error;
  }

  let closePromise: Promise<void> | null = null;

  return {
    app,
    server,
    db,
    close(): Promise<void> {
      closePromise ??= (async (): Promise<void> => {
        // The background tasks hold the database, so they stop first; the
        // connection is released last, once nothing can still query it.
        await Promise.all([bookDirectoryWatcher.close(), coverThumbnailBackfill.close()]);
        await closeServer(server);
        db.close();
      })();

      return closePromise;
    },
  };
}

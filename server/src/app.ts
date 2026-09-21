/**
 * The Express application.
 *
 * Importing this module has no side effects: no directory is created, no
 * staging area is swept, no database is opened and no background task starts.
 * `createApp` only wires middleware and routes, so a test can build an app
 * around an in-memory database. The startup work lives in `server.ts`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import type { ApiErrorResponse } from '@lan-reader/shared';
import { isRecord } from '@lan-reader/shared';
import { checkDatabase } from './db/database.js';
import type { DatabaseHandle } from './db/rows.js';
import { readErrorCode, readErrorStatus } from './http/httpError.js';
// `http/requestInput.ts` owns how `app.locals.db` is recognised; `/api/health`
// needs the non-throwing read, the routes need the 503 one.
import { readConfiguredDatabase } from './http/requestInput.js';
import booksRouter from './routes/books.js';
import foldersRouter from './routes/folders.js';
import libraryRouter from './routes/library.js';
import readingRouter from './routes/reading.js';
import { coverThumbnailsDir, coversDir } from './services/fileStorage.js';

// Resolved next to this module, so it is `server/public` from `src/` and from
// `dist/` alike.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDistDir = path.resolve(currentDir, '..', 'public');
const clientIndexFile = path.join(clientDistDir, 'index.html');

export interface CreateAppOptions {
  /** Absent builds an app that answers 503 on every database-backed route. */
  db?: DatabaseHandle;
}

function readErrorProperty(error: unknown, key: string): unknown {
  return isRecord(error) ? error[key] : undefined;
}

/**
 * The message reported below 500.
 *
 * Everything that reaches here with a sub-500 status is an `Error` — an
 * `HttpError`, an `InvalidEpubError` or multer's `MulterError` — so the
 * message is always a string in practice.
 */
function readErrorMessage(error: unknown): string {
  const message = readErrorProperty(error, 'message');

  return typeof message === 'string' ? message : '';
}

export function createApp({ db }: CreateAppOptions = {}): express.Express {
  const app = express();

  app.locals.db = db;

  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/covers/thumbnails',
    express.static(coverThumbnailsDir, {
      immutable: true,
      maxAge: '1y',
    }),
  );
  app.use('/covers', express.static(coversDir));

  app.get('/api/health', (req, res) => {
    const configuredDatabase = readConfiguredDatabase(req);
    const database = configuredDatabase ? checkDatabase(configuredDatabase) : 'unconfigured';

    res.json({
      status: 'ok',
      service: 'epub-reader-server',
      database,
    });
  });

  app.use('/api/books', booksRouter);
  app.use('/api/folders', foldersRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api/reading', readingRouter);

  if (existsSync(clientIndexFile)) {
    app.use(express.static(clientDistDir));
    app.get(/^\/(?!api\/|covers\/).*/, (_req, res) => {
      res.sendFile(clientIndexFile);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({
      error: 'Not Found',
    });
  });

  // Express recognises an error handler by its four parameters, so the unused
  // `next` has to stay declared even though this handler always ends the
  // response itself.
  app.use((err: unknown, req: Request, res: Response<ApiErrorResponse>, _next: NextFunction) => {
    const status = readErrorStatus(err);
    if (status === 500) {
      console.error(`${req.method} ${req.path}`, readErrorProperty(err, 'stack') || err);
    }

    const code = readErrorCode(err);
    const message = status === 500 ? 'Internal Server Error' : readErrorMessage(err);
    const body: ApiErrorResponse =
      status < 500 && code ? { error: message, code } : { error: message };

    res.status(status).json(body);
  });

  return app;
}

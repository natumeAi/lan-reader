/**
 * Keeps the database in step with the books directory.
 *
 * Files may also arrive by copying them into `data/books` instead of uploading
 * them, so a watcher imports, refreshes and removes Books as the directory
 * changes, and runs one full sync once the initial scan is ready.
 *
 * The library calls are injectable: a test can drive every handler without a
 * real EPUB, a real database or a real file system event.
 */
import path from 'node:path';
import chokidar from 'chokidar';
import type { BookRow, DatabaseHandle } from '../db/rows.js';
import { readErrorCode } from '../http/httpError.js';
import {
  addBookFileToLibrary,
  removeBookFileFromLibrary,
  syncBookDirectory,
} from './bookLibrary.js';
import type { AddBookFileOptions, SyncBookDirectoryOptions } from './bookLibrary.js';
import { InvalidEpubError } from './epubValidation.js';
import { booksDir, ensureBookDirectory, isEpubFileName } from './fileStorage.js';

/**
 * The `chokidar.watch` options this module passes.
 *
 * `awaitWriteFinish` is what makes a large EPUB safe to import: the file has to
 * stop growing before the `add` event fires.
 */
interface DirectoryWatchOptions {
  awaitWriteFinish: {
    stabilityThreshold: number;
    pollInterval: number;
  };
  ignoreInitial: boolean;
}

/**
 * The part of chokidar's `FSWatcher` this module relies on.
 *
 * Declared locally rather than importing the concrete class so an injected
 * fake watcher only has to provide these five events and `close()`.
 */
export interface DirectoryWatcher {
  on(event: 'add', listener: (filePath: string) => void): unknown;
  on(event: 'change', listener: (filePath: string) => void): unknown;
  on(event: 'unlink', listener: (filePath: string) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  close(): Promise<void>;
}

/** The `chokidar.watch` factory, as this module calls it. */
export type WatchDirectory = (
  directory: string,
  options: DirectoryWatchOptions,
) => DirectoryWatcher;

/**
 * Replaceable collaborators.
 *
 * The return values are only ever awaited, never inspected, so the contract
 * asked of a substitute is deliberately wider than the real functions' types.
 */
export interface BookDirectoryWatcherDependencies {
  addBookFileToLibrary?: (
    db: DatabaseHandle,
    filePath: string,
    options?: AddBookFileOptions,
  ) => Promise<BookRow | null>;
  removeBookFileFromLibrary?: (db: DatabaseHandle, filePath: string) => unknown;
  syncBookDirectory?: (db: DatabaseHandle, options?: SyncBookDirectoryOptions) => Promise<void>;
  watch?: WatchDirectory;
}

function logSyncError(action: string, filePath: string, error: unknown): void {
  console.error(`Failed to ${action} EPUB file ${path.resolve(filePath)} [${readErrorCode(error) || 'UNEXPECTED_ERROR'}]`);
}

export function startBookDirectoryWatcher(
  db: DatabaseHandle,
  dependencies: BookDirectoryWatcherDependencies = {},
): DirectoryWatcher {
  const addBook = dependencies.addBookFileToLibrary || addBookFileToLibrary;
  const removeBook = dependencies.removeBookFileFromLibrary || removeBookFileFromLibrary;
  const syncBooks = dependencies.syncBookDirectory || syncBookDirectory;
  const watch: WatchDirectory = dependencies.watch || chokidar.watch;
  let readySyncStarted = false;

  ensureBookDirectory();
  const watcher = watch(booksDir, {
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
    ignoreInitial: true,
  });

  watcher.on('add', async (filePath) => {
    if (!isEpubFileName(filePath)) return;
    try {
      await addBook(db, filePath);
    } catch (error) {
      if (error instanceof InvalidEpubError) removeBook(db, filePath);
      logSyncError('add', filePath, error);
    }
  });

  watcher.on('change', async (filePath) => {
    if (!isEpubFileName(filePath)) return;
    try {
      await addBook(db, filePath, { forceRefresh: true });
    } catch (error) {
      if (error instanceof InvalidEpubError) removeBook(db, filePath);
      logSyncError('update', filePath, error);
    }
  });

  watcher.on('unlink', (filePath) => {
    if (!isEpubFileName(filePath)) return;
    try {
      removeBook(db, filePath);
    } catch (error) {
      logSyncError('remove', filePath, error);
    }
  });

  watcher.on('ready', async () => {
    if (readySyncStarted) return;
    readySyncStarted = true;
    try {
      await syncBooks(db);
    } catch (error) {
      console.error('Failed to sync EPUB directory on watcher ready:', error);
    }
  });

  watcher.on('error', (error) => {
    console.error('Book directory watcher error:', error);
  });

  return watcher;
}

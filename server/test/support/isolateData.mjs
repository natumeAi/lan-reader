import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Preloaded via `node --import` before any test file is evaluated.
 *
 * `services/fileStorage.ts` and `db/database.ts` resolve EPUB_DATA_DIR /
 * DATABASE_PATH at import time, and a test that starts a real server creates
 * the books, cover and staging directories under them. Pointing both at a
 * throwaway directory keeps every server test process away from the real
 * library, whatever the ambient environment happens to say.
 *
 * This file stays `.mjs`: it is loaded by plain Node before the tsx hook is
 * installed, so it cannot be TypeScript.
 */
const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-reader-server-test-'));

process.env.EPUB_DATA_DIR = runDirectory;
process.env.DATABASE_PATH = path.join(runDirectory, 'library.sqlite');

process.on('exit', () => {
  try {
    fs.rmSync(runDirectory, { force: true, recursive: true });
  } catch {
    // A leftover temporary directory must never fail a test run.
  }
});

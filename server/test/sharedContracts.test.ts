import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { UploadedBookRecord } from '@lan-reader/shared';
import { LIBRARY_SNAPSHOT_SCHEMA_VERSION, MAX_FOLDER_NAME_LENGTH } from '@lan-reader/shared';

import type { BookRow } from '../src/db/rows.js';

/**
 * `true` only when two types describe each other exactly.
 *
 * One-way `extends` would accept an extra property on the wider side, which is
 * the drift this has to catch, so both directions are checked.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `POST /api/books` serialises a `books` row straight into its 201 body, so
 * `UploadedBookRecord` is a published copy of `BookRow` — and nothing else ties
 * the two together. A migration that adds, drops or retypes a column would
 * otherwise leave the shared contract quietly describing the old table.
 *
 * This is a compile-time assertion: if the two drift, `typecheck` fails on the
 * line below rather than at some later consumer.
 */
const uploadedBookRecordMatchesBookRow: MutuallyAssignable<BookRow, UploadedBookRecord> = true;

// Importing server services runs module-level path resolution against
// EPUB_DATA_DIR, so point it at a throwaway directory before loading them.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-reader-shared-contracts-'));
const originalDataDir = process.env['EPUB_DATA_DIR'];
process.env['EPUB_DATA_DIR'] = testDataDir;

const { LIBRARY_SNAPSHOT_SCHEMA_VERSION: serverSnapshotVersion } = await import(
  '../src/services/librarySnapshot.js'
);
const { MAX_FOLDER_NAME_LENGTH: serverMaxFolderNameLength } = await import(
  '../src/services/folderLibrary.js'
);

after(() => {
  if (originalDataDir === undefined) {
    delete process.env['EPUB_DATA_DIR'];
  } else {
    process.env['EPUB_DATA_DIR'] = originalDataDir;
  }
  fs.rmSync(testDataDir, { force: true, recursive: true });
});

test('the shared workspace resolves from the server at runtime', () => {
  // A type-only import would vanish after compilation; these are real values.
  assert.equal(typeof LIBRARY_SNAPSHOT_SCHEMA_VERSION, 'number');
  assert.equal(typeof MAX_FOLDER_NAME_LENGTH, 'number');
});

test('shared contracts still agree with the values the server enforces', () => {
  assert.equal(
    LIBRARY_SNAPSHOT_SCHEMA_VERSION,
    serverSnapshotVersion,
    'snapshot schema version drifted between shared/ and server/',
  );
  assert.equal(
    MAX_FOLDER_NAME_LENGTH,
    serverMaxFolderNameLength,
    'Folder name limit drifted between shared/ and server/',
  );
});

test('the published upload record still matches the books row it echoes', () => {
  // The assertion itself is the type annotation above; reading it here is what
  // keeps the check from being dropped as an unused declaration.
  assert.equal(
    uploadedBookRecordMatchesBookRow,
    true,
    'UploadedBookRecord drifted from BookRow',
  );
});

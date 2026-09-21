import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { LIBRARY_SNAPSHOT_SCHEMA_VERSION, MAX_FOLDER_NAME_LENGTH } from '@lan-reader/shared';

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

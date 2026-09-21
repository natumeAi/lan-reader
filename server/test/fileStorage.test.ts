import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-reader-file-storage-'));
const originalDataDir = process.env.EPUB_DATA_DIR;
process.env.EPUB_DATA_DIR = testDataDir;

// `fileStorage` resolves its directories at module scope, so the environment
// has to be set before the import runs. A static import would be hoisted above
// the assignment above and resolve the ambient data directory instead.
const {
  booksDir,
  ensureBookDirectory,
  ensureStagingDirectory,
  moveValidatedUploadToBooks,
  stagingDir,
} = await import('../src/services/fileStorage.js');

after(() => {
  if (originalDataDir === undefined) {
    delete process.env.EPUB_DATA_DIR;
  } else {
    process.env.EPUB_DATA_DIR = originalDataDir;
  }
  fs.rmSync(testDataDir, { force: true, recursive: true });
});

/**
 * `renameSync` accepts a string, a Buffer or a file URL; the production code
 * only ever passes strings, but the mock has to honour the real signature to
 * stay type-compatible with the method it replaces.
 */
function resolvePathLike(value: PathLike): string {
  if (typeof value === 'string') {
    return path.resolve(value);
  }

  if (Buffer.isBuffer(value)) {
    return path.resolve(value.toString('utf8'));
  }

  return path.resolve(fileURLToPath(value));
}

test('moves a validated upload across filesystems without changing its final name', (t) => {
  ensureBookDirectory();
  ensureStagingDirectory();

  const stagedPath = path.join(stagingDir, 'staged-upload.epub');
  const originalName = 'Original Book Name.epub';
  const expectedPath = path.join(booksDir, originalName);
  const contents = Buffer.from('validated EPUB contents');
  fs.writeFileSync(stagedPath, contents);

  const renameSync = fs.renameSync.bind(fs);
  let renameAttempts = 0;
  t.mock.method(fs, 'renameSync', (sourcePath: PathLike, destinationPath: PathLike): void => {
    renameAttempts += 1;
    if (resolvePathLike(sourcePath) === path.resolve(stagedPath)) {
      const error: NodeJS.ErrnoException = new Error('Cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    }
    return renameSync(sourcePath, destinationPath);
  });

  const finalPath = moveValidatedUploadToBooks(stagedPath, originalName);

  assert.equal(finalPath, expectedPath);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.deepEqual(fs.readFileSync(expectedPath), contents);
  assert.deepEqual(fs.readdirSync(booksDir), [originalName]);
  assert.equal(renameAttempts, 2);
});

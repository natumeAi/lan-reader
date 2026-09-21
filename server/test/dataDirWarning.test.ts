import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { booksDir, describeUnservableDataDir } from '../src/services/fileStorage.js';

/**
 * `GET /api/books/:id/file` hands an absolute path to `res.sendFile`, and
 * Express's `send` runs `part.length > 1 && part[0] === '.'` over every segment
 * of it with `dotfiles: 'ignore'`. These cases are that predicate, so the
 * warning fires exactly when downloads would break.
 */

test('a hidden segment anywhere in the path is reported', () => {
  for (const directory of [
    'D:\\Projects\\lan-reader\\.tmp\\data\\books',
    '/home/reader/.local/share/epub/books',
    '/srv/.hidden/books',
    '/srv/data/.books',
  ]) {
    const warning = describeUnservableDataDir(directory);

    assert.ok(warning, `expected a warning for ${directory}`);
    assert.match(warning, /GET \/api\/books\/:id\/file will answer 404/);
    assert.ok(warning.includes(directory), 'the warning names the offending path');
  }
});

test('the reported segment is the one that breaks downloads', () => {
  const warning = describeUnservableDataDir('/srv/.hidden/books');

  assert.ok(warning);
  assert.match(warning, /hidden path segment \.hidden\./);
});

test('every hidden segment is named, not just the first', () => {
  const warning = describeUnservableDataDir('/srv/.one/.two/books');

  assert.ok(warning);
  assert.match(warning, /\.one, \.two/);
});

test('an ordinary path produces no warning', () => {
  for (const directory of [
    'D:\\Projects\\lan-reader\\server\\data\\books',
    '/var/lib/epub-reader/books',
    '/srv/data.backup/books',
    path.join(os.tmpdir(), 'lan-reader-test', 'books'),
  ]) {
    assert.equal(describeUnservableDataDir(directory), null, directory);
  }
});

test('a bare dot or double dot segment is not treated as hidden', () => {
  // `send`'s own test requires `length > 1`, and `path.resolve` removes these
  // before they ever reach it. Matching it exactly keeps the warning honest.
  assert.equal(describeUnservableDataDir('/srv/./books'), null);
  assert.equal(describeUnservableDataDir('/srv/../srv/books'), null);
});

test('the directory the tests actually run against is servable', () => {
  // Guards against a false positive: the suite points EPUB_DATA_DIR at a
  // throwaway directory under the OS temp dir, which must not trip the warning.
  assert.equal(describeUnservableDataDir(), null, booksDir);
});

/**
 * The compatibility surface of the shared request parsing.
 *
 * Step 2 replaced four inline copies of these checks with one module, so the
 * inputs the old copies accepted have to keep working and the ones they
 * rejected have to keep failing with the same status and the same wording.
 * The loose inputs below are the ones measured against the pre-migration code
 * (see the step's migration plan, section 10): identifiers go through
 * `Number()`, which is why `'01'`, `'0x1'`, `[5]` and `true` are all valid ids.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/database.js';
import type { DatabaseHandle } from '../src/db/rows.js';
import { HttpError } from '../src/http/httpError.js';
import {
  parseBookId,
  parseBookIds,
  parseOptionalFolderId,
  parsePositiveInteger,
  parseShelfItems,
} from '../src/http/requestInput.js';
import { createApp } from '../src/app.js';
import { readJsonRecord, readRecord, withServer } from './support/http.js';

const looseValidIds: unknown[] = ['1', '01', ' 1 ', '1.0', '+1', '0x1', '1e0', [5], true];
const rejectedIds: unknown[] = ['', null, undefined, 0, -1, 1.5, 'abc'];

function assertBadRequest(run: () => unknown, message: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HttpError, 'a rejected input must raise an HttpError');
    assert.equal(error.status, 400);
    assert.equal(error.message, message);
    assert.equal(error.code, undefined);
    return true;
  });
}

function seedShelfBook(db: DatabaseHandle, id: number): void {
  db.prepare<[number, string, string, string, number, number]>(`
    INSERT INTO books (id, title, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `Book ${id}`, `${id}.epub`, `data/books/${id}.epub`, 1024, id * 1000);
}

test('every id input the pre-migration routes accepted still parses', () => {
  for (const value of looseValidIds) {
    assert.equal(parsePositiveInteger(value, 'book id'), Number(value));
    assert.equal(parseBookId(value), Number(value));
    assert.equal(parseOptionalFolderId(value), Number(value));
  }

  // Spelled out as well as looped, so the accepted set is readable in the file.
  assert.equal(parseBookId('1'), 1);
  assert.equal(parseBookId('01'), 1);
  assert.equal(parseBookId(' 1 '), 1);
  assert.equal(parseBookId('1.0'), 1);
  assert.equal(parseBookId('+1'), 1);
  assert.equal(parseBookId('0x1'), 1);
  assert.equal(parseBookId('1e0'), 1);
  assert.equal(parseBookId([5]), 5);
  assert.equal(parseBookId(true), 1);
});

test('rejected ids keep their 400 status and their message', () => {
  for (const value of rejectedIds) {
    assertBadRequest(() => parseBookId(value), 'book id must be a positive integer');
    assertBadRequest(
      () => parsePositiveInteger(value, 'sourceBookId'),
      'sourceBookId must be a positive integer',
    );
  }

  // `undefined` is the one value the optional Folder parser lets through.
  assert.equal(parseOptionalFolderId(undefined), undefined);
  for (const value of rejectedIds.filter((candidate) => candidate !== undefined)) {
    assertBadRequest(
      () => parseOptionalFolderId(value),
      'folderId must be a positive integer',
    );
  }
});

test('parseBookIds keeps its array, entry and uniqueness messages', () => {
  assert.deepEqual(parseBookIds(['2', 1, '0x3']), [2, 1, 3]);
  assert.deepEqual(parseBookIds([]), []);

  assertBadRequest(() => parseBookIds(undefined), 'bookIds must be an array');
  assertBadRequest(() => parseBookIds(null), 'bookIds must be an array');
  assertBadRequest(() => parseBookIds({ 0: 1 }), 'bookIds must be an array');
  assertBadRequest(() => parseBookIds('1,2'), 'bookIds must be an array');
  assertBadRequest(() => parseBookIds([1, 'abc']), 'book id must be a positive integer');
  assertBadRequest(() => parseBookIds([1, 0]), 'book id must be a positive integer');
  assertBadRequest(() => parseBookIds([1, '1']), 'bookIds must be unique');
  assertBadRequest(() => parseBookIds([2, 1, 2]), 'bookIds must be unique');
});

test('parseShelfItems keeps its array, entry, id and uniqueness messages', () => {
  assert.deepEqual(
    parseShelfItems([{ type: 'book', id: '2' }, { type: 'folder', id: 3 }]),
    [{ type: 'book', id: 2 }, { type: 'folder', id: 3 }],
  );
  // A Book and a Folder may share an id: the key is `type:id`, not `id`.
  assert.deepEqual(
    parseShelfItems([{ type: 'book', id: 1 }, { type: 'folder', id: 1 }]),
    [{ type: 'book', id: 1 }, { type: 'folder', id: 1 }],
  );

  assertBadRequest(() => parseShelfItems(undefined), 'items must be an array');
  assertBadRequest(() => parseShelfItems({ type: 'book', id: 1 }), 'items must be an array');

  for (const entry of [null, 0, '', 5, { type: 'shelf', id: 1 }, { id: 1 }]) {
    assertBadRequest(
      () => parseShelfItems([entry]),
      'items must contain book or folder entries',
    );
  }

  assertBadRequest(
    () => parseShelfItems([{ type: 'book' }]),
    'book id must be a positive integer',
  );
  assertBadRequest(
    () => parseShelfItems([{ type: 'folder', id: -1 }]),
    'folder id must be a positive integer',
  );
  assertBadRequest(
    () => parseShelfItems([{ type: 'book', id: 1 }, { type: 'book', id: '1' }]),
    'items must be unique',
  );
});

test('the routes still accept the loose ids over HTTP', async () => {
  const db = initializeDatabase(new Database(':memory:'));
  seedShelfBook(db, 1);

  await withServer(createApp({ db }), async (baseUrl) => {
    // ' 1 ' has to travel percent-encoded; everything else is path-safe.
    for (const pathId of ['1', '01', '%201%20', '1.0', '+1', '0x1', '1e0']) {
      const response = await fetch(`${baseUrl}/api/books/${pathId}`);
      const body = await readJsonRecord(response);

      assert.equal(response.status, 200, `GET /api/books/${pathId} must still resolve`);
      assert.equal(readRecord(body['book'], 'book')['id'], 1);
    }

    const rejected = await fetch(`${baseUrl}/api/books/abc`);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: 'book id must be a positive integer',
    });

    const folderFiltered = await fetch(`${baseUrl}/api/books?folderId=0x2`);
    assert.equal(folderFiltered.status, 200);
    assert.deepEqual((await readJsonRecord(folderFiltered))['books'], []);
  });

  db.close();
});

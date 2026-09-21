/**
 * The Folder mutation routes.
 *
 * Creating a Folder, importing a Book into it, moving a Book back to the
 * Bookshelf and the three order conflicts had no test coverage before step 2,
 * yet they carry the most state: every one of them rewrites `folder_id` and the
 * shelf order inside a transaction, and emptying a Folder deletes it. The
 * statuses and the conflict messages below are the published contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { requireArray } from '@lan-reader/shared';
import { initializeDatabase } from '../src/db/database.js';
import type { DatabaseHandle } from '../src/db/rows.js';
import { createApp } from '../src/app.js';
import { readJsonRecord, readRecord, withServer } from './support/http.js';

/** Four Books on the root shelf, sort order 1000 apart. */
function createShelf(): DatabaseHandle {
  const db = initializeDatabase(new Database(':memory:'));
  const insertBook = db.prepare<[number, string, string, string, number, number]>(`
    INSERT INTO books (id, title, file_name, file_path, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const id of [1, 2, 3, 4]) {
    insertBook.run(id, `Book ${id}`, `${id}.epub`, `data/books/${id}.epub`, id * 100, id * 1000);
  }

  return db;
}

function shelfKeys(value: unknown): string[] {
  return requireArray(value, 'shelfItems').map((item, index) => {
    const entry = readRecord(item, `shelfItems[${index}]`);

    return `${String(entry['type'])}:${String(entry['id'])}`;
  });
}

function bookIds(value: unknown): unknown[] {
  return requireArray(value, 'books').map(
    (book, index) => readRecord(book, `books[${index}]`)['id'],
  );
}

async function patch(url: string, body?: unknown): Promise<Response> {
  if (body === undefined) {
    return fetch(url, { method: 'PATCH' });
  }

  return fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('creating a Folder moves both Books into it and keeps the shelf ordered', async () => {
  const db = createShelf();

  await withServer(createApp({ db }), async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/folders`, {
      sourceBookId: 1,
      targetBookId: 2,
      name: '技术',
    });
    const body = await readJsonRecord(response);
    const folder = readRecord(body['folder'], 'folder');

    assert.equal(response.status, 201);
    assert.equal(folder['id'], 1);
    assert.equal(folder['name'], '技术');
    assert.equal(folder['bookCount'], 2);
    assert.deepEqual(bookIds(body['books']), [1, 2]);
    // The Folder inherits the target Book's shelf position.
    assert.deepEqual(shelfKeys(body['shelfItems']), ['folder:1', 'book:3', 'book:4']);

    const identical = await postJson(`${baseUrl}/api/folders`, {
      sourceBookId: 3,
      targetBookId: 3,
    });
    assert.equal(identical.status, 400);
    assert.deepEqual(await identical.json(), {
      error: 'sourceBookId and targetBookId must be different',
    });

    const alreadyFiled = await postJson(`${baseUrl}/api/folders`, {
      sourceBookId: 1,
      targetBookId: 3,
    });
    assert.equal(alreadyFiled.status, 409);
    assert.deepEqual(await alreadyFiled.json(), {
      error: 'Folder creation requires two root shelf books',
    });

    const missingBook = await postJson(`${baseUrl}/api/folders`, {
      sourceBookId: 3,
      targetBookId: 999,
    });
    assert.equal(missingBook.status, 404);
    assert.deepEqual(await missingBook.json(), { error: 'Book not found' });
  });

  db.close();
});

test('only a root shelf Book can be imported into a Folder', async () => {
  const db = createShelf();

  await withServer(createApp({ db }), async (baseUrl) => {
    await postJson(`${baseUrl}/api/folders`, { sourceBookId: 1, targetBookId: 2 });

    const imported = await patch(`${baseUrl}/api/folders/1/import-book/3`);
    const body = await readJsonRecord(imported);

    assert.equal(imported.status, 200);
    assert.equal(readRecord(body['folder'], 'folder')['bookCount'], 3);
    assert.deepEqual(bookIds(body['books']), [1, 2, 3]);
    assert.deepEqual(shelfKeys(body['shelfItems']), ['folder:1', 'book:4']);

    const repeated = await patch(`${baseUrl}/api/folders/1/import-book/3`);
    assert.equal(repeated.status, 409);
    assert.deepEqual(await repeated.json(), {
      error: 'Only root shelf books can move into folders',
    });

    const missingFolder = await patch(`${baseUrl}/api/folders/99/import-book/4`);
    assert.equal(missingFolder.status, 404);
    assert.deepEqual(await missingFolder.json(), { error: 'Folder not found' });

    const missingBook = await patch(`${baseUrl}/api/folders/1/import-book/999`);
    assert.equal(missingBook.status, 404);
    assert.deepEqual(await missingBook.json(), { error: 'Book not found' });
  });

  db.close();
});

test('moving a Book back to the shelf keeps a Folder that still holds Books', async () => {
  const db = createShelf();

  await withServer(createApp({ db }), async (baseUrl) => {
    await postJson(`${baseUrl}/api/folders`, { sourceBookId: 1, targetBookId: 2 });
    await patch(`${baseUrl}/api/folders/1/import-book/3`);

    const response = await patch(`${baseUrl}/api/folders/1/books/1/move-to-shelf`);
    const body = await readJsonRecord(response);

    assert.equal(response.status, 200);
    assert.equal(readRecord(body['book'], 'book')['folderId'], null);
    assert.equal(body['removedFolderId'], null);
    assert.equal(readRecord(body['folder'], 'folder')['bookCount'], 2);
    assert.deepEqual(bookIds(body['books']), [2, 3]);
    // The Book lands directly behind the Folder it came out of.
    assert.deepEqual(shelfKeys(body['shelfItems']), ['folder:1', 'book:1', 'book:4']);

    const foreignBook = await patch(`${baseUrl}/api/folders/1/books/4/move-to-shelf`);
    assert.equal(foreignBook.status, 409);
    assert.deepEqual(await foreignBook.json(), { error: 'Book is not in this folder' });
  });

  db.close();
});

test('emptying a Folder deletes it and reports the removed id', async () => {
  const db = createShelf();

  await withServer(createApp({ db }), async (baseUrl) => {
    await postJson(`${baseUrl}/api/folders`, { sourceBookId: 1, targetBookId: 2 });
    await patch(`${baseUrl}/api/folders/1/import-book/3`);
    await patch(`${baseUrl}/api/folders/1/books/1/move-to-shelf`);
    await patch(`${baseUrl}/api/folders/1/books/2/move-to-shelf`);

    const response = await patch(`${baseUrl}/api/folders/1/books/3/move-to-shelf`);
    const body = await readJsonRecord(response);

    assert.equal(response.status, 200);
    assert.equal(body['removedFolderId'], 1);
    assert.equal(body['folder'], null);
    assert.deepEqual(body['books'], []);
    assert.deepEqual(shelfKeys(body['shelfItems']), [
      'book:3',
      'book:2',
      'book:1',
      'book:4',
    ]);

    const goneFolder = await fetch(`${baseUrl}/api/folders/1`);
    assert.equal(goneFolder.status, 404);
    assert.deepEqual(await goneFolder.json(), { error: 'Folder not found' });

    const folders = await readJsonRecord(await fetch(`${baseUrl}/api/folders`));
    assert.deepEqual(folders['folders'], []);
  });

  db.close();
});

test('every order route rejects a list that no longer matches the library', async () => {
  const db = createShelf();

  await withServer(createApp({ db }), async (baseUrl) => {
    await postJson(`${baseUrl}/api/folders`, { sourceBookId: 1, targetBookId: 2 });

    const staleBookOrder = await patch(`${baseUrl}/api/books/order`, { bookIds: [3] });
    assert.equal(staleBookOrder.status, 409);
    assert.deepEqual(await staleBookOrder.json(), { error: 'Book order is out of date' });

    const staleFolderOrder = await patch(`${baseUrl}/api/folders/1/books/order`, {
      bookIds: [1],
    });
    assert.equal(staleFolderOrder.status, 409);
    assert.deepEqual(await staleFolderOrder.json(), {
      error: 'Folder book order is out of date',
    });

    const staleShelfOrder = await patch(`${baseUrl}/api/folders/shelf/order`, {
      items: [{ type: 'book', id: 3 }],
    });
    assert.equal(staleShelfOrder.status, 409);
    assert.deepEqual(await staleShelfOrder.json(), { error: 'Shelf order is out of date' });

    const staleMoveOrder = await patch(`${baseUrl}/api/folders/1/books/1/move-to-shelf`, {
      items: [{ type: 'book', id: 999 }],
    });
    assert.equal(staleMoveOrder.status, 409);
    assert.deepEqual(await staleMoveOrder.json(), { error: 'Shelf order is out of date' });

    // The rejected move is rolled back: the Book is still in the Folder.
    const folderBooks = await readJsonRecord(await fetch(`${baseUrl}/api/folders/1/books`));
    assert.deepEqual(bookIds(folderBooks['books']), [1, 2]);

    // A list that does match is still accepted.
    const accepted = await patch(`${baseUrl}/api/folders/1/books/order`, { bookIds: [2, 1] });
    assert.equal(accepted.status, 200);
    assert.deepEqual(bookIds((await readJsonRecord(accepted))['books']), [2, 1]);
  });

  db.close();
});

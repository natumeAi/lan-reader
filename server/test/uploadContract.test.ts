import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { initializeDatabase } from '../src/db/database.js';
import { deleteBookById } from '../src/services/bookLibrary.js';
import { buildEpub } from './support/epub.js';
import { readJsonRecord, readRecord, withServer } from './support/http.js';

test('upload returns the same Book DTO as GET, with no database paths', async () => {
  const db = initializeDatabase(new Database(':memory:'));
  let bookId: number | undefined;
  try {
    await withServer(createApp({ db }), async (baseUrl) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(buildEpub({
        title: 'Upload contract fixture',
        author: 'Test author',
        identifier: 'urn:lan-reader:upload-contract',
      }))], 'upload-contract.epub', { type: 'application/epub+zip' }));
      const response = await fetch(`${baseUrl}/api/books`, { method: 'POST', body: form });
      assert.equal(response.status, 201);
      const body = await readJsonRecord(response);
      const book = readRecord(body['book'], 'book');
      assert.equal(typeof book['id'], 'number');
      if (typeof book['id'] !== 'number') throw new Error('Missing uploaded id');
      bookId = book['id'];
      assert.equal(book['title'], 'Upload contract fixture');
      assert.equal(book['fileName'], 'upload-contract.epub');
      assert.equal(typeof book['coverUrl'], 'string');
      assert.equal(typeof book['coverThumbnailUrl'], 'string');
      assert.equal(Object.keys(book).some((key) => key.includes('_')), false);
      assert.equal('filePath' in book, false);
      assert.equal('fileMtimeMs' in book, false);
      const stored = await readJsonRecord(await fetch(`${baseUrl}/api/books/${bookId}`));
      assert.deepEqual(body, stored);
    });
  } finally {
    if (bookId !== undefined) deleteBookById(db, bookId);
    db.close();
  }
});

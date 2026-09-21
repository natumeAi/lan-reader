import assert from 'node:assert/strict';
import test from 'node:test';

import { isShelfBookItem, isShelfFolderItem } from '../src/index.js';
import type { ShelfItemDto, ShelfItemRef } from '../src/index.js';

test('partitions a mixed Bookshelf of references', () => {
  const shelf: ShelfItemRef[] = [
    { type: 'book', id: 1, sortOrder: 1000 },
    { type: 'folder', id: 9, sortOrder: 2000 },
    { type: 'book', id: 3, sortOrder: 3000 },
  ];

  assert.deepEqual(shelf.filter(isShelfBookItem).map((item) => item.id), [1, 3]);
  assert.deepEqual(shelf.filter(isShelfFolderItem).map((item) => item.id), [9]);
});

test('narrows an embedded Bookshelf entry to the record it carries', () => {
  const bookItem: ShelfItemDto = {
    type: 'book',
    id: 1,
    sortOrder: 1000,
    book: {
      id: 1,
      folderId: null,
      title: 'Root book',
      author: null,
      description: null,
      publisher: null,
      language: null,
      identifier: null,
      fileName: 'root.epub',
      fileSize: 2048,
      coverPath: null,
      coverUrl: null,
      coverThumbnailSmallPath: null,
      coverThumbnailLargePath: null,
      coverThumbnailUrl: null,
      coverThumbnail2xUrl: null,
      coverThumbnailVersion: null,
      sortOrder: 1000,
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    },
  };
  const folderItem: ShelfItemDto = {
    type: 'folder',
    id: 9,
    sortOrder: 2000,
    folder: {
      id: 9,
      name: '技术',
      sortOrder: 2000,
      bookCount: 0,
      previewBooks: [],
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    },
  };

  assert.equal(isShelfBookItem(bookItem) ? bookItem.book.title : null, 'Root book');
  assert.equal(isShelfFolderItem(folderItem) ? folderItem.folder.name : null, '技术');
  assert.equal(isShelfBookItem(folderItem), false);
});

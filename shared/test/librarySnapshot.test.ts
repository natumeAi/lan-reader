import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIBRARY_SNAPSHOT_SCHEMA_VERSION,
  WireDecodeError,
  decodeLibrarySnapshot,
  decodeLibrarySnapshotResponse,
} from '../src/index.js';

/**
 * Mirrors one real `buildLibrarySnapshot` payload: a Bookshelf Book, a Book
 * inside a Folder, the Folder, the ordered Bookshelf, and one Continue Reading
 * entry whose `progress` is the Reading Position object rather than a number.
 */
function serverSnapshot(): unknown {
  return {
    schemaVersion: 1,
    version: 7,
    books: [
      {
        id: 1,
        folderId: null,
        title: 'Root book',
        author: null,
        identifier: null,
        fileName: 'root.epub',
        fileSize: 2048,
        coverPath: null,
        coverUrl: null,
        coverThumbnailUrl: null,
        coverThumbnail2xUrl: null,
        coverThumbnailVersion: null,
        sortOrder: 1000,
        createdAt: '2026-01-01 00:00:00',
        updatedAt: '2026-01-01 00:00:00',
        readingProgress: null,
        readingUpdatedAt: null,
      },
      {
        id: 2,
        folderId: 9,
        title: 'Folder book',
        author: 'Author',
        identifier: 'shared-identifier',
        fileName: 'folder.epub',
        fileSize: 4096,
        coverPath: 'data/covers/2.webp',
        coverUrl: '/covers/2.webp',
        coverThumbnailUrl: '/covers/thumbnails/2.webp',
        coverThumbnail2xUrl: '/covers/thumbnails/2@2x.webp',
        coverThumbnailVersion: 'v1',
        sortOrder: 1000,
        createdAt: '2026-01-01 00:00:00',
        updatedAt: '2026-01-02 00:00:00',
        readingProgress: 0.5,
        readingUpdatedAt: '2026-01-02 00:00:00',
      },
    ],
    folders: [
      {
        id: 9,
        name: '技术',
        sortOrder: 2000,
        bookCount: 1,
        bookIds: [2],
        previewBookIds: [2],
        createdAt: '2026-01-01 00:00:00',
        updatedAt: '2026-01-01 00:00:00',
      },
    ],
    shelf: [
      { type: 'book', id: 1, sortOrder: 1000 },
      { type: 'folder', id: 9, sortOrder: 2000 },
    ],
    recent: [
      {
        bookId: 2,
        progress: {
          bookId: 2,
          cfi: 'epubcfi(/6/4!/4/2)',
          progress: 0.5,
          chapterHref: 'chapter-2.xhtml',
          chapterLabel: '第二章',
          updatedAt: '2026-01-02 00:00:00',
        },
      },
    ],
  };
}

test('decodes a server snapshot into the typed contract', () => {
  const snapshot = decodeLibrarySnapshot(serverSnapshot());

  assert.equal(snapshot.schemaVersion, LIBRARY_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.version, 7);
  assert.equal(snapshot.books.length, 2);
  assert.equal(snapshot.folders[0]?.bookIds[0], 2);
  assert.deepEqual(
    snapshot.shelf.map((item) => `${item.type}:${item.id}`),
    ['book:1', 'folder:9'],
  );
  // A Continue Reading entry carries the Reading Position object, not a number.
  assert.equal(snapshot.recent[0]?.progress.progress, 0.5);
  assert.equal(snapshot.recent[0]?.progress.chapterLabel, '第二章');
});

test('keeps 0 progress distinct from a Book that was never opened', () => {
  const payload = serverSnapshot() as { books: { readingProgress: number | null }[] };
  payload.books[0]!.readingProgress = 0;

  const snapshot = decodeLibrarySnapshot(payload);

  assert.equal(snapshot.books[0]?.readingProgress, 0);
  assert.equal(snapshot.books[1]?.readingProgress, 0.5);
});

test('rejects a snapshot written by another schema version', () => {
  const payload = { ...(serverSnapshot() as object), schemaVersion: 2 };

  assert.throws(
    () => decodeLibrarySnapshot(payload),
    (error: unknown) =>
      error instanceof WireDecodeError
      && error.message === 'Library snapshot version is not supported',
  );
});

test('names the missing array when a snapshot is truncated', () => {
  for (const property of ['books', 'folders', 'shelf', 'recent']) {
    const payload = serverSnapshot() as Record<string, unknown>;
    delete payload[property];

    assert.throws(
      () => decodeLibrarySnapshot(payload),
      (error: unknown) =>
        error instanceof WireDecodeError
        && error.message === `Library snapshot is missing ${property}`,
      `expected a decode failure naming ${property}`,
    );
  }
});

test('accepts the partial Book records the pre-migration client tolerated', () => {
  const snapshot = decodeLibrarySnapshot({
    schemaVersion: 1,
    version: 3,
    books: [{ id: 1, folderId: null, title: 'Root book', sortOrder: 1000 }],
    folders: [],
    shelf: [{ type: 'book', id: 1, sortOrder: 1000 }],
    recent: [],
  });

  assert.equal(snapshot.books[0]?.id, 1);
});

test('rejects a Bookshelf entry that is neither a Book nor a Folder', () => {
  const payload = serverSnapshot() as { shelf: { type: string }[] };
  payload.shelf[0]!.type = 'shelf';

  assert.throws(
    () => decodeLibrarySnapshot(payload),
    /snapshot\.shelf\[0\]\.type must be "book" or "folder"/,
  );
});

test('rejects join keys that are not integers', () => {
  const payload = serverSnapshot() as { recent: { bookId: unknown }[] };
  payload.recent[0]!.bookId = '2';

  assert.throws(() => decodeLibrarySnapshot(payload), /snapshot\.recent\[0\]\.bookId/);
});

test('unwraps the HTTP snapshot envelope', () => {
  const snapshot = decodeLibrarySnapshotResponse({ snapshot: serverSnapshot() });

  assert.equal(snapshot.version, 7);
});

test('rejects a cached value that is not a snapshot at all', () => {
  for (const value of [null, undefined, 'snapshot', 42, []]) {
    assert.throws(() => decodeLibrarySnapshot(value), WireDecodeError);
  }
});

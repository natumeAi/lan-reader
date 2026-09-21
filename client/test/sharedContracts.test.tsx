import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIBRARY_SNAPSHOT_SCHEMA_VERSION,
  MAX_FOLDER_NAME_LENGTH,
  decodeLibrarySnapshot,
} from '@lan-reader/shared';

import {
  LIBRARY_SNAPSHOT_SCHEMA_VERSION as clientSnapshotVersion,
  hydrateLibrarySnapshot,
} from '../src/utils/librarySnapshot.js';

function Probe({ label }: { label: string }) {
  return <span>{label}</span>;
}

test('the client test runner executes TSX', () => {
  const element = <Probe label="ok" />;

  assert.equal(element.type, Probe);
  assert.equal(element.props.label, 'ok');
});

test('the shared workspace resolves from the client at runtime', () => {
  // A type-only import would vanish after compilation; this is a real value.
  assert.equal(typeof MAX_FOLDER_NAME_LENGTH, 'number');
});

test('the client re-exports the shared snapshot version', () => {
  assert.equal(
    LIBRARY_SNAPSHOT_SCHEMA_VERSION,
    clientSnapshotVersion,
    'client snapshot version must remain the shared re-export',
  );
});

test('a decoded snapshot still feeds the existing bookshelf hydration', () => {
  const snapshot = decodeLibrarySnapshot({
    schemaVersion: 1,
    version: 7,
    books: [
      { id: 1, folderId: null, title: 'Root book', sortOrder: 1000 },
      { id: 2, folderId: 9, title: 'Folder book', sortOrder: 1000 },
    ],
    folders: [
      { id: 9, name: '技术', sortOrder: 2000, bookIds: [2], previewBookIds: [2] },
    ],
    shelf: [
      { type: 'book', id: 1, sortOrder: 1000 },
      { type: 'folder', id: 9, sortOrder: 2000 },
    ],
    recent: [{ bookId: 2, progress: { bookId: 2, progress: 0.5 } }],
  });

  const hydrated = hydrateLibrarySnapshot(snapshot);

  assert.deepEqual(
    hydrated.shelfData.items.map((item: { key: string }) => item.key),
    ['book:1', 'folder:9'],
  );
  assert.equal(hydrated.recentData.items[0]?.book.id, 2);
  assert.equal(hydrated.folderBooksByFolderId.get(9)?.length, 1);
});

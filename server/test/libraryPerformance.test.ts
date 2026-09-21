import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeLibrarySnapshotResponse } from '@lan-reader/shared';
import type { BookRow, DatabaseHandle } from '../src/db/rows.js';
import { listeningPort } from './support/http.js';

const testDataDir = mkdtempSync(path.join(tmpdir(), 'epub-reader-performance-'));
process.env.EPUB_DATA_DIR = testDataDir;

// Every module below resolves its storage paths at import time, so the
// environment has to be set first. The type-only imports above are erased and
// therefore load nothing.
const { default: Database } = await import('better-sqlite3');
const { initializeDatabase } = await import('../src/db/database.js');
const {
  ensureBookCoverThumbnails,
  saveBookCover,
  saveBookCoverAssets,
} = await import('../src/services/coverStorage.js');
const { removeBookFileFromLibrary } = await import('../src/services/bookLibrary.js');
const { backfillCoverThumbnails } = await import(
  '../src/services/coverThumbnailBackfill.js'
);
const {
  buildLibrarySnapshot,
  getLibraryRevision,
  librarySnapshotEtag,
} = await import('../src/services/librarySnapshot.js');
const {
  ensureBookDirectory,
  toAbsoluteStoragePath,
  toStoredPath,
} = await import('../src/services/fileStorage.js');
const { default: sharp } = await import('sharp');
const { createApp } = await import('../src/app.js');

after(() => {
  const resolvedTestDataDir = path.resolve(testDataDir);
  const resolvedTempDir = path.resolve(tmpdir());
  assert.ok(resolvedTestDataDir.startsWith(`${resolvedTempDir}${path.sep}`));
  rmSync(resolvedTestDataDir, { force: true, recursive: true });
});

function createMemoryDatabase(): DatabaseHandle {
  return initializeDatabase(new Database(':memory:'));
}

/** The columns a test supplies; the rest fall back to the defaults below. */
interface InsertBookValues {
  id: number;
  folderId?: number | null;
  title: string;
  author?: string | null;
  identifier?: string | null;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs?: number | null;
  coverPath?: string | null;
  sortOrder: number;
}

/** The named bind parameters the statement below expects. */
interface InsertBookParams {
  id: number;
  folderId: number | null;
  title: string;
  author: string | null;
  identifier: string | null;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number | null;
  coverPath: string | null;
  sortOrder: number;
}

function insertBook(db: DatabaseHandle, values: InsertBookValues): void {
  const params: InsertBookParams = {
    author: null,
    coverPath: null,
    fileMtimeMs: 1,
    folderId: null,
    identifier: null,
    ...values,
  };

  db.prepare<InsertBookParams>(`
    INSERT INTO books (
      id,
      folder_id,
      title,
      author,
      identifier,
      file_name,
      file_path,
      file_size,
      file_mtime_ms,
      cover_path,
      sort_order
    )
    VALUES (
      @id,
      @folderId,
      @title,
      @author,
      @identifier,
      @fileName,
      @filePath,
      @fileSize,
      @fileMtimeMs,
      @coverPath,
      @sortOrder
    )
  `).run(params);
}

function readBookRow(db: DatabaseHandle, id: number): BookRow {
  const row = db.prepare<[number], BookRow>('SELECT * FROM books WHERE id = ?').get(id);

  assert.ok(row, `book ${id} must exist`);

  return row;
}

test('library snapshot normalizes books, folders, shelf order, and recent reading', () => {
  const db = createMemoryDatabase();

  db.prepare<[string, number]>(
    'INSERT INTO folders (id, name, sort_order) VALUES (1, ?, ?)',
  ).run('技术', 2000);
  insertBook(db, {
    id: 1,
    title: 'Root book',
    fileName: 'root.epub',
    filePath: 'data/books/root.epub',
    fileSize: 100,
    sortOrder: 1000,
  });
  insertBook(db, {
    id: 2,
    folderId: 1,
    title: 'Folder book',
    fileName: 'folder.epub',
    filePath: 'data/books/folder.epub',
    fileSize: 200,
    sortOrder: 1000,
  });
  db.prepare(`
    INSERT INTO reading_progress (book_id, cfi, progress, updated_at)
    VALUES (2, 'epubcfi(/6/2)', 0.5, '2026-07-31 00:00:00')
  `).run();

  const revision = getLibraryRevision(db);
  const snapshot = buildLibrarySnapshot(db);
  const [firstFolder] = snapshot.folders;
  const [firstRecent] = snapshot.recent;

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.version, revision);
  assert.equal(librarySnapshotEtag(revision), `"library-${revision}"`);
  assert.deepEqual(
    snapshot.shelf.map(({ type, id }) => `${type}:${id}`),
    ['book:1', 'folder:1'],
  );
  assert.ok(firstFolder);
  assert.deepEqual(firstFolder.bookIds, [2]);
  assert.deepEqual(firstFolder.previewBookIds, [2]);
  assert.equal(snapshot.books.length, 2);
  assert.ok(firstRecent);
  assert.equal(firstRecent.bookId, 2);
  assert.equal(firstRecent.progress.progress, 0.5);

  db.close();
});

test('cover assets are content-addressed WebP files at both accepted widths', async () => {
  ensureBookDirectory();
  const bookFilePath = path.join(testDataDir, 'books', 'thumbnail-test.epub');
  writeFileSync(bookFilePath, 'test');
  const coverImage = {
    data: Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
        <rect width="400" height="600" fill="#9b6b43"/>
      </svg>
    `),
    mimeType: 'image/svg+xml',
  };
  const assets = await saveBookCoverAssets({
    bookFilePath,
    coverImage,
    title: 'Thumbnail test',
    author: 'Codex',
  });
  const smallPath = toAbsoluteStoragePath(assets.coverThumbnailSmallPath);
  const largePath = toAbsoluteStoragePath(assets.coverThumbnailLargePath);
  const smallMetadata = await sharp(smallPath).metadata();
  const largeMetadata = await sharp(largePath).metadata();

  assert.equal(smallMetadata.format, 'webp');
  assert.equal(smallMetadata.width, 384);
  assert.equal(largeMetadata.format, 'webp');
  assert.equal(largeMetadata.width, 768);
  assert.ok(assets.coverThumbnailSmallPath.includes(assets.coverThumbnailVersion));
  assert.ok(assets.coverThumbnailLargePath.includes(assets.coverThumbnailVersion));

  const repeated = await ensureBookCoverThumbnails({
    bookFilePath,
    storedCoverPath: assets.coverPath,
  });
  assert.deepEqual(repeated, {
    coverThumbnailSmallPath: assets.coverThumbnailSmallPath,
    coverThumbnailLargePath: assets.coverThumbnailLargePath,
    coverThumbnailVersion: assets.coverThumbnailVersion,
  });
});

test('generated fallback covers center a larger title and omit the author', () => {
  ensureBookDirectory();
  const bookFilePath = path.join(testDataDir, 'books', 'fallback-layout-test.epub');
  writeFileSync(bookFilePath, 'test');
  const coverPath = saveBookCover({
    bookFilePath,
    coverImage: null,
    title: '义妹生活 短篇',
    author: '不应显示的作者',
  });
  const coverSvg = readFileSync(toAbsoluteStoragePath(coverPath), 'utf8');

  assert.match(coverSvg, /data-epub-reader-cover="fallback"/);
  assert.match(coverSvg, /font-size="96"/);
  assert.match(
    coverSvg,
    /font-family="Microsoft YaHei, 微软雅黑, Noto Sans CJK SC/,
  );
  assert.match(coverSvg, /text-anchor="middle"/);
  assert.match(coverSvg, /<tspan x="480" y="720">义妹生活 短篇<\/tspan>/);
  assert.doesNotMatch(coverSvg, /不应显示的作者/);
});

test('legacy covers backfill one book without requiring EPUB parsing', async () => {
  const db = createMemoryDatabase();
  ensureBookDirectory();
  const bookFilePath = path.join(testDataDir, 'books', 'legacy-test.epub');
  writeFileSync(bookFilePath, 'not parsed because a legacy cover exists');
  const coverPath = saveBookCover({
    bookFilePath,
    coverImage: {
      data: Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="320" height="480">
          <rect width="320" height="480" fill="#345678"/>
        </svg>
      `),
      mimeType: 'image/svg+xml',
    },
    title: 'Legacy',
    author: null,
  });

  insertBook(db, {
    id: 1,
    title: 'Legacy',
    fileName: path.basename(bookFilePath),
    filePath: toStoredPath(bookFilePath),
    fileSize: 42,
    coverPath,
    sortOrder: 1000,
  });

  const result = await backfillCoverThumbnails(db, {
    betweenBookDelayMs: 0,
  });
  const book = readBookRow(db, 1);

  assert.deepEqual(result, {
    convertedCount: 1,
    failedCount: 0,
    stopped: false,
  });
  assert.ok(existsSync(toAbsoluteStoragePath(book.cover_thumbnail_small_path)));
  assert.ok(existsSync(toAbsoluteStoragePath(book.cover_thumbnail_large_path)));
  assert.ok(book.cover_thumbnail_version);

  db.close();
});

test('thumbnail backfill refreshes legacy generated fallback covers', async () => {
  const db = createMemoryDatabase();
  ensureBookDirectory();
  const bookFilePath = path.join(testDataDir, 'books', 'legacy-fallback-test.epub');
  writeFileSync(bookFilePath, 'not parsed because a generated fallback exists');
  const coverPath = saveBookCover({
    bookFilePath,
    coverImage: null,
    title: '旧版书名',
    author: '旧版作者',
  });
  const absoluteCoverPath = toAbsoluteStoragePath(coverPath);
  writeFileSync(
    absoluteCoverPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1440">
      <defs><linearGradient id="paper"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
      <rect width="960" height="1440" rx="36" fill="url(#paper)"/>
      <text x="80" y="232" font-size="34" font-family="Georgia, serif" fill="#9a7d62" letter-spacing="5">EPUB</text>
      <text x="80" y="690" font-size="72" font-family="Georgia, serif" font-weight="700" fill="#3f342b">旧版书名</text>
      <text x="80" y="1040" font-size="42" font-family="Georgia, serif" fill="#6f6257">旧版作者</text>
    </svg>`,
    'utf8',
  );
  const legacySmallPath = path.join(testDataDir, 'covers', 'thumbnails', 'legacy-small.webp');
  const legacyLargePath = path.join(testDataDir, 'covers', 'thumbnails', 'legacy-large.webp');
  mkdirSync(path.dirname(legacySmallPath), { recursive: true });
  writeFileSync(legacySmallPath, 'old thumbnail');
  writeFileSync(legacyLargePath, 'old thumbnail');

  insertBook(db, {
    id: 1,
    title: '新版居中书名',
    author: '不应显示的作者',
    fileName: path.basename(bookFilePath),
    filePath: toStoredPath(bookFilePath),
    fileSize: 42,
    coverPath,
    sortOrder: 1000,
  });
  db.prepare<[string, string, string]>(`
    UPDATE books
    SET cover_thumbnail_small_path = ?,
        cover_thumbnail_large_path = ?,
        cover_thumbnail_version = ?
    WHERE id = 1
  `).run(
    toStoredPath(legacySmallPath),
    toStoredPath(legacyLargePath),
    'legacy-version',
  );

  const result = await backfillCoverThumbnails(db, {
    betweenBookDelayMs: 0,
  });
  const book = readBookRow(db, 1);
  const refreshedSvg = readFileSync(toAbsoluteStoragePath(book.cover_path), 'utf8');

  assert.equal(result.convertedCount, 1);
  assert.ok(book.cover_thumbnail_version);
  assert.match(book.cover_thumbnail_version, /^v3-/);
  assert.notEqual(book.cover_thumbnail_small_path, toStoredPath(legacySmallPath));
  assert.match(refreshedSvg, /data-epub-reader-cover="fallback"/);
  assert.match(refreshedSvg, /新版居中书名/);
  assert.doesNotMatch(refreshedSvg, /不应显示的作者|旧版作者/);

  db.close();
});

test('removing a book deletes every generated cover variant', async () => {
  const db = createMemoryDatabase();
  ensureBookDirectory();
  const bookFilePath = path.join(testDataDir, 'books', 'delete-cover-test.epub');
  writeFileSync(bookFilePath, 'cover cleanup test');
  const assets = await saveBookCoverAssets({
    bookFilePath,
    coverImage: {
      data: Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
          <rect width="400" height="600" fill="#654321"/>
        </svg>
      `),
      mimeType: 'image/svg+xml',
    },
    title: 'Cleanup',
    author: null,
  });

  insertBook(db, {
    id: 1,
    title: 'Cleanup',
    fileName: path.basename(bookFilePath),
    filePath: toStoredPath(bookFilePath),
    fileSize: 42,
    coverPath: assets.coverPath,
    sortOrder: 1000,
  });
  db.prepare<[string, string, string]>(`
    UPDATE books
    SET cover_thumbnail_small_path = ?,
        cover_thumbnail_large_path = ?,
        cover_thumbnail_version = ?
    WHERE id = 1
  `).run(
    assets.coverThumbnailSmallPath,
    assets.coverThumbnailLargePath,
    assets.coverThumbnailVersion,
  );

  assert.equal(removeBookFileFromLibrary(db, bookFilePath), 1);
  assert.equal(existsSync(toAbsoluteStoragePath(assets.coverPath)), false);
  assert.equal(existsSync(toAbsoluteStoragePath(assets.coverThumbnailSmallPath)), false);
  assert.equal(existsSync(toAbsoluteStoragePath(assets.coverThumbnailLargePath)), false);

  db.close();
});

test('snapshot endpoint compresses payloads and answers matching revisions with 304', async () => {
  const db = createMemoryDatabase();

  for (let id = 1; id <= 30; id += 1) {
    insertBook(db, {
      id,
      title: `Synthetic book ${id}`,
      fileName: `synthetic-${id}.epub`,
      filePath: `data/books/synthetic-${id}.epub`,
      fileSize: id * 100,
      sortOrder: id * 1000,
    });
  }

  const server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const port = listeningPort(server);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/library/snapshot`,
      {
        headers: {
          'Accept-Encoding': 'gzip',
        },
      },
    );
    const etag = response.headers.get('etag');
    const snapshot = decodeLibrarySnapshotResponse(await response.json());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.ok(etag);
    assert.equal(snapshot.books.length, 30);

    const unchangedResponse = await fetch(
      `http://127.0.0.1:${port}/api/library/snapshot`,
      {
        headers: {
          'If-None-Match': etag,
        },
      },
    );
    assert.equal(unchangedResponse.status, 304);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    db.close();
  }
});

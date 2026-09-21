import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { internalError, readErrorCode } from '../http/httpError.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..', '..');

// Resolved once, at module scope: tests and `test/support/isolateData.mjs` set
// EPUB_DATA_DIR before importing this module and rely on that ordering. Making
// these lazy would change when the environment is read.
export const dataDir = process.env.EPUB_DATA_DIR
  ? path.resolve(process.env.EPUB_DATA_DIR)
  : path.join(serverRoot, 'data');
export const booksDir = path.join(dataDir, 'books');
export const coversDir = path.join(dataDir, 'covers');
export const coverThumbnailsDir = path.join(coversDir, 'thumbnails');
export const stagingDir = path.join(dataDir, 'staging');
export const STALE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Path segments that `res.sendFile` refuses to serve.
 *
 * Express's `send` defaults to `dotfiles: 'ignore'`, and with no `root` option
 * it applies that to every segment of the path. Its pipeline is
 * `normalize(path).split(sep)` and then `part.length > 1 && part[0] === '.'`,
 * both mirrored here — normalising first matters, because `..` satisfies that
 * predicate and would otherwise be reported as hidden even though `send` has
 * already collapsed it away. A Book stored beneath a genuinely hidden directory
 * answers 404 on `GET /api/books/:id/file`, no matter that the file is present
 * and every other endpoint works.
 */
function hiddenPathSegments(absolutePath: string): string[] {
  return path
    .normalize(absolutePath)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 1 && segment.startsWith('.'));
}

/**
 * The warning to print when the configured data directory cannot serve Books,
 * or `null` when it can. Reported at startup rather than enforced: a hidden
 * directory is perfectly usable for everything except that one route, and
 * refusing to boot over it would be a harsher rule than the one being broken.
 */
export function describeUnservableDataDir(bookDirectory: string = booksDir): string | null {
  const hiddenSegments = hiddenPathSegments(bookDirectory);

  if (hiddenSegments.length === 0) {
    return null;
  }

  return (
    `EPUB_DATA_DIR resolves to ${bookDirectory}, which contains the hidden path ` +
    `segment ${hiddenSegments.join(', ')}. Express refuses to serve files under a ` +
    'dot-segment, so GET /api/books/:id/file will answer 404 for every Book. ' +
    'Move the data directory to a path with no leading-dot component.'
  );
}

export function ensureBookDirectory(): void {
  mkdirSync(booksDir, { recursive: true });
}

export function ensureCoverDirectory(): void {
  mkdirSync(coversDir, { recursive: true });
  mkdirSync(coverThumbnailsDir, { recursive: true });
}

export function ensureStagingDirectory(): void {
  mkdirSync(stagingDir, { recursive: true });
}

/**
 * Prepares the storage layout for a running server.
 *
 * Importing this module must not touch the filesystem, so the directory and
 * staging work a server needs is collected here and called from the startup
 * path instead of from the application factory.
 */
export function initializeStorage(): void {
  ensureCoverDirectory();
  ensureStagingDirectory();
  cleanupStaleUploads();
}

function safeStorageFileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();

  if (!baseName || baseName === '.epub') {
    return 'Untitled Book.epub';
  }

  return isEpubFileName(baseName) ? baseName : `${baseName}.epub`;
}

function availableBookFileName(fileName: string): string {
  const safeName = safeStorageFileName(fileName);
  const parsedName = path.parse(safeName);
  let candidateName = safeName;
  let index = 1;

  while (existsSync(path.join(booksDir, candidateName))) {
    candidateName = `${parsedName.name} (${index})${parsedName.ext || '.epub'}`;
    index += 1;
  }

  return candidateName;
}

export function createEpubUploadStorage(): multer.StorageEngine {
  return multer.diskStorage({
    destination(_req, _file, callback) {
      ensureStagingDirectory();
      callback(null, stagingDir);
    },
    filename(_req, _file, callback) {
      callback(null, `${randomUUID()}.epub`);
    },
  });
}

function isDirectStagingFile(filePath: string): boolean {
  const relativePath = path.relative(path.resolve(stagingDir), path.resolve(filePath));
  return Boolean(relativePath) && !relativePath.includes(path.sep) && !path.isAbsolute(relativePath);
}

function moveUploadAcrossFilesystems(uploadedPath: string, finalPath: string): void {
  const temporaryPath = path.join(path.dirname(finalPath), `.${randomUUID()}.uploading`);

  try {
    fs.copyFileSync(uploadedPath, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporaryPath, finalPath);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary error.
      }
    }
    throw error;
  }

  try {
    unlinkSync(uploadedPath);
  } catch {
    // A stale staging copy is safer than failing after the Book was published.
  }
}

export function moveValidatedUploadToBooks(uploadedPath: string, originalName: string): string {
  if (!isDirectStagingFile(uploadedPath)) {
    throw internalError('Upload path is outside staging');
  }

  ensureBookDirectory();
  const finalPath = path.join(booksDir, availableBookFileName(originalName));
  try {
    fs.renameSync(uploadedPath, finalPath);
  } catch (error) {
    // Staging and books can sit on different filesystems (bind mounts, tmpfs);
    // `rename` then fails with EXDEV and the file has to be copied instead.
    if (readErrorCode(error) !== 'EXDEV') throw error;
    moveUploadAcrossFilesystems(uploadedPath, finalPath);
  }
  return finalPath;
}

export interface CleanupStaleUploadsOptions {
  now?: number;
  maxAgeMs?: number;
}

export function cleanupStaleUploads(options: CleanupStaleUploadsOptions = {}): number {
  ensureStagingDirectory();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_UPLOAD_MAX_AGE_MS;
  let removedCount = 0;

  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(stagingDir, entry.name);
    if (!isDirectStagingFile(filePath)) continue;
    const fileStat = statSync(filePath);
    if (now - fileStat.mtimeMs <= maxAgeMs) continue;
    unlinkSync(filePath);
    removedCount += 1;
  }

  return removedCount;
}

export function isEpubFileName(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === '.epub';
}

export function isEpubUpload(file: Express.Multer.File): boolean {
  return isEpubFileName(file.originalname);
}

export function fileNameFromUpload(file: Express.Multer.File): string {
  const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');

  if (!decodedName || decodedName.includes('\uFFFD')) {
    return file.originalname;
  }

  return decodedName;
}

export function titleFromFileName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).trim() || 'Untitled Book';
}

export function titleFromUpload(file: Express.Multer.File): string {
  return titleFromFileName(fileNameFromUpload(file));
}

export function toStoredPath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(dataDir, absolutePath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw internalError('Storage path is outside EPUB_DATA_DIR');
  }

  return `data/${relativePath.replaceAll(path.sep, '/')}`;
}

export function toAbsoluteStoragePath(storedPath: string | null | undefined): string {
  if (!storedPath?.startsWith('data/')) {
    throw internalError('Stored path is outside EPUB_DATA_DIR');
  }

  const absolutePath = path.resolve(dataDir, storedPath.slice('data/'.length));
  const relativePath = path.relative(dataDir, absolutePath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw internalError('Stored path is outside EPUB_DATA_DIR');
  }

  return absolutePath;
}

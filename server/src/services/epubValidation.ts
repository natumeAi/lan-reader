/**
 * Structural validation of an EPUB container.
 *
 * This is the boundary between "an uploaded file" and "a Book": every
 * rejection carries a stable `reason` string, and the callers
 * (`bookLibrary`, `bookDirectoryWatcher`) branch on `InvalidEpubError`.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { HttpError } from '../http/httpError.js';

const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MEBIBYTE = 1024 * 1024;

function positiveLimit(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

export interface InvalidEpubErrorOptions {
  cause?: unknown;
}

/**
 * A rejected EPUB: 400 with code `INVALID_EPUB`.
 *
 * It extends `HttpError` so the error handler needs no special case, but it
 * keeps its own class, its own `name` and the `reason` that says which check
 * failed.
 */
export class InvalidEpubError extends HttpError {
  readonly reason: string;

  constructor(reason: string, options: InvalidEpubErrorOptions = {}) {
    super(400, 'EPUB 文件无效或已损坏', 'INVALID_EPUB');
    this.name = 'InvalidEpubError';
    this.reason = reason;

    // `HttpError` takes no error options, so the `cause` pass-through is done
    // here. `Error` only installs `cause` when the key is present, not when it
    // is merely `undefined`, which is what `in` reproduces.
    if ('cause' in options) {
      this.cause = options.cause;
    }
  }
}

export interface EpubValidationLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
}

export type EpubValidationLimitOptions = Partial<EpubValidationLimits>;

/**
 * Explicit limits win; otherwise the environment is read, and anything that is
 * not a finite positive number — including the `NaN` produced by
 * `Number(undefined) * MEBIBYTE` — falls back to the built-in limit.
 */
export function resolveEpubValidationLimits(
  options: EpubValidationLimitOptions = {},
): EpubValidationLimits {
  return {
    maxEntries: positiveLimit(
      options.maxEntries ?? process.env.EPUB_MAX_ENTRIES,
      10_000,
    ),
    maxTotalUncompressedBytes: positiveLimit(
      options.maxTotalUncompressedBytes ??
        (Number(process.env.EPUB_MAX_UNCOMPRESSED_MB) * MEBIBYTE),
      500 * MEBIBYTE,
    ),
    maxEntryUncompressedBytes: positiveLimit(
      options.maxEntryUncompressedBytes ??
        (Number(process.env.EPUB_MAX_ENTRY_MB) * MEBIBYTE),
      100 * MEBIBYTE,
    ),
  };
}

function assertZipSignature(filePath: string): void {
  const descriptor = openSync(filePath, 'r');
  try {
    const signature = Buffer.alloc(4);
    const bytesRead = readSync(descriptor, signature, 0, 4, 0);
    if (bytesRead !== 4 || !signature.equals(ZIP_LOCAL_FILE_SIGNATURE)) {
      throw new InvalidEpubError('ZIP_SIGNATURE');
    }
  } finally {
    closeSync(descriptor);
  }
}

function normalizedEntryName(entry: AdmZip.IZipEntry): string {
  return entry.entryName.replaceAll('\\', '/').replace(/^\/+/, '');
}

export interface EpubArchiveSummary {
  entryCount: number;
  totalUncompressedBytes: number;
}

export function validateEpubArchive(
  filePath: string,
  options: EpubValidationLimitOptions = {},
): EpubArchiveSummary {
  if (path.extname(filePath).toLowerCase() !== '.epub') {
    throw new InvalidEpubError('FILE_EXTENSION');
  }

  try {
    assertZipSignature(filePath);
  } catch (error) {
    if (error instanceof InvalidEpubError) throw error;
    throw new InvalidEpubError('ZIP_READ', { cause: error });
  }

  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(filePath).getEntries();
  } catch (error) {
    throw new InvalidEpubError('ZIP_DIRECTORY', { cause: error });
  }

  const limits = resolveEpubValidationLimits(options);
  if (entries.length > limits.maxEntries) {
    throw new InvalidEpubError('ENTRY_COUNT');
  }

  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const entrySize = Number(entry.header?.size);
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
      throw new InvalidEpubError('ENTRY_SIZE');
    }
    if (entrySize > limits.maxEntryUncompressedBytes) {
      throw new InvalidEpubError('ENTRY_SIZE_LIMIT');
    }
    totalUncompressedBytes += entrySize;
    if (
      !Number.isSafeInteger(totalUncompressedBytes) ||
      totalUncompressedBytes > limits.maxTotalUncompressedBytes
    ) {
      throw new InvalidEpubError('TOTAL_SIZE_LIMIT');
    }
  }

  const entryMap = new Map(
    entries.map((entry): [string, AdmZip.IZipEntry] => [normalizedEntryName(entry), entry]),
  );
  const mimetypeEntry = entryMap.get('mimetype');
  if (!mimetypeEntry || mimetypeEntry.isDirectory) {
    throw new InvalidEpubError('MIMETYPE_MISSING');
  }

  let mimetype: string;
  try {
    mimetype = mimetypeEntry.getData().toString('utf8');
  } catch (error) {
    throw new InvalidEpubError('MIMETYPE_READ', { cause: error });
  }
  if (mimetype !== 'application/epub+zip') {
    throw new InvalidEpubError('MIMETYPE_VALUE');
  }

  const containerEntry = entryMap.get('META-INF/container.xml');
  if (!containerEntry || containerEntry.isDirectory) {
    throw new InvalidEpubError('CONTAINER_MISSING');
  }

  return {
    entryCount: entries.length,
    totalUncompressedBytes,
  };
}

/**
 * Book routes: the Catalog, the Bookshelf order, uploads, downloads, deletes.
 *
 * Registration order is part of the compatibility surface and is kept exactly
 * as it was: `/catalog` is matched before `/:id`, and `/order` keeps its place
 * after it. Request parsing now comes from `http/requestInput.ts`; the checks,
 * the messages and the statuses are the ones this file used to carry itself.
 */
import { existsSync, unlinkSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import type {
  BookResponse,
  BooksResponse,
  CatalogBooksResponse,
  UploadBookResponse,
} from '@lan-reader/shared';
import { badRequest, notFound } from '../http/httpError.js';
import {
  parseBookId,
  parseBookIds,
  parseOptionalFolderId,
  readRequestBody,
  requireDatabase,
} from '../http/requestInput.js';
import {
  addBookFileToLibrary,
  deleteBookById,
  getBookById,
  getBookFilePath,
  inspectEpubFile,
  listBooks,
  listCatalogBooks,
  updateShelfBookOrder,
} from '../services/bookLibrary.js';
import { deleteBookCoverFiles } from '../services/coverStorage.js';
import {
  createEpubUploadStorage,
  fileNameFromUpload,
  isEpubUpload,
  moveValidatedUploadToBooks,
  titleFromUpload,
} from '../services/fileStorage.js';

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The upload ceiling in bytes, from `EPUB_UPLOAD_MAX_MB`.
 *
 * multer 2.x requires `limits.fileSize` to be a non-negative integer and throws
 * otherwise — while this module is being evaluated, which takes the process
 * down before it can serve anything. A configured value such as `0.002` is a
 * finite, positive number of megabytes but a fractional number of bytes, so the
 * byte count is floored. A value that rounds down to nothing is treated the
 * same way as the other nonsensical inputs this has always rejected, and falls
 * back to the default. Every whole number of megabytes is unaffected.
 */
export function resolveMaxUploadBytes(configuredValue: string | undefined): number {
  const configuredMaxUploadSizeMb = Number(configuredValue || 100);

  if (!Number.isFinite(configuredMaxUploadSizeMb) || configuredMaxUploadSizeMb <= 0) {
    return DEFAULT_MAX_UPLOAD_BYTES;
  }

  const maxUploadBytes = Math.floor(configuredMaxUploadSizeMb * 1024 * 1024);

  return maxUploadBytes > 0 ? maxUploadBytes : DEFAULT_MAX_UPLOAD_BYTES;
}

const upload = multer({
  storage: createEpubUploadStorage(),
  limits: {
    fileSize: resolveMaxUploadBytes(process.env['EPUB_UPLOAD_MAX_MB']),
  },
  fileFilter(_req, file, callback) {
    if (!isEpubUpload(file)) {
      callback(badRequest('Only EPUB files are supported'));
      return;
    }

    callback(null, true);
  },
});

const router = Router();

/**
 * Runs the single-file upload and gives multer's own failures a status.
 *
 * `MulterError` is multer's class, not an `HttpError`, so the status is
 * attached to the instance exactly as before — the error handler reads it
 * through `readErrorStatus` either way.
 */
function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      next(Object.assign(err, { status: 400 }));
      return;
    }

    next(err);
  });
}

router.get('/', (req, res: Response<BooksResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parseOptionalFolderId(req.query.folderId);
    const books = folderId === undefined ? listBooks(db) : listBooks(db, { folderId });

    res.json({ books });
  } catch (err) {
    next(err);
  }
});

router.get('/catalog', (req, res: Response<CatalogBooksResponse>, next) => {
  try {
    const db = requireDatabase(req);
    res.json({ books: listCatalogBooks(db) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res: Response<BookResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const bookId = parseBookId(req.params.id);
    const book = getBookById(db, bookId);

    if (!book) {
      throw notFound('Book not found');
    }

    res.json({ book });
  } catch (err) {
    next(err);
  }
});

router.patch('/order', (req, res: Response<BooksResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const bookIds = parseBookIds(readRequestBody(req).bookIds);
    const books = updateShelfBookOrder(db, bookIds);

    res.json({ books });
  } catch (err) {
    next(err);
  }
});

// The 201 body is the raw `books` row, not a `BookDto`; `UploadBookResponse` in
// `@lan-reader/shared` describes that legacy shape, including the `null` the
// import helper can answer. Binding the response to it is what makes a column
// added to `BookRow` a compile error here instead of silent contract drift.
router.post('/', handleUpload, async (req, res: Response<UploadBookResponse>, next) => {
  const uploadedFile = req.file;
  const stagedPath = uploadedFile?.path;
  let finalPath: string | null = null;
  let committed = false;

  try {
    const db = requireDatabase(req);

    if (!uploadedFile) {
      throw badRequest('EPUB file is required');
    }

    const displayFileName = fileNameFromUpload(uploadedFile);
    const epubDetails = await inspectEpubFile(uploadedFile.path);
    finalPath = moveValidatedUploadToBooks(uploadedFile.path, displayFileName);
    const book = await addBookFileToLibrary(db, finalPath, {
      archiveValidated: true,
      epubDetails,
      fileName: displayFileName,
      title: titleFromUpload(uploadedFile),
    });
    committed = true;
    res.status(201).json({ book });
  } catch (error) {
    if (!committed) {
      for (const filePath of [stagedPath, finalPath]) {
        if (!filePath || !existsSync(filePath)) continue;
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the primary error.
        }
      }
      if (finalPath) {
        try {
          deleteBookCoverFiles(finalPath);
        } catch {
          // Preserve the primary error.
        }
      }
    }
    next(error);
  }
});

router.get('/:id/file', (req, res, next) => {
  try {
    const db = requireDatabase(req);
    const bookId = parseBookId(req.params.id);
    const filePath = getBookFilePath(db, bookId);

    if (!filePath) {
      throw notFound('Book not found');
    }

    res.setHeader('Content-Type', 'application/epub+zip');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res: Response<BookResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const bookId = parseBookId(req.params.id);
    const book = deleteBookById(db, bookId);

    if (!book) {
      throw notFound('Book not found');
    }

    res.json({ book });
  } catch (err) {
    next(err);
  }
});

export default router;

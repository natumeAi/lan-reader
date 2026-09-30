/**
 * Folder routes and the Bookshelf arrangement.
 *
 * `/shelf` and `/shelf/order` stay registered before `/:id` so a literal
 * "shelf" is never parsed as a Folder id. Request parsing now comes from
 * `http/requestInput.ts` — the same checks, messages and statuses this file
 * used to declare inline.
 */
import type { Response } from 'express';
import { Router } from 'express';
import type {
  BatchFolderImportResponse,
  BatchMoveToShelfResponse,
  FolderBooksResponse,
  FolderMutationResponse,
  FolderResponse,
  FoldersResponse,
  MoveFolderBookToShelfResponse,
  ShelfItemsResponse,
} from '@lan-reader/shared';
import { badRequest, notFound } from '../http/httpError.js';
import {
  parseBatchBookIds,
  parseBookIds,
  parsePositiveInteger,
  parseShelfItems,
  readRequestBody,
  requireDatabase,
} from '../http/requestInput.js';
import { listBooks } from '../services/bookLibrary.js';
import {
  batchImportBooksToFolder,
  batchMoveBooksToShelf,
  createFolderFromBooks,
  getFolder,
  listFolders,
  listShelfItems,
  moveFolderBookToShelf,
  moveShelfBookToFolder,
  renameFolder,
  updateFolderBookOrder,
  updateShelfItemOrder,
} from '../services/folderLibrary.js';

const router = Router();

router.get('/shelf', (req, res: Response<ShelfItemsResponse>, next) => {
  try {
    const db = requireDatabase(req);

    res.json({ items: listShelfItems(db) });
  } catch (err) {
    next(err);
  }
});

router.patch('/shelf/order', (req, res: Response<ShelfItemsResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const items = parseShelfItems(readRequestBody(req).items);

    res.json({ items: updateShelfItemOrder(db, items) });
  } catch (err) {
    next(err);
  }
});

router.patch('/shelf/batch-move-out', (req, res: Response<BatchMoveToShelfResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const bookIds = parseBatchBookIds(readRequestBody(req).bookIds);
    res.json(batchMoveBooksToShelf(db, bookIds));
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res: Response<FoldersResponse>, next) => {
  try {
    const db = requireDatabase(req);

    res.json({ folders: listFolders(db) });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res: Response<FolderMutationResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const body = readRequestBody(req);
    const result = createFolderFromBooks(db, {
      sourceBookId: parsePositiveInteger(body.sourceBookId, 'sourceBookId'),
      targetBookId: parsePositiveInteger(body.targetBookId, 'targetBookId'),
      name: body.name,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res: Response<FolderResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parsePositiveInteger(req.params.id, 'folder id');
    const folder = getFolder(db, folderId);

    if (!folder) {
      throw notFound('Folder not found');
    }

    res.json({ folder });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', (req, res: Response<FolderResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parsePositiveInteger(req.params.id, 'folder id');
    const body = readRequestBody(req);
    if (!Object.hasOwn(body, 'name')) {
      throw badRequest('name is required');
    }
    const folder = renameFolder(db, folderId, body.name);

    if (!folder) {
      throw notFound('Folder not found');
    }

    res.json({ folder });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/books', (req, res: Response<FolderBooksResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parsePositiveInteger(req.params.id, 'folder id');

    if (!getFolder(db, folderId)) {
      throw notFound('Folder not found');
    }

    res.json({ books: listBooks(db, { folderId }) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/books/order', (req, res: Response<FolderBooksResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parsePositiveInteger(req.params.id, 'folder id');
    const bookIds = parseBookIds(readRequestBody(req).bookIds);

    res.json({ books: updateFolderBookOrder(db, folderId, bookIds) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/books/batch-import', (req, res: Response<BatchFolderImportResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parsePositiveInteger(req.params.id, 'folder id');
    const bookIds = parseBatchBookIds(readRequestBody(req).bookIds);
    res.json(batchImportBooksToFolder(db, folderId, bookIds));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/import-book/:bookId', (req, res: Response<FolderMutationResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const folderId = parsePositiveInteger(req.params.id, 'folder id');
    const bookId = parsePositiveInteger(req.params.bookId, 'book id');

    const body = readRequestBody(req);
    const bookIds = Object.hasOwn(body, 'bookIds') ? parseBookIds(body.bookIds) : undefined;

    res.json(moveShelfBookToFolder(db, folderId, bookId, { bookIds }));
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id/books/:bookId/move-to-shelf',
  (req, res: Response<MoveFolderBookToShelfResponse>, next) => {
    try {
      const db = requireDatabase(req);
      const folderId = parsePositiveInteger(req.params.id, 'folder id');
      const bookId = parsePositiveInteger(req.params.bookId, 'book id');
      const requestedItems = readRequestBody(req).items;
      const items = requestedItems === undefined ? undefined : parseShelfItems(requestedItems);

      res.json(moveFolderBookToShelf(db, folderId, bookId, { items }));
    } catch (err) {
      next(err);
    }
  },
);

export default router;

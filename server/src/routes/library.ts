/**
 * The library snapshot: one request that carries the whole Bookshelf.
 *
 * The revision and its ETag are computed before the snapshot is built, so a
 * client whose `If-None-Match` still matches is answered 304 without the
 * database ever assembling a payload. A 304 carries no body.
 */
import type { Response } from 'express';
import { Router } from 'express';
import type { LibrarySnapshotResponse } from '@lan-reader/shared';
import { requireDatabase } from '../http/requestInput.js';
import {
  buildLibrarySnapshot,
  getLibraryRevision,
  librarySnapshotEtag,
} from '../services/librarySnapshot.js';

const router = Router();

router.get('/snapshot', (req, res: Response<LibrarySnapshotResponse>, next) => {
  try {
    const db = requireDatabase(req);
    const revision = getLibraryRevision(db);
    const etag = librarySnapshotEtag(revision);

    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('X-Library-Revision', String(revision));

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.json({ snapshot: buildLibrarySnapshot(db) });
  } catch (error) {
    next(error);
  }
});

export default router;

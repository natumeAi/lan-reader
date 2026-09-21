/**
 * Request parsing shared by the Book, Folder, Library and Reading routes.
 *
 * Every route used to carry its own copy of these checks. The behaviour here is
 * the behaviour those copies had, down to the wording of each message and the
 * inputs they accept: identifiers go through `Number()`, so `'1'`, `'01'`,
 * `' 1 '`, `'1.0'`, `'+1'`, `'0x1'`, `'1e0'`, `[5]` and `true` all still resolve
 * to a valid id. Tightening that with `parseInt`, a regular expression or a
 * `typeof` check would reject requests the API accepts today.
 */
import type { Request } from 'express';
import type { ShelfItemType, ShelfOrderItem } from '@lan-reader/shared';
import { isRecord } from '@lan-reader/shared';
import type { DatabaseHandle } from '../db/rows.js';
import { badRequest, serviceUnavailable } from './httpError.js';

function isDatabaseHandle(value: unknown): value is DatabaseHandle {
  return isRecord(value) && typeof value['prepare'] === 'function';
}

function isShelfItemType(value: unknown): value is ShelfItemType {
  return value === 'book' || value === 'folder';
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * The connection `app.locals` holds, or `undefined`.
 *
 * `/api/health` reports `'unconfigured'` and stays 200 rather than failing, so
 * it needs a read that reports absence instead of throwing.
 */
export function readConfiguredDatabase(req: Request): DatabaseHandle | undefined {
  const db: unknown = req.app.locals['db'];

  return isDatabaseHandle(db) ? db : undefined;
}

/**
 * The connection the request must run against.
 *
 * `app.locals.db` is only unset when the process was started without a
 * database, which is answered with 503 exactly as before.
 */
export function requireDatabase(req: Request): DatabaseHandle {
  const db = readConfiguredDatabase(req);

  if (!db) {
    throw serviceUnavailable('Database is not configured');
  }

  return db;
}

/**
 * A request body as a plain record.
 *
 * Express 5 leaves `req.body` undefined when no JSON body was parsed. Reading a
 * field off it used to throw a `TypeError` and surface as 500; a missing body is
 * now the empty object, so those requests fail the same validation — and return
 * the same 400 — as a request that sent `{}`.
 */
export function readRequestBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;

  return isRecord(body) ? body : {};
}

export function parsePositiveInteger(value: unknown, label: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw badRequest(`${label} must be a positive integer`);
  }

  return parsedValue;
}

export function parseBookId(value: unknown): number {
  return parsePositiveInteger(value, 'book id');
}

export function parseOptionalFolderId(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parsePositiveInteger(value, 'folderId');
}

export function parseBookIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw badRequest('bookIds must be an array');
  }

  const entries: unknown[] = value;
  const bookIds = entries.map((bookId) => parseBookId(bookId));

  if (new Set(bookIds).size !== bookIds.length) {
    throw badRequest('bookIds must be unique');
  }

  return bookIds;
}

export function parseShelfItems(value: unknown): ShelfOrderItem[] {
  if (!Array.isArray(value)) {
    throw badRequest('items must be an array');
  }

  const entries: unknown[] = value;
  const items = entries.map((entry) => {
    const type = readProperty(entry, 'type');

    if (!entry || !isShelfItemType(type)) {
      throw badRequest('items must contain book or folder entries');
    }

    return {
      type,
      id: parsePositiveInteger(readProperty(entry, 'id'), `${type} id`),
    };
  });

  const itemKeys = items.map((item) => `${item.type}:${item.id}`);

  if (new Set(itemKeys).size !== itemKeys.length) {
    throw badRequest('items must be unique');
  }

  return items;
}

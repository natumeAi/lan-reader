/**
 * Reading results that the surrounding SQL is guaranteed to produce.
 *
 * `better-sqlite3` types `Statement.get()` as `Result | undefined`, but several
 * queries here cannot miss: an aggregate such as `COUNT(*)` always yields one
 * row, and a row inserted or updated earlier in the same transaction is always
 * readable back. The pre-migration JavaScript dereferenced those results
 * directly, so a missing row would have thrown a `TypeError` and surfaced as a
 * 500. This keeps that 500 — with a message naming the query instead of an
 * unchecked assertion — and never fires in practice.
 */
import { internalError } from '../http/httpError.js';

export function requireQueryResult<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) {
    throw internalError(`${description} returned no row`);
  }

  return value;
}

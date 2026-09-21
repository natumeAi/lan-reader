/**
 * The HTTP error shape the error handler understands.
 *
 * The routes used to throw `new Error(message)` and then assign `.status` /
 * `.code` onto it. `HttpError` carries the same two fields, so every status,
 * message and code stays byte for byte what the API returned before.
 *
 * Not every error reaching the handler is an `HttpError`: multer throws its own
 * `MulterError` (which only gets a `status` assigned), and `InvalidEpubError`
 * is its own class. `readErrorStatus` / `readErrorCode` therefore read any
 * error-like value instead of assuming a concrete class.
 */
import { isRecord } from '@lan-reader/shared';

export class HttpError extends Error {
  readonly status: number;

  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code?: string): HttpError {
  return new HttpError(400, message, code);
}

export function notFound(message: string, code?: string): HttpError {
  return new HttpError(404, message, code);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

export function serviceUnavailable(message: string): HttpError {
  return new HttpError(503, message);
}

export function internalError(message: string): HttpError {
  return new HttpError(500, message);
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * The status an error asks for, or 500.
 *
 * Mirrors the previous `err.status || 500`: anything that is not a usable
 * status number — missing, zero, `NaN` — falls back to 500.
 */
export function readErrorStatus(error: unknown): number {
  const status = readProperty(error, 'status');

  if (typeof status === 'number' && Number.isFinite(status) && status > 0) {
    return status;
  }

  return 500;
}

/**
 * The machine-readable code an error carries, if any.
 *
 * `HttpError.code`, `InvalidEpubError.code` (`INVALID_EPUB`) and
 * `MulterError.code` (`LIMIT_FILE_SIZE`, ...) are all read through here.
 */
export function readErrorCode(error: unknown): string | undefined {
  const code = readProperty(error, 'code');

  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

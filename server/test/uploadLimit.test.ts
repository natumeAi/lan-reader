import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMaxUploadBytes } from '../src/routes/books.js';

const MEBIBYTE = 1024 * 1024;
const DEFAULT_BYTES = 100 * MEBIBYTE;

test('every whole megabyte setting keeps the byte count it always had', () => {
  assert.equal(resolveMaxUploadBytes(undefined), DEFAULT_BYTES);
  assert.equal(resolveMaxUploadBytes(''), DEFAULT_BYTES);
  assert.equal(resolveMaxUploadBytes('100'), DEFAULT_BYTES);
  assert.equal(resolveMaxUploadBytes('1'), MEBIBYTE);
  assert.equal(resolveMaxUploadBytes('250'), 250 * MEBIBYTE);
});

test('nonsense settings still fall back to 100 MiB', () => {
  for (const value of ['0', '-1', 'abc', 'Infinity', '-Infinity', 'NaN']) {
    assert.equal(resolveMaxUploadBytes(value), DEFAULT_BYTES, `EPUB_UPLOAD_MAX_MB=${value}`);
  }
});

test('a fractional megabyte setting yields an integer multer accepts', () => {
  // multer 2.x throws `Expected limits.fileSize to be a non-negative integer or
  // Infinity` while the route module is evaluated, so a non-integer here used to
  // take the whole process down before it could answer a single request.
  for (const value of ['0.5', '1.5', '0.002', '99.999']) {
    const bytes = resolveMaxUploadBytes(value);

    assert.ok(Number.isInteger(bytes), `EPUB_UPLOAD_MAX_MB=${value} produced ${bytes}`);
    assert.ok(bytes > 0, `EPUB_UPLOAD_MAX_MB=${value} produced ${bytes}`);
  }

  assert.equal(resolveMaxUploadBytes('0.5'), MEBIBYTE / 2);
  assert.equal(resolveMaxUploadBytes('0.002'), Math.floor(0.002 * MEBIBYTE));
});

test('a setting that rounds down to nothing falls back instead of blocking every upload', () => {
  // Below one byte there is no ceiling that could accept anything, so this joins
  // the other nonsensical inputs rather than silently rejecting every request.
  assert.equal(resolveMaxUploadBytes('0.0000001'), DEFAULT_BYTES);
});

test('multer accepts the resolved value for a fractional setting', async () => {
  const { default: multer } = await import('multer');

  assert.doesNotThrow(() => {
    multer({ limits: { fileSize: resolveMaxUploadBytes('0.002') } });
  });
});

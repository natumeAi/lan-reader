/**
 * Boundary decoding helpers.
 *
 * Everything that arrives from HTTP or from browser storage enters as
 * `unknown`. These helpers turn it into typed values or throw, so no consumer
 * has to reach for an unchecked cast.
 */

/** Raised when a payload does not match the contract it claims to follow. */
export class WireDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireDecodeError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WireDecodeError(`${context} must be an object`);
  }
  return value;
}

export function requireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WireDecodeError(`${context} must be an array`);
  }
  return value;
}

export function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WireDecodeError(`${context} must be a finite number`);
  }
  return value;
}

export function requireInteger(value: unknown, context: string): number {
  const numberValue = requireNumber(value, context);
  if (!Number.isInteger(numberValue)) {
    throw new WireDecodeError(`${context} must be an integer`);
  }
  return numberValue;
}

import { isRecord } from '@lan-reader/shared';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
  }
}
export function errorMessage(error: unknown, fallback = '操作失败'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'AbortError';
}
export interface RequestOptions extends RequestInit {
  errorMessage: string | ((status: number) => string);
  serverErrorMessage?: boolean;
}
export async function requestResponse(url: string, options: RequestOptions): Promise<Response> {
  const { errorMessage: message, serverErrorMessage, ...init } = options;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError(errorMessage(cause, typeof message === 'string' ? message : message(0)), 0, { cause });
  }
  if (response.ok || response.status === 304) return response;
  let text = typeof message === 'function' ? message(response.status) : message;
  if (serverErrorMessage) {
    const body: unknown = await response.json().catch((cause: unknown) => {
      if (isAbortError(cause)) throw cause;
      return null;
    });
    if (isRecord(body) && typeof body['error'] === 'string' && body['error']) text = body['error'];
  }
  throw new ApiError(text, response.status);
}
export async function decodeResponse<T>(response: Response, decode: (value: unknown) => T): Promise<T> {
  try {
    const value: unknown = await response.json();
    return decode(value);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError('服务器返回的数据无效', response.status, { cause });
  }
}
export async function request<T>(url: string, decode: (value: unknown) => T, options: RequestOptions): Promise<T> {
  return decodeResponse(await requestResponse(url, options), decode);
}
export function jsonBody(value: unknown): Pick<RequestInit, 'headers' | 'body'> {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

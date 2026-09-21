/**
 * Typing helpers for the tests that drive the API over a real socket.
 *
 * `server.address()` is `string | AddressInfo | null` and `response.json()` is
 * `unknown`; both have to be narrowed before a test can assert on them. These
 * helpers do that narrowing in one place so no test needs a cast.
 *
 * This module is not a test file: the runner only collects `*.test.ts`.
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import { requireRecord } from '@lan-reader/shared';

export function listeningPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a TCP port');
  }

  return address.port;
}

/** Binds an ephemeral loopback port and resolves once the socket is up. */
export async function listenOnLoopback(app: Express): Promise<Server> {
  const server = app.listen(0, '127.0.0.1');

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  return server;
}

/** Runs `action` against a listening app and always closes the socket again. */
export async function withServer(
  app: Express,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await listenOnLoopback(app);

  try {
    await action(`http://127.0.0.1:${listeningPort(server)}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

/** The parsed JSON body of a response, as a record the test can index. */
export async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  return requireRecord(await response.json(), 'response body');
}

/** A nested object of a decoded body, named for a readable failure message. */
export function readRecord(value: unknown, context: string): Record<string, unknown> {
  return requireRecord(value, context);
}

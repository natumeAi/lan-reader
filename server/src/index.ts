/**
 * Process entry point.
 *
 * Reads the port and host, starts the server and translates the termination
 * signals into one graceful shutdown. Everything else lives in `server.ts`,
 * which knows nothing about the process it runs in — `process.exit` is this
 * file's concern alone.
 */
import { startServer } from './server.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const runningServer = await startServer({ port, host });

console.log(`EPUB reader server listening on http://${host}:${port}`);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`${signal} received, shutting down server`);
  await runningServer.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

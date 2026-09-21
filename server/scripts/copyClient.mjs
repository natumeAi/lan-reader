/** Stage the complete Vite/PWA output where both src and dist serve it. */
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(serverRoot, '..', 'client', 'dist');
const target = path.join(serverRoot, 'public');

if (!existsSync(path.join(source, 'index.html'))) {
  throw new Error('Client build is missing. Run npm run build from the repository root.');
}

// This fixed target contains generated assets only; remove stale hashed chunks.
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log('copyClient: staged client/dist into server/public');

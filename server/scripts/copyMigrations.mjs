/**
 * Copies the SQL migrations into the compiled output.
 *
 * `tsc` only emits JavaScript, so `dist/db/migrations` would stay empty and
 * `runMigrations()` would find nothing to apply. The destination mirrors the
 * source layout exactly, which keeps `path.join(currentDir, 'migrations')` in
 * `db/database.ts` correct for both the `src` and the `dist` layout.
 *
 * Runs on Windows and Linux: only `node:fs` / `node:path` are used, never a
 * shell command.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..');
const sourceDir = path.join(serverRoot, 'src', 'db', 'migrations');
const targetDir = path.join(serverRoot, 'dist', 'db', 'migrations');

if (!existsSync(sourceDir)) {
  console.error(`copyMigrations: migration directory is missing: ${sourceDir}`);
  process.exit(1);
}

const migrationFiles = readdirSync(sourceDir)
  .filter((fileName) => fileName.endsWith('.sql'))
  .sort();

if (migrationFiles.length === 0) {
  console.error(`copyMigrations: no .sql migrations found in ${sourceDir}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

for (const fileName of migrationFiles) {
  copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
}

console.log(
  `copyMigrations: copied ${migrationFiles.length} migration(s) to ${path.relative(serverRoot, targetDir)}`,
);

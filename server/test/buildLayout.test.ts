/**
 * The compiled layout has to match the source layout exactly.
 *
 * `db/database.ts` and `services/fileStorage.ts` resolve the server root with
 * `path.resolve(currentDir, '..', '..')`, `app.ts` resolves the client bundle
 * with `'..', 'public'`, and the migration runner reads `./migrations` next to
 * itself. All four are only correct while `dist/` mirrors `src/` directory for
 * directory — and while the build copies the SQL across, which `tsc` never
 * does on its own.
 *
 * These assertions need a build. When `dist/` is absent the test skips instead
 * of failing, so a plain `npm test` on a fresh checkout stays green; `npm run
 * check` builds afterwards, and `npm run build && npm test` covers it for real.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(serverRoot, 'src');
const distDir = path.join(serverRoot, 'dist');
const skip = existsSync(distDir)
  ? false
  : 'server/dist is not built; run `npm run build --workspace server` first';

/** Every file with `extension` below `root`, as sorted `/`-separated paths. */
function collectRelativeFiles(root: string, extension: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (entry.name.endsWith(extension)) {
        found.push(path.relative(root, entryPath).replaceAll(path.sep, '/'));
      }
    }
  };

  walk(root);

  return found.sort();
}

function migrationFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();
}

test('every source module is emitted at the same depth', { skip }, () => {
  const sourceModules = collectRelativeFiles(srcDir, '.ts').map((relativePath) =>
    relativePath.replace(/\.ts$/, '.js'),
  );
  const emittedModules = collectRelativeFiles(distDir, '.js');

  assert.ok(sourceModules.length > 0);
  assert.deepEqual(emittedModules, sourceModules);
});

test('the server root resolves to server/ from both layouts', { skip }, () => {
  for (const relativeModule of ['db/database', 'services/fileStorage']) {
    const sourceFile = path.join(srcDir, `${relativeModule}.ts`);
    const emittedFile = path.join(distDir, `${relativeModule}.js`);

    assert.ok(existsSync(sourceFile), `${relativeModule}.ts is missing`);
    assert.ok(existsSync(emittedFile), `${relativeModule}.js is missing`);
    assert.equal(path.resolve(path.dirname(sourceFile), '..', '..'), serverRoot);
    assert.equal(path.resolve(path.dirname(emittedFile), '..', '..'), serverRoot);
  }

  // `app` resolves the client bundle one level up instead of two.
  assert.equal(
    path.resolve(path.dirname(path.join(srcDir, 'app.ts')), '..', 'public'),
    path.join(serverRoot, 'public'),
  );
  assert.equal(
    path.resolve(path.dirname(path.join(distDir, 'app.js')), '..', 'public'),
    path.join(serverRoot, 'public'),
  );
});

test('the build copies every migration next to the compiled runner', { skip }, () => {
  const sourceMigrationsDir = path.join(srcDir, 'db', 'migrations');
  const emittedMigrationsDir = path.join(distDir, 'db', 'migrations');
  const sourceMigrations = migrationFiles(sourceMigrationsDir);

  assert.equal(sourceMigrations.length, 4, 'the library schema has four migrations');
  assert.deepEqual(migrationFiles(emittedMigrationsDir), sourceMigrations);

  for (const fileName of sourceMigrations) {
    assert.equal(
      readFileSync(path.join(emittedMigrationsDir, fileName), 'utf8'),
      readFileSync(path.join(sourceMigrationsDir, fileName), 'utf8'),
      `${fileName} differs between src and dist`,
    );
  }
});

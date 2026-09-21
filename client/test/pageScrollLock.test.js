import test from 'node:test';
import assert from 'node:assert/strict';
import { acquirePageScrollLock } from '../src/utils/pageScrollLock.js';

function createPage() {
  return {
    documentElement: {
      style: {
        overflow: 'clip',
        overscrollBehavior: 'contain',
      },
    },
    body: {
      style: {
        overflow: 'auto',
        overscrollBehavior: 'auto',
      },
    },
  };
}

test('locks the bookshelf while a modal overlay is open and restores it after close', () => {
  const page = createPage();
  const release = acquirePageScrollLock(page);

  assert.equal(page.documentElement.style.overflow, 'hidden');
  assert.equal(page.documentElement.style.overscrollBehavior, 'none');
  assert.equal(page.body.style.overflow, 'hidden');
  assert.equal(page.body.style.overscrollBehavior, 'none');

  release();

  assert.equal(page.documentElement.style.overflow, 'clip');
  assert.equal(page.documentElement.style.overscrollBehavior, 'contain');
  assert.equal(page.body.style.overflow, 'auto');
  assert.equal(page.body.style.overscrollBehavior, 'auto');
});

test('keeps the bookshelf locked until every stacked overlay closes', () => {
  const page = createPage();
  const releaseFolder = acquirePageScrollLock(page);
  const releaseReader = acquirePageScrollLock(page);

  releaseFolder();

  assert.equal(page.documentElement.style.overflow, 'hidden');
  assert.equal(page.body.style.overflow, 'hidden');

  releaseReader();

  assert.equal(page.documentElement.style.overflow, 'clip');
  assert.equal(page.body.style.overflow, 'auto');
});

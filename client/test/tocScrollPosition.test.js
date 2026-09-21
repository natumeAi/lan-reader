import test from 'node:test';
import assert from 'node:assert/strict';
import { centerTocEntry } from '../src/utils/tocScrollPosition.js';

test('centers the current chapter by scrolling only the table-of-contents list', () => {
  let outerScrollRequests = 0;
  const container = {
    clientHeight: 400,
    scrollHeight: 1200,
    scrollTop: 120,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const entry = {
    getBoundingClientRect: () => ({ height: 40, top: 350 }),
    scrollIntoView: () => {
      outerScrollRequests += 1;
    },
  };

  const centered = centerTocEntry(container, entry);

  assert.equal(centered, true);
  assert.equal(container.scrollTop, 190);
  assert.equal(outerScrollRequests, 0);
});

test('clamps the centered chapter position to the table-of-contents bounds', () => {
  const container = {
    clientHeight: 400,
    scrollHeight: 900,
    scrollTop: 470,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const entry = {
    getBoundingClientRect: () => ({ height: 40, top: 650 }),
  };

  assert.equal(centerTocEntry(container, entry), true);
  assert.equal(container.scrollTop, 500);
});

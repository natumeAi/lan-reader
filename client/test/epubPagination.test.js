import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpubPagination } from '../src/utils/epubPagination.js';

const container = {
  getBoundingClientRect: () => ({ height: 800, width: 600 }),
};
const settings = {
  fontFamilyId: 'serif',
  fontSize: 18,
  horizontalMargin: 16,
  letterSpacing: 0,
  lineHeight: 1.6,
  verticalMargin: 12,
};

test('reuses current-layout pagination when returning to a Reading Section', async () => {
  const readingSection = { id: 'chapter', sectionIndexes: [0] };
  const invalidations = [];
  const completed = [];
  let paginationRuns = 0;
  const pagination = createEpubPagination({
    applyReaderSettingsToContents() {},
    arrayBuffer: new ArrayBuffer(1),
    onLayoutInvalidated: () => invalidations.push('invalidated'),
    onReadingSectionComplete: (section) => completed.push(section.id),
    readingSections: [
      readingSection,
      { id: 'next', sectionIndexes: [1] },
    ],
  }, {
    debounceMs: 0,
    paginateBook: async ({ onReadingSectionComplete }) => {
      paginationRuns += 1;
      onReadingSectionComplete(
        readingSection,
        new Map([[0, { endPage: 3, startPage: 1 }]]),
      );
    },
  });

  assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'completed');
  assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'cached');

  assert.equal(paginationRuns, 1);
  assert.deepEqual(invalidations, ['invalidated']);
  assert.deepEqual(completed, ['chapter']);
  pagination.destroy();
});

test('keeps a cached Reading Section when a same-document sibling fails', async () => {
  const partOne = { id: 'part-one', sectionIndexes: [0] };
  const partTwo = { id: 'part-two', sectionIndexes: [0] };
  const failed = [];
  let paginationRuns = 0;
  const pagination = createEpubPagination({
    applyReaderSettingsToContents() {},
    arrayBuffer: new ArrayBuffer(1),
    onReadingSectionFailed: (section) => failed.push(section.id),
    readingSections: [partOne, partTwo],
  }, {
    debounceMs: 0,
    paginateBook: async ({ onReadingSectionComplete }) => {
      paginationRuns += 1;
      if (paginationRuns === 1) {
        onReadingSectionComplete(partOne, new Map([[0, { endPage: 4, startPage: 1 }]]));
        return;
      }
      throw new Error('Measurement Book failed');
    },
  });

  assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'completed');
  assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'failed');
  assert.deepEqual(failed, ['part-two']);
  pagination.destroy();
});

test('retries a failed Reading Section after the retry cooldown', async () => {
  const readingSection = { id: 'chapter', sectionIndexes: [0] };
  const completed = [];
  const failed = [];
  let now = 1000;
  let paginationRuns = 0;
  const pagination = createEpubPagination({
    applyReaderSettingsToContents() {},
    arrayBuffer: new ArrayBuffer(1),
    onReadingSectionComplete: (section) => completed.push(section.id),
    onReadingSectionFailed: (section) => failed.push(section.id),
    readingSections: [readingSection],
  }, {
    debounceMs: 0,
    failureRetryMs: 100,
    now: () => now,
    paginateBook: async ({ onReadingSectionComplete, onReadingSectionFailed }) => {
      paginationRuns += 1;
      if (paginationRuns === 1) {
        onReadingSectionFailed(readingSection);
      } else {
        onReadingSectionComplete(
          readingSection,
          new Map([[0, { endPage: 3, startPage: 1 }]]),
        );
      }
    },
  });

  assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'completed');
  assert.equal(
    await pagination.request({ container, currentSectionIndex: 0, settings }),
    'retry-pending',
  );
  now += 100;
  assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'completed');

  assert.equal(paginationRuns, 2);
  assert.deepEqual(failed, ['chapter']);
  assert.deepEqual(completed, ['chapter']);
  pagination.destroy();
});

test('automatically retries a failed Reading Section after the retry cooldown', async () => {
  const readingSection = { id: 'chapter', sectionIndexes: [0] };
  let paginationRuns = 0;
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const pagination = createEpubPagination({
    applyReaderSettingsToContents() {},
    arrayBuffer: new ArrayBuffer(1),
    onReadingSectionComplete: resolveCompleted,
    readingSections: [readingSection],
  }, {
    debounceMs: 0,
    failureRetryMs: 10,
    paginateBook: async ({ onReadingSectionComplete, onReadingSectionFailed }) => {
      paginationRuns += 1;
      if (paginationRuns === 1) {
        onReadingSectionFailed(readingSection);
      } else {
        onReadingSectionComplete(
          readingSection,
          new Map([[0, { endPage: 3, startPage: 1 }]]),
        );
      }
    },
  });

  try {
    assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'completed');
    await Promise.race([
      completed,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Reading Section was not retried')), 100);
      }),
    ]);
    assert.equal(paginationRuns, 2);
  } finally {
    pagination.destroy();
  }
});

test('stops automatically retrying a Reading Section that keeps failing', async () => {
  const readingSection = { id: 'chapter', sectionIndexes: [0] };
  let paginationRuns = 0;
  let resolveSecondRun;
  const secondRun = new Promise((resolve) => {
    resolveSecondRun = resolve;
  });
  const pagination = createEpubPagination({
    applyReaderSettingsToContents() {},
    arrayBuffer: new ArrayBuffer(1),
    readingSections: [readingSection],
  }, {
    debounceMs: 0,
    failureRetryMs: 0,
    paginateBook: async ({ onReadingSectionFailed }) => {
      paginationRuns += 1;
      onReadingSectionFailed(readingSection);
      if (paginationRuns === 2) resolveSecondRun();
    },
  });

  try {
    assert.equal(await pagination.request({ container, currentSectionIndex: 0, settings }), 'completed');
    await secondRun;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(paginationRuns, 2);
  } finally {
    pagination.destroy();
  }
});

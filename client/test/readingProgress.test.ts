import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBookCardAriaLabel,
  formatReadingPosition,
  selectProgressForRelocation,
} from '../src/utils/readingProgress.js';

function selectProgress({ atEnd, generatedProgress, lastValidProgress = 0.4 }: { atEnd: boolean; generatedProgress: number; lastValidProgress?: number }) {
  return selectProgressForRelocation({
    atEnd,
    cfi: 'epubcfi(/6/4)',
    lastValidProgress,
    locations: {
      percentageFromCfi: () => generatedProgress,
    },
    locationsReady: true,
  });
}

test('normalizes a committed final-page location to 100%', () => {
  assert.equal(selectProgress({ atEnd: true, generatedProgress: 0.97 }), 1);
});

test('keeps the final page normalized across repeated relocations', () => {
  assert.equal(selectProgress({
    atEnd: true,
    generatedProgress: 0.97,
    lastValidProgress: 1,
  }), 1);
});

test('recomputes ordinary progress after leaving the final page', () => {
  assert.equal(selectProgress({
    atEnd: false,
    generatedProgress: 0.72,
    lastValidProgress: 1,
  }), 0.72);
});

test('formats unread and opened-at-start positions as distinct states', () => {
  assert.deepEqual(formatReadingPosition(null), {
    accessibleDescription: null,
    barWidth: 0,
    label: null,
    percent: null,
    state: 'unread',
  });
  assert.deepEqual(formatReadingPosition(0), {
    accessibleDescription: '已读 0%',
    barWidth: 0,
    label: '0%',
    percent: 0,
    state: 'reading',
  });
});

test('rounds in-progress labels and reserves 100% for persisted completion', () => {
  assert.equal(formatReadingPosition(0.004).percent, 0);
  assert.equal(formatReadingPosition(0.005).percent, 1);
  assert.equal(formatReadingPosition(0.994).percent, 99);
  assert.equal(formatReadingPosition(0.999).percent, 99);
  assert.deepEqual(formatReadingPosition(1), {
    accessibleDescription: '已读完',
    barWidth: 100,
    label: null,
    percent: 100,
    state: 'finished',
  });
});

test('defensively handles invalid and out-of-range presentation inputs', () => {
  assert.equal(formatReadingPosition(Number.NaN).state, 'unread');
  assert.equal(formatReadingPosition('invalid').state, 'unread');
  assert.equal(formatReadingPosition(-2).percent, 0);
  assert.equal(formatReadingPosition(3).state, 'finished');
});

test('extends only saved-position Book-card labels with reading state', () => {
  assert.equal(formatBookCardAriaLabel('Book', null), 'Book');
  assert.equal(formatBookCardAriaLabel('Book', 0.42), 'Book，已读 42%');
  assert.equal(formatBookCardAriaLabel('Book', 1), 'Book，已读完');
});

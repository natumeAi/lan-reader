import test from 'node:test';
import assert from 'node:assert/strict';
import { getPageProgressFromLocation } from '../src/hooks/usePageProgress.js';
import { measureReadingSectionPages } from '../src/utils/epubPageMap.js';
import { createReadingSections, findCurrentTocItem } from '../src/utils/epubToc.js';

function locationAt(index, page, total) {
  return {
    start: {
      displayed: { page, total },
      index,
    },
  };
}

test('keeps page progress continuous across a standalone illustration', () => {
  const options = {
    readingSection: {
      id: 'chapter',
      sectionIndexes: [7, 8, 9],
    },
    pageRangesBySectionIndex: new Map([
      [7, { endPage: 3, startPage: 1 }],
      [8, { endPage: 1, startPage: 1 }],
      [9, { endPage: 4, startPage: 1 }],
    ]),
  };

  assert.deepEqual(
    getPageProgressFromLocation(locationAt(7, 2, 3), options),
    { current: 2, total: 8 },
  );
  assert.deepEqual(
    getPageProgressFromLocation(locationAt(8, 1, 1), options),
    { current: 4, total: 8 },
  );
  assert.deepEqual(
    getPageProgressFromLocation(locationAt(9, 2, 4), options),
    { current: 6, total: 8 },
  );
});

function createBook(sectionHrefs) {
  const spineItems = sectionHrefs.map((href, index) => ({ href, index, linear: true }));
  return {
    spine: {
      get(target) {
        const documentHref = String(target).split('#')[0];
        return spineItems.find((section) => section.href === documentHref) || null;
      },
      spineItems,
    },
  };
}

test('uses the exact table-of-contents document on an illustration omitted from locations', () => {
  const book = createBook(['Text/chapter6.xhtml', 'Text/chapter7.xhtml']);
  book.locations = {
    epubcfi: {
      compare: (first, second) => Number(first) - Number(second),
    },
  };
  const items = [
    {
      chapterId: '0',
      href: 'Text/chapter6.xhtml',
      label: '24',
      startCfi: '36',
      subitems: [],
    },
    {
      chapterId: '1',
      href: 'Text/chapter7.xhtml',
      label: '25',
      // Generated locations skipped the image-only section and put this
      // boundary at the following text document.
      startCfi: '40',
      subitems: [],
    },
  ];

  assert.equal(findCurrentTocItem(items, {
    book,
    cfi: '39',
    href: 'Text/chapter7.xhtml',
  })?.label, '25');
});

test('groups complete publication documents between table-of-contents entries', () => {
  const book = createBook([
    'cover.xhtml',
    'chapter.xhtml',
    'body.xhtml',
    'illustration.xhtml',
    'next-chapter.xhtml',
  ]);
  const readingSections = createReadingSections([
    { href: 'chapter.xhtml', subitems: [] },
    { href: 'next-chapter.xhtml', subitems: [] },
  ], book);

  assert.deepEqual(readingSections, [
    {
      endHref: 'next-chapter.xhtml',
      id: 'chapter.xhtml',
      sectionIndexes: [1, 2, 3],
      startHref: 'chapter.xhtml',
    },
    {
      endHref: null,
      id: 'next-chapter.xhtml',
      sectionIndexes: [4],
      startHref: 'next-chapter.xhtml',
    },
  ]);
});

test('extends the final Reading Section to the end of the Book', () => {
  const book = createBook([
    'chapter.xhtml',
    'body.xhtml',
    'illustration.xhtml',
  ]);

  assert.deepEqual(createReadingSections([
    { href: 'chapter.xhtml', subitems: [] },
  ], book), [
    {
      endHref: null,
      id: 'chapter.xhtml',
      sectionIndexes: [0, 1, 2],
      startHref: 'chapter.xhtml',
    },
  ]);
});

test('keeps a non-linear table-of-contents target as a Reading Section boundary', () => {
  const book = createBook([
    'chapter.xhtml',
    'illustration.xhtml',
    'body.xhtml',
    'next.xhtml',
  ]);
  book.spine.spineItems[1].linear = false;

  assert.deepEqual(createReadingSections([
    { href: 'chapter.xhtml', subitems: [] },
    { href: 'illustration.xhtml', subitems: [] },
    { href: 'next.xhtml', subitems: [] },
  ], book).map(({ id, sectionIndexes }) => ({ id, sectionIndexes })), [
    { id: 'chapter.xhtml', sectionIndexes: [0] },
    { id: 'illustration.xhtml', sectionIndexes: [1, 2] },
    { id: 'next.xhtml', sectionIndexes: [3] },
  ]);
});

test('keeps page progress continuous when a Reading Section begins at a document anchor', () => {
  const book = createBook(['chapter.xhtml', 'illustration.xhtml', 'next.xhtml']);
  const readingSections = createReadingSections([
    { href: 'chapter.xhtml#start', subitems: [] },
    { href: 'next.xhtml', subitems: [] },
  ], book);
  const readingSection = readingSections.find((item) => item.sectionIndexes.includes(1));

  assert.deepEqual(
    getPageProgressFromLocation(locationAt(1, 1, 1), {
      readingSection,
      pageRangesBySectionIndex: new Map([
        [0, { endPage: 3, startPage: 1 }],
        [1, { endPage: 1, startPage: 1 }],
      ]),
    }),
    { current: 4, total: 4 },
  );
});

test('counts only pages after a same-document Reading Section anchor', () => {
  const readingSection = {
    sectionIndexes: [0],
  };

  assert.deepEqual(
    getPageProgressFromLocation(locationAt(0, 6, 8), {
      readingSection,
      pageRangesBySectionIndex: new Map([
        [0, { endPage: 8, startPage: 5 }],
      ]),
    }),
    { current: 2, total: 4 },
  );
});

test('includes pages before an anchor in the next publication document', () => {
  const book = createBook(['chapter.xhtml', 'next.xhtml']);
  const [readingSection] = createReadingSections([
    { href: 'chapter.xhtml', subitems: [] },
    { href: 'next.xhtml#part-two', subitems: [] },
  ], book);

  assert.deepEqual(
    getPageProgressFromLocation(locationAt(1, 2, 8), {
      readingSection,
      pageRangesBySectionIndex: new Map([
        [0, { endPage: 3, startPage: 1 }],
        [1, { endPage: 4, startPage: 1 }],
      ]),
    }),
    { current: 5, total: 7 },
  );
});

test('ends a Reading Section before a next-document anchor on its first page', async () => {
  const book = createBook(['chapter.xhtml', 'next.xhtml']);
  const readingSections = createReadingSections([
    { href: 'chapter.xhtml', subitems: [] },
    { href: 'next.xhtml#part-two', subitems: [] },
  ], book);
  let firstSectionPages;

  await measureReadingSectionPages({
    measureSection: async () => {
      throw new Error('No intermediate publication document should be measured');
    },
    measureTarget: async (target) => ({
      page: 1,
      sectionIndex: target.startsWith('chapter') ? 0 : 1,
      total: target.startsWith('chapter') ? 3 : 4,
    }),
    onReadingSectionComplete: (readingSection, pageRanges) => {
      if (readingSection.id === 'chapter.xhtml') firstSectionPages = pageRanges;
    },
    readingSections,
  });

  assert.deepEqual(
    getPageProgressFromLocation(locationAt(0, 2, 3), {
      readingSection: readingSections[0],
      pageRangesBySectionIndex: firstSectionPages,
    }),
    { current: 2, total: 3 },
  );
});

test('keeps distinct Reading Sections for anchors in one publication document', () => {
  const book = createBook(['chapter.xhtml', 'next.xhtml']);
  const readingSections = createReadingSections([
    { href: 'chapter.xhtml#part-one', subitems: [] },
    { href: 'chapter.xhtml#part-two', subitems: [] },
    { href: 'next.xhtml', subitems: [] },
  ], book);

  assert.deepEqual(
    readingSections.map(({ endHref, startHref }) => ({ endHref, startHref })),
    [
      { endHref: 'chapter.xhtml#part-two', startHref: 'chapter.xhtml#part-one' },
      { endHref: 'next.xhtml', startHref: 'chapter.xhtml#part-two' },
      { endHref: null, startHref: 'next.xhtml' },
    ],
  );
});

test('selects the Reading Section whose measured range contains the current page', () => {
  const readingSections = [
    { id: 'part-one', sectionIndexes: [0] },
    { id: 'part-two', sectionIndexes: [0] },
  ];
  const pageRangesByReadingSectionId = new Map([
    ['part-one', new Map([[0, { endPage: 4, startPage: 1 }]])],
    ['part-two', new Map([[0, { endPage: 8, startPage: 5 }]])],
  ]);

  assert.deepEqual(
    getPageProgressFromLocation(locationAt(0, 6, 8), {
      pageRangesByReadingSectionId,
      readingSections,
    }),
    { current: 2, total: 4 },
  );
});

test('measures the current reading section first and isolates section failures', async () => {
  const readingSections = [
    { id: 'first', sectionIndexes: [1, 2] },
    { id: 'broken', sectionIndexes: [3] },
    { id: 'priority', sectionIndexes: [4] },
  ];
  const measurementOrder = [];
  const completed = [];
  const failed = [];

  await measureReadingSectionPages({
    measureSection: async (sectionIndex) => {
      measurementOrder.push(sectionIndex);
      if (sectionIndex === 3) throw new Error('broken document');
      return sectionIndex + 1;
    },
    onReadingSectionComplete: (readingSection, totals) => {
      completed.push([readingSection.id, [...totals]]);
    },
    onReadingSectionFailed: (readingSection) => failed.push(readingSection.id),
    prioritySectionIndex: 4,
    readingSections,
  });

  assert.deepEqual(measurementOrder, [4, 1, 2, 3]);
  assert.deepEqual(completed, [
    ['priority', [[4, { endPage: 5, startPage: 1 }]]],
    ['first', [
      [1, { endPage: 2, startPage: 1 }],
      [2, { endPage: 3, startPage: 1 }],
    ]],
  ]);
  assert.deepEqual(failed, ['broken']);
});

test('does not let a stalled Reading Section block later page totals', async () => {
  const completed = [];
  const failed = [];
  const pagination = measureReadingSectionPages({
    measurementTimeoutMs: 10,
    measureSection: async (sectionIndex) => {
      if (sectionIndex === 0) return new Promise(() => {});
      return 3;
    },
    onReadingSectionComplete: (readingSection) => completed.push(readingSection.id),
    onReadingSectionFailed: (readingSection) => failed.push(readingSection.id),
    readingSections: [
      { id: 'stalled', sectionIndexes: [0] },
      { id: 'later', sectionIndexes: [1] },
    ],
  });

  let guardTimer;
  try {
    await Promise.race([
      pagination,
      new Promise((_, reject) => {
        guardTimer = setTimeout(() => (
          reject(new Error('Reading Section pagination stayed blocked'))
        ), 100);
      }),
    ]);
  } finally {
    clearTimeout(guardTimer);
  }

  assert.deepEqual(completed, ['later']);
  assert.deepEqual(failed, ['stalled']);
});

test('cancels a stalled Reading Section measurement when its layout becomes stale', async () => {
  let stopped = false;
  const completed = [];
  const failed = [];
  const pagination = measureReadingSectionPages({
    measurementTimeoutMs: 500,
    measureSection: async () => new Promise(() => {}),
    onReadingSectionComplete: (readingSection) => completed.push(readingSection.id),
    onReadingSectionFailed: (readingSection) => failed.push(readingSection.id),
    readingSections: [{ id: 'current', sectionIndexes: [0] }],
    shouldStop: () => stopped,
  });
  setTimeout(() => {
    stopped = true;
  }, 10);

  let guardTimer;
  try {
    await Promise.race([
      pagination,
      new Promise((_, reject) => {
        guardTimer = setTimeout(() => reject(new Error('Stale pagination was not cancelled')), 100);
      }),
    ]);
  } finally {
    clearTimeout(guardTimer);
  }

  assert.deepEqual(completed, []);
  assert.deepEqual(failed, []);
});

test('measures only Reading Sections containing the current publication document', async () => {
  const measured = [];
  const completed = [];

  await measureReadingSectionPages({
    measureCurrentReadingSectionsOnly: true,
    measureSection: async (sectionIndex) => {
      measured.push(sectionIndex);
      return 2;
    },
    onReadingSectionComplete: (readingSection) => completed.push(readingSection.id),
    prioritySectionIndex: 0,
    readingSections: [
      { id: 'part-one', sectionIndexes: [0] },
      { id: 'part-two', sectionIndexes: [0] },
      { id: 'next', sectionIndexes: [1] },
    ],
  });

  assert.deepEqual(measured, [0, 0]);
  assert.deepEqual(completed, ['part-one', 'part-two']);
});

test('reuses cached Reading Section totals for the current layout', async () => {
  const measured = [];
  const completed = [];

  await measureReadingSectionPages({
    cachedReadingSectionIds: new Set(['part-one']),
    measureCurrentReadingSectionsOnly: true,
    measureSection: async (sectionIndex) => {
      measured.push(sectionIndex);
      return 2;
    },
    onReadingSectionComplete: (readingSection) => completed.push(readingSection.id),
    prioritySectionIndex: 0,
    readingSections: [
      { id: 'part-one', sectionIndexes: [0] },
      { id: 'part-two', sectionIndexes: [0] },
      { id: 'next', sectionIndexes: [1] },
    ],
  });

  assert.deepEqual(measured, [0]);
  assert.deepEqual(completed, ['part-two']);
});

test('measures page ranges between table-of-contents anchors', async () => {
  const readingSections = [
    {
      endHref: 'chapter.xhtml#part-two',
      id: 'part-one',
      sectionIndexes: [0],
      startHref: 'chapter.xhtml#part-one',
    },
    {
      endHref: 'next.xhtml',
      id: 'part-two',
      sectionIndexes: [0],
      startHref: 'chapter.xhtml#part-two',
    },
    {
      endHref: null,
      id: 'next',
      sectionIndexes: [1],
      startHref: 'next.xhtml',
    },
  ];
  const targetMeasurements = new Map([
    ['chapter.xhtml#part-one', { page: 2, sectionIndex: 0, total: 8 }],
    ['chapter.xhtml#part-two', { page: 5, sectionIndex: 0, total: 8 }],
    ['next.xhtml', { page: 1, sectionIndex: 1, total: 4 }],
  ]);
  const completed = [];

  await measureReadingSectionPages({
    measureSection: async () => {
      throw new Error('No intermediate publication document should be measured');
    },
    measureTarget: async (target) => targetMeasurements.get(target),
    onReadingSectionComplete: (readingSection, pageRanges) => {
      completed.push([readingSection.id, [...pageRanges]]);
    },
    readingSections,
  });

  assert.deepEqual(completed, [
    ['part-one', [[0, { endPage: 4, startPage: 2 }]]],
    ['part-two', [[0, { endPage: 8, startPage: 5 }]]],
    ['next', [[1, { endPage: 4, startPage: 1 }]]],
  ]);
});

test('keeps a one-page Reading Section when adjacent anchors share a page', async () => {
  const readingSection = {
    endHref: 'chapter.xhtml#part-two',
    id: 'part-one',
    sectionIndexes: [0],
    startHref: 'chapter.xhtml#part-one',
  };
  const completed = [];
  const failed = [];

  await measureReadingSectionPages({
    measureSection: async () => {
      throw new Error('No intermediate publication document should be measured');
    },
    measureTarget: async () => ({ page: 2, sectionIndex: 0, total: 8 }),
    onReadingSectionComplete: (section, pageRanges) => {
      completed.push([section.id, [...pageRanges]]);
    },
    onReadingSectionFailed: (section) => failed.push(section.id),
    readingSections: [readingSection],
  });

  assert.deepEqual(completed, [
    ['part-one', [[0, { endPage: 2, startPage: 2 }]]],
  ]);
  assert.deepEqual(failed, []);
});

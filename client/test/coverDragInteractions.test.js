import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DndContext } from '@dnd-kit/core';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

let preventNativeImageDrag;
let ReadOnlyShelfItem;
let SortableFolderBook;
let SortableShelfItem;
let vite;

before(async () => {
  vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
  });

  [
    { preventNativeImageDrag },
    { ReadOnlyShelfItem },
    { SortableFolderBook },
    { SortableShelfItem },
  ] = await Promise.all([
    vite.ssrLoadModule('/src/components/bookshelf/BookCover.jsx'),
    vite.ssrLoadModule('/src/components/bookshelf/ReadOnlyShelfItem.jsx'),
    vite.ssrLoadModule('/src/components/folders/SortableFolderBook.jsx'),
    vite.ssrLoadModule('/src/components/bookshelf/SortableShelfItem.jsx'),
  ]);
});

after(async () => {
  await vite?.close();
});

function firstImage(markup, selector) {
  const dom = new JSDOM(markup);
  const image = dom.window.document.querySelector(selector);
  assert.ok(image, `Expected ${selector} in rendered markup`);
  return image;
}

function renderSortableItem(item) {
  return renderToStaticMarkup(
    createElement(
      DndContext,
      null,
      createElement(SortableShelfItem, {
        item,
        onOpenBook() {},
        onOpenFolder() {},
      }),
    ),
  );
}

test('draggable Bookshelf cover images disable native image actions', () => {
  const bookImage = firstImage(
    renderSortableItem({
      book: { coverUrl: '/covers/book.jpg', id: 1, title: 'Book' },
      id: 1,
      key: 'book:1',
      type: 'book',
    }),
    '.book-cover-image',
  );
  assert.equal(bookImage.draggable, false);
  assert.equal(bookImage.classList.contains('is-native-image-actions-disabled'), true);

  const folderImage = firstImage(
    renderSortableItem({
      folder: {
        id: 2,
        name: 'Folder',
        previewBooks: [{ coverUrl: '/covers/preview.jpg', id: 3, title: 'Preview' }],
      },
      id: 2,
      key: 'folder:2',
      type: 'folder',
    }),
    '.folder-preview-image',
  );
  assert.equal(folderImage.draggable, false);
  assert.equal(folderImage.classList.contains('is-native-image-actions-disabled'), true);
});

test('Folder book cover images disable native image actions', () => {
  const markup = renderToStaticMarkup(
    createElement(
      DndContext,
      null,
      createElement(SortableFolderBook, {
        book: {
          coverUrl: '/covers/folder-book.jpg',
          id: 4,
          key: 'folder-book:4',
          title: 'Folder book',
        },
        onOpenBook() {},
      }),
    ),
  );
  const image = firstImage(markup, '.book-cover-image');

  assert.equal(image.draggable, false);
  assert.equal(image.classList.contains('is-native-image-actions-disabled'), true);
});

test('read-only cover images retain native image actions', () => {
  const markup = renderToStaticMarkup(
    createElement(ReadOnlyShelfItem, {
      item: {
        book: { coverUrl: '/covers/read-only.jpg', id: 5, title: 'Read only' },
        id: 5,
        key: 'book:5',
        type: 'book',
      },
      onOpenBook() {},
      onOpenFolder() {},
    }),
  );
  const image = firstImage(markup, '.book-cover-image');

  assert.equal(image.draggable, true);
  assert.equal(image.classList.contains('is-native-image-actions-disabled'), false);
});

test('native image drag prevention cancels the browser default', () => {
  let prevented = false;

  preventNativeImageDrag({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
});

test('protected cover images suppress the iOS callout without blocking page scroll', async () => {
  const css = await readFile(
    new URL('../src/styles/bookshelf.css', import.meta.url),
    'utf8',
  );
  const rule = css.match(
    /\.book-cover-image\.is-native-image-actions-disabled,\s*\.folder-preview-image\.is-native-image-actions-disabled\s*\{([^}]*)\}/,
  );

  assert.ok(rule, 'Expected a scoped native image action suppression rule');
  for (const declaration of [
    'pointer-events: none',
    '-webkit-touch-callout: none',
    '-webkit-user-drag: none',
    '-webkit-user-select: none',
    'user-select: none',
  ]) {
    assert.match(rule[1], new RegExp(`${declaration.replaceAll('-', '\\-')}\\s*;`));
  }
  assert.doesNotMatch(rule[1], /touch-action\s*:\s*none/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReaderSettingsToRendition } from '../src/hooks/useReaderSettings.js';

const settings = {
  fontFamilyId: 'serif',
  fontSize: 18,
  horizontalMargin: 0,
  letterSpacing: 0,
  lineHeight: 1.6,
  themeId: 'warm',
  verticalMargin: 0,
};

test('forces long unbreakable EPUB text to wrap inside a page', () => {
  const contentOverrides = [];
  const stylesheets = new Map();
  const themeOverrides = [];
  const contents = {
    addStylesheetCss(css, id) {
      stylesheets.set(id, css);
    },
    css(...args) {
      contentOverrides.push(args);
    },
  };
  const rendition = {
    getContents: () => [contents],
    themes: {
      font() {},
      fontSize() {},
      override(...args) {
        themeOverrides.push(args);
      },
      register() {},
      select() {},
    },
  };

  applyReaderSettingsToRendition(rendition, settings);

  const layoutCss = stylesheets.get('reader-layout-settings');
  assert.match(
    layoutCss,
    /body\s*\{[^}]*overflow-wrap:\s*anywhere\s*!important;/s,
  );
  assert.match(
    layoutCss,
    /p,\s*div,\s*section,\s*article,\s*blockquote,\s*li\s*\{[^}]*overflow-wrap:\s*anywhere\s*!important;/s,
  );
  assert.deepEqual(
    contentOverrides.find(([property]) => property === 'overflow-wrap'),
    ['overflow-wrap', 'anywhere', true],
  );
  assert.deepEqual(
    themeOverrides.find(([property]) => property === 'overflow-wrap'),
    ['overflow-wrap', 'anywhere', true],
  );
});

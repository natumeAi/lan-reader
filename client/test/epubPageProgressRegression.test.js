import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { usePageProgress } from '../src/hooks/usePageProgress.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function locationAt(index, page, total) {
  return {
    start: {
      displayed: { page, total },
      index,
    },
  };
}

function regressionController(pageProgress) {
  if (pageProgress.pageProgressController) return pageProgress.pageProgressController;

  // The fixed point exposed only the location updater. Keep it reachable so
  // this regression fails on the old rendered label instead of an API error.
  return {
    setReadingSectionPageRanges() {},
    setReadingSections() {},
    updatePageProgressFromLocation: pageProgress.updatePageProgressFromLocation,
  };
}

test('keeps page totals attached to distinct Reading Sections in one publication document', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousHTMLElement = globalThis.HTMLElement;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;

  const renditionRef = { current: null };
  let progressController;

  function PageProgressHarness() {
    progressController = usePageProgress({ renditionRef });
    return createElement('output', null, progressController.pageProgressLabel);
  }

  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PageProgressHarness));
  });

  const partOne = {
    id: 'chapter.xhtml#part-one',
    sectionIndexes: [0],
  };
  const partTwo = {
    id: 'chapter.xhtml#part-two',
    sectionIndexes: [0],
  };

  await act(async () => {
    const controller = regressionController(progressController);
    controller.setReadingSections([partOne, partTwo]);
    controller.setReadingSectionPageRanges(
      partTwo,
      new Map([[0, { endPage: 8, startPage: 5 }]]),
    );
    controller.setReadingSectionPageRanges(
      partOne,
      new Map([[0, { endPage: 4, startPage: 1 }]]),
    );
    controller.updatePageProgressFromLocation(locationAt(0, 6, 8));
  });

  assert.equal(container.textContent, '2/4');

  await act(async () => {
    const controller = regressionController(progressController);
    controller.setReadingSections([partOne, partTwo], partOne.id);
    controller.setReadingSectionPageRanges(
      partOne,
      new Map([[0, { endPage: 4, startPage: 1 }]]),
    );
    controller.setReadingSectionPageRanges(
      partTwo,
      new Map([[0, { endPage: 8, startPage: 5 }]]),
    );
    controller.updatePageProgressFromLocation(locationAt(0, 6, 8));
  });

  assert.equal(container.textContent, '2/4');

  await act(async () => {
    const controller = regressionController(progressController);
    controller.setReadingSections([partOne, partTwo], partTwo.id);
    controller.setReadingSectionPageRanges(
      partOne,
      new Map([[0, { endPage: 2, startPage: 2 }]]),
    );
    controller.setReadingSectionPageRanges(
      partTwo,
      new Map([[0, { endPage: 8, startPage: 2 }]]),
    );
    controller.updatePageProgressFromLocation(locationAt(0, 2, 8));
  });

  assert.equal(container.textContent, '1/7');
  await act(async () => root.unmount());
  dom.window.close();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousNode === undefined) delete globalThis.Node;
  else globalThis.Node = previousNode;
  if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = previousHTMLElement;
});

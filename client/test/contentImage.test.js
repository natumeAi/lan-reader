import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  contentImageCursorAtViewportPoint,
  findContentImageAtViewportPoint,
  prepareSvgContentImageSource,
} from '../src/utils/contentImage.js';

function rect({ bottom, height, left, right, top, width }) {
  return { bottom, height, left, right, top, width, x: left, y: top };
}

function createReaderFrame() {
  const dom = new JSDOM('<!doctype html><div id="reader"><iframe></iframe></div>', {
    url: 'https://reader.test/',
  });
  const container = dom.window.document.getElementById('reader');
  const frame = container.querySelector('iframe');
  frame.getBoundingClientRect = () => rect({
    bottom: 500,
    height: 400,
    left: 50,
    right: 350,
    top: 100,
    width: 300,
  });
  return { container, dom, frame };
}

test('maps a reader tap to the original linked Content Image resource', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <a href="chapter-2.xhtml">
        <img src="https://reader.test/books/plate.jpg" alt="星图">
      </a>
    `;
    const image = frame.contentDocument.querySelector('img');
    Object.defineProperties(image, {
      naturalHeight: { configurable: true, value: 1200 },
      naturalWidth: { configurable: true, value: 1600 },
    });
    image.getBoundingClientRect = () => rect({
      bottom: 230,
      height: 200,
      left: 20,
      right: 220,
      top: 30,
      width: 200,
    });
    frame.contentDocument.elementFromPoint = () => image;

    assert.deepEqual(
      findContentImageAtViewportPoint(container, 100, 150),
      {
        alt: '星图',
        intrinsicHeight: 1200,
        intrinsicWidth: 1600,
        kind: 'url',
        source: 'https://reader.test/books/plate.jpg',
      },
    );
  } finally {
    dom.window.close();
  }
});

test('maps a reader tap through disabled Content Image hit-testing', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <a href="chapter-2.xhtml">
        <img src="plate.jpg" alt="星图" style="pointer-events: none">
      </a>
    `;
    const link = frame.contentDocument.querySelector('a');
    const image = frame.contentDocument.querySelector('img');
    image.getBoundingClientRect = () => rect({
      bottom: 230,
      height: 200,
      left: 20,
      right: 220,
      top: 30,
      width: 200,
    });
    frame.contentDocument.elementFromPoint = () => link;

    assert.equal(
      findContentImageAtViewportPoint(container, 100, 150)?.source,
      'https://reader.test/plate.jpg',
    );
  } finally {
    dom.window.close();
  }
});

test('maps a reader tap to a positioned Content Image with disabled hit-testing', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <p>图片下方的正文</p>
      <img src="plate.jpg" alt="星图" style="pointer-events: none; position: absolute">
    `;
    const paragraph = frame.contentDocument.querySelector('p');
    const image = frame.contentDocument.querySelector('img');
    image.getBoundingClientRect = () => rect({
      bottom: 230,
      height: 200,
      left: 20,
      right: 220,
      top: 30,
      width: 200,
    });
    frame.contentDocument.elementFromPoint = () => (
      image.style.pointerEvents === 'auto' ? image : paragraph
    );

    const contentImage = findContentImageAtViewportPoint(container, 100, 150);
    assert.deepEqual(
      {
        pointerEvents: image.style.pointerEvents,
        source: contentImage?.source,
      },
      {
        pointerEvents: 'none',
        source: 'https://reader.test/plate.jpg',
      },
    );
  } finally {
    dom.window.close();
  }
});

test('ignores CSS backgrounds when resolving a reader tap', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <div style="width: 200px; height: 200px; background-image: url(plate.jpg)"></div>
    `;
    const background = frame.contentDocument.querySelector('div');
    frame.contentDocument.elementFromPoint = () => background;

    assert.equal(findContentImageAtViewportPoint(container, 100, 150), null);
  } finally {
    dom.window.close();
  }
});

test('ignores a CSS-hidden Content Image at the reader tap point', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    for (const style of ['opacity: 0', 'visibility: hidden']) {
      frame.contentDocument.body.innerHTML = `
        <img src="plate.jpg" alt="星图" style="${style}">
      `;
      const image = frame.contentDocument.querySelector('img');
      frame.contentDocument.elementFromPoint = () => image;

      assert.equal(
        findContentImageAtViewportPoint(container, 100, 150),
        null,
        style,
      );
    }
  } finally {
    dom.window.close();
  }
});

test('ignores a Content Image covered at the reader tap point', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <img src="plate.jpg" alt="星图">
      <p>覆盖图片的正文</p>
    `;
    const image = frame.contentDocument.querySelector('img');
    const paragraph = frame.contentDocument.querySelector('p');
    image.getBoundingClientRect = () => rect({
      bottom: 230,
      height: 200,
      left: 20,
      right: 220,
      top: 30,
      width: 200,
    });
    frame.contentDocument.elementFromPoint = () => paragraph;

    assert.equal(findContentImageAtViewportPoint(container, 100, 150), null);
  } finally {
    dom.window.close();
  }
});

test('serializes an inline SVG Content Image without rasterizing it', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <svg viewBox="0 0 800 600" aria-label="航海图">
        <path d="M0 0 L800 600"></path>
      </svg>
    `;
    const svg = frame.contentDocument.querySelector('svg');
    const path = frame.contentDocument.querySelector('path');
    svg.getBoundingClientRect = () => rect({
      bottom: 230,
      height: 200,
      left: 20,
      right: 286.67,
      top: 30,
      width: 266.67,
    });
    frame.contentDocument.elementFromPoint = () => path;

    const contentImage = findContentImageAtViewportPoint(container, 100, 150);

    assert.equal(contentImage.kind, 'svg');
    assert.equal(contentImage.alt, '航海图');
    assert.equal(contentImage.intrinsicWidth, 800);
    assert.equal(contentImage.intrinsicHeight, 600);
    assert.match(contentImage.source, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(contentImage.source, /<path\b[^>]*d="M0 0 L800 600"[^>]*\/?>(?:<\/path>)?/);
  } finally {
    dom.window.close();
  }
});

test('captures publication styles and absolute resources for an inline SVG Content Image', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.head.innerHTML = `
      <base href="https://reader.test/books/chapters/chapter-1.xhtml">
      <style>
        @font-face {
          font-family: BookSerif;
          src: url("../assets/book.woff2") format("woff2");
        }
        .publication-mark { fill: rgb(12, 34, 56); font-family: BookSerif; }
      </style>
    `;
    frame.contentDocument.body.innerHTML = `
      <svg viewBox="0 0 800 600" aria-label="航海图">
        <image width="800" height="600" href="../assets/plate.png"></image>
        <path class="publication-mark" d="M0 0 L800 600"></path>
      </svg>
    `;
    const path = frame.contentDocument.querySelector('path');
    frame.contentDocument.elementFromPoint = () => path;

    const contentImage = findContentImageAtViewportPoint(container, 100, 150);

    assert.equal(contentImage.kind, 'svg');
    assert.match(contentImage.source, /fill:\s*rgb\(12, 34, 56\)/);
    assert.match(contentImage.source, /font-family:\s*BookSerif/);
    assert.deepEqual(
      contentImage.resources.map(({ source }) => source),
      [
        'https://reader.test/books/assets/plate.png',
        'https://reader.test/books/assets/book.woff2',
      ],
    );
    assert.match(contentImage.source, /__EPUB_READER_SVG_RESOURCE_0__/);
    assert.doesNotMatch(contentImage.source, /\.\.\/assets\/plate\.png/);
  } finally {
    dom.window.close();
  }
});

test('embeds external SVG resources before the Image Viewer renders them', async () => {
  const { container, dom, frame } = createReaderFrame();
  let contentImage;
  try {
    frame.contentDocument.head.innerHTML = `
      <base href="https://reader.test/books/chapters/chapter-1.xhtml">
    `;
    frame.contentDocument.body.innerHTML = `
      <svg viewBox="0 0 800 600" aria-label="航海图">
        <image width="800" height="600" href="../assets/plate.png"></image>
        <path d="M0 0 L800 600"></path>
      </svg>
    `;
    const path = frame.contentDocument.querySelector('path');
    frame.contentDocument.elementFromPoint = () => path;
    contentImage = findContentImageAtViewportPoint(container, 100, 150);
  } finally {
    dom.window.close();
  }

  const requested = [];
  const source = await prepareSvgContentImageSource(contentImage, {
    fetchImpl: async (url) => {
      requested.push(url);
      return {
        blob: async () => new Blob(['plate'], { type: 'image/png' }),
        ok: true,
      };
    },
  });

  assert.deepEqual(requested, ['https://reader.test/books/assets/plate.png']);
  assert.match(source, /href="data:image\/png;base64,cGxhdGU="/);
  assert.doesNotMatch(source, /__EPUB_READER_SVG_RESOURCE_/);
});

test('uses the original resource from an SVG-wrapped Content Image', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = `
      <svg viewBox="0 0 1600 1200" aria-label="星图">
        <image width="1600" height="1200" href="blob:https://reader.test/plate"></image>
      </svg>
    `;
    const image = frame.contentDocument.querySelector('image');
    frame.contentDocument.elementFromPoint = () => image;

    assert.deepEqual(
      findContentImageAtViewportPoint(container, 100, 150),
      {
        alt: '星图',
        intrinsicHeight: 1200,
        intrinsicWidth: 1600,
        kind: 'url',
        source: 'blob:https://reader.test/plate',
      },
    );
  } finally {
    dom.window.close();
  }
});

test('offers a zoom cursor only while the outer gesture layer is over a Content Image', () => {
  const { container, dom, frame } = createReaderFrame();
  try {
    frame.contentDocument.body.innerHTML = '<img src="plate.jpg"><p>正文</p>';
    const image = frame.contentDocument.querySelector('img');
    const paragraph = frame.contentDocument.querySelector('p');
    frame.contentDocument.elementFromPoint = (x) => (x < 100 ? image : paragraph);

    assert.equal(contentImageCursorAtViewportPoint(container, 100, 150), 'zoom-in');
    assert.equal(contentImageCursorAtViewportPoint(container, 250, 150), '');
  } finally {
    dom.window.close();
  }
});

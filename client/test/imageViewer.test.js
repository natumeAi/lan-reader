import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { ImageViewer } from '../src/components/reader/ImageViewer.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const previousGlobals = new Map();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://reader.test/',
  });
  const install = (name, value) => {
    previousGlobals.set(name, globalThis[name]);
    globalThis[name] = value;
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('Node', dom.window.Node);
  install('Element', dom.window.Element);
  install('HTMLElement', dom.window.HTMLElement);
  install('requestAnimationFrame', (callback) => setTimeout(() => callback(Date.now()), 0));
  install('cancelAnimationFrame', clearTimeout);

  return {
    cleanup() {
      dom.window.close();
      for (const [name, value] of previousGlobals) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    },
    dom,
  };
}

const contentImage = {
  alt: '星图',
  intrinsicHeight: 1200,
  intrinsicWidth: 1600,
  kind: 'url',
  source: 'https://reader.test/books/plate.jpg',
};

async function renderViewer(props = {}) {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(createElement(ImageViewer, {
      contentImage,
      onRequestClose() {},
      ...props,
    }));
  });
  const viewport = document.querySelector('.image-viewer-viewport');
  viewport.getBoundingClientRect = () => ({
    bottom: 640,
    height: 640,
    left: 0,
    right: 360,
    top: 0,
    width: 360,
  });
  return { root, viewport };
}

function createPointerEvent(type, {
  clientX,
  clientY,
  isPrimary = true,
  pointerId = 1,
  pointerType = 'touch',
}) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperties(event, {
    isPrimary: { value: isPrimary },
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  return event;
}

async function loadViewerImage() {
  const image = document.querySelector('.image-viewer-image');
  await act(async () => {
    image.dispatchEvent(new window.Event('load', { bubbles: true }));
  });
  return image;
}

async function tap(target, options) {
  await act(async () => {
    target.dispatchEvent(createPointerEvent('pointerdown', options));
    target.dispatchEvent(createPointerEvent('pointerup', options));
  });
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.fail(message);
}

test('opens immediately with loading feedback and reveals the original Content Image', async () => {
  const environment = installDom();
  let root;
  try {
    ({ root } = await renderViewer());
    const image = document.querySelector('.image-viewer-image');

    assert.equal(document.querySelector('[role="status"]')?.textContent, '正在加载图片');
    assert.equal(image.getAttribute('src'), contentImage.source);
    assert.equal(image.getAttribute('alt'), '星图');

    await act(async () => {
      image.dispatchEvent(new window.Event('load', { bubbles: true }));
    });

    assert.equal(document.querySelector('[role="status"]'), null);
    assert.equal(image.style.width, '360px');
    assert.equal(image.style.height, '270px');
    assert.equal(image.classList.contains('is-ready'), true);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('does not upscale a small original resource wrapped by a larger SVG viewport', async () => {
  const environment = installDom();
  let root;
  try {
    const rendered = await renderViewer({
      contentImage: {
        alt: '星图',
        intrinsicHeight: 1200,
        intrinsicWidth: 1600,
        kind: 'url',
        source: 'blob:https://reader.test/plate',
      },
    });
    root = rendered.root;
    rendered.viewport.getBoundingClientRect = () => ({
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
    });
    const image = document.querySelector('.image-viewer-image');
    Object.defineProperties(image, {
      naturalHeight: { configurable: true, value: 300 },
      naturalWidth: { configurable: true, value: 400 },
    });

    await act(async () => {
      image.dispatchEvent(new window.Event('load', { bubbles: true }));
    });

    assert.equal(image.style.width, '400px');
    assert.equal(image.style.height, '300px');
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('prepares a standalone inline SVG before the Image Viewer renders it', async () => {
  const environment = installDom();
  const originalFetch = globalThis.fetch;
  const requested = [];
  let root;
  try {
    globalThis.fetch = async (url) => {
      requested.push(url);
      return {
        blob: async () => new Blob(['plate'], { type: 'image/png' }),
        ok: true,
      };
    };
    ({ root } = await renderViewer({
      contentImage: {
        alt: '航海图',
        intrinsicHeight: 600,
        intrinsicWidth: 800,
        kind: 'svg',
        resources: [{
          placeholder: '__EPUB_READER_SVG_RESOURCE_0__',
          source: 'https://reader.test/books/assets/plate.png',
        }],
        source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><image href="__EPUB_READER_SVG_RESOURCE_0__" /></svg>',
      },
    }));
    const image = document.querySelector('.image-viewer-image');

    await waitUntil(
      () => image.getAttribute('src')?.startsWith('blob:'),
      'the inline SVG was not prepared as an isolated image resource',
    );

    assert.deepEqual(requested, ['https://reader.test/books/assets/plate.png']);
  } finally {
    globalThis.fetch = originalFetch;
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('shows a clear error when the original Content Image cannot load', async () => {
  const environment = installDom();
  let root;
  try {
    ({ root } = await renderViewer());
    const image = document.querySelector('.image-viewer-image');

    await act(async () => {
      image.dispatchEvent(new window.Event('error', { bubbles: true }));
    });

    assert.equal(document.querySelector('[role="alert"]')?.textContent, '图片无法加载');
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('keeps a close button visible and supports Escape without extra controls', async () => {
  const environment = installDom();
  let root;
  let closeCount = 0;
  try {
    ({ root } = await renderViewer({
      onRequestClose() {
        closeCount += 1;
      },
    }));
    const dialog = document.querySelector('[role="dialog"]');
    const closeButton = document.querySelector('button[aria-label="关闭图片查看器"]');
    const tabEvent = new window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Tab',
    });

    assert.ok(closeButton);
    assert.equal(document.querySelectorAll('button').length, 1);
    await act(async () => {
      closeButton.dispatchEvent(tabEvent);
    });
    assert.equal(tabEvent.defaultPrevented, true);
    await act(async () => {
      closeButton.click();
    });
    await act(async () => {
      dialog.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Escape',
      }));
    });

    assert.equal(closeCount, 2);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('double-taps a Content Image to 2.5x without closing on the zoomed backdrop', async () => {
  const environment = installDom();
  let root;
  let closeCount = 0;
  try {
    const rendered = await renderViewer({
      onRequestClose() {
        closeCount += 1;
      },
    });
    root = rendered.root;
    const image = await loadViewerImage();

    await tap(image, { clientX: 280, clientY: 320 });
    await tap(image, { clientX: 280, clientY: 320 });

    assert.match(image.style.transform, /scale\(2\.5\)/);

    await tap(rendered.viewport, { clientX: 10, clientY: 10 });
    assert.equal(closeCount, 0);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('pinches a Content Image continuously with two touch pointers', async () => {
  const environment = installDom();
  let root;
  try {
    ({ root } = await renderViewer());
    const image = await loadViewerImage();

    await act(async () => {
      image.dispatchEvent(createPointerEvent('pointerdown', {
        clientX: 130,
        clientY: 320,
        pointerId: 1,
      }));
      image.dispatchEvent(createPointerEvent('pointerdown', {
        clientX: 230,
        clientY: 320,
        isPrimary: false,
        pointerId: 2,
      }));
      image.dispatchEvent(createPointerEvent('pointermove', {
        clientX: 330,
        clientY: 320,
        isPrimary: false,
        pointerId: 2,
      }));
    });

    assert.match(image.style.transform, /scale\(2\)/);

    await act(async () => {
      image.dispatchEvent(createPointerEvent('pointerup', {
        clientX: 130,
        clientY: 320,
        pointerId: 1,
      }));
      image.dispatchEvent(createPointerEvent('pointerup', {
        clientX: 330,
        clientY: 320,
        isPrimary: false,
        pointerId: 2,
      }));
    });
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('keeps one-finger pan immediate after one pointer leaves a pinch', async () => {
  const environment = installDom();
  let root;
  try {
    ({ root } = await renderViewer());
    const image = await loadViewerImage();
    const panLayer = document.querySelector('.image-viewer-pan-layer');

    await act(async () => {
      image.dispatchEvent(createPointerEvent('pointerdown', {
        clientX: 130,
        clientY: 320,
        pointerId: 1,
      }));
      image.dispatchEvent(createPointerEvent('pointerdown', {
        clientX: 230,
        clientY: 320,
        isPrimary: false,
        pointerId: 2,
      }));
      image.dispatchEvent(createPointerEvent('pointermove', {
        clientX: 330,
        clientY: 320,
        isPrimary: false,
        pointerId: 2,
      }));
      image.dispatchEvent(createPointerEvent('pointerup', {
        clientX: 330,
        clientY: 320,
        isPrimary: false,
        pointerId: 2,
      }));
    });

    assert.equal(
      document.querySelector('.image-viewer').classList.contains('is-transform-animating'),
      false,
    );
    await act(async () => {
      image.dispatchEvent(createPointerEvent('pointermove', {
        clientX: 180,
        clientY: 320,
        pointerId: 1,
      }));
    });
    assert.equal(panLayer.style.transform, 'translate3d(100px, 0px, 0)');
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('pans a zoomed Content Image with one pointer', async () => {
  const environment = installDom();
  let root;
  try {
    ({ root } = await renderViewer());
    const image = await loadViewerImage();
    const panLayer = document.querySelector('.image-viewer-pan-layer');
    await tap(image, { clientX: 180, clientY: 320 });
    await tap(image, { clientX: 180, clientY: 320 });

    await act(async () => {
      image.dispatchEvent(createPointerEvent('pointerdown', {
        clientX: 180,
        clientY: 320,
        pointerId: 1,
        pointerType: 'mouse',
      }));
      image.dispatchEvent(createPointerEvent('pointermove', {
        clientX: 280,
        clientY: 320,
        pointerId: 1,
        pointerType: 'mouse',
      }));
      image.dispatchEvent(createPointerEvent('pointerup', {
        clientX: 280,
        clientY: 320,
        pointerId: 1,
        pointerType: 'mouse',
      }));
    });

    assert.equal(panLayer.style.transform, 'translate3d(100px, 0px, 0)');
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('zooms around the desktop pointer with a wheel or trackpad', async () => {
  const environment = installDom();
  let root;
  try {
    const rendered = await renderViewer();
    root = rendered.root;
    const image = await loadViewerImage();
    const wheelEvent = new window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 280,
      clientY: 320,
      deltaY: -200,
    });

    await act(async () => {
      rendered.viewport.dispatchEvent(wheelEvent);
    });

    const scale = Number(image.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    assert.equal(wheelEvent.defaultPrevented, true);
    assert.ok(scale > 1 && scale <= 5);
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

test('animates a resisted pan back to the image boundary on release', async () => {
  const environment = installDom();
  let root;
  try {
    ({ root } = await renderViewer());
    const image = await loadViewerImage();
    await tap(image, { clientX: 180, clientY: 320 });
    await tap(image, { clientX: 180, clientY: 320 });

    await act(async () => {
      image.dispatchEvent(createPointerEvent('pointerdown', {
        clientX: 180,
        clientY: 320,
        pointerId: 1,
      }));
      image.dispatchEvent(createPointerEvent('pointermove', {
        clientX: 680,
        clientY: 320,
        pointerId: 1,
      }));
      image.dispatchEvent(createPointerEvent('pointerup', {
        clientX: 680,
        clientY: 320,
        pointerId: 1,
      }));
    });

    assert.equal(
      document.querySelector('.image-viewer').classList.contains('is-transform-animating'),
      true,
    );
  } finally {
    if (root) await act(async () => root.unmount());
    environment.cleanup();
  }
});

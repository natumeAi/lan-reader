const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const SVG_GRAPHIC_SELECTOR = [
  'circle',
  'ellipse',
  'foreignObject',
  'image',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'text',
  'use',
].join(',');
const SVG_COMPUTED_STYLE_PROPERTIES = [
  'alignment-baseline',
  'baseline-shift',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'cursor',
  'direction',
  'display',
  'dominant-baseline',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-variation-settings',
  'font-weight',
  'image-rendering',
  'isolation',
  'letter-spacing',
  'lighting-color',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'mask-type',
  'mix-blend-mode',
  'opacity',
  'overflow',
  'paint-order',
  'pointer-events',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-orientation',
  'text-rendering',
  'transform',
  'transform-box',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'white-space',
  'word-spacing',
  'writing-mode',
];
const SVG_RESOURCE_PLACEHOLDER_PREFIX = '__EPUB_READER_SVG_RESOURCE_';

function containsPoint(rect, x, y) {
  return Boolean(
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left &&
    x <= rect.right &&
    y >= rect.top &&
    y <= rect.bottom
  );
}

function computedStyleFor(element) {
  const view = element?.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return null;
  try {
    return view.getComputedStyle(element);
  } catch {
    return null;
  }
}

function isVisibleContentImage(element) {
  if (!element) return true;

  for (let current = element; current; current = current.parentElement) {
    const style = computedStyleFor(current);
    if (!style) continue;
    if (
      style.display === 'none' ||
      style.contentVisibility === 'hidden' ||
      (style.opacity !== '' && Number(style.opacity) === 0)
    ) {
      return false;
    }
    if (current === element && /^(?:collapse|hidden)$/.test(style.visibility)) {
      return false;
    }
  }

  return true;
}

function hitsContentImageWhenEnabled(document, element, x, y) {
  const style = element?.style;
  if (
    computedStyleFor(element)?.pointerEvents !== 'none' ||
    typeof document?.elementFromPoint !== 'function' ||
    !style?.setProperty
  ) {
    return false;
  }

  const previousValue = style.getPropertyValue('pointer-events');
  const previousPriority = style.getPropertyPriority('pointer-events');
  try {
    style.setProperty('pointer-events', 'auto', 'important');
    const target = document.elementFromPoint(x, y);
    return target === element || Boolean(element.contains?.(target));
  } catch {
    return false;
  } finally {
    if (previousValue) {
      style.setProperty('pointer-events', previousValue, previousPriority);
    } else {
      style.removeProperty('pointer-events');
    }
  }
}

function imageAtPoint(document, x, y) {
  let target = null;
  try {
    target = document.elementFromPoint?.(x, y) || null;
  } catch {
    target = null;
  }

  const closestImage = target?.closest?.('img, svg');
  if (closestImage && isVisibleContentImage(closestImage)) return closestImage;

  const candidates = [...(document.querySelectorAll?.('img, svg') || [])];
  return candidates.reverse().find((candidate) => (
    isVisibleContentImage(candidate) &&
    containsPoint(candidate.getBoundingClientRect?.(), x, y) &&
    (
      !target ||
      target.contains?.(candidate) ||
      hitsContentImageWhenEnabled(document, candidate, x, y)
    )
  )) || null;
}

function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function svgDimensions(svg) {
  const viewBox = String(svg.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    const width = finiteDimension(viewBox[2]);
    const height = finiteDimension(viewBox[3]);
    if (width && height) return { height, width };
  }

  const width = finiteDimension(String(svg.getAttribute('width') || '').replace(/px$/i, ''));
  const height = finiteDimension(String(svg.getAttribute('height') || '').replace(/px$/i, ''));
  if (width && height) return { height, width };

  const rendered = svg.getBoundingClientRect?.();
  return {
    height: finiteDimension(rendered?.height),
    width: finiteDimension(rendered?.width),
  };
}

function replaceCssUrls(value, replaceUrl) {
  return String(value || '').replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
    (match, doubleQuoted, singleQuoted, unquoted) => {
      const resource = doubleQuoted ?? singleQuoted ?? unquoted?.trim() ?? '';
      const replacement = replaceUrl(resource);
      return replacement === resource ? match : `url("${replacement}")`;
    },
  );
}

function createSvgResourceCollector() {
  const resources = [];
  const placeholdersBySource = new Map();

  const register = (value, baseUri) => {
    const resource = String(value || '').trim();
    if (
      !resource ||
      resource.startsWith('#') ||
      resource.startsWith('data:') ||
      resource.startsWith(SVG_RESOURCE_PLACEHOLDER_PREFIX)
    ) {
      return resource;
    }

    let source;
    try {
      source = new URL(resource, baseUri).href;
    } catch {
      return resource;
    }
    if (!/^(?:blob|https?|file):/i.test(source)) return resource;

    const existing = placeholdersBySource.get(source);
    if (existing) return existing;
    const placeholder = `${SVG_RESOURCE_PLACEHOLDER_PREFIX}${resources.length}__`;
    placeholdersBySource.set(source, placeholder);
    resources.push({ placeholder, source });
    return placeholder;
  };

  return { register, resources };
}

function copyComputedStyle(source, clone) {
  if (!clone?.style) return;
  const computed = computedStyleFor(source);
  if (!computed) return;
  const properties = source.namespaceURI === SVG_NAMESPACE
    ? SVG_COMPUTED_STYLE_PROPERTIES
    : [...computed];
  for (const property of properties) {
    const value = computed.getPropertyValue(property);
    if (value) clone.style.setProperty(property, value);
  }
}

function fontFaceRules(document, register) {
  const rules = [];
  const visited = new Set();

  const visit = (sheet) => {
    if (!sheet || visited.has(sheet)) return;
    visited.add(sheet);
    let cssRules;
    try {
      cssRules = [...sheet.cssRules];
    } catch {
      return;
    }
    for (const rule of cssRules) {
      if (/^@font-face\b/i.test(rule.cssText || '')) {
        const baseUri = sheet.href || document.baseURI;
        rules.push(replaceCssUrls(rule.cssText, (url) => register(url, baseUri)));
      } else if (rule.styleSheet) {
        visit(rule.styleSheet);
      }
    }
  };

  for (const sheet of [...(document.styleSheets || [])]) visit(sheet);
  return rules;
}

function serializeSvg(svg) {
  const clone = svg.cloneNode(true);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', SVG_NAMESPACE);
  const { register, resources } = createSvgResourceCollector();
  const sources = [svg, ...svg.querySelectorAll('*')];
  const clones = [clone, ...clone.querySelectorAll('*')];

  sources.forEach((source, index) => {
    const clonedElement = clones[index];
    if (!clonedElement) return;
    copyComputedStyle(source, clonedElement);
    for (const attribute of [...clonedElement.attributes]) {
      if (/^on/i.test(attribute.name)) {
        clonedElement.removeAttributeNode(attribute);
        continue;
      }
      const baseUri = source.baseURI || svg.baseURI;
      const localName = clonedElement.localName?.toLowerCase();
      const isDirectResource = (
        attribute.localName === 'src' ||
        attribute.localName === 'poster' ||
        attribute.localName === 'data' ||
        (attribute.localName === 'href' && localName !== 'a' && localName !== 'link')
      );
      const nextValue = isDirectResource
        ? register(attribute.value, baseUri)
        : replaceCssUrls(attribute.value, (url) => register(url, baseUri));
      if (nextValue !== attribute.value) {
        clonedElement.setAttributeNS(attribute.namespaceURI, attribute.name, nextValue);
      }
    }
  });

  clone.querySelectorAll('script, link[rel="stylesheet"]').forEach((element) => element.remove());
  const fonts = fontFaceRules(svg.ownerDocument, register);
  if (fonts.length) {
    const style = svg.ownerDocument.createElementNS(SVG_NAMESPACE, 'style');
    style.textContent = fonts.join('\n');
    clone.insertBefore(style, clone.firstChild);
  }

  const Serializer = svg.ownerDocument?.defaultView?.XMLSerializer || globalThis.XMLSerializer;
  return {
    resources,
    source: typeof Serializer === 'function' ? new Serializer().serializeToString(clone) : '',
  };
}

async function blobAsDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const mimeType = blob.type || 'application/octet-stream';
  return `data:${mimeType};base64,${globalThis.btoa(binary)}`;
}

export async function prepareSvgContentImageSource(contentImage, {
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (contentImage?.kind !== 'svg') return contentImage?.source || '';
  const resources = contentImage.resources || [];
  if (!resources.length) return contentImage.source || '';
  if (typeof fetchImpl !== 'function') throw new Error('SVG resource loading is unavailable');

  const dataUrlsBySource = new Map();
  const loadResource = (source) => {
    const url = new URL(source);
    const fragment = url.hash;
    url.hash = '';
    const fetchUrl = url.href;
    let pending = dataUrlsBySource.get(fetchUrl);
    if (!pending) {
      pending = Promise.resolve(fetchImpl(fetchUrl, signal ? { signal } : undefined))
        .then((response) => {
          if (!response || response.ok === false || typeof response.blob !== 'function') {
            throw new Error(`Unable to load SVG resource: ${fetchUrl}`);
          }
          return response.blob();
        })
        .then(blobAsDataUrl);
      dataUrlsBySource.set(fetchUrl, pending);
    }
    return pending.then((dataUrl) => `${dataUrl}${fragment}`);
  };

  const replacements = await Promise.all(resources.map(async ({ placeholder, source }) => ({
    placeholder,
    value: await loadResource(source),
  })));
  return replacements.reduce(
    (source, replacement) => source.split(replacement.placeholder).join(replacement.value),
    contentImage.source || '',
  );
}

function originalResourceFromSvgImage(svg, dimensions) {
  if (!dimensions.width || !dimensions.height) return '';
  const graphics = [...svg.querySelectorAll(SVG_GRAPHIC_SELECTOR)].filter((element) => (
    !element.closest('defs, clipPath, marker, mask, pattern, symbol')
  ));
  if (graphics.length !== 1 || graphics[0].localName !== 'image') return '';

  const image = graphics[0];
  const x = Number(image.getAttribute('x') || 0);
  const y = Number(image.getAttribute('y') || 0);
  const width = finiteDimension(image.getAttribute('width'));
  const height = finiteDimension(image.getAttribute('height'));
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x !== 0 ||
    y !== 0 ||
    width !== dimensions.width ||
    height !== dimensions.height ||
    image.hasAttribute('transform') ||
    image.hasAttribute('clip-path') ||
    image.hasAttribute('filter') ||
    image.hasAttribute('mask') ||
    /\bslice\b/i.test(image.getAttribute('preserveAspectRatio') || '')
  ) {
    return '';
  }

  for (let ancestor = image.parentElement; ancestor && ancestor !== svg; ancestor = ancestor.parentElement) {
    if (
      ancestor.hasAttribute('transform') ||
      ancestor.hasAttribute('clip-path') ||
      ancestor.hasAttribute('filter') ||
      ancestor.hasAttribute('mask')
    ) {
      return '';
    }
  }

  const source = image.getAttribute('href') ||
    image.getAttributeNS(XLINK_NAMESPACE, 'href') ||
    image.getAttribute('xlink:href') ||
    '';
  if (!source || source.startsWith('#')) return '';
  try {
    return new URL(source, svg.ownerDocument?.baseURI).href;
  } catch {
    return source;
  }
}

function describeContentImage(element) {
  if (element.localName === 'img') {
    const source = element.currentSrc || element.src || element.getAttribute('src') || '';
    if (!source) return null;
    return {
      alt: element.getAttribute('alt') || '',
      intrinsicHeight: finiteDimension(element.naturalHeight),
      intrinsicWidth: finiteDimension(element.naturalWidth),
      kind: 'url',
      source,
    };
  }

  if (element.localName === 'svg') {
    const dimensions = svgDimensions(element);
    const alt = element.getAttribute('aria-label') ||
      element.querySelector('title')?.textContent?.trim() ||
      '';
    const originalResource = originalResourceFromSvgImage(element, dimensions);
    if (originalResource) {
      return {
        alt,
        intrinsicHeight: dimensions.height,
        intrinsicWidth: dimensions.width,
        kind: 'url',
        source: originalResource,
      };
    }

    const { resources, source } = serializeSvg(element);
    if (!source) return null;
    return {
      alt,
      intrinsicHeight: dimensions.height,
      intrinsicWidth: dimensions.width,
      kind: 'svg',
      resources,
      source,
    };
  }

  return null;
}

function findContentImageElementAtViewportPoint(container, clientX, clientY) {
  const frames = [...(container?.querySelectorAll?.('iframe') || [])];

  for (const frame of frames.reverse()) {
    const frameRect = frame.getBoundingClientRect?.();
    if (!containsPoint(frameRect, clientX, clientY)) continue;

    let frameDocument;
    try {
      frameDocument = frame.contentDocument;
    } catch {
      continue;
    }
    if (!frameDocument) continue;

    const element = imageAtPoint(
      frameDocument,
      clientX - frameRect.left,
      clientY - frameRect.top,
    );
    if (element) return element;
  }

  return null;
}

export function contentImageCursorAtViewportPoint(container, clientX, clientY) {
  return findContentImageElementAtViewportPoint(container, clientX, clientY)
    ? 'zoom-in'
    : '';
}

export function findContentImageAtViewportPoint(container, clientX, clientY) {
  const element = findContentImageElementAtViewportPoint(container, clientX, clientY);
  return element ? describeContentImage(element) : null;
}

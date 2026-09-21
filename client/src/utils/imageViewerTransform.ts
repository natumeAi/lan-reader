import type { ImagePoint, ImageViewerDimensions, ImageViewerTransform } from '../types/contentImage.js';

export const IMAGE_VIEWER_MIN_SCALE = 1;
export const IMAGE_VIEWER_MAX_SCALE = 5;
export const IMAGE_VIEWER_DOUBLE_TAP_SCALE = 2.5;

const PAN_RESISTANCE = 0.25;

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fitImage(imageWidth: number, imageHeight: number, viewportWidth: number, viewportHeight: number) {
  if (!imageWidth || !imageHeight || !viewportWidth || !viewportHeight) {
    return { height: 0, width: 0 };
  }
  const fitScale = Math.min(1, viewportWidth / imageWidth, viewportHeight / imageHeight);
  return {
    height: imageHeight * fitScale,
    width: imageWidth * fitScale,
  };
}

export function getImageViewerBounds(transform: ImageViewerTransform) {
  return {
    x: Math.max(0, (transform.baseWidth * transform.scale - transform.viewportWidth) / 2),
    y: Math.max(0, (transform.baseHeight * transform.scale - transform.viewportHeight) / 2),
  };
}

function clampOffsets(transform: ImageViewerTransform) {
  const bounds = getImageViewerBounds(transform);
  return {
    ...transform,
    offsetX: clamp(transform.offsetX, -bounds.x, bounds.x),
    offsetY: clamp(transform.offsetY, -bounds.y, bounds.y),
  };
}

export function createImageViewerTransform({
  imageHeight,
  imageWidth,
  viewportHeight,
  viewportWidth,
}: ImageViewerDimensions): ImageViewerTransform {
  const normalizedImageWidth = positive(imageWidth);
  const normalizedImageHeight = positive(imageHeight);
  const normalizedViewportWidth = positive(viewportWidth);
  const normalizedViewportHeight = positive(viewportHeight);
  const fitted = fitImage(
    normalizedImageWidth,
    normalizedImageHeight,
    normalizedViewportWidth,
    normalizedViewportHeight,
  );

  return {
    baseHeight: fitted.height,
    baseWidth: fitted.width,
    imageHeight: normalizedImageHeight,
    imageWidth: normalizedImageWidth,
    offsetX: 0,
    offsetY: 0,
    scale: IMAGE_VIEWER_MIN_SCALE,
    viewportHeight: normalizedViewportHeight,
    viewportWidth: normalizedViewportWidth,
  };
}

export function zoomImageViewerAt(transform: ImageViewerTransform, requestedScale: number, point: Partial<ImagePoint> = {}) {
  const scale = clamp(
    finite(requestedScale, transform.scale),
    IMAGE_VIEWER_MIN_SCALE,
    IMAGE_VIEWER_MAX_SCALE,
  );
  const ratio = transform.scale > 0 ? scale / transform.scale : 1;
  const focalX = finite(point.x, transform.viewportWidth / 2) - transform.viewportWidth / 2;
  const focalY = finite(point.y, transform.viewportHeight / 2) - transform.viewportHeight / 2;
  const next = {
    ...transform,
    offsetX: focalX - (focalX - transform.offsetX) * ratio,
    offsetY: focalY - (focalY - transform.offsetY) * ratio,
    scale,
  };
  return clampOffsets(next);
}

function resistOffset(value: number, bound: number) {
  if (bound <= 0) return value * PAN_RESISTANCE;
  if (value > bound) return bound + (value - bound) * PAN_RESISTANCE;
  if (value < -bound) return -bound + (value + bound) * PAN_RESISTANCE;
  return value;
}

export function panImageViewerBy(transform: ImageViewerTransform, deltaX: number, deltaY: number, { resist = false } = {}) {
  const next = {
    ...transform,
    offsetX: transform.offsetX + finite(deltaX),
    offsetY: transform.offsetY + finite(deltaY),
  };
  if (!resist) return clampOffsets(next);

  const bounds = getImageViewerBounds(next);
  return {
    ...next,
    offsetX: resistOffset(next.offsetX, bounds.x),
    offsetY: resistOffset(next.offsetY, bounds.y),
  };
}

export function settleImageViewerTransform(transform: ImageViewerTransform) {
  return clampOffsets({
    ...transform,
    scale: clamp(
      finite(transform.scale, IMAGE_VIEWER_MIN_SCALE),
      IMAGE_VIEWER_MIN_SCALE,
      IMAGE_VIEWER_MAX_SCALE,
    ),
  });
}

export function resizeImageViewerTransform(transform: ImageViewerTransform, {
  viewportHeight,
  viewportWidth,
}: Pick<ImageViewerDimensions, 'viewportHeight' | 'viewportWidth'>) {
  const normalizedViewportWidth = positive(viewportWidth);
  const normalizedViewportHeight = positive(viewportHeight);
  const fitted = fitImage(
    transform.imageWidth,
    transform.imageHeight,
    normalizedViewportWidth,
    normalizedViewportHeight,
  );
  const viewedX = transform.baseWidth > 0
    ? -transform.offsetX / (transform.baseWidth * transform.scale)
    : 0;
  const viewedY = transform.baseHeight > 0
    ? -transform.offsetY / (transform.baseHeight * transform.scale)
    : 0;

  return clampOffsets({
    ...transform,
    baseHeight: fitted.height,
    baseWidth: fitted.width,
    offsetX: -viewedX * fitted.width * transform.scale,
    offsetY: -viewedY * fitted.height * transform.scale,
    viewportHeight: normalizedViewportHeight,
    viewportWidth: normalizedViewportWidth,
  });
}

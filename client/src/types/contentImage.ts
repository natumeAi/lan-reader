export interface ImageDimensions {
  intrinsicHeight: number;
  intrinsicWidth: number;
}

export interface SvgImageResource {
  placeholder: string;
  source: string;
}

export type ContentImage = ImageDimensions & { alt: string; source: string } & (
  | { kind: 'url' }
  | { kind: 'svg'; resources: SvgImageResource[] }
);

export interface ImagePoint { x: number; y: number }

export interface ImageViewerDimensions {
  imageHeight: number;
  imageWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}

export interface ImageViewerTransform extends ImageViewerDimensions {
  baseHeight: number;
  baseWidth: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

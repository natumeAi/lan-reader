import type { ReaderSettings } from '../hooks/useReaderSettings';

export type SurfaceDirection = 'next' | 'prev';
export interface PositionKey {
  readonly sessionId: number;
  readonly positionRevision: number;
  readonly layoutGeneration: number;
  readonly appearanceGeneration: number;
}
export interface SurfaceRequest {
  readonly key: PositionKey;
  readonly cfi: string;
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly direction: SurfaceDirection;
  readonly readingDirection: 'ltr' | 'rtl';
  readonly settings: Readonly<ReaderSettings>;
}
export interface PreparedSurface {
  readonly element: HTMLElement;
  readonly origin: PositionKey;
  readonly target: { readonly sectionIndex: number; readonly page: number; readonly cfi: string };
}
export interface SurfaceOwner {
  readonly id: string;
  readonly ready: Promise<PreparedSurface | null>;
  /** Stop future work/publication; never implies pending upstream work settled. */
  stop(): void;
  /** Actual navigation/font/image/frame work; reuse a completed drain until work changes. */
  drain(): Promise<void>;
  /** Idempotent; resolves after work and frame-only disposal have completed. */
  dispose(): Promise<void>;
}
export interface SurfaceProvider { create(request: SurfaceRequest): SurfaceOwner }
export interface SurfaceLease {
  readonly id: string;
  readonly prepared: PreparedSurface;
  readonly request: SurfaceRequest;
  release(): void;
}
export interface OptionalPagination {
  request(): void;
  pause(): void;
  stopAndDrain(): Promise<void>;
  invalidate(): void;
  destroy(): void;
}
export function samePositionKey(left: PositionKey, right: PositionKey) {
  return left.sessionId === right.sessionId && left.positionRevision === right.positionRevision
    && left.layoutGeneration === right.layoutGeneration && left.appearanceGeneration === right.appearanceGeneration;
}

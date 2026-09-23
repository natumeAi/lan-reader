import type { ReaderLocation, TocItem, ReadingSection } from '../types/epub';
import type { ReaderSettings } from '../hooks/useReaderSettings';
import type { PageBuffer } from './pageBuffer';
import type { OptionalPagination, PositionKey, SurfaceDirection, SurfaceRequest } from './bufferTypes';
export type ReaderState = 'loading' | 'ready' | 'suspended' | 'recovering' | 'failed' | 'closed';
export interface ContentDocument { document: Document; sectionIndex: number; frame: HTMLIFrameElement | null }
export interface StablePosition { cfi: string; location: ReaderLocation; text: string; layout: string; page: number }
export type NavigationCommand =
  | { kind: 'open'; data: ArrayBuffer; target?: string | number }
  | { kind: 'turn'; direction: 'next' | 'prev' }
  | { kind: 'display' | 'restore'; target: string | number }
  | { kind: 'settings'; settings: ReaderSettings; target: string | number };
export type NavigationResult =
  | { kind: 'verified'; commandId: number; position: StablePosition }
  | { kind: 'boundary' | 'cancelled' | 'unavailable'; commandId: number }
  | { kind: 'failed'; commandId: number; error: unknown };
export interface ReaderEngine {
  readonly direction?: 'ltr' | 'rtl';
  state: ReaderState;
  stable: StablePosition | null;
  toc: TocItem[];
  readingSections: ReadingSection[];
  currentLocation(): ReaderLocation | null;
  getContents(): ContentDocument[];
  execute(command: NavigationCommand): Promise<NavigationResult>;
  onLayoutInvalidated?: () => void;
  display(target: string | number): Promise<void>;
  turn(direction: 'next' | 'prev'): Promise<void>;
  applySettings(settings: ReaderSettings): Promise<void>;
  suspend(): void;
  resume(): Promise<void>;
  destroy(): void;
}

/** Composition boundary: navigation engine has no animation/cache ownership. */
export interface ReaderSession {
  readonly engine: ReaderEngine;
  readonly foreground: HTMLElement;
  readonly buffer: PageBuffer;
  readonly pagination: OptionalPagination;
  createRequest(position: StablePosition, key: PositionKey, direction: SurfaceDirection, viewport: { width: number; height: number }): SurfaceRequest;
  setOptionalWorkAllowed(allowed: boolean): void;
}

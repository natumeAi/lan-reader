import type { ReaderLocation, TocItem, ReadingSection } from '../types/epub';
import type { ReaderSettings } from '../hooks/useReaderSettings';
import type { PageBuffer } from './pageBuffer';
import type { OptionalPagination, PositionKey, SurfaceDirection, SurfaceRequest } from './bufferTypes';
export type ReaderState = 'loading' | 'ready' | 'suspended' | 'recovering' | 'failed' | 'closed';
export interface ContentDocument { document: Document; sectionIndex: number; frame: HTMLIFrameElement | null }
export interface StablePosition { cfi: string; location: ReaderLocation; text: string; layout: string; page: number }
/**
 * The prepared preview a turn must reach: its accepted origin and layout plus
 * the preview's verified page and visible anchor. The engine verifies it in the
 * foreground's own document; the anchor need not equal the foreground's newly
 * sampled midpoint CFI, only lie on the same verified page.
 */
export interface TurnTarget { origin: string; layout: string; sectionIndex: number; page: number; total: number; cfi: string }
export type NavigationCommand =
  | { kind: 'open'; data: ArrayBuffer; target?: string | number }
  | { kind: 'turn'; direction: 'next' | 'prev'; expectedTarget?: TurnTarget }
  | { kind: 'display' | 'restore'; target: string | number }
  | { kind: 'settings'; settings: ReaderSettings; target: string | number };
export type NavigationResult =
  | { kind: 'verified'; commandId: number; position: StablePosition }
  | { kind: 'boundary' | 'cancelled' | 'unavailable'; commandId: number }
  /** The foreground did not reach the expected turn target; nothing may be accepted. */
  | { kind: 'mismatch'; commandId: number; reason: 'origin' | 'layout' | 'section' | 'page' | 'anchor' }
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

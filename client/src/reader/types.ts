import type { ReaderLocation, TocItem, ReadingSection } from '../types/epub';
import type { ReaderSettings } from '../hooks/useReaderSettings';
export type ReaderState = 'loading' | 'ready' | 'suspended' | 'recovering' | 'failed' | 'closed';
export interface ContentDocument { document: Document; sectionIndex: number; frame: HTMLIFrameElement | null }
export interface StablePosition { cfi: string; location: ReaderLocation; text: string; layout: string; page: number }
export interface ReaderEngine {
  readonly direction?: 'ltr' | 'rtl';
  element: HTMLElement;
  state: ReaderState;
  stable: StablePosition | null;
  toc: TocItem[];
  readingSections: ReadingSection[];
  currentLocation(): ReaderLocation | null;
  getContents(): ContentDocument[];
  display(target: string | number): Promise<void>;
  turn(direction: 'next' | 'prev'): Promise<void>;
  prepareTurn(direction: 'next' | 'prev'): Promise<HTMLElement | null>;
  cancelTurnPreview(): void;
  applySettings(settings: ReaderSettings): Promise<void>;
  pauseMeasurement?(): void;
  schedulePages?(): void;
  suspend(): void;
  resume(): Promise<void>;
  destroy(): void;
}

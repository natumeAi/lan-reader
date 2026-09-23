/**
 * Reading-activity observation for one open Book (one ReaderView).
 *
 * The only observation boundary is the Controller's accepted positions
 * (`opened` / `navigation` / `layout-restored`; `snapshot` is a forced capture
 * and is ignored). Engine readiness, `onPosition`/`onState` notifications and
 * independently owned preview/measurement Views never produce observations.
 *
 * Time and text have separate eligibility:
 * - time runs while readable content is in the foreground: content ready, page
 *   visible (and not hidden by pagehide), no blocking settings/TOC panel, a
 *   live controller that is not recovering/suspended/failed, attached to a
 *   mounted reader and not closed. An open book-image viewer keeps time.
 * - text additionally needs no image viewer, an idle controller (no moving or
 *   covering preview surface) and a ready engine. Sampling is deferred off the
 *   accepting call and re-validated across every yield by generation,
 *   engine identity and the accepted CFI/layout.
 *
 * Completion follows `qualifiesForCompletion` and is recorded immediately as
 * its own dated record. Duration is checkpointed periodically and at every
 * lifecycle boundary; each checkpoint closes the running span exactly once.
 * Observer failures never propagate into the reader.
 */
import type { ReadingActivitySink } from '../utils/activityDelivery';
import type { ActivityClockSource } from '../utils/readingActivity';
import {
  ACTIVITY_CHECKPOINT_INTERVAL_MS,
  CoverageLedger,
  ForegroundClock,
  browserClock,
  createActivityEvents,
  createCompletionEvent,
  qualifiesForCompletion,
  splitAtLocalMidnight,
} from '../utils/readingActivity';
import type { AcceptedPosition, ReaderController, ReaderPhase } from './readerController';
import type { ContentDocument, ReaderEngine } from './types';
import type { VisibleTextOptions, VisibleTextOutcome } from './visibleText';
import { sampleVisibleText } from './visibleText';

/** One accepted position together with the foreground that produced it. */
export interface AcceptedObservation {
  readonly event: AcceptedPosition;
  readonly engine: ReaderEngine;
  readonly controller: Pick<ReaderController, 'snapshot' | 'subscribe'>;
  /** The foreground engine element; bounds what can be visible. */
  readonly foreground: HTMLElement;
  /** Whether a saved (server or pending) position existed when this engine opened. */
  readonly hadSavedPosition: boolean;
}

export type AcceptedObserver = (observation: AcceptedObservation) => void;

export interface ActivityTrackerInputs {
  readonly sink: ReadingActivitySink | null;
  /** Loaded, laid out and without an error message. */
  readonly contentReady: boolean;
  /** A settings/TOC panel covers the page. */
  readonly blockingPanel: boolean;
  /** The book-image viewer is open (time continues, no text). */
  readonly imageViewerOpen: boolean;
}

export interface ActivityTrackerOptions {
  readonly clock?: ActivityClockSource;
  readonly sample?: (contents: readonly ContentDocument[], options: VisibleTextOptions) => Promise<VisibleTextOutcome>;
  /** Delay after the controller settles before sampling visible text. */
  readonly settleMs?: number;
  readonly checkpointMs?: number;
  readonly document?: Document;
  readonly window?: Window;
}

const TIME_PHASES = new Set<ReaderPhase>(['idle', 'tracking', 'dragging', 'preparing', 'settling', 'committing']);
const DEFAULT_SETTLE_MS = 300;

export class ReaderActivityTracker {
  private readonly clock: ForegroundClock;
  private readonly source: ActivityClockSource;
  private readonly ledger = new CoverageLedger();
  private readonly sample: NonNullable<ActivityTrackerOptions['sample']>;
  private readonly settleMs: number;
  private readonly checkpointMs: number;
  private inputs: ActivityTrackerInputs = { sink: null, contentReady: false, blockingPanel: false, imageViewerOpen: false };
  private current: { observation: AcceptedObservation; unsubscribe: () => void } | null = null;
  private pending: AcceptedObservation | null = null;
  private generation = 0;
  private sampleTimer: ReturnType<typeof setTimeout> | null = null;
  private sampling = false;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private attachments = 0;
  private pageHidden = false;
  private closed = false;
  private previousAtEnd: boolean | null = null;
  private openedBefore = false;
  private completed = false;

  constructor(private readonly bookId: number, private readonly options: ActivityTrackerOptions = {}) {
    this.source = options.clock ?? browserClock;
    this.clock = new ForegroundClock(this.source);
    this.sample = options.sample ?? sampleVisibleText;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.checkpointMs = options.checkpointMs ?? ACTIVITY_CHECKPOINT_INTERVAL_MS;
  }

  private get document() { return this.options.document ?? globalThis.document; }
  private get window() { return this.options.window ?? globalThis.window; }

  /** Whether foreground time is currently being measured (diagnostics/tests). */
  get timing() { return this.clock.running; }

  setInputs(inputs: ActivityTrackerInputs) {
    this.inputs = inputs;
    this.evaluate();
  }

  /**
   * Installs page lifecycle listeners for a mounted reader. The returned
   * detach stops time with a checkpoint; a later attach (StrictMode remount)
   * starts a fresh baseline and cannot re-add the detached interval.
   */
  attach(): () => void {
    const doc = this.document;
    const win = this.window;
    const onVisibility = () => { this.guard(() => this.evaluate()); };
    const onPageHide = () => this.guard(() => {
      this.pageHidden = true;
      this.evaluate();
      this.inputs.sink?.flush({ keepalive: true });
    });
    const onPageShow = () => this.guard(() => { this.pageHidden = false; this.evaluate(); });
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('pageshow', onPageShow);
    // A (re)mounted reader is showing; a pagehide seen by an earlier mount is over.
    if (this.attachments === 0) this.pageHidden = false;
    this.attachments++;
    this.guard(() => this.evaluate());
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      this.attachments--;
      this.guard(() => {
        this.evaluate();
        if (this.attachments === 0) this.inputs.sink?.flush();
      });
    };
  }

  /** Ends the session (reader close/history exit): final checkpoint and delivery request. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.guard(() => {
      this.evaluate();
      this.pending = null;
      this.current?.unsubscribe();
      this.current = null;
      this.inputs.sink?.flush();
    });
  }

  /** Accepted-position observer; safe to call from the Controller's accept path. */
  readonly observeAccepted: AcceptedObserver = observation => {
    this.guard(() => this.accept(observation));
  };

  private guard(work: () => void) {
    try { work(); } catch { /* Statistics must never break reading. */ }
  }

  private accept(observation: AcceptedObservation) {
    if (this.closed) return;
    const { event } = observation;
    if (event.reason === 'snapshot') return;
    if (this.current?.observation.controller !== observation.controller) {
      this.current?.unsubscribe();
      const unsubscribe = observation.controller.subscribe(() => this.guard(() => this.evaluate()));
      this.current = { observation, unsubscribe };
    } else {
      this.current.observation = observation;
    }
    const atEnd = event.position.location.atEnd === true;
    if (!this.completed && qualifiesForCompletion({
      reason: event.reason,
      atEnd,
      previousAtEnd: this.previousAtEnd,
      hadSavedPosition: observation.hadSavedPosition,
      openedBefore: this.openedBefore,
    })) {
      this.completed = true;
      this.inputs.sink?.record([createCompletionEvent(this.bookId, this.source.wall())]);
    }
    this.previousAtEnd = atEnd;
    if (event.reason === 'opened') this.openedBefore = true;
    this.pending = observation;
    this.invalidateSample();
    this.evaluate();
  }

  private visible() {
    return !this.pageHidden && this.document.visibilityState !== 'hidden';
  }

  private timeEligible() {
    const current = this.current?.observation;
    if (this.closed || this.attachments === 0 || !current) return false;
    if (!this.inputs.contentReady || this.inputs.blockingPanel || !this.visible()) return false;
    const state = current.engine.state;
    return TIME_PHASES.has(current.controller.snapshot.phase) && state !== 'closed' && state !== 'failed' && state !== 'suspended';
  }

  private textEligible(observation: AcceptedObservation) {
    return this.timeEligible() && !this.inputs.imageViewerOpen
      && this.current?.observation.engine === observation.engine
      && observation.controller.snapshot.phase === 'idle'
      && observation.engine.state === 'ready';
  }

  private evaluate() {
    const timeEligible = this.timeEligible();
    if (timeEligible && !this.clock.running) {
      this.clock.start();
      // Each tick rechecks eligibility, so a missed lifecycle notification
      // cannot keep crediting time for more than one checkpoint period.
      this.checkpointTimer = setInterval(() => this.guard(() => {
        if (this.timeEligible()) this.checkpoint(false);
        else this.evaluate();
      }), this.checkpointMs);
    } else if (!timeEligible && this.clock.running) {
      this.checkpoint(true);
    } else if (!timeEligible && this.ledger.hasPending) {
      this.checkpoint(true);
    }
    const pending = this.pending;
    if (!pending || !this.textEligible(pending)) { this.invalidateSample(); return; }
    if (this.sampleTimer === null && !this.sampling) {
      const generation = this.generation;
      this.sampleTimer = setTimeout(() => {
        this.sampleTimer = null;
        void this.runSample(pending, generation);
      }, this.settleMs);
    }
  }

  private invalidateSample() {
    this.generation++;
    if (this.sampleTimer !== null) clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
  }

  private checkpoint(stop: boolean) {
    const span = stop ? this.clock.stop() : this.clock.checkpoint();
    if (stop && this.checkpointTimer !== null) { clearInterval(this.checkpointTimer); this.checkpointTimer = null; }
    const events = createActivityEvents(this.bookId, span ? splitAtLocalMidnight(span) : [], this.ledger.drain());
    if (events.length) this.inputs.sink?.record(events);
  }

  private async runSample(observation: AcceptedObservation, generation: number) {
    if (generation !== this.generation || this.pending !== observation) return;
    const { engine, foreground, event } = observation;
    const accepted = event.position;
    const isCurrent = () => generation === this.generation && this.pending === observation
      && this.textEligible(observation)
      && engine.stable?.cfi === accepted.cfi && engine.stable.layout === accepted.layout;
    let outcome: VisibleTextOutcome | null = null;
    this.sampling = true;
    try { outcome = await this.sample(engine.getContents(), { foreground, isCurrent }); } catch { outcome = null; } finally { this.sampling = false; }
    this.guard(() => {
      if (outcome?.kind === 'sampled' && this.pending === observation) {
        this.pending = null;
        const sink = this.inputs.sink;
        const sections = outcome.sections.filter(section => !sink?.isCoverageSuspended(this.bookId, section.sectionIndex, section.signature));
        if (sections.length) this.ledger.observe(sections, this.source.wall());
      } else if (outcome === null && this.pending === observation) {
        // Unexpected sampler failure: skip this page rather than retrying forever.
        this.pending = null;
      } else if (this.pending === observation && (engine.stable?.cfi !== accepted.cfi || engine.stable.layout !== accepted.layout)) {
        // The engine moved on without a new acceptance; wait for the next one.
        this.pending = null;
      }
      this.evaluate();
    });
  }
}

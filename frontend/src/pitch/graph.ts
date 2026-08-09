import type { PitchFrame } from './socket';
import { classifyGraphTraceColor, colorForMidi, type GraphTraceColor } from './graph-colors';
import { midiToNoteName } from './note-name';

export const GRAPH_MIDI_MIN = 36; // C2
export const GRAPH_MIDI_MAX = 84; // C6
const DEFAULT_VIEWPORT_SEMITONE_SPAN = 24;
const RECENTER_THRESHOLD_RATIO = 0.3;

/** Default tolerance for the target-note band (±50 cents = ±0.5 semitone). */
export const DEFAULT_BAND_CENTS_TOLERANCE = 50;

/**
 * Where "now" sits across the plot width, as a fraction from the left —
 * the "note highway" layout: sung history trails to the left of the
 * playhead, upcoming targets (see setTargets()) approach from the right.
 * A plain rolling graph (playheadRatio effectively 1, "now" at the right
 * edge) is what this used to be; timeToGraphX()'s playheadRatio param
 * defaults to 1 for that reason — old callers/tests are unaffected.
 */
const DEFAULT_PLAYHEAD_RATIO = 0.24;

const SCALE_BAR_WIDTH = 40;
const SCALE_LABEL_STEP_SEMITONES = 4;
const DOT_GRID_SPACING_X = 34;
const DOT_GRID_SPACING_Y = 26;
const DOT_GRID_RADIUS = 1.6;
const TRACE_LINE_WIDTH = 7;
const PILL_HEIGHT = 26;
const PUCK_OUTER_RADIUS = 11;
const PUCK_INNER_RADIUS = 6;
/** Puck hides itself if the most recent sample is older than this — no signal, no false "you're here". */
const PUCK_STALE_SEC = 0.5;

/* The "now" line through the puck. Solid and reasonably firm — it's the
   reference the singer reads arrival against — but still darker-on-light
   rather than an accent colour, so it never competes with the trace. */
const PLAYHEAD_LINE_COLOR = 'rgba(43, 36, 56, 0.45)';
const PLAYHEAD_LINE_WIDTH = 2;

export interface GraphTargetPill {
  midi: number;
  startMs: number;
  endMs: number;
  label?: string;
}

interface GraphSample {
  tSec: number;
  midi: number;
  expectedMidi: number | null;
  color: GraphTraceColor;
}

export interface PitchGraphOptions {
  windowSeconds?: number;
  backgroundColor?: string;
  /**
   * Half-width of the target-note band in cents (default 50).
   * The band spans [expectedMidi - tolerance/100, expectedMidi + tolerance/100]
   * in MIDI units, rendered as a filled semi-transparent rectangle.
   */
  bandCentsTolerance?: number;
}

interface GridLine {
  midi: number;
  isOctave: boolean;
  isBlackKey: boolean;
  label: string | null;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function buildPitchGraphAriaLabel(minMidi: number, maxMidi: number, windowSeconds: number): string {
  return `Real-time pitch graph showing your sung pitch (${midiToNoteName(minMidi)}–${midiToNoteName(maxMidi)}) over a ${windowSeconds}-second rolling window`;
}

function midiToScaleLabel(midi: number): string | null {
  const note = NOTE_NAMES[midi % 12];
  if (note.includes('#')) return null;
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

export function midiToGraphY(midi: number, height: number, minMidi = GRAPH_MIDI_MIN, maxMidi = GRAPH_MIDI_MAX): number {
  const clamped = Math.max(minMidi, Math.min(maxMidi, midi));
  const norm = (clamped - minMidi) / Math.max(1, maxMidi - minMidi);
  return height - (norm * height);
}

function frequencyToMidi(freq: number): number {
  return 69 + (12 * Math.log2(freq / 440));
}

/**
 * Maps a sample/target timestamp to an X position. `playheadRatio` (0-1,
 * default 1) is where "now" sits as a fraction of the width — the default
 * reproduces the original rolling-graph behavior (now pinned at the right
 * edge); PitchGraphCanvas itself always calls this with
 * DEFAULT_PLAYHEAD_RATIO internally so history trails left of a fixed
 * playhead and setTargets() pills can appear ahead of it to the right.
 */
export function timeToGraphX(sampleSec: number, nowSec: number, width: number, windowSec: number, playheadRatio = 1): number {
  const pxPerSec = width / windowSec;
  const playheadX = width * playheadRatio;
  const x = playheadX + ((sampleSec - nowSec) * pxPerSec);
  return Math.max(0, Math.min(width, x));
}

export function pruneSamples(samples: GraphSample[], cutoffSec: number): GraphSample[] {
  return samples.filter((sample) => sample.tSec >= cutoffSec);
}

export function buildSemitoneGrid(minMidi = GRAPH_MIDI_MIN, maxMidi = GRAPH_MIDI_MAX): GridLine[] {
  const lines: GridLine[] = [];
  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    const isOctave = midi % 12 === 0;
    const isBlackKey = NOTE_NAMES[midi % 12]?.includes('#') ?? false;
    lines.push({ midi, isOctave, isBlackKey, label: midiToScaleLabel(midi) });
  }
  return lines;
}

/**
 * Labels for the rainbow scale bar — unlike buildSemitoneGrid() (naturals
 * only, for the old plain grid), these use every note name including
 * sharps at a fixed semitone step, since the scale bar has room for only a
 * handful of labels regardless of which notes they land on.
 */
export function buildScaleBarLabels(
  minMidi: number,
  maxMidi: number,
  stepSemitones: number = SCALE_LABEL_STEP_SEMITONES,
): { midi: number; label: string }[] {
  const labels: { midi: number; label: string }[] = [];
  const start = Math.ceil(minMidi / stepSemitones) * stepSemitones;
  for (let midi = start; midi <= maxMidi; midi += stepSemitones) {
    labels.push({ midi, label: midiToNoteName(midi) });
  }
  return labels;
}

/**
 * Returns the canvas Y coordinates for the top and bottom edges of the
 * target-note band centred on `expectedMidi`.
 *
 * @param expectedMidi  MIDI note number for the expected pitch
 * @param centsTolerance  Half-width of the band in cents (e.g. 50)
 * @param height  Canvas height in pixels
 * @returns { topY, bottomY } — topY < bottomY (canvas Y increases downward)
 */
export function targetBandY(
  expectedMidi: number,
  centsTolerance: number,
  height: number,
  minMidi = GRAPH_MIDI_MIN,
  maxMidi = GRAPH_MIDI_MAX,
): { topY: number; bottomY: number } {
  const halfSemitones = centsTolerance / 100;
  const topY = midiToGraphY(expectedMidi + halfSemitones, height, minMidi, maxMidi);
  const bottomY = midiToGraphY(expectedMidi - halfSemitones, height, minMidi, maxMidi);
  return { topY, bottomY };
}

export function traceLineDash(color: GraphTraceColor): number[] {
  if (color === 'red') return [7, 4];
  if (color === 'grey') return [2, 4];
  return [];
}

export class PitchGraphCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: Required<PitchGraphOptions>;
  private samples: GraphSample[] = [];
  private targets: GraphTargetPill[] = [];
  private fullRangeMinMidi = GRAPH_MIDI_MIN;
  private fullRangeMaxMidi = GRAPH_MIDI_MAX;
  private viewRangeMinMidi = GRAPH_MIDI_MIN;
  private viewRangeMaxMidi = GRAPH_MIDI_MAX;

  constructor(container: HTMLElement, opts: PitchGraphOptions = {}) {
    this.opts = {
      windowSeconds: opts.windowSeconds ?? 10,
      backgroundColor: opts.backgroundColor ?? '#ffffff',
      bandCentsTolerance: opts.bandCentsTolerance ?? DEFAULT_BAND_CENTS_TOLERANCE,
    };
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', buildPitchGraphAriaLabel(this.fullRangeMinMidi, this.fullRangeMaxMidi, this.opts.windowSeconds));
    this.canvas.textContent = 'Real-time pitch graph';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    container.appendChild(this.canvas);
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  pushFrame(frame: PitchFrame, expectedMidi: number | null): void {
    this.samples.push({
      tSec: frame.t / 1000,
      midi: frame.midi,
      expectedMidi,
      color: classifyGraphTraceColor(frame.midi, expectedMidi),
    });
  }

  /**
   * Full set of exercise targets (including ones not reached yet) so the
   * "note highway" can render upcoming pills ahead of the playhead, not
   * just a band over targets a frame has already been pushed for.
   */
  setTargets(targets: GraphTargetPill[]): void {
    this.targets = targets;
  }

  tick(nowSec: number): void {
    const cutoffSec = nowSec - this.opts.windowSeconds;
    this.samples = pruneSamples(this.samples, cutoffSec);
    this.redraw(nowSec);
  }

  setWindowSeconds(sec: number): void {
    this.opts.windowSeconds = Math.max(2, Math.min(30, sec));
    this.updateAriaLabel();
  }

  setBandCentsTolerance(cents: number): void {
    this.opts.bandCentsTolerance = Math.max(10, Math.min(200, cents));
  }

  setRange(minFreq: number, maxFreq: number): void {
    const minMidi = frequencyToMidi(minFreq);
    const maxMidi = frequencyToMidi(maxFreq);
    if (!Number.isFinite(minMidi) || !Number.isFinite(maxMidi) || maxMidi <= minMidi) {
      this.resetRange();
      return;
    }
    this.fullRangeMinMidi = minMidi;
    this.fullRangeMaxMidi = maxMidi;
    this.resetViewport();
    this.updateAriaLabel();
  }

  resetRange(): void {
    this.fullRangeMinMidi = GRAPH_MIDI_MIN;
    this.fullRangeMaxMidi = GRAPH_MIDI_MAX;
    this.resetViewport();
    this.updateAriaLabel();
  }

  private updateAriaLabel(): void {
    this.canvas.setAttribute('aria-label', buildPitchGraphAriaLabel(this.fullRangeMinMidi, this.fullRangeMaxMidi, this.opts.windowSeconds));
  }

  autoCenterOnMidi(expectedMidi: number | null): void {
    if (expectedMidi === null) return;

    const fullSpan = this.fullRangeMaxMidi - this.fullRangeMinMidi;
    if (fullSpan <= DEFAULT_VIEWPORT_SEMITONE_SPAN) {
      this.resetViewport();
      return;
    }

    const currentCenter = (this.viewRangeMinMidi + this.viewRangeMaxMidi) / 2;
    const threshold = DEFAULT_VIEWPORT_SEMITONE_SPAN * RECENTER_THRESHOLD_RATIO;
    if (Math.abs(expectedMidi - currentCenter) <= threshold) return;

    const halfSpan = DEFAULT_VIEWPORT_SEMITONE_SPAN / 2;
    const unclampedMin = expectedMidi - halfSpan;
    const minMidi = Math.max(this.fullRangeMinMidi, Math.min(unclampedMin, this.fullRangeMaxMidi - DEFAULT_VIEWPORT_SEMITONE_SPAN));
    this.viewRangeMinMidi = minMidi;
    this.viewRangeMaxMidi = minMidi + DEFAULT_VIEWPORT_SEMITONE_SPAN;
  }

  clear(): void {
    this.samples = [];
    this.redraw(performance.now() / 1000);
  }

  destroy(): void {
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }

  private redraw(nowSec: number): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const plotLeft = Math.min(SCALE_BAR_WIDTH, width * 0.18);
    const plotWidth = Math.max(1, width - plotLeft);

    this.ctx.fillStyle = this.opts.backgroundColor;
    this.ctx.fillRect(0, 0, width, height);

    this.drawDotGrid(plotLeft, plotWidth, height);
    this.drawScaleBar(plotLeft, height);
    // Layer order (bottom -> top): dot grid -> scale bar -> playhead line ->
    // target pills -> sung trace -> puck, so the puck always reads as "on
    // top." The playhead line sits UNDER the pills so an arriving pill
    // visibly crosses it rather than being cut in half by it.
    this.drawPlayheadLine(plotLeft, plotWidth, height);
    this.drawTargetPills(nowSec, plotLeft, plotWidth, height);
    this.drawTrace(nowSec, plotLeft, plotWidth, height);
    this.drawPuck(nowSec, plotLeft, plotWidth, height);
  }

  /** Soft dotted background across the plot area — replaces solid gridlines. */
  private drawDotGrid(plotLeft: number, plotWidth: number, height: number): void {
    this.ctx.fillStyle = 'rgba(43, 36, 56, 0.12)';
    for (let y = DOT_GRID_SPACING_Y / 2; y < height; y += DOT_GRID_SPACING_Y) {
      for (let x = plotLeft + (DOT_GRID_SPACING_X / 2); x < plotLeft + plotWidth; x += DOT_GRID_SPACING_X) {
        this.ctx.beginPath();
        this.ctx.arc(x, y, DOT_GRID_RADIUS, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
  }

  /** Rainbow gradient bar mapping pitch height to color, with a few note-name labels. */
  private drawScaleBar(plotLeft: number, height: number): void {
    const barWidth = Math.max(0, plotLeft - 8);
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    const stops = 12;
    for (let i = 0; i <= stops; i += 1) {
      const t = i / stops;
      const midiAtStop = this.viewRangeMaxMidi - (t * (this.viewRangeMaxMidi - this.viewRangeMinMidi));
      gradient.addColorStop(t, colorForMidi(midiAtStop, this.viewRangeMinMidi, this.viewRangeMaxMidi, 68, 62));
    }
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.roundRect(4, 4, barWidth, Math.max(0, height - 8), 10);
    this.ctx.fill();

    const labels = buildScaleBarLabels(this.viewRangeMinMidi, this.viewRangeMaxMidi);
    this.ctx.font = '600 10px system-ui, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const { midi, label } of labels) {
      const y = midiToGraphY(midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      this.ctx.fillText(label, 4 + (barWidth / 2), y + 3);
    }
  }

  /**
   * The "now" line — a fixed vertical line through the puck, spanning the full
   * plot height.
   *
   * This is the arrival marker: target pills scroll toward it from the right,
   * and a note is due the instant its pill's left edge touches the line. That
   * makes the approach readable as a countdown ("the pill is two thirds of the
   * way there") instead of something the singer only notices once it has
   * already happened.
   *
   * It sits at the same X as the puck (DEFAULT_PLAYHEAD_RATIO) by
   * construction, so the puck always rides along it.
   */
  private drawPlayheadLine(plotLeft: number, plotWidth: number, height: number): void {
    const x = plotLeft + (plotWidth * DEFAULT_PLAYHEAD_RATIO);
    this.ctx.save();
    this.ctx.strokeStyle = PLAYHEAD_LINE_COLOR;
    this.ctx.lineWidth = PLAYHEAD_LINE_WIDTH;
    this.ctx.beginPath();
    this.ctx.moveTo(x, 0);
    this.ctx.lineTo(x, height);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /**
   * Upcoming/active exercise targets as pill badges — active (playhead is
   * inside its time window) in the app's "good" accent color, everything
   * else upcoming in a lighter accent. Targets fully outside the visible
   * time window are skipped rather than drawn as degenerate zero-width
   * pills at the edge.
   */
  private drawTargetPills(nowSec: number, plotLeft: number, plotWidth: number, height: number): void {
    if (this.targets.length === 0) return;

    const historySpanSec = this.opts.windowSeconds * DEFAULT_PLAYHEAD_RATIO;
    const futureSpanSec = this.opts.windowSeconds - historySpanSec;

    for (const target of this.targets) {
      const startSec = target.startMs / 1000;
      const endSec = target.endMs / 1000;
      if (endSec < nowSec - historySpanSec || startSec > nowSec + futureSpanSec) continue;

      const x1 = plotLeft + timeToGraphX(startSec, nowSec, plotWidth, this.opts.windowSeconds, DEFAULT_PLAYHEAD_RATIO);
      const x2 = plotLeft + timeToGraphX(endSec, nowSec, plotWidth, this.opts.windowSeconds, DEFAULT_PLAYHEAD_RATIO);
      const y = midiToGraphY(target.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      const isActive = nowSec >= startSec && nowSec < endSec;
      const pillWidth = Math.max(x2 - x1, PILL_HEIGHT);

      this.ctx.fillStyle = isActive ? 'rgba(52, 211, 153, 0.92)' : 'rgba(198, 233, 74, 0.85)';
      this.ctx.beginPath();
      this.ctx.roundRect(x1, y - (PILL_HEIGHT / 2), pillWidth, PILL_HEIGHT, PILL_HEIGHT / 2);
      this.ctx.fill();

      if (target.label) {
        this.ctx.fillStyle = isActive ? '#ffffff' : '#3a4a1a';
        this.ctx.font = '600 12px system-ui, sans-serif';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(target.label, x1 + 12, y + 4, Math.max(0, pillWidth - 20));
      }
    }
  }

  /** Thick, round-capped, pitch-height-colored trace — history only, never ahead of the playhead. */
  private drawTrace(nowSec: number, plotLeft: number, plotWidth: number, height: number): void {
    if (this.samples.length < 2) return;

    this.ctx.lineWidth = TRACE_LINE_WIDTH;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    for (let i = 1; i < this.samples.length; i += 1) {
      const prev = this.samples[i - 1];
      const next = this.samples[i];
      if (next.tSec > nowSec) break;

      const x1 = plotLeft + timeToGraphX(prev.tSec, nowSec, plotWidth, this.opts.windowSeconds, DEFAULT_PLAYHEAD_RATIO);
      const y1 = midiToGraphY(prev.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      const x2 = plotLeft + timeToGraphX(next.tSec, nowSec, plotWidth, this.opts.windowSeconds, DEFAULT_PLAYHEAD_RATIO);
      const y2 = midiToGraphY(next.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);

      this.ctx.strokeStyle = colorForMidi(next.midi, this.viewRangeMinMidi, this.viewRangeMaxMidi);
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    }
  }

  /**
   * Fixed-position "you are here" marker at the playhead. Its outer ring
   * reuses the frame's in-tune/out-of-tune classification (GraphSample.color,
   * still computed in pushFrame() for exactly this) — the one place accuracy
   * feedback survives the switch to pitch-height trace coloring.
   */
  private drawPuck(nowSec: number, plotLeft: number, plotWidth: number, height: number): void {
    if (this.samples.length === 0) return;
    const last = this.samples[this.samples.length - 1];
    if (nowSec - last.tSec > PUCK_STALE_SEC) return;

    const x = plotLeft + (plotWidth * DEFAULT_PLAYHEAD_RATIO);
    const y = midiToGraphY(last.midi, height, this.viewRangeMinMidi, this.viewRangeMaxMidi);

    this.ctx.beginPath();
    this.ctx.arc(x, y, PUCK_OUTER_RADIUS, 0, Math.PI * 2);
    this.ctx.fillStyle = this.puckRingColor(last.color);
    this.ctx.fill();

    this.ctx.beginPath();
    this.ctx.arc(x, y, PUCK_INNER_RADIUS, 0, Math.PI * 2);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fill();
  }

  private puckRingColor(color: GraphTraceColor): string {
    if (color === 'green') return '#1a8a63';
    if (color === 'red') return '#b91c1c';
    return '#2b2438';
  }

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw(performance.now() / 1000);
  };

  private resetViewport(): void {
    const fullSpan = this.fullRangeMaxMidi - this.fullRangeMinMidi;
    if (fullSpan <= DEFAULT_VIEWPORT_SEMITONE_SPAN) {
      this.viewRangeMinMidi = this.fullRangeMinMidi;
      this.viewRangeMaxMidi = this.fullRangeMaxMidi;
      return;
    }
    this.viewRangeMinMidi = this.fullRangeMinMidi;
    this.viewRangeMaxMidi = this.fullRangeMinMidi + DEFAULT_VIEWPORT_SEMITONE_SPAN;
  }
}

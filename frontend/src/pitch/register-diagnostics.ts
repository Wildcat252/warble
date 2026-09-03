/**
 * Phase 0 diagnostic buffer for vocal-register features.
 *
 * This exists to answer ONE question before any register UI is built: do the
 * acoustic features actually separate this singer's chest voice from their
 * head voice, on this microphone?
 *
 * Synthetic-tone tests prove the extractor recovers known harmonic ratios;
 * they prove nothing about a voice. Only real singing can answer that, so this
 * module captures a rolling window of live frames and can dump them as JSON
 * for offline comparison. Every threshold in the eventual classifier should be
 * derived from data captured here rather than guessed — which is also what
 * CLAUDE.md requires for any magic number.
 *
 * Deliberately NOT persisted: this is a measurement tool, not a feature, and
 * stale diagnostic data in localStorage would be a trap.
 */
import type { PitchFrame } from './socket';

/**
 * Rolling capacity. At ~21.5 frames/sec this is a little over 30 seconds —
 * long enough to hold a chest phrase and a head phrase in one buffer so they
 * can be compared directly, short enough not to grow without bound.
 */
export const DIAGNOSTIC_CAPACITY = 700;

export interface DiagnosticSample {
  tMs: number;
  midi: number;
  conf: number;
  h1h2: number;
  tilt: number;
  hfrac: number;
  nh: number;
  lvl: number;
}

export interface DiagnosticSummary {
  count: number;
  /** Median of each feature — median, not mean, because vibrato and octave errors produce outliers. */
  medianH1h2: number | null;
  medianTilt: number | null;
  medianMidi: number | null;
  /** Newest sample, for the live readout. */
  latest: DiagnosticSample | null;
}

const samples: DiagnosticSample[] = [];

/** True once any frame has arrived carrying features — i.e. the backend supports them. */
let sawFeatures = false;

export function recordDiagnosticFrame(frame: PitchFrame): void {
  if (!frame.features) return;
  sawFeatures = true;
  samples.push({
    tMs: frame.t,
    midi: frame.midi,
    conf: frame.conf,
    h1h2: frame.features.h1h2,
    tilt: frame.features.tilt,
    hfrac: frame.features.hfrac,
    nh: frame.features.nh,
    lvl: frame.features.lvl,
  });
  if (samples.length > DIAGNOSTIC_CAPACITY) {
    samples.splice(0, samples.length - DIAGNOSTIC_CAPACITY);
  }
}

export function backendSupportsRegisterFeatures(): boolean {
  return sawFeatures;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function diagnosticSummary(): DiagnosticSummary {
  return {
    count: samples.length,
    medianH1h2: median(samples.map((s) => s.h1h2)),
    medianTilt: median(samples.map((s) => s.tilt)),
    medianMidi: median(samples.map((s) => s.midi)),
    latest: samples.length > 0 ? samples[samples.length - 1] : null,
  };
}

/** Everything captured, as JSON, for offline analysis. */
export function diagnosticJson(): string {
  return JSON.stringify({ capturedAt: new Date().toISOString(), samples }, null, 2);
}

export function clearDiagnostics(): void {
  samples.length = 0;
}

/** Sample count currently held — exposed for tests and the readout. */
export function diagnosticCount(): number {
  return samples.length;
}

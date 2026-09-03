/**
 * Vocal-register classification: turns per-frame spectral features into a
 * chest↔head position and a label.
 *
 * Runs in the FRONTEND, not the backend, because classification needs the
 * singer's own calibration (which lives in browser storage) and because every
 * threshold here will be re-tuned against real singing — a vitest/HMR loop
 * rather than an audio-process restart.
 *
 * Two stages, deliberately separated:
 *   1. registerPosition() — pure, stateless, one frame in, one number out.
 *   2. RegisterSmoother   — temporal stabilisation, mirroring StableNoteDetector.
 * A per-frame reading at ~21fps is far too jittery to show directly; the
 * smoother is what makes it readable without making it laggy.
 */
import {
  expectedAt, extrapolationSemitones, modelSeparates, separationDb,
  EXTRAPOLATION_TOLERANCE_SEMITONES,
  type RegisterCalibration,
} from './register-calibration';
import type { RegisterFeatures } from './socket';

export type RegisterLabel = 'chest' | 'mix' | 'head';

/**
 * Mix band edges on the 0..1 chest→head continuum.
 *
 * THIS IS A UX CHOICE, NOT A SCIENTIFIC ONE. "Mix" is a pedagogical term for a
 * blend, not a distinct laryngeal configuration with a measurable boundary —
 * there is no ground truth to calibrate these against, and voice teachers
 * disagree about where mix begins.
 *
 * The reasoning that IS defensible: mix takes the middle 30%, narrower than an
 * even third, so the extremes — where the singer's own calibration sits and
 * the estimate is most trustworthy — get the larger share, and "mix" reads as
 * a genuine middle rather than the answer the classifier falls back to when
 * unsure.
 */
export const MIX_LOWER = 0.35;
export const MIX_UPPER = 0.65;

/** Extra distance a boundary must be crossed by to change the published label. */
export const LABEL_HYSTERESIS = 0.05;

/**
 * Window the smoother medians over, in wall-clock ms.
 *
 * ~8-9 frames at 21.5fps. Longer than StableNoteDetector's 320ms because
 * register genuinely changes more slowly than pitch, still under the ~500ms
 * where live feedback starts to feel laggy.
 */
export const SMOOTHING_WINDOW_MS = 400;

/** Frames required in the window before anything is published. */
export const MIN_FRAMES_IN_WINDOW = 4;

/**
 * How long a new label must hold before it replaces the shown one.
 *
 * The analogue of StableNoteDetector's hold, but longer: a flickering register
 * badge is more irritating than a flickering note readout, and nothing is
 * scored off it.
 */
export const LABEL_HOLD_MS = 250;

/** Frame quality gate — mirrors calibration's, so the same frames count in both. */
export const MIN_HARMONIC_FRACTION = 0.5;
export const MIN_HARMONICS = 4;

export function labelForPosition(position: number): RegisterLabel {
  if (position < MIX_LOWER) return 'chest';
  if (position > MIX_UPPER) return 'head';
  return 'mix';
}

/** True if a frame is worth classifying at all. */
export function isUsableFrame(features: RegisterFeatures): boolean {
  return features.hfrac >= MIN_HARMONIC_FRACTION && features.nh >= MIN_HARMONICS;
}

/**
 * Where one feature falls between its expected chest and head values at this
 * pitch. 0 = on the chest line, 1 = on the head line.
 *
 * Clamped WIDE rather than to [0,1]: a value beyond an anchor is real
 * information (more head-like than the calibration head take), and clipping it
 * before averaging would discard that. The final average is clamped properly.
 */
function featurePosition(
  model: Parameters<typeof expectedAt>[0],
  value: number,
  midi: number,
): number | null {
  if (!modelSeparates(model)) return null;
  const chest = expectedAt(model, midi, 'chest');
  const head = expectedAt(model, midi, 'head');
  const span = head - chest;
  if (Math.abs(span) < 1e-6) return null;
  const raw = (value - chest) / span;
  return Math.max(-0.5, Math.min(1.5, raw));
}

export interface RegisterReading {
  /** 0 = chest, 1 = head. */
  position: number;
  label: RegisterLabel;
  /**
   * False when the note sits well outside the calibrated pitch range, i.e. the
   * lines are being extrapolated into pitches the singer never demonstrated.
   * The reading is still shown, but should be presented as uncertain.
   */
  confident: boolean;
}

/**
 * Classifies one frame. Returns null when it cannot be done honestly: no
 * calibration, an unusable frame, or a feature whose calibration lines don't
 * separate.
 */
export function registerPosition(
  features: RegisterFeatures,
  midi: number,
  cal: RegisterCalibration | null,
): RegisterReading | null {
  if (!cal || !isUsableFrame(features)) return null;

  const parts: number[] = [];
  const h = featurePosition(cal.h1h2, features.h1h2, midi);
  if (h !== null) parts.push(h);
  const t = featurePosition(cal.tilt, features.tilt, midi);
  if (t !== null) parts.push(t);
  // If neither feature's lines separate there is nothing to say. Weighting is
  // renormalised implicitly by averaging whatever survived.
  if (parts.length === 0) return null;

  const position = Math.max(0, Math.min(1, parts.reduce((a, b) => a + b, 0) / parts.length));
  return {
    position,
    label: labelForPosition(position),
    confident: extrapolationSemitones(cal, midi) <= EXTRAPOLATION_TOLERANCE_SEMITONES,
  };
}

interface WindowEntry {
  tMs: number;
  position: number;
}

/**
 * Temporal stabiliser for the live badge.
 *
 * Mirrors StableNoteDetector's shape (wall-clock window, candidate, dwell,
 * reset) but medians a CONTINUOUS quantity instead of clustering a discrete
 * one. The window is keyed on frame timestamps rather than frame count because
 * sub-threshold frames create gaps in the stream — counting frames would let a
 * 2-second gap masquerade as a full window.
 */
export class RegisterSmoother {
  private window: WindowEntry[] = [];
  private published: RegisterLabel | null = null;
  private candidate: RegisterLabel | null = null;
  private candidateSinceMs = 0;

  push(tMs: number, position: number): { position: number; label: RegisterLabel | null } {
    this.window.push({ tMs, position });
    const cutoff = tMs - SMOOTHING_WINDOW_MS;
    while (this.window.length > 0 && this.window[0].tMs < cutoff) this.window.shift();

    if (this.window.length < MIN_FRAMES_IN_WINDOW) {
      return { position, label: this.published };
    }

    // Median, not mean: one bad frame must not drag the badge.
    const sorted = this.window.map((e) => e.position).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const smoothed = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    const next = this.labelWithHysteresis(smoothed);

    if (next !== this.candidate) {
      this.candidate = next;
      this.candidateSinceMs = tMs;
    }
    if (this.candidate !== this.published && tMs - this.candidateSinceMs >= LABEL_HOLD_MS) {
      this.published = this.candidate;
    }
    // First reading has nothing to dwell against, so publish it immediately —
    // otherwise the badge stays blank for the first quarter second of every note.
    if (this.published === null) this.published = next;

    return { position: smoothed, label: this.published };
  }

  /**
   * Leaving the current label requires crossing its boundary by an extra
   * margin; returning requires crossing back. Without this a value sitting
   * exactly on a boundary flips the badge every frame.
   */
  private labelWithHysteresis(position: number): RegisterLabel {
    const current = this.published;
    if (current === 'chest') return position >= MIX_LOWER + LABEL_HYSTERESIS ? labelForPosition(position) : 'chest';
    if (current === 'head') return position <= MIX_UPPER - LABEL_HYSTERESIS ? labelForPosition(position) : 'head';
    if (current === 'mix') {
      if (position < MIX_LOWER - LABEL_HYSTERESIS) return 'chest';
      if (position > MIX_UPPER + LABEL_HYSTERESIS) return 'head';
      return 'mix';
    }
    return labelForPosition(position);
  }

  reset(): void {
    this.window = [];
    this.published = null;
    this.candidate = null;
    this.candidateSinceMs = 0;
  }
}

/** Wording for the badge. Hedged on purpose — this is an estimate, not a measurement. */
export function describeRegister(label: RegisterLabel, confident: boolean): string {
  const name = label === 'chest' ? 'chest voice' : label === 'head' ? 'head voice' : 'mix';
  return confident ? `Sounds like ${name}` : `Maybe ${name}`;
}

/** Separation across both features, for Settings to report calibration quality. */
export function calibrationQuality(cal: RegisterCalibration): {
  h1h2Db: number; tiltDb: number; slopeEstimated: boolean;
} {
  return {
    h1h2Db: separationDb(cal.h1h2),
    tiltDb: separationDb(cal.tilt),
    slopeEstimated: cal.h1h2.slopeEstimated,
  };
}

/**
 * Per-singer calibration for vocal-register estimation.
 *
 * WHY CALIBRATION EXISTS
 * The acoustics are universal — chest voice always reads lower H1-H2 than head
 * voice, for every larynx. What is NOT universal is the absolute dB value,
 * which shifts with microphone response, gain, distance, room and individual
 * anatomy. Calibration measures where those points sit for THIS singer on THIS
 * microphone.
 *
 * THE MODEL: A LINE PER REGISTER, NOT A SCALAR ANCHOR
 * H1-H2 rises steeply with pitch as well as with register, so a single number
 * per register only classifies correctly near the pitch it was captured at.
 * Each register is therefore modelled as
 *
 *     H1-H2  =  intercept + slope * log2(f0)
 *
 * with a SHARED slope and separate intercepts (a within-group regression —
 * ANCOVA). The vertical gap between the two lines is the register effect,
 * pitch-independent by construction.
 *
 * This replaced an earlier design that captured both anchors on one note to
 * dodge the pitch confound. That design was wrong in practice: most singers
 * cannot produce both registers on a single pitch — that is precisely what a
 * passaggio is. Fitting the slope instead of avoiding it removes the
 * requirement entirely, and is better anyway: the lines predict expected chest
 * and head values at EVERY pitch, not just near a calibration note.
 *
 * Reference measurements from a real singer (headphones, sustained "ah" at
 * D#4/E4, five passages, 505 frames) that set the constants below:
 *     chest H1-H2  2.0 dB (IQR 2.2) · head 15.2 dB (IQR 3.0) · gap 13.2 dB
 *     a midpoint threshold classified 98.2% of individual frames correctly
 *     with no smoothing at all.
 * Those values sit inside the published modal-vs-falsetto range, which is
 * independent evidence the measurement reflects vocal-fold behaviour rather
 * than a microphone artefact.
 */
import { STORAGE_PREFIX } from '../branding';
import { loadBackendDeviceId } from '../services/audio-device';
import { midiToFrequency } from './note-name';
import type { RegisterFeatures } from './socket';

const CALIBRATION_KEY = `${STORAGE_PREFIX}.register-calibration.v2`;

export const CALIBRATION_SCHEMA_VERSION = 2;

/**
 * Minimum gap between the two fitted lines before calibration is trusted.
 *
 * Measured per-register IQRs were 2-3 dB, so lines closer than this are not
 * distinguishable from within-register variation. A real separation measured
 * 13.2 dB, so this rejects failures without being near a good capture. When
 * it isn't met the honest output is "we can't tell", not a confident label.
 */
export const MIN_SEPARATION_DB = 3;

/** Frames needed per register (~1.2s of usable audio at 21.5fps). */
export const MIN_REGISTER_FRAMES = 25;

/**
 * Pitch span a capture must cover before its slope is believed. Below this the
 * slope is unidentifiable and a shared default is used instead — the
 * separation is still valid, it just carries the pitch confound.
 */
export const MIN_PITCH_SPAN_SEMITONES = 3;

/**
 * Fallback slope when neither capture spans enough pitch to fit one.
 *
 * NOT measured from this codebase's data — published modal-voice H1-H2 pitch
 * dependence is roughly +2 to +4 dB/octave, and it varies by speaker and
 * vowel. It is only ever used when the singer sang both patterns on
 * effectively one note each, and `slopeEstimated` records that so the UI can
 * say the calibration is weaker.
 */
export const FALLBACK_SLOPE_DB_PER_OCTAVE = 3;

/** Onset discarded from each capture — attack and pitch-finding are register-ambiguous. */
export const ONSET_IGNORE_MS = 500;

/** Frame quality gate; below these the features are not meaningful. */
export const MIN_HARMONIC_FRACTION = 0.5;
export const MIN_HARMONICS = 4;

/**
 * How far outside the calibrated pitch range a note may sit before the reading
 * is flagged low-confidence. Beyond this the lines are being extrapolated into
 * pitches the singer never demonstrated, which is where this model is weakest.
 */
export const EXTRAPOLATION_TOLERANCE_SEMITONES = 7;

/** A fitted line per feature: shared slope, one intercept per register. */
export interface FeatureModel {
  slope: number;
  chestIntercept: number;
  headIntercept: number;
  /** False when the slope fell back to the default because no capture spanned enough pitch. */
  slopeEstimated: boolean;
}

export interface RegisterPitchRange {
  minMidi: number;
  maxMidi: number;
  medianMidi: number;
  frameCount: number;
}

export interface RegisterCalibration {
  version: number;
  /** Backend REGISTER_FEATURE_VERSION at capture — anchors are invalid if the DSP changed. */
  featureVersion: number;
  capturedAt: string;
  /** Calibration is microphone-specific; a different input device invalidates it. */
  deviceId: number | null;
  h1h2: FeatureModel;
  tilt: FeatureModel;
  chestRange: RegisterPitchRange;
  headRange: RegisterPitchRange;
}

export interface CalibrationSample {
  tMs: number;
  midi: number;
  features: RegisterFeatures;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** log2 of frequency — the x-axis the lines are fitted against. */
export function pitchAxis(midi: number): number {
  return Math.log2(midiToFrequency(midi));
}

export function isAcceptableCalibrationFrame(
  sample: CalibrationSample,
  phaseStartMs: number,
): boolean {
  if (sample.tMs - phaseStartMs < ONSET_IGNORE_MS) return false;
  const f = sample.features;
  return f.hfrac >= MIN_HARMONIC_FRACTION && f.nh >= MIN_HARMONICS;
}

/**
 * Within-group regression: one slope shared by both registers, one intercept
 * each.
 *
 * The shared slope is what makes the intercept difference meaningful — with
 * independent slopes the "gap" would depend on which pitch you evaluated it
 * at, which is the confound this exists to remove. Solving on pitch-centred
 * data within each group means group means cannot leak into the slope.
 */
function fitFeatureModel(
  chest: { x: number; y: number }[],
  head: { x: number; y: number }[],
): FeatureModel {
  const meanX = (s: { x: number }[]): number => s.reduce((a, p) => a + p.x, 0) / s.length;
  const meanY = (s: { y: number }[]): number => s.reduce((a, p) => a + p.y, 0) / s.length;

  const cx = meanX(chest); const cy = meanY(chest);
  const hx = meanX(head); const hy = meanY(head);

  let num = 0;
  let den = 0;
  for (const p of chest) { num += (p.x - cx) * (p.y - cy); den += (p.x - cx) ** 2; }
  for (const p of head) { num += (p.x - hx) * (p.y - hy); den += (p.x - hx) ** 2; }

  // den is the pooled within-group variance in pitch. Near zero means both
  // patterns were sung on effectively one note, so the slope carries no
  // information and must not be inferred from between-group differences.
  const spanX = MIN_PITCH_SPAN_SEMITONES / 12;
  const identifiable = den > spanX * spanX * Math.min(chest.length, head.length) * 0.25;

  const slope = identifiable ? num / den : FALLBACK_SLOPE_DB_PER_OCTAVE;
  return {
    slope,
    chestIntercept: cy - slope * cx,
    headIntercept: hy - slope * hx,
    slopeEstimated: identifiable,
  };
}

function pitchRange(samples: CalibrationSample[]): RegisterPitchRange {
  const midis = samples.map((s) => s.midi);
  return {
    minMidi: Math.min(...midis),
    maxMidi: Math.max(...midis),
    medianMidi: median(midis),
    frameCount: samples.length,
  };
}

export interface FitResult {
  calibration: Omit<RegisterCalibration, 'version' | 'featureVersion' | 'capturedAt' | 'deviceId'>;
  /** Gap between the fitted lines, in dB. The headline number. */
  separationDb: number;
}

/** Builds the model, or null when either capture is too thin to fit. */
export function fitCalibration(
  chestSamples: CalibrationSample[],
  headSamples: CalibrationSample[],
): FitResult | null {
  if (chestSamples.length < MIN_REGISTER_FRAMES) return null;
  if (headSamples.length < MIN_REGISTER_FRAMES) return null;

  const pts = (s: CalibrationSample[], pick: (f: RegisterFeatures) => number) =>
    s.map((x) => ({ x: pitchAxis(x.midi), y: pick(x.features) }));

  const h1h2 = fitFeatureModel(pts(chestSamples, (f) => f.h1h2), pts(headSamples, (f) => f.h1h2));
  const tilt = fitFeatureModel(pts(chestSamples, (f) => f.tilt), pts(headSamples, (f) => f.tilt));

  return {
    calibration: {
      h1h2,
      tilt,
      chestRange: pitchRange(chestSamples),
      headRange: pitchRange(headSamples),
    },
    separationDb: h1h2.headIntercept - h1h2.chestIntercept,
  };
}

/** Gap between the lines for a feature. Constant across pitch — that is the point of the shared slope. */
export function separationDb(model: FeatureModel): number {
  return model.headIntercept - model.chestIntercept;
}

/**
 * True when the lines are far enough apart to classify against.
 *
 * A NEGATIVE separation fails too, not just a small one: it means the takes
 * were swapped or one was mis-produced, and using them would invert every
 * label.
 */
export function modelSeparates(model: FeatureModel): boolean {
  return separationDb(model) >= MIN_SEPARATION_DB;
}

/** Expected value of a feature for `register` at `midi`, per the fitted lines. */
export function expectedAt(model: FeatureModel, midi: number, register: 'chest' | 'head'): number {
  const intercept = register === 'chest' ? model.chestIntercept : model.headIntercept;
  return intercept + model.slope * pitchAxis(midi);
}

/** How far outside the calibrated pitches a note sits, in semitones (0 when inside). */
export function extrapolationSemitones(cal: RegisterCalibration, midi: number): number {
  const lo = Math.min(cal.chestRange.minMidi, cal.headRange.minMidi);
  const hi = Math.max(cal.chestRange.maxMidi, cal.headRange.maxMidi);
  if (midi < lo) return lo - midi;
  if (midi > hi) return midi - hi;
  return 0;
}

function isFiniteModel(value: unknown): value is FeatureModel {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<FeatureModel>;
  return [m.slope, m.chestIntercept, m.headIntercept].every(
    (n) => typeof n === 'number' && Number.isFinite(n),
  );
}

function isFiniteRange(value: unknown): value is RegisterPitchRange {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<RegisterPitchRange>;
  return [r.minMidi, r.maxMidi, r.medianMidi].every(
    (n) => typeof n === 'number' && Number.isFinite(n),
  );
}

/**
 * Reads stored calibration, returning null unless it is usable RIGHT NOW.
 *
 * Deliberately strict — a wrong feature version (the DSP changed underneath
 * the fit) or lines that don't separate both yield null, and null means the UI
 * shows nothing rather than something confidently wrong.
 */
export function loadRegisterCalibration(featureVersion?: number): RegisterCalibration | null {
  const cal = loadRawCalibration();
  if (!cal) return null;
  if (featureVersion !== undefined && cal.featureVersion !== featureVersion) return null;
  if (!modelSeparates(cal.h1h2)) return null;
  return cal;
}

/** Reads the record without the usability checks — so Settings can explain WHY it's unusable. */
export function loadRawCalibration(): RegisterCalibration | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const cal = parsed as Partial<RegisterCalibration>;
    if (cal.version !== CALIBRATION_SCHEMA_VERSION) return null;
    if (!isFiniteModel(cal.h1h2) || !isFiniteModel(cal.tilt)) return null;
    if (!isFiniteRange(cal.chestRange) || !isFiniteRange(cal.headRange)) return null;
    return cal as RegisterCalibration;
  } catch {
    return null;
  }
}

export function persistRegisterCalibration(
  fit: FitResult,
  featureVersion: number,
): RegisterCalibration | null {
  const calibration: RegisterCalibration = {
    version: CALIBRATION_SCHEMA_VERSION,
    featureVersion,
    capturedAt: new Date().toISOString(),
    deviceId: loadBackendDeviceId(),
    ...fit.calibration,
  };
  const storage = getStorage();
  if (!storage) return null;
  try {
    storage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
    return calibration;
  } catch {
    return null;
  }
}

export function clearRegisterCalibration(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(CALIBRATION_KEY);
  } catch {
    // Non-critical: the classifier falls back to showing nothing.
  }
}

/** Plain-language summary of a separation, for the reveal screen. */
export function describeSeparation(sep: number): string {
  if (sep < MIN_SEPARATION_DB) return 'too close to tell apart — the two takes measured almost the same';
  if (sep < 6) return 'a usable but narrow separation';
  if (sep < 12) return 'a clear separation';
  return 'a very clear separation';
}

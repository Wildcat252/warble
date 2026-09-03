import { beforeEach, describe, expect, it } from 'vitest';
import {
  fitCalibration, isAcceptableCalibrationFrame, persistRegisterCalibration,
  loadRegisterCalibration, loadRawCalibration, clearRegisterCalibration,
  separationDb, modelSeparates, expectedAt, extrapolationSemitones, describeSeparation,
  MIN_REGISTER_FRAMES, MIN_SEPARATION_DB, ONSET_IGNORE_MS, FALLBACK_SLOPE_DB_PER_OCTAVE,
  type CalibrationSample,
} from './register-calibration';

/**
 * Builds a capture spanning `midis`, with H1-H2 following
 * `intercept + slope*log2(f0)` exactly — so a correct fit must recover both.
 */
function capture(
  midis: number[],
  intercept: number,
  slope: number,
  perNote = 8,
): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  let t = 1000;
  for (const midi of midis) {
    const f0 = 440 * 2 ** ((midi - 69) / 12);
    const h1h2 = intercept + slope * Math.log2(f0);
    for (let i = 0; i < perNote; i += 1) {
      out.push({
        tMs: t, midi,
        features: { h1h2, tilt: h1h2 * 0.4, hfrac: 0.99, nh: 8, lvl: -25 },
      });
      t += 46;
    }
  }
  return out;
}

const LOW = [50, 52, 54, 55, 57];   // chest, low in the range
const HIGH = [64, 66, 67, 69, 71];  // head, high in the range — no overlap

beforeEach(() => {
  window.localStorage.clear();
});

describe('isAcceptableCalibrationFrame', () => {
  const s = (over: Partial<CalibrationSample> = {}): CalibrationSample => ({
    tMs: 5000, midi: 60,
    features: { h1h2: 5, tilt: 2, hfrac: 0.99, nh: 8, lvl: -25 },
    ...over,
  });

  it('rejects the onset, where the note is still being found', () => {
    expect(isAcceptableCalibrationFrame(s({ tMs: 1000 }), 900)).toBe(false);
    expect(isAcceptableCalibrationFrame(s({ tMs: 1000 }), 100)).toBe(true);
  });

  it('accepts exactly at the onset boundary', () => {
    expect(isAcceptableCalibrationFrame(s({ tMs: 1000 }), 1000 - ONSET_IGNORE_MS)).toBe(true);
  });

  it('does NOT constrain pitch — the pattern is meant to move', () => {
    // This is the behaviour change from the old single-note design.
    expect(isAcceptableCalibrationFrame(s({ midi: 48 }), 0)).toBe(true);
    expect(isAcceptableCalibrationFrame(s({ midi: 72 }), 0)).toBe(true);
  });

  it('rejects breathy or thin frames', () => {
    const breathy = s(); breathy.features = { ...breathy.features, hfrac: 0.3 };
    expect(isAcceptableCalibrationFrame(breathy, 0)).toBe(false);
    const thin = s(); thin.features = { ...thin.features, nh: 2 };
    expect(isAcceptableCalibrationFrame(thin, 0)).toBe(false);
  });
});

describe('fitCalibration', () => {
  it('recovers a known slope and separation from non-overlapping patterns', () => {
    // The whole point: chest low, head high, no shared pitch.
    const fit = fitCalibration(capture(LOW, 0, 6), capture(HIGH, 13, 6))!;
    expect(fit.calibration.h1h2.slope).toBeCloseTo(6, 1);
    expect(fit.separationDb).toBeCloseTo(13, 1);
    expect(fit.calibration.h1h2.slopeEstimated).toBe(true);
  });

  it('separates register from pitch — a steeper slope does not inflate the gap', () => {
    // Raw group means differ hugely here because the patterns sit an octave
    // apart; only a correct fit reports the true 13dB register effect.
    const steep = fitCalibration(capture(LOW, 0, 20), capture(HIGH, 13, 20))!;
    expect(steep.separationDb).toBeCloseTo(13, 1);
    expect(steep.calibration.h1h2.slope).toBeCloseTo(20, 1);
  });

  it('refuses when either capture is too thin', () => {
    expect(fitCalibration(capture([50], 0, 6, 3), capture(HIGH, 13, 6))).toBeNull();
    expect(fitCalibration(capture(LOW, 0, 6), capture([64], 13, 6, 3))).toBeNull();
  });

  it('falls back to a default slope when both patterns sat on one pitch', () => {
    const fit = fitCalibration(
      capture([55], 0, 6, MIN_REGISTER_FRAMES + 5),
      capture([55], 13, 6, MIN_REGISTER_FRAMES + 5),
    )!;
    expect(fit.calibration.h1h2.slopeEstimated).toBe(false);
    expect(fit.calibration.h1h2.slope).toBe(FALLBACK_SLOPE_DB_PER_OCTAVE);
    // Separation is still right — at one shared pitch there is no confound.
    expect(fit.separationDb).toBeCloseTo(13, 1);
  });

  it('records the pitch range each register was captured over', () => {
    const fit = fitCalibration(capture(LOW, 0, 6), capture(HIGH, 13, 6))!;
    expect(fit.calibration.chestRange.minMidi).toBe(50);
    expect(fit.calibration.chestRange.maxMidi).toBe(57);
    expect(fit.calibration.headRange.minMidi).toBe(64);
  });
});

describe('the fitted lines', () => {
  const fit = fitCalibration(capture(LOW, 0, 6), capture(HIGH, 13, 6))!;
  const model = fit.calibration.h1h2;

  it('predicts different values at different pitches, same gap', () => {
    const gapLow = expectedAt(model, 55, 'head') - expectedAt(model, 55, 'chest');
    const gapHigh = expectedAt(model, 67, 'head') - expectedAt(model, 67, 'chest');
    expect(gapLow).toBeCloseTo(gapHigh, 4);
    // ...and the absolute values do move with pitch, which is the point.
    expect(expectedAt(model, 67, 'chest')).toBeGreaterThan(expectedAt(model, 55, 'chest'));
  });

  it('accepts a real separation and rejects a vanishing one', () => {
    expect(modelSeparates(model)).toBe(true);
    const flat = fitCalibration(capture(LOW, 0, 6), capture(HIGH, 0, 6))!;
    expect(modelSeparates(flat.calibration.h1h2)).toBe(false);
  });

  it('rejects a NEGATIVE separation — swapped or mis-produced takes', () => {
    // Using these would invert every label, worse than refusing.
    const swapped = fitCalibration(capture(LOW, 13, 6), capture(HIGH, 0, 6))!;
    expect(separationDb(swapped.calibration.h1h2)).toBeLessThan(0);
    expect(modelSeparates(swapped.calibration.h1h2)).toBe(false);
  });

  it('measures how far a note sits outside the calibrated pitches', () => {
    const cal = persistRegisterCalibration(fit, 1)!;
    expect(extrapolationSemitones(cal, 60)).toBe(0);   // between the two patterns
    expect(extrapolationSemitones(cal, 45)).toBe(5);   // 5 below the lowest
    expect(extrapolationSemitones(cal, 75)).toBe(4);   // 4 above the highest
  });
});

describe('persistence', () => {
  const fit = fitCalibration(capture(LOW, 0, 6), capture(HIGH, 13, 6))!;

  it('round-trips', () => {
    expect(persistRegisterCalibration(fit, 1)).not.toBeNull();
    expect(loadRegisterCalibration(1)?.h1h2.slope).toBeCloseTo(6, 1);
  });

  it('returns null when nothing is stored', () => {
    expect(loadRegisterCalibration(1)).toBeNull();
  });

  it('refuses a calibration captured under a different DSP version', () => {
    persistRegisterCalibration(fit, 1);
    expect(loadRegisterCalibration(2)).toBeNull();
    expect(loadRegisterCalibration(1)).not.toBeNull();
  });

  it('refuses to load lines that do not separate', () => {
    const flat = fitCalibration(capture(LOW, 0, 6), capture(HIGH, 0, 6))!;
    persistRegisterCalibration(flat, 1);
    expect(loadRegisterCalibration(1)).toBeNull();
    // ...but Settings can still read it back to explain why.
    expect(loadRawCalibration()).not.toBeNull();
  });

  it('records the microphone it was captured on', () => {
    window.localStorage.setItem('warble.backend-device-id.v1', '3');
    expect(persistRegisterCalibration(fit, 1)?.deviceId).toBe(3);
  });

  it('survives corrupt stored JSON', () => {
    window.localStorage.setItem('warble.register-calibration.v2', '{not json');
    expect(loadRegisterCalibration(1)).toBeNull();
    expect(loadRawCalibration()).toBeNull();
  });

  it('ignores a record from the older scalar-anchor schema', () => {
    window.localStorage.setItem('warble.register-calibration.v2', JSON.stringify({
      version: 1, chest: { h1h2Db: 2 }, head: { h1h2Db: 15 },
    }));
    expect(loadRawCalibration()).toBeNull();
  });

  it('clears', () => {
    persistRegisterCalibration(fit, 1);
    clearRegisterCalibration();
    expect(loadRegisterCalibration(1)).toBeNull();
  });
});

describe('describeSeparation', () => {
  it('escalates its wording with the size of the gap', () => {
    expect(describeSeparation(MIN_SEPARATION_DB - 1)).toContain('too close');
    expect(describeSeparation(4)).toContain('narrow');
    expect(describeSeparation(8)).toContain('clear');
    expect(describeSeparation(13.2)).toContain('very clear'); // the real measured value
  });
});

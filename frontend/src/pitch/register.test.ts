import { describe, expect, it } from 'vitest';
import {
  registerPosition, labelForPosition, isUsableFrame, describeRegister,
  RegisterSmoother, calibrationQuality,
  MIX_LOWER, MIX_UPPER, LABEL_HOLD_MS, SMOOTHING_WINDOW_MS, MIN_FRAMES_IN_WINDOW,
} from './register';
import type { RegisterCalibration } from './register-calibration';
import type { RegisterFeatures } from './socket';

/**
 * A calibration matching the real measured singer: chest ~2dB, head ~15dB at
 * D#4 (midi 63), with a modest pitch slope.
 */
function calibration(over: Partial<RegisterCalibration> = {}): RegisterCalibration {
  const axis = Math.log2(440 * 2 ** ((63 - 69) / 12));
  const slope = 6;
  return {
    version: 2, featureVersion: 1, capturedAt: '', deviceId: null,
    h1h2: {
      slope,
      chestIntercept: 2 - slope * axis,
      headIntercept: 15.2 - slope * axis,
      slopeEstimated: true,
    },
    tilt: {
      slope,
      chestIntercept: 15.2 - slope * axis,
      headIntercept: 20.4 - slope * axis,
      slopeEstimated: true,
    },
    chestRange: { minMidi: 50, maxMidi: 57, medianMidi: 54, frameCount: 40 },
    headRange: { minMidi: 64, maxMidi: 71, medianMidi: 67, frameCount: 40 },
    ...over,
  };
}

function features(h1h2: number, over: Partial<RegisterFeatures> = {}): RegisterFeatures {
  return { h1h2, tilt: 18, hfrac: 0.99, nh: 8, lvl: -25, ...over };
}

describe('labelForPosition', () => {
  it('splits the continuum into chest / mix / head', () => {
    expect(labelForPosition(0)).toBe('chest');
    expect(labelForPosition(0.5)).toBe('mix');
    expect(labelForPosition(1)).toBe('head');
  });

  it('puts the boundaries themselves in mix', () => {
    expect(labelForPosition(MIX_LOWER)).toBe('mix');
    expect(labelForPosition(MIX_UPPER)).toBe('mix');
  });
});

describe('registerPosition', () => {
  const cal = calibration();

  it('maps the measured chest value near 0 and head near 1', () => {
    // The real singer's own numbers at the pitch they were measured at.
    expect(registerPosition(features(2, { tilt: 15.2 }), 63, cal)!.position).toBeCloseTo(0, 1);
    expect(registerPosition(features(15.2, { tilt: 20.4 }), 63, cal)!.position).toBeCloseTo(1, 1);
  });

  it('is monotonic — a more fundamental-dominated frame reads more head-like', () => {
    const p = [2, 6, 10, 15].map((h) => registerPosition(features(h), 63, cal)!.position);
    expect(p).toEqual([...p].sort((a, b) => a - b));
  });

  it('accounts for pitch — the SAME raw value means different things at different pitches', () => {
    // This is what the line model buys: 10dB is head-ish down low, chest-ish up high.
    const low = registerPosition(features(10), 55, cal)!.position;
    const high = registerPosition(features(10), 71, cal)!.position;
    expect(low).toBeGreaterThan(high);
  });

  it('returns null without calibration', () => {
    expect(registerPosition(features(10), 63, null)).toBeNull();
  });

  it('returns null for a breathy or thin frame', () => {
    expect(registerPosition(features(10, { hfrac: 0.2 }), 63, cal)).toBeNull();
    expect(registerPosition(features(10, { nh: 2 }), 63, cal)).toBeNull();
  });

  it('returns null when neither feature has separating lines', () => {
    const flat = calibration({
      h1h2: { slope: 0, chestIntercept: 5, headIntercept: 5, slopeEstimated: true },
      tilt: { slope: 0, chestIntercept: 5, headIntercept: 5, slopeEstimated: true },
    });
    expect(registerPosition(features(10), 63, flat)).toBeNull();
  });

  it('still classifies when only ONE feature separates', () => {
    const halfFlat = calibration({
      tilt: { slope: 0, chestIntercept: 5, headIntercept: 5, slopeEstimated: true },
    });
    expect(registerPosition(features(15.2), 63, halfFlat)!.position).toBeGreaterThan(0.8);
  });

  it('clamps the reported position to 0..1 even for values beyond the anchors', () => {
    // Both features must be driven past their anchors — the position is their
    // average, so leaving one mid-range correctly lands mid-range.
    expect(registerPosition(features(-30, { tilt: -10 }), 63, cal)!.position).toBe(0);
    expect(registerPosition(features(60, { tilt: 60 }), 63, cal)!.position).toBe(1);
  });

  it('flags low confidence far outside the calibrated pitches', () => {
    expect(registerPosition(features(10), 60, cal)!.confident).toBe(true);
    expect(registerPosition(features(10), 40, cal)!.confident).toBe(false);
    expect(registerPosition(features(10), 85, cal)!.confident).toBe(false);
  });
});

describe('RegisterSmoother', () => {
  /** Feeds `n` frames at ~21.5fps from `startMs`. */
  function feed(s: RegisterSmoother, positions: number[], startMs = 0): { position: number; label: string | null } {
    let out = { position: 0, label: null as string | null };
    positions.forEach((p, i) => { out = s.push(startMs + i * 46, p); });
    return out;
  }

  it('publishes nothing until the window has enough frames', () => {
    const s = new RegisterSmoother();
    const early = feed(s, Array(MIN_FRAMES_IN_WINDOW - 1).fill(0.1));
    expect(early.label).toBeNull();
  });

  it('settles on a steady value', () => {
    const s = new RegisterSmoother();
    expect(feed(s, Array(20).fill(0.1)).label).toBe('chest');
  });

  it('a single outlier frame never flips the label', () => {
    const s = new RegisterSmoother();
    feed(s, Array(20).fill(0.1));
    // One wild frame in the middle of a chest passage.
    const after = s.push(20 * 46, 0.95);
    expect(after.label).toBe('chest');
  });

  it('a sustained change does flip, after the dwell', () => {
    const s = new RegisterSmoother();
    feed(s, Array(20).fill(0.1));
    // Long enough to fill the window AND satisfy LABEL_HOLD_MS.
    const frames = Math.ceil((SMOOTHING_WINDOW_MS + LABEL_HOLD_MS) / 46) + 4;
    const after = feed(s, Array(frames).fill(0.95), 20 * 46);
    expect(after.label).toBe('head');
  });

  it('a value oscillating ON a boundary produces at most one label change', () => {
    // The test that actually proves "doesn't flicker".
    const s = new RegisterSmoother();
    const labels: (string | null)[] = [];
    for (let i = 0; i < 60; i += 1) {
      labels.push(s.push(i * 46, i % 2 === 0 ? MIX_LOWER - 0.01 : MIX_LOWER + 0.01).label);
    }
    const changes = labels.filter((l, i) => i > 0 && l !== labels[i - 1]).length;
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('a gap in frame timestamps does not count as elapsed dwell', () => {
    // Window is wall-clock, so a 5-second gap must not fake a full window.
    const s = new RegisterSmoother();
    feed(s, Array(20).fill(0.1));
    const afterGap = s.push(20 * 46 + 5000, 0.95);
    expect(afterGap.label).toBe('chest');
  });

  it('reset clears the published label', () => {
    const s = new RegisterSmoother();
    feed(s, Array(20).fill(0.1));
    s.reset();
    expect(s.push(0, 0.9).label).toBeNull();
  });
});

describe('presentation', () => {
  it('hedges the wording — this is an estimate, not a measurement', () => {
    expect(describeRegister('chest', true)).toBe('Sounds like chest voice');
    expect(describeRegister('mix', false)).toBe('Maybe mix');
  });

  it('reports calibration quality for Settings', () => {
    const q = calibrationQuality(calibration());
    expect(q.h1h2Db).toBeCloseTo(13.2, 1);
    expect(q.tiltDb).toBeCloseTo(5.2, 1);
    expect(q.slopeEstimated).toBe(true);
  });
});

describe('isUsableFrame', () => {
  it('gates on harmonic content, not loudness', () => {
    expect(isUsableFrame(features(5, { lvl: -60 }))).toBe(true);
    expect(isUsableFrame(features(5, { hfrac: 0.2 }))).toBe(false);
  });
});

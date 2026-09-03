import { describe, expect, it } from 'vitest';
import { SETTLE_MS, scoreContinuousCents, scoreStableHold } from './scoring';
import type { ExerciseTargetNote } from './types';
import type { StableNoteState } from '../pitch/stable-note';

describe('scoreContinuousCents', () => {
  // A 1s target starting at 0. Frames are placed past SETTLE_MS unless a test
  // is specifically about the settle period.
  const target = (startMs = 0, endMs = 1000, midi = 60): ExerciseTargetNote => ({ midi, startMs, endMs });
  const after = (midi: number, conf: number, t = SETTLE_MS + 50) => ({ t, midi, conf });

  it('misses when there are no confident frames', () => {
    const result = scoreContinuousCents([after(60, 0.1)], target());
    expect(result.hit).toBe(false);
    expect(result.avgAbsCents).toBe(Infinity);
  });

  it('excludes low-confidence frames from the average', () => {
    const result = scoreContinuousCents(
      [
        after(60, 0.9), // confident, on pitch
        after(65, 0.1), // unconfident, wildly off — must be excluded
      ],
      target(),
    );
    expect(result.avgAbsCents).toBeCloseTo(0, 5);
    expect(result.hit).toBe(true);
  });

  it('averages absolute cents across confident frames', () => {
    const result = scoreContinuousCents(
      [
        after(60.2, 0.9), // +20 cents
        after(59.9, 0.9), // -10 cents
      ],
      target(),
    );
    expect(result.avgAbsCents).toBeCloseTo(15, 5);
    expect(result.hit).toBe(true);
  });

  it('misses when the average is beyond the green threshold', () => {
    const result = scoreContinuousCents([after(61, 0.9)], target()); // 100 cents off
    expect(result.avgAbsCents).toBeCloseTo(100, 5);
    expect(result.hit).toBe(false);
  });

  describe('settle period', () => {
    it('ignores the travel to the note, scoring only what was held', () => {
      // Wildly off while arriving, dead on once there. Averaging the whole
      // window would read 250 cents and miss; only the held part counts.
      const result = scoreContinuousCents(
        [
          { t: 0, midi: 55, conf: 0.9 },
          { t: 100, midi: 57, conf: 0.9 },
          { t: 200, midi: 59, conf: 0.9 },
          after(60, 0.9, 300),
          after(60, 0.9, 500),
        ],
        target(),
      );
      expect(result.avgAbsCents).toBeCloseTo(0, 5);
      expect(result.hit).toBe(true);
    });

    it('still fails a singer who is off pitch for the whole held part', () => {
      // The settle period must not become a way to pass by singing badly.
      const result = scoreContinuousCents(
        [after(60.8, 0.9, 300), after(60.8, 0.9, 600), after(60.8, 0.9, 900)],
        target(),
      );
      expect(result.avgAbsCents).toBeCloseTo(80, 5);
      expect(result.hit).toBe(false);
    });

    it('is measured from the target start, not from zero', () => {
      const late = target(5000, 6000);
      const result = scoreContinuousCents(
        [
          { t: 5000, midi: 55, conf: 0.9 },  // arriving — inside the settle
          { t: 5300, midi: 60, conf: 0.9 },  // held
        ],
        late,
      );
      expect(result.avgAbsCents).toBeCloseTo(0, 5);
    });

    it('never swallows more than half a short target', () => {
      // A 200ms target: settle is capped at 100ms, so the frame at 150ms counts.
      const short = target(0, 200);
      const result = scoreContinuousCents(
        [{ t: 0, midi: 55, conf: 0.9 }, { t: 150, midi: 60, conf: 0.9 }],
        short,
      );
      expect(result.avgAbsCents).toBeCloseTo(0, 5);
    });

    it('falls back to the early frames when nothing was sung after settling', () => {
      // Singer sounded only at the very start. Scoring nothing would be a
      // guaranteed miss for frames we did hear.
      const result = scoreContinuousCents([{ t: 10, midi: 60, conf: 0.9 }], target());
      expect(result.avgAbsCents).toBeCloseTo(0, 5);
      expect(result.hit).toBe(true);
    });
  });
});

function stateAt(stableMidi: number | null): StableNoteState {
  return { rawMidi: stableMidi ?? 0, stableMidi };
}

describe('scoreStableHold', () => {
  it('misses when no state ever reports a stable pitch', () => {
    const states = [stateAt(null), stateAt(null)];
    expect(scoreStableHold(states, 60).hit).toBe(false);
  });

  it('misses when the only stable pitch is outside tolerance', () => {
    const states = [stateAt(61)]; // 100 cents off, default tolerance is 50
    const result = scoreStableHold(states, 60);
    expect(result.hit).toBe(false);
    expect(result.achievedMidi).toBeNull();
  });

  it('hits and reports the achieved pitch once a stable state lands within tolerance', () => {
    const states = [stateAt(null), stateAt(61), stateAt(60.1)];
    const result = scoreStableHold(states, 60);
    expect(result.hit).toBe(true);
    expect(result.achievedMidi).toBe(60.1);
  });

  it('respects a custom tolerance', () => {
    const states = [stateAt(60.6)]; // 60 cents off
    expect(scoreStableHold(states, 60, 50).hit).toBe(false);
    expect(scoreStableHold(states, 60, 75).hit).toBe(true);
  });
});

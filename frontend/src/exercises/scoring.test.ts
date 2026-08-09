import { describe, expect, it } from 'vitest';
import { scoreContinuousCents, scoreStableHold } from './scoring';
import type { StableNoteState } from '../pitch/stable-note';

describe('scoreContinuousCents', () => {
  it('misses when there are no confident frames', () => {
    const result = scoreContinuousCents([{ midi: 60, conf: 0.1 }], 60);
    expect(result.hit).toBe(false);
    expect(result.avgAbsCents).toBe(Infinity);
  });

  it('excludes low-confidence frames from the average', () => {
    const result = scoreContinuousCents(
      [
        { midi: 60, conf: 0.9 }, // confident, on pitch
        { midi: 65, conf: 0.1 }, // unconfident, wildly off — must be excluded
      ],
      60,
    );
    expect(result.avgAbsCents).toBeCloseTo(0, 5);
    expect(result.hit).toBe(true);
  });

  it('hits when average |cents off| is within the green threshold', () => {
    const result = scoreContinuousCents(
      [
        { midi: 60.2, conf: 0.9 }, // +20 cents
        { midi: 59.9, conf: 0.9 }, // -10 cents
      ],
      60,
    );
    expect(result.avgAbsCents).toBeCloseTo(15, 5);
    expect(result.hit).toBe(true);
  });

  it('misses when average |cents off| exceeds the green threshold', () => {
    const result = scoreContinuousCents([{ midi: 61, conf: 0.9 }], 60); // 100 cents off
    expect(result.avgAbsCents).toBeCloseTo(100, 5);
    expect(result.hit).toBe(false);
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

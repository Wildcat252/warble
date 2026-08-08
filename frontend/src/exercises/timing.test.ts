import { describe, expect, it } from 'vitest';
import { exerciseDurationMs, expectedTargetAtTime } from './timing';
import type { ExerciseTargetNote } from './types';

const targets: ExerciseTargetNote[] = [
  { midi: 60, startMs: 0, endMs: 1000 },
  { midi: 62, startMs: 1000, endMs: 3000 },
  { midi: 64, startMs: 3500, endMs: 4500 }, // gap between 3000 and 3500
];

describe('expectedTargetAtTime', () => {
  it('returns null for an empty target list', () => {
    expect(expectedTargetAtTime(0, [])).toBeNull();
  });

  it('returns null before the first target', () => {
    expect(expectedTargetAtTime(-1, targets)).toBeNull();
  });

  it('finds the active target at exact start and interior times', () => {
    expect(expectedTargetAtTime(0, targets)?.midi).toBe(60);
    expect(expectedTargetAtTime(1500, targets)?.midi).toBe(62);
  });

  it('returns null in a gap between targets', () => {
    expect(expectedTargetAtTime(3200, targets)).toBeNull();
  });

  it('returns null exactly at a target end boundary (end is exclusive)', () => {
    expect(expectedTargetAtTime(1000, targets)?.midi).toBe(62);
    expect(expectedTargetAtTime(3000, targets)).toBeNull();
  });

  it('returns null after the last target ends', () => {
    expect(expectedTargetAtTime(4500, targets)).toBeNull();
    expect(expectedTargetAtTime(10000, targets)).toBeNull();
  });
});

describe('exerciseDurationMs', () => {
  it('returns 0 for an empty target list', () => {
    expect(exerciseDurationMs([])).toBe(0);
  });

  it('returns the end time of the last target', () => {
    expect(exerciseDurationMs(targets)).toBe(4500);
  });
});

import { describe, expect, it } from 'vitest';
import { exerciseDurationMs, expectedTargetAtTime, withLeadIn } from './timing';
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

describe('withLeadIn', () => {
  const targets = [
    { midi: 60, startMs: 0, endMs: 1000 },
    { midi: 64, startMs: 1000, endMs: 2000 },
  ];

  it('shifts every target later by the offset', () => {
    expect(withLeadIn(targets, 2000).map((t) => [t.startMs, t.endMs]))
      .toEqual([[2000, 3000], [3000, 4000]]);
  });

  it('preserves note durations and gaps', () => {
    const shifted = withLeadIn(targets, 2000);
    expect(shifted[0].endMs - shifted[0].startMs).toBe(1000);
    expect(shifted[1].startMs - shifted[0].endMs).toBe(0);
  });

  it('keeps midi and labels intact', () => {
    const shifted = withLeadIn([{ midi: 60, startMs: 0, endMs: 500, label: 'Root' }], 1000);
    expect(shifted[0].midi).toBe(60);
    expect(shifted[0].label).toBe('Root');
  });

  it('returns the input unchanged for a zero or negative offset', () => {
    expect(withLeadIn(targets, 0)).toBe(targets);
    expect(withLeadIn(targets, -500)).toBe(targets);
  });

  it('does not mutate the original targets', () => {
    withLeadIn(targets, 2000);
    expect(targets[0].startMs).toBe(0);
  });

  it('leaves the exercise duration longer by exactly the lead-in', () => {
    expect(exerciseDurationMs(withLeadIn(targets, 2000)) - exerciseDurationMs(targets)).toBe(2000);
  });
});

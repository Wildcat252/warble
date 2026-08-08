import { describe, expect, it } from 'vitest';
import { EXERCISE_CATALOG, getExerciseById } from './catalog';
import type { ExerciseGenerationContext, ExerciseTargetNote } from './types';

const TEST_ANCHORS = [48, 55, 60, 67, 72]; // spread across a plausible vocal range

function assertValidSequence(targets: ExerciseTargetNote[]): void {
  expect(targets.length).toBeGreaterThan(0);
  let previousEnd = -Infinity;
  for (const target of targets) {
    expect(target.endMs).toBeGreaterThan(target.startMs);
    expect(target.startMs).toBeGreaterThanOrEqual(previousEnd);
    expect(Number.isFinite(target.midi)).toBe(true);
    previousEnd = target.endMs;
  }
}

describe('EXERCISE_CATALOG', () => {
  it('has a unique id per entry', () => {
    const ids = EXERCISE_CATALOG.map((ex) => ex.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const exercise of EXERCISE_CATALOG) {
    describe(exercise.id, () => {
      for (const anchorMidi of TEST_ANCHORS) {
        it(`produces a valid, non-overlapping, ascending-time sequence for anchor ${anchorMidi}`, () => {
          const ctx: ExerciseGenerationContext = { anchorMidi };
          assertValidSequence(exercise.generate(ctx));
        });
      }

      it('is retrievable via getExerciseById', () => {
        expect(getExerciseById(exercise.id)).toBe(exercise);
      });
    });
  }

  it('returns undefined for an unknown id', () => {
    expect(getExerciseById('does-not-exist')).toBeUndefined();
  });
});

describe('note-hold-basic', () => {
  it('targets the root, major 3rd, and 5th above the anchor', () => {
    const exercise = getExerciseById('note-hold-basic')!;
    const targets = exercise.generate({ anchorMidi: 60 });
    expect(targets.map((t) => t.midi)).toEqual([60, 64, 67]);
  });
});

describe('guided-warmup', () => {
  it('delegates to warmup/session.ts::buildWarmupSequence with no new scheduling logic', () => {
    const exercise = getExerciseById('guided-warmup')!;
    const targets = exercise.generate({ anchorMidi: 60 });
    expect(targets[0].startMs).toBe(0);
    expect(targets.at(-1)?.endMs).toBe(exercise.estSeconds * 1000);
  });
});

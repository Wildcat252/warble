import { describe, expect, it } from 'vitest';
import {
  validateCustomExerciseSpec, isCustomExerciseId,
  CUSTOM_EXERCISE_SCHEMA_VERSION, CUSTOM_ID_PREFIX,
  MAX_STEPS, MAX_TITLE_LENGTH,
  type CustomExerciseSpec,
} from './custom-types';

function spec(overrides: Partial<CustomExerciseSpec> = {}): CustomExerciseSpec {
  return {
    schemaVersion: CUSTOM_EXERCISE_SCHEMA_VERSION,
    id: `${CUSTOM_ID_PREFIX}test`,
    title: 'My exercise',
    description: 'A drill',
    difficulty: 'easy',
    scoringStrategy: 'continuous-cents',
    steps: [{ offset: 0 }, { offset: 7 }],
    msPerNote: 2000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fields(errors: { field: string }[]): string[] {
  return errors.map((e) => e.field);
}

describe('validateCustomExerciseSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateCustomExerciseSpec(spec())).toEqual([]);
  });

  it('rejects a blank or whitespace-only title', () => {
    expect(fields(validateCustomExerciseSpec(spec({ title: '' })))).toContain('title');
    expect(fields(validateCustomExerciseSpec(spec({ title: '   ' })))).toContain('title');
  });

  it('rejects an over-long title', () => {
    const title = 'x'.repeat(MAX_TITLE_LENGTH + 1);
    expect(fields(validateCustomExerciseSpec(spec({ title })))).toContain('title');
  });

  it('rejects an exercise with no notes', () => {
    expect(fields(validateCustomExerciseSpec(spec({ steps: [] })))).toContain('steps');
  });

  it('rejects more notes than the cap', () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ offset: 0 }));
    expect(fields(validateCustomExerciseSpec(spec({ steps })))).toContain('steps');
  });

  it('rejects offsets beyond two octaves either way', () => {
    expect(fields(validateCustomExerciseSpec(spec({ steps: [{ offset: 25 }] })))).toContain('steps.0');
    expect(fields(validateCustomExerciseSpec(spec({ steps: [{ offset: -25 }] })))).toContain('steps.0');
  });

  it('accepts offsets exactly on the boundary', () => {
    expect(validateCustomExerciseSpec(spec({ steps: [{ offset: 24 }, { offset: -24 }] }))).toEqual([]);
  });

  it('rejects fractional offsets', () => {
    expect(fields(validateCustomExerciseSpec(spec({ steps: [{ offset: 1.5 }] })))).toContain('steps.0');
  });

  it('reports every bad step, not just the first', () => {
    const errors = validateCustomExerciseSpec(spec({ steps: [{ offset: 99 }, { offset: 0 }, { offset: -99 }] }));
    expect(fields(errors)).toEqual(expect.arrayContaining(['steps.0', 'steps.2']));
    expect(fields(errors)).not.toContain('steps.1');
  });

  it('rejects note lengths outside the playable window', () => {
    expect(fields(validateCustomExerciseSpec(spec({ msPerNote: 100 })))).toContain('msPerNote');
    expect(fields(validateCustomExerciseSpec(spec({ msPerNote: 999999 })))).toContain('msPerNote');
    expect(fields(validateCustomExerciseSpec(spec({ msPerNote: Number.NaN })))).toContain('msPerNote');
  });

  describe('stable-hold scoring', () => {
    it('requires a hold duration', () => {
      const errors = validateCustomExerciseSpec(spec({ scoringStrategy: 'stable-hold' }));
      expect(fields(errors)).toContain('holdDurationMs');
    });

    it('rejects a hold longer than the note itself — it could never be satisfied', () => {
      const errors = validateCustomExerciseSpec(spec({
        scoringStrategy: 'stable-hold', msPerNote: 1000, holdDurationMs: 1500,
      }));
      expect(fields(errors)).toContain('holdDurationMs');
    });

    it('accepts a hold equal to the note length', () => {
      const errors = validateCustomExerciseSpec(spec({
        scoringStrategy: 'stable-hold', msPerNote: 1000, holdDurationMs: 1000,
      }));
      expect(errors).toEqual([]);
    });

    it('ignores hold duration entirely for continuous-cents', () => {
      const errors = validateCustomExerciseSpec(spec({
        scoringStrategy: 'continuous-cents', holdDurationMs: undefined,
      }));
      expect(errors).toEqual([]);
    });
  });
});

describe('isCustomExerciseId', () => {
  it('recognises prefixed ids', () => {
    expect(isCustomExerciseId(`${CUSTOM_ID_PREFIX}abc`)).toBe(true);
  });

  it('rejects built-in ids, so a stored spec can never shadow one', () => {
    expect(isCustomExerciseId('note-hold-basic')).toBe(false);
    expect(isCustomExerciseId('guided-warmup')).toBe(false);
  });
});

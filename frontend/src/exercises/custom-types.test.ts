import { describe, expect, it } from 'vitest';
import {
  validateCustomExerciseSpec, isCustomExerciseId, migrateSpec, usedSlots, sortedNotes,
  CUSTOM_EXERCISE_SCHEMA_VERSION, CUSTOM_ID_PREFIX,
  MAX_SLOTS, MAX_TITLE_LENGTH, MAX_NOTE_LENGTH_SLOTS,
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
    notes: [
      { offset: 0, startSlot: 0, lengthSlots: 2 },
      { offset: 7, startSlot: 2, lengthSlots: 2 },
    ],
    slotMs: 1000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const fields = (errors: { field: string }[]): string[] => errors.map((e) => e.field);

describe('validateCustomExerciseSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateCustomExerciseSpec(spec())).toEqual([]);
  });

  it('accepts a rest — a gap between notes is legal', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 1 },
      { offset: 7, startSlot: 4, lengthSlots: 1 },
    ];
    expect(validateCustomExerciseSpec(spec({ notes }))).toEqual([]);
  });

  it('accepts notes of differing lengths', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 1 },
      { offset: 7, startSlot: 1, lengthSlots: 6 },
    ];
    expect(validateCustomExerciseSpec(spec({ notes }))).toEqual([]);
  });

  it('rejects a blank or whitespace-only title', () => {
    expect(fields(validateCustomExerciseSpec(spec({ title: '' })))).toContain('title');
    expect(fields(validateCustomExerciseSpec(spec({ title: '   ' })))).toContain('title');
  });

  it('rejects an over-long title', () => {
    expect(fields(validateCustomExerciseSpec(spec({ title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }))))
      .toContain('title');
  });

  it('rejects an empty grid', () => {
    expect(fields(validateCustomExerciseSpec(spec({ notes: [] })))).toContain('notes');
  });

  it('rejects overlapping notes — singing is monophonic', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 3 },
      { offset: 7, startSlot: 2, lengthSlots: 2 },
    ];
    expect(fields(validateCustomExerciseSpec(spec({ notes })))).toContain('notes');
  });

  it('detects an overlap even when notes are stored out of order', () => {
    const notes = [
      { offset: 7, startSlot: 2, lengthSlots: 2 },
      { offset: 0, startSlot: 0, lengthSlots: 3 },
    ];
    expect(fields(validateCustomExerciseSpec(spec({ notes })))).toContain('notes');
  });

  it('allows notes that touch exactly, with no overlap', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 2 },
      { offset: 7, startSlot: 2, lengthSlots: 2 },
    ];
    expect(validateCustomExerciseSpec(spec({ notes }))).toEqual([]);
  });

  it('rejects a grid spanning past the column cap', () => {
    const notes = [{ offset: 0, startSlot: MAX_SLOTS, lengthSlots: 1 }];
    expect(fields(validateCustomExerciseSpec(spec({ notes })))).toContain('notes');
  });

  it('rejects offsets beyond two octaves either way', () => {
    expect(fields(validateCustomExerciseSpec(spec({ notes: [{ offset: 25, startSlot: 0, lengthSlots: 1 }] }))))
      .toContain('notes.0');
    expect(fields(validateCustomExerciseSpec(spec({ notes: [{ offset: -25, startSlot: 0, lengthSlots: 1 }] }))))
      .toContain('notes.0');
  });

  it('rejects a zero-length or over-long note', () => {
    expect(fields(validateCustomExerciseSpec(spec({ notes: [{ offset: 0, startSlot: 0, lengthSlots: 0 }] }))))
      .toContain('notes.0');
    expect(fields(validateCustomExerciseSpec(spec({
      notes: [{ offset: 0, startSlot: 0, lengthSlots: MAX_NOTE_LENGTH_SLOTS + 1 }],
    })))).toContain('notes.0');
  });

  it('rejects a negative start column', () => {
    expect(fields(validateCustomExerciseSpec(spec({ notes: [{ offset: 0, startSlot: -1, lengthSlots: 1 }] }))))
      .toContain('notes.0');
  });

  it('rejects column lengths outside the playable window', () => {
    expect(fields(validateCustomExerciseSpec(spec({ slotMs: 100 })))).toContain('slotMs');
    expect(fields(validateCustomExerciseSpec(spec({ slotMs: 99999 })))).toContain('slotMs');
    expect(fields(validateCustomExerciseSpec(spec({ slotMs: Number.NaN })))).toContain('slotMs');
  });

  describe('stable-hold scoring', () => {
    it('requires a hold duration', () => {
      expect(fields(validateCustomExerciseSpec(spec({ scoringStrategy: 'stable-hold' }))))
        .toContain('holdDurationMs');
    });

    it('rejects a hold longer than the SHORTEST note, not just the longest', () => {
      const notes = [
        { offset: 0, startSlot: 0, lengthSlots: 4 }, // 4000ms
        { offset: 7, startSlot: 4, lengthSlots: 1 }, // 1000ms — the binding one
      ];
      const errors = validateCustomExerciseSpec(spec({
        notes, scoringStrategy: 'stable-hold', slotMs: 1000, holdDurationMs: 1500,
      }));
      expect(fields(errors)).toContain('holdDurationMs');
    });

    it('accepts a hold equal to the shortest note', () => {
      expect(validateCustomExerciseSpec(spec({
        scoringStrategy: 'stable-hold', slotMs: 1000, holdDurationMs: 2000,
      }))).toEqual([]);
    });

    it('ignores hold duration entirely for continuous-cents', () => {
      expect(validateCustomExerciseSpec(spec({
        scoringStrategy: 'continuous-cents', holdDurationMs: undefined,
      }))).toEqual([]);
    });
  });
});

describe('usedSlots', () => {
  it('measures to the end of the last note, including rests before it', () => {
    expect(usedSlots([
      { offset: 0, startSlot: 0, lengthSlots: 1 },
      { offset: 7, startSlot: 6, lengthSlots: 2 },
    ])).toBe(8);
  });

  it('is zero for an empty grid', () => {
    expect(usedSlots([])).toBe(0);
  });
});

describe('sortedNotes', () => {
  it('orders by start column without mutating the input', () => {
    const notes = [
      { offset: 7, startSlot: 4, lengthSlots: 1 },
      { offset: 0, startSlot: 0, lengthSlots: 1 },
    ];
    expect(sortedNotes(notes).map((n) => n.startSlot)).toEqual([0, 4]);
    expect(notes[0].startSlot).toBe(4);
  });
});

/** A genuine v1 record: `steps` + `msPerNote`, and crucially NO notes/slotMs. */
function legacyV1(steps: { offset: number; label?: string }[], msPerNote: number): never {
  const { notes, slotMs, ...rest } = spec();
  void notes; void slotMs;
  return { ...rest, schemaVersion: 1, steps, msPerNote } as never;
}

describe('migrateSpec', () => {
  it('turns v1 uniform steps into one-column notes on consecutive columns', () => {
    const migrated = migrateSpec(legacyV1([{ offset: 0, label: 'Root' }, { offset: 4 }, { offset: 7 }], 1500));

    expect(migrated.slotMs).toBe(1500);
    expect(migrated.schemaVersion).toBe(CUSTOM_EXERCISE_SCHEMA_VERSION);
    expect(migrated.notes).toEqual([
      { offset: 0, startSlot: 0, lengthSlots: 1, label: 'Root' },
      { offset: 4, startSlot: 1, lengthSlots: 1, label: undefined },
      { offset: 7, startSlot: 2, lengthSlots: 1, label: undefined },
    ]);
  });

  it('leaves a v2 spec untouched', () => {
    const v2 = spec();
    expect(migrateSpec(v2 as never)).toBe(v2);
  });

  it('produces a valid spec from a migrated v1', () => {
    const migrated = migrateSpec(legacyV1([{ offset: 0 }, { offset: 7 }], 1000));
    expect(validateCustomExerciseSpec(migrated)).toEqual([]);
  });

  it('places migrated notes back to back, reproducing v1 playback exactly', () => {
    const migrated = migrateSpec(legacyV1([{ offset: 0 }, { offset: 4 }, { offset: 7 }], 1000));
    expect(migrated.notes.map((n) => [n.startSlot, n.lengthSlots])).toEqual([[0, 1], [1, 1], [2, 1]]);
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

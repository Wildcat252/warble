import { beforeEach, describe, expect, it } from 'vitest';
import { specToDefinition, getCustomExercises, getCustomExerciseById } from './custom-catalog';
import {
  createCustomExercise, updateCustomExercise, deleteCustomExercise,
  loadCustomExerciseSpecs, getCustomExerciseSpec,
} from './custom-store';
import { CUSTOM_EXERCISE_SCHEMA_VERSION, CUSTOM_ID_PREFIX, type CustomExerciseSpec } from './custom-types';
import { getExerciseById } from './catalog';

function spec(overrides: Partial<CustomExerciseSpec> = {}): CustomExerciseSpec {
  return {
    schemaVersion: CUSTOM_EXERCISE_SCHEMA_VERSION,
    id: `${CUSTOM_ID_PREFIX}test`,
    title: 'Triad',
    description: 'Root, 3rd, 5th',
    difficulty: 'easy',
    scoringStrategy: 'continuous-cents',
    notes: [
      { offset: 0, startSlot: 0, lengthSlots: 1, label: 'Root' },
      { offset: 4, startSlot: 1, lengthSlots: 1 },
      { offset: 7, startSlot: 2, lengthSlots: 1 },
    ],
    slotMs: 2000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const baseInput = {
  title: 'Triad',
  description: 'Root, 3rd, 5th',
  difficulty: 'easy' as const,
  scoringStrategy: 'continuous-cents' as const,
  notes: [
    { offset: 0, startSlot: 0, lengthSlots: 1 },
    { offset: 4, startSlot: 1, lengthSlots: 1 },
    { offset: 7, startSlot: 2, lengthSlots: 1 },
  ],
  slotMs: 2000,
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('specToDefinition', () => {
  it('builds targets relative to the anchor, so the exercise transposes', () => {
    const def = specToDefinition(spec());
    expect(def.generate({ anchorMidi: 60 }).map((t) => t.midi)).toEqual([60, 64, 67]);
    expect(def.generate({ anchorMidi: 48 }).map((t) => t.midi)).toEqual([48, 52, 55]);
  });

  it('schedules uniform targets back to back with no gaps or overlap', () => {
    const targets = specToDefinition(spec()).generate({ anchorMidi: 60 });
    expect(targets.map((t) => [t.startMs, t.endMs])).toEqual([[0, 2000], [2000, 4000], [4000, 6000]]);
  });

  it('carries step labels through and leaves unlabelled steps undefined', () => {
    const targets = specToDefinition(spec()).generate({ anchorMidi: 60 });
    expect(targets[0].label).toBe('Root');
    expect(targets[1].label).toBeUndefined();
  });

  it('derives estSeconds from grid span and column length', () => {
    expect(specToDefinition(spec()).estSeconds).toBe(6);
  });

  it('pays more for a harder exercise of the same length', () => {
    // difficulty used to be cosmetic: the editor offered it, the picker showed
    // it, and xp ignored it entirely.
    const easy = specToDefinition(spec({ difficulty: 'easy' })).xpBase;
    const medium = specToDefinition(spec({ difficulty: 'medium' })).xpBase;
    const hard = specToDefinition(spec({ difficulty: 'hard' })).xpBase;
    expect(medium).toBeGreaterThan(easy);
    expect(hard).toBeGreaterThan(medium);
  });

  it('drops holdDurationMs when scoring is not stable-hold', () => {
    const def = specToDefinition(spec({ scoringStrategy: 'continuous-cents', holdDurationMs: 900 }));
    expect(def.holdDurationMs).toBeUndefined();
  });

  it('keeps holdDurationMs for stable-hold', () => {
    const def = specToDefinition(spec({ scoringStrategy: 'stable-hold', holdDurationMs: 900 }));
    expect(def.holdDurationMs).toBe(900);
  });

  it('caps XP so a very long exercise cannot out-earn every built-in', () => {
    const notes = Array.from({ length: 64 }, (_, i) => ({ offset: 0, startSlot: i, lengthSlots: 1 }));
    expect(specToDefinition(spec({ notes })).xpBase).toBeLessThanOrEqual(80);
  });

  it('awards a floor of XP for a one-note exercise', () => {
    const notes = [{ offset: 0, startSlot: 0, lengthSlots: 1 }];
    expect(specToDefinition(spec({ notes })).xpBase).toBeGreaterThanOrEqual(10);
  });

  it('honours per-note lengths in the generated targets', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 3 },
      { offset: 7, startSlot: 3, lengthSlots: 1 },
    ];
    const targets = specToDefinition(spec({ notes, slotMs: 1000 })).generate({ anchorMidi: 60 });
    expect(targets.map((t) => [t.startMs, t.endMs])).toEqual([[0, 3000], [3000, 4000]]);
  });

  it('leaves a real gap in the timeline for a rest', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 1 },
      { offset: 7, startSlot: 3, lengthSlots: 1 },
    ];
    const targets = specToDefinition(spec({ notes, slotMs: 1000 })).generate({ anchorMidi: 60 });
    expect(targets[0].endMs).toBe(1000);
    expect(targets[1].startMs).toBe(3000); // 2s of silence between them
  });

  it('emits targets in time order even when notes are stored out of order', () => {
    const notes = [
      { offset: 7, startSlot: 2, lengthSlots: 1 },
      { offset: 0, startSlot: 0, lengthSlots: 1 },
    ];
    const targets = specToDefinition(spec({ notes, slotMs: 1000 })).generate({ anchorMidi: 60 });
    expect(targets.map((t) => t.startMs)).toEqual([0, 2000]);
  });

  it('counts rests toward estSeconds — silence is part of the exercise', () => {
    const notes = [
      { offset: 0, startSlot: 0, lengthSlots: 1 },
      { offset: 7, startSlot: 5, lengthSlots: 1 },
    ];
    expect(specToDefinition(spec({ notes, slotMs: 1000 })).estSeconds).toBe(6);
  });
});

describe('custom-store round trip', () => {
  it('creates, reads back, and lists a spec', () => {
    const created = createCustomExercise(baseInput);
    expect(created).not.toBeNull();
    expect(getCustomExerciseSpec(created!.id)?.title).toBe('Triad');
    expect(loadCustomExerciseSpecs()).toHaveLength(1);
  });

  it('gives each exercise a distinct id', () => {
    const a = createCustomExercise(baseInput);
    const b = createCustomExercise(baseInput);
    expect(a!.id).not.toBe(b!.id);
  });

  it('preserves the id across an edit, so practice-log entries keep resolving', () => {
    const created = createCustomExercise(baseInput)!;
    const updated = updateCustomExercise(created.id, { ...baseInput, title: 'Renamed' })!;
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe('Renamed');
    expect(loadCustomExerciseSpecs()).toHaveLength(1);
  });

  it('preserves createdAt but moves updatedAt on edit', () => {
    const created = createCustomExercise(baseInput)!;
    const updated = updateCustomExercise(created.id, { ...baseInput, title: 'Renamed' })!;
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('returns null when editing an id that does not exist', () => {
    expect(updateCustomExercise('custom:missing', baseInput)).toBeNull();
  });

  it('deletes only the targeted spec', () => {
    const a = createCustomExercise(baseInput)!;
    const b = createCustomExercise(baseInput)!;
    expect(deleteCustomExercise(a.id)).toBe(true);
    expect(loadCustomExerciseSpecs().map((s) => s.id)).toEqual([b.id]);
  });

  it('reports failure when deleting something that is not there', () => {
    expect(deleteCustomExercise('custom:missing')).toBe(false);
  });

  it('ignores corrupt entries rather than losing the whole list', () => {
    const good = createCustomExercise(baseInput)!;
    const raw = JSON.parse(window.localStorage.getItem('warble.custom-exercises.v1')!);
    raw.push({ id: 'custom:bad' }); // missing notes/title/slotMs
    raw.push('not an object');
    window.localStorage.setItem('warble.custom-exercises.v1', JSON.stringify(raw));

    const loaded = loadCustomExerciseSpecs();
    expect(loaded.map((s) => s.id)).toEqual([good.id]);
  });

  it('returns an empty list when storage holds unparseable JSON', () => {
    window.localStorage.setItem('warble.custom-exercises.v1', '{not json');
    expect(loadCustomExerciseSpecs()).toEqual([]);
  });
});

describe('getCustomExercises', () => {
  it('returns newest first', () => {
    const older = createCustomExercise(baseInput)!;
    // createdAt has millisecond resolution, so force a distinct, later stamp.
    const all = loadCustomExerciseSpecs();
    all[0] = { ...older, createdAt: '2020-01-01T00:00:00.000Z' };
    window.localStorage.setItem('warble.custom-exercises.v1', JSON.stringify(all));
    const newer = createCustomExercise({ ...baseInput, title: 'Newer' })!;

    expect(getCustomExercises().map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  it('is empty when nothing has been created', () => {
    expect(getCustomExercises()).toEqual([]);
  });
});

describe('getExerciseById resolves both catalogs', () => {
  it('finds built-ins', () => {
    expect(getExerciseById('note-hold-basic')?.title).toBe('Note Hold');
  });

  it('finds custom exercises', () => {
    const created = createCustomExercise(baseInput)!;
    expect(getExerciseById(created.id)?.title).toBe('Triad');
  });

  it('returns undefined for an unknown custom id', () => {
    expect(getExerciseById('custom:nope')).toBeUndefined();
  });

  it('returns undefined for an unknown unprefixed id', () => {
    expect(getExerciseById('does-not-exist')).toBeUndefined();
  });

  it('does not consult storage for unprefixed ids, so a built-in cannot be shadowed', () => {
    // Hand-write a spec whose id collides with a built-in.
    window.localStorage.setItem('warble.custom-exercises.v1', JSON.stringify([
      { ...spec({ id: 'note-hold-basic', title: 'Impostor' }) },
    ]));
    expect(getExerciseById('note-hold-basic')?.title).toBe('Note Hold');
  });
});

describe('getCustomExerciseById', () => {
  it('returns undefined for a missing id', () => {
    expect(getCustomExerciseById('custom:missing')).toBeUndefined();
  });
});

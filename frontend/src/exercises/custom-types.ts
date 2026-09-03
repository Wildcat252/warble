/**
 * Serializable spec for user-created exercises.
 *
 * Built-in exercises (catalog.ts) carry a `generate()` FUNCTION, which cannot
 * survive JSON.stringify — so custom exercises can't reuse ExerciseDefinition
 * as their stored shape. This is the data-only counterpart, which
 * custom-catalog.ts compiles into a real ExerciseDefinition at load time.
 *
 * GRID MODEL (v2). Notes live on a piano-roll grid: `slotMs` is one column's
 * duration, and each note carries a start column and a length in columns.
 * That replaces v1's uniform `steps[] + msPerNote`, which forced every note
 * to be the same length, back to back, with no rests — a grid editor needs
 * all three of those to vary. Quantising to integer slots (rather than free
 * milliseconds) keeps notes aligned to the grid the user is clicking on and
 * makes overlap checks exact.
 *
 * Offsets are SEMITONES RELATIVE TO THE ANCHOR, not absolute MIDI, so a
 * custom exercise transposes to each singer's voice type exactly like the
 * built-ins do. Storing absolute pitches would have handed a bass and a
 * soprano the identical notes.
 */
import type { ScoringStrategy } from './types';

/** v1 = uniform steps + msPerNote. v2 = piano-roll grid. See migrateSpec. */
export const CUSTOM_EXERCISE_SCHEMA_VERSION = 2;

/** Prefix on every generated id, so custom exercises can never collide with a built-in's id. */
export const CUSTOM_ID_PREFIX = 'custom:';

export interface CustomExerciseNote {
  /** Semitones from the anchor pitch. Negative = below. */
  offset: number;
  /** Grid column the note starts on, 0-based. */
  startSlot: number;
  /** Length in grid columns; at least 1. */
  lengthSlots: number;
  /** Optional on-screen label, e.g. "Root" or "5th". */
  label?: string;
}

export interface CustomExerciseSpec {
  schemaVersion: number;
  /** Always starts with CUSTOM_ID_PREFIX. */
  id: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  scoringStrategy: ScoringStrategy;
  /** Duration of one grid column, in milliseconds. */
  slotMs: number;
  notes: CustomExerciseNote[];
  /** Only meaningful when scoringStrategy === 'stable-hold'. */
  holdDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}

// Editor bounds. Guard-rails against specs that would produce an unplayable
// exercise, not musical opinions:
//  - offsets beyond ±2 octaves leave every real voice type behind
//  - under ~400ms a slot is shorter than the pitch pipeline's own settling
//    time, so a one-slot note could never be scored as hit
//  - the slot cap keeps a single exercise from running past ~10 minutes
export const MIN_OFFSET = -24;
export const MAX_OFFSET = 24;
/** Rows shown without scrolling; the grid scrolls to reach MIN/MAX_OFFSET. */
export const VISIBLE_OFFSET_SPAN = 12;
export const MIN_SLOT_MS = 400;
export const MAX_SLOT_MS = 4000;
export const MAX_SLOTS = 64;
export const MAX_NOTE_LENGTH_SLOTS = 16;
export const MAX_TITLE_LENGTH = 60;

export interface SpecValidationError {
  field: string;
  message: string;
}

/** Notes in playing order. Storage order is whatever the editor produced. */
export function sortedNotes(notes: CustomExerciseNote[]): CustomExerciseNote[] {
  return [...notes].sort((a, b) => a.startSlot - b.startSlot);
}

/** Last occupied column + 1, i.e. how many columns the exercise actually uses. */
export function usedSlots(notes: CustomExerciseNote[]): number {
  return notes.reduce((max, n) => Math.max(max, n.startSlot + n.lengthSlots), 0);
}

/**
 * Validates a spec for playability. Returns every problem rather than the
 * first, so the editor can mark all bad fields in one pass.
 */
export function validateCustomExerciseSpec(spec: CustomExerciseSpec): SpecValidationError[] {
  const errors: SpecValidationError[] = [];

  if (spec.title.trim() === '') {
    errors.push({ field: 'title', message: 'Give the exercise a name.' });
  } else if (spec.title.length > MAX_TITLE_LENGTH) {
    errors.push({ field: 'title', message: `Name must be ${MAX_TITLE_LENGTH} characters or fewer.` });
  }

  if (spec.notes.length === 0) {
    errors.push({ field: 'notes', message: 'Add at least one note to the grid.' });
  }

  if (usedSlots(spec.notes) > MAX_SLOTS) {
    errors.push({ field: 'notes', message: `An exercise can span at most ${MAX_SLOTS} columns.` });
  }

  for (const [i, note] of spec.notes.entries()) {
    if (!Number.isInteger(note.offset) || note.offset < MIN_OFFSET || note.offset > MAX_OFFSET) {
      errors.push({ field: `notes.${i}`, message: `A note sits outside ±2 octaves of your anchor.` });
    }
    if (!Number.isInteger(note.startSlot) || note.startSlot < 0) {
      errors.push({ field: `notes.${i}`, message: 'A note starts before the beginning of the grid.' });
    }
    if (!Number.isInteger(note.lengthSlots) || note.lengthSlots < 1
      || note.lengthSlots > MAX_NOTE_LENGTH_SLOTS) {
      errors.push({ field: `notes.${i}`, message: `Note length must be 1–${MAX_NOTE_LENGTH_SLOTS} columns.` });
    }
  }

  // Singing is monophonic — two targets live at once has no meaning, and
  // expectedTargetAtTime assumes non-overlapping targets.
  const ordered = sortedNotes(spec.notes);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    if (ordered[i].startSlot < prev.startSlot + prev.lengthSlots) {
      errors.push({ field: 'notes', message: 'Two notes overlap — you can only sing one at a time.' });
      break;
    }
  }

  if (!Number.isFinite(spec.slotMs) || spec.slotMs < MIN_SLOT_MS || spec.slotMs > MAX_SLOT_MS) {
    errors.push({
      field: 'slotMs',
      message: `A column must last between ${MIN_SLOT_MS / 1000}s and ${MAX_SLOT_MS / 1000}s.`,
    });
  }

  // A hold longer than the shortest note can never be satisfied — that target
  // ends before the singer can accumulate enough stable time.
  if (spec.scoringStrategy === 'stable-hold') {
    const hold = spec.holdDurationMs ?? 0;
    const shortestMs = spec.notes.length > 0
      ? Math.min(...spec.notes.map((n) => n.lengthSlots)) * spec.slotMs
      : spec.slotMs;
    if (hold <= 0) {
      errors.push({ field: 'holdDurationMs', message: 'Set how long each note must be held.' });
    } else if (hold > shortestMs) {
      errors.push({ field: 'holdDurationMs', message: 'Hold time is longer than your shortest note.' });
    }
  }

  return errors;
}

/** True when `id` refers to a user-created exercise rather than a built-in. */
export function isCustomExerciseId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

/** v1 shape, kept only so stored specs written before the grid editor can be read. */
interface LegacyV1Spec {
  steps?: { offset: number; label?: string }[];
  msPerNote?: number;
}

/**
 * Upgrades a v1 spec in place of a v2 one: v1's uniform steps become
 * one-column notes on consecutive columns, which reproduces the old playback
 * exactly. Anything already at v2 passes through untouched.
 */
export function migrateSpec(raw: CustomExerciseSpec & LegacyV1Spec): CustomExerciseSpec {
  if (Array.isArray(raw.notes) && typeof raw.slotMs === 'number') return raw;

  const steps = raw.steps ?? [];
  return {
    ...raw,
    schemaVersion: CUSTOM_EXERCISE_SCHEMA_VERSION,
    slotMs: raw.msPerNote ?? 2000,
    notes: steps.map((s, i) => ({
      offset: s.offset,
      startSlot: i,
      lengthSlots: 1,
      label: s.label,
    })),
  };
}

/**
 * Serializable spec for user-created exercises.
 *
 * Built-in exercises (catalog.ts) carry a `generate()` FUNCTION, which cannot
 * survive JSON.stringify — so custom exercises can't reuse ExerciseDefinition
 * as their stored shape. This is the data-only counterpart: a spec that
 * describes the note sequence declaratively, which custom-catalog.ts compiles
 * into a real ExerciseDefinition (function and all) at load time. The runtime
 * downstream of that compile step can't tell a custom exercise from a
 * built-in, which is the point — exercise-player, scoring and the practice
 * log all stay untouched.
 *
 * Offsets are SEMITONES RELATIVE TO THE ANCHOR, not absolute MIDI, so a
 * custom exercise transposes to each singer's voice type exactly like the
 * built-ins do. Storing absolute pitches would have handed a bass and a
 * soprano the identical notes.
 */
import type { ScoringStrategy } from './types';

/** Marks stored specs so a future shape change can migrate rather than silently misparse. */
export const CUSTOM_EXERCISE_SCHEMA_VERSION = 1;

/** Prefix on every generated id, so custom exercises can never collide with a built-in's id. */
export const CUSTOM_ID_PREFIX = 'custom:';

export interface CustomExerciseStep {
  /** Semitones from the anchor pitch. Negative = below. */
  offset: number;
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
  steps: CustomExerciseStep[];
  /** Duration of each step's window, in milliseconds. */
  msPerNote: number;
  /** Only meaningful when scoringStrategy === 'stable-hold'. */
  holdDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}

// Editor bounds. These are guard-rails against specs that would produce an
// unplayable exercise, not musical opinions:
//  - offsets beyond ±2 octaves leave every real voice type behind
//  - under ~400ms a target is shorter than the pitch pipeline's own settling
//    time, so it can never be scored as hit
//  - the step cap keeps a single exercise from running past ~15 minutes
export const MIN_OFFSET = -24;
export const MAX_OFFSET = 24;
export const MIN_MS_PER_NOTE = 400;
export const MAX_MS_PER_NOTE = 10000;
export const MAX_STEPS = 64;
export const MAX_TITLE_LENGTH = 60;

export interface SpecValidationError {
  field: string;
  message: string;
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

  if (spec.steps.length === 0) {
    errors.push({ field: 'steps', message: 'Add at least one note.' });
  } else if (spec.steps.length > MAX_STEPS) {
    errors.push({ field: 'steps', message: `An exercise can have at most ${MAX_STEPS} notes.` });
  }

  for (const [i, step] of spec.steps.entries()) {
    if (!Number.isInteger(step.offset)) {
      errors.push({ field: `steps.${i}`, message: 'Note offsets must be whole semitones.' });
    } else if (step.offset < MIN_OFFSET || step.offset > MAX_OFFSET) {
      errors.push({ field: `steps.${i}`, message: `Note ${i + 1} is outside ±2 octaves of your anchor.` });
    }
  }

  if (!Number.isFinite(spec.msPerNote) || spec.msPerNote < MIN_MS_PER_NOTE || spec.msPerNote > MAX_MS_PER_NOTE) {
    errors.push({
      field: 'msPerNote',
      message: `Each note must last between ${MIN_MS_PER_NOTE / 1000}s and ${MAX_MS_PER_NOTE / 1000}s.`,
    });
  }

  // A hold longer than the note's own window can never be satisfied — the
  // target ends before the singer can accumulate enough stable time.
  if (spec.scoringStrategy === 'stable-hold') {
    const hold = spec.holdDurationMs ?? 0;
    if (hold <= 0) {
      errors.push({ field: 'holdDurationMs', message: 'Set how long each note must be held.' });
    } else if (hold > spec.msPerNote) {
      errors.push({ field: 'holdDurationMs', message: 'Hold time cannot be longer than the note itself.' });
    }
  }

  return errors;
}

/** True when `id` refers to a user-created exercise rather than a built-in. */
export function isCustomExerciseId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

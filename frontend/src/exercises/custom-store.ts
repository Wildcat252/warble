/**
 * localStorage persistence for user-created exercise specs.
 *
 * Mirrors services/user-settings.ts: every storage access is wrapped, because
 * localStorage throws (not returns null) in private-mode Safari and when a
 * quota is exceeded. A singer losing their custom exercises is bad; the app
 * crashing on a screen that merely *lists* them is worse.
 *
 * Specs are stored as one JSON array under a single key rather than a key per
 * exercise — the list is small and always read in full, and one key keeps
 * reads/writes atomic with respect to each other.
 */
import { STORAGE_PREFIX } from '../branding';
import {
  CUSTOM_EXERCISE_SCHEMA_VERSION, CUSTOM_ID_PREFIX,
  type CustomExerciseSpec,
} from './custom-types';

const CUSTOM_EXERCISES_KEY = `${STORAGE_PREFIX}.custom-exercises.v1`;

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Structural check on one parsed entry. localStorage is user-writable and
 * survives app upgrades, so anything read back is untrusted input — a spec
 * with a missing `steps` array would otherwise throw inside generate() during
 * an exercise, long after the bad data was read.
 */
function isValidStoredSpec(value: unknown): value is CustomExerciseSpec {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Partial<CustomExerciseSpec>;
  return (
    typeof spec.id === 'string' && spec.id.startsWith(CUSTOM_ID_PREFIX)
    && typeof spec.title === 'string'
    && typeof spec.msPerNote === 'number'
    && Array.isArray(spec.steps)
    && spec.steps.every((s) => typeof s === 'object' && s !== null && typeof s.offset === 'number')
  );
}

/** Reads every stored spec, silently dropping any that no longer parse. */
export function loadCustomExerciseSpecs(): CustomExerciseSpec[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOM_EXERCISES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop rather than throw: one corrupt entry must not hide the others.
    return parsed.filter(isValidStoredSpec);
  } catch {
    return [];
  }
}

/** Overwrites the whole list. Returns false when persistence failed (quota, private mode). */
function persistAll(specs: CustomExerciseSpec[]): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(CUSTOM_EXERCISES_KEY, JSON.stringify(specs));
    return true;
  } catch {
    return false;
  }
}

export function getCustomExerciseSpec(id: string): CustomExerciseSpec | undefined {
  return loadCustomExerciseSpecs().find((s) => s.id === id);
}

/**
 * Generates a collision-free id. Uses a timestamp plus a random suffix rather
 * than a slug of the title, so renaming an exercise never changes its id —
 * practice-log entries reference exercises by id and would otherwise lose
 * their title on the Progress screen after a rename.
 */
function newCustomId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}-${random}`;
}

export interface NewCustomExerciseInput {
  title: string;
  description: string;
  difficulty: CustomExerciseSpec['difficulty'];
  scoringStrategy: CustomExerciseSpec['scoringStrategy'];
  steps: CustomExerciseSpec['steps'];
  msPerNote: number;
  holdDurationMs?: number;
}

/** Creates and persists a new spec. Returns it, or null if storage was unavailable. */
export function createCustomExercise(input: NewCustomExerciseInput): CustomExerciseSpec | null {
  const now = new Date().toISOString();
  const spec: CustomExerciseSpec = {
    schemaVersion: CUSTOM_EXERCISE_SCHEMA_VERSION,
    id: newCustomId(),
    ...input,
    createdAt: now,
    updatedAt: now,
  };
  const all = loadCustomExerciseSpecs();
  all.push(spec);
  return persistAll(all) ? spec : null;
}

/**
 * Applies edits to an existing spec. `id`, `createdAt` and `schemaVersion` are
 * not editable — see newCustomId for why the id in particular is immutable.
 * Returns the updated spec, or null if it wasn't found or storage failed.
 */
export function updateCustomExercise(
  id: string,
  input: NewCustomExerciseInput,
): CustomExerciseSpec | null {
  const all = loadCustomExerciseSpecs();
  const index = all.findIndex((s) => s.id === id);
  if (index === -1) return null;

  const updated: CustomExerciseSpec = {
    ...all[index],
    ...input,
    updatedAt: new Date().toISOString(),
  };
  all[index] = updated;
  return persistAll(all) ? updated : null;
}

/** Removes a spec. Returns false if it wasn't found or storage failed. */
export function deleteCustomExercise(id: string): boolean {
  const all = loadCustomExerciseSpecs();
  const remaining = all.filter((s) => s.id !== id);
  if (remaining.length === all.length) return false;
  return persistAll(remaining);
}

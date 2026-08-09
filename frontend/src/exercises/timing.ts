/**
 * ms-keyed scheduling for exercise target notes — structural analog of
 * pitch/accuracy.ts::expectedNoteAtBeat, but keyed on startMs/endMs instead
 * of beat_start/duration (exercises have no score/tempo-mark concept).
 *
 * Kept as a separate function rather than generalizing expectedNoteAtBeat
 * itself, to avoid coupling that score-shaped function to a shape it
 * doesn't need.
 */
import type { ExerciseTargetNote } from './types';

/**
 * Returns the target note active at `elapsedMs`, or null if none is active
 * (before the first target, in a gap, or after the last target ends).
 *
 * Assumes `targets` is sorted ascending by startMs and non-overlapping —
 * true of every exercises/catalog.ts generator.
 */
export function expectedTargetAtTime(elapsedMs: number, targets: ExerciseTargetNote[]): ExerciseTargetNote | null {
  if (targets.length === 0) return null;

  let lo = 0;
  let hi = targets.length - 1;
  let idx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid].startMs <= elapsedMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (idx < 0) return null;
  const candidate = targets[idx];
  return elapsedMs >= candidate.startMs && elapsedMs < candidate.endMs ? candidate : null;
}

/** Total duration of an exercise, i.e. the end time of its last target. */
export function exerciseDurationMs(targets: ExerciseTargetNote[]): number {
  if (targets.length === 0) return 0;
  return targets[targets.length - 1].endMs;
}

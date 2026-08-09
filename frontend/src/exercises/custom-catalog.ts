/**
 * Compiles stored CustomExerciseSpec data into real ExerciseDefinition
 * objects, so everything downstream — exercise-player, scoring, the practice
 * log, the results screen — treats a user-created exercise exactly like a
 * built-in. The spec/definition split exists because ExerciseDefinition
 * carries a `generate()` function that can't be serialized; see
 * custom-types.ts.
 */
import type { ExerciseDefinition, ExerciseGenerationContext, ExerciseTargetNote } from './types';
import type { CustomExerciseSpec } from './custom-types';
import { loadCustomExerciseSpecs, getCustomExerciseSpec } from './custom-store';

/**
 * Custom exercises are all reported as 'note-hold' kind.
 *
 * ExerciseKind drives presentation only (labels and the Progress screen's
 * grouping) — the runtime branches on scoringStrategy, not kind. A freeform
 * user sequence genuinely isn't a scale-climb or an interval-jump, and
 * inventing a 'custom' kind would mean touching every exhaustive switch on
 * ExerciseKind for no behavioural gain.
 */
const CUSTOM_EXERCISE_KIND = 'note-hold' as const;

/** XP for a custom exercise, scaled by length so a 3-note drill isn't worth as much as a 20-note one. */
function xpForSpec(spec: CustomExerciseSpec): number {
  const PER_STEP_XP = 4;
  const MIN_XP = 10;
  const MAX_XP = 80; // capped so a 64-step exercise can't out-earn every built-in
  return Math.max(MIN_XP, Math.min(MAX_XP, spec.steps.length * PER_STEP_XP));
}

export function specToDefinition(spec: CustomExerciseSpec): ExerciseDefinition {
  return {
    id: spec.id,
    kind: CUSTOM_EXERCISE_KIND,
    scoringStrategy: spec.scoringStrategy,
    title: spec.title,
    description: spec.description,
    difficulty: spec.difficulty,
    estSeconds: Math.round((spec.steps.length * spec.msPerNote) / 1000),
    xpBase: xpForSpec(spec),
    holdDurationMs: spec.scoringStrategy === 'stable-hold' ? spec.holdDurationMs : undefined,
    generate(ctx: ExerciseGenerationContext): ExerciseTargetNote[] {
      return spec.steps.map((step, i) => ({
        midi: ctx.anchorMidi + step.offset,
        startMs: i * spec.msPerNote,
        endMs: (i + 1) * spec.msPerNote,
        label: step.label,
      }));
    },
  };
}

/**
 * Every user-created exercise, newest first — the ordering the picker wants,
 * since a just-created exercise is the one you're most likely to play next.
 * Read fresh from storage on each call rather than cached, so an edit made in
 * the editor is visible the moment the picker re-renders.
 */
export function getCustomExercises(): ExerciseDefinition[] {
  return loadCustomExerciseSpecs()
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(specToDefinition);
}

export function getCustomExerciseById(id: string): ExerciseDefinition | undefined {
  const spec = getCustomExerciseSpec(id);
  return spec ? specToDefinition(spec) : undefined;
}

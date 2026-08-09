/**
 * v1 exercise catalog — see the "Exercise engine" section of the Warble
 * rework plan for the source table. Each entry's `generate()` is a pure
 * function of the anchor pitch so the same catalog produces a
 * voice-appropriate sequence for any singer.
 */
import type { ExerciseDefinition, ExerciseGenerationContext, ExerciseTargetNote } from './types';
import { buildWarmupSequence, type WarmupSegment } from '../warmup/session';
import { isCustomExerciseId } from './custom-types';
import { getCustomExerciseById } from './custom-catalog';

/** 1:1 adapter — guided-warmup reuses warmup/session.ts's generator verbatim, zero new scheduling logic. */
function warmupSegmentsToTargets(segments: WarmupSegment[]): ExerciseTargetNote[] {
  return segments.map((seg) => ({ midi: seg.midi, startMs: seg.startMs, endMs: seg.endMs, label: seg.exercise }));
}

/** Builds a sequence of equal-length, back-to-back targets from semitone offsets off the anchor. */
function targetsFromOffsets(
  anchorMidi: number,
  offsets: number[],
  msPerNote: number,
  labels?: string[],
): ExerciseTargetNote[] {
  return offsets.map((offset, i) => ({
    midi: anchorMidi + offset,
    startMs: i * msPerNote,
    endMs: (i + 1) * msPerNote,
    label: labels?.[i],
  }));
}

const NOTE_HOLD_WINDOW_MS = 6000;
const GUIDED_WARMUP_SECONDS = 120; // matches the old default warm-up duration (2 min)

export const noteHoldBasic: ExerciseDefinition = {
  id: 'note-hold-basic',
  kind: 'note-hold',
  scoringStrategy: 'stable-hold',
  title: 'Note Hold',
  description: 'Match and hold three notes steadily: the root, a major 3rd above, and a 5th above.',
  difficulty: 'easy',
  estSeconds: 18,
  xpBase: 30,
  holdDurationMs: 1200,
  generate(ctx: ExerciseGenerationContext): ExerciseTargetNote[] {
    return [
      { midi: ctx.anchorMidi, startMs: 0, endMs: NOTE_HOLD_WINDOW_MS, label: 'Root' },
      { midi: ctx.anchorMidi + 4, startMs: NOTE_HOLD_WINDOW_MS, endMs: NOTE_HOLD_WINDOW_MS * 2, label: 'Major 3rd' },
      { midi: ctx.anchorMidi + 7, startMs: NOTE_HOLD_WINDOW_MS * 2, endMs: NOTE_HOLD_WINDOW_MS * 3, label: '5th' },
    ];
  },
};

const MAJOR_SCALE_UP_DOWN_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0];

export const scaleClimbMajor: ExerciseDefinition = {
  id: 'scale-climb-major',
  kind: 'scale-climb',
  scoringStrategy: 'continuous-cents',
  title: 'Major Scale Climb',
  description: 'Sing a major scale up an octave and back down, one note at a time.',
  difficulty: 'medium',
  estSeconds: Math.round((MAJOR_SCALE_UP_DOWN_OFFSETS.length * 900) / 1000),
  xpBase: 50,
  generate(ctx: ExerciseGenerationContext): ExerciseTargetNote[] {
    return targetsFromOffsets(ctx.anchorMidi, MAJOR_SCALE_UP_DOWN_OFFSETS, 900);
  },
};

const FIFTHS_INTERVAL_OFFSETS = [0, 7, 0, 4, 0, 12, 0];
const FIFTHS_INTERVAL_LABELS = ['Root', '5th', 'Root', 'Major 3rd', 'Root', 'Octave', 'Root'];

export const intervalJumpFifths: ExerciseDefinition = {
  id: 'interval-jump-fifths',
  kind: 'interval-jump',
  scoringStrategy: 'continuous-cents',
  title: 'Interval Jumps',
  description: 'Jump between the root and a 5th, 3rd, and octave above — no gliding, land on each note directly.',
  difficulty: 'hard',
  estSeconds: Math.round((FIFTHS_INTERVAL_OFFSETS.length * 1500) / 1000),
  xpBase: 60,
  generate(ctx: ExerciseGenerationContext): ExerciseTargetNote[] {
    return targetsFromOffsets(ctx.anchorMidi, FIFTHS_INTERVAL_OFFSETS, 1500, FIFTHS_INTERVAL_LABELS);
  },
};

export const guidedWarmup: ExerciseDefinition = {
  id: 'guided-warmup',
  kind: 'guided-warmup',
  scoringStrategy: 'continuous-cents',
  title: 'Guided Warm-up',
  description: 'A 2-minute guided sequence: sirens, sustained notes, a scale, then a range stretch.',
  difficulty: 'easy',
  estSeconds: GUIDED_WARMUP_SECONDS,
  xpBase: 20,
  generate(ctx: ExerciseGenerationContext): ExerciseTargetNote[] {
    return warmupSegmentsToTargets(buildWarmupSequence(GUIDED_WARMUP_SECONDS, ctx.anchorMidi));
  },
};

export const EXERCISE_CATALOG: ExerciseDefinition[] = [
  noteHoldBasic,
  scaleClimbMajor,
  intervalJumpFifths,
  guidedWarmup,
];

/**
 * Resolves any exercise id — built-in or user-created.
 *
 * Custom exercises are checked second and only for ids carrying the
 * `custom:` prefix, so a built-in can never be shadowed by stored data and
 * the common path stays a plain array scan with no localStorage read.
 * Everything that renders an exercise (player, results, progress) goes
 * through here, which is why custom exercises needed no changes in any of
 * those screens.
 */
export function getExerciseById(id: string): ExerciseDefinition | undefined {
  const builtIn = EXERCISE_CATALOG.find((ex) => ex.id === id);
  if (builtIn) return builtIn;
  return isCustomExerciseId(id) ? getCustomExerciseById(id) : undefined;
}

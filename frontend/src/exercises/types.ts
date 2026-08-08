/**
 * Exercise data model.
 *
 * One shared, time-scheduled contract for every exercise kind (note-hold,
 * scale-climb, interval-jump, guided-warmup). They differ only in how
 * `generate()` builds the target sequence and which ScoringStrategy grades
 * each target — see scoring.ts. This keeps the runtime (exercise-player: one
 * clock, one graph, one WS connection, one scoring pass) identical across
 * every exercise, at the cost of note-hold feeling slightly more paced than
 * a "wait as long as you need" UX — an accepted v1 tradeoff (see the Warble
 * rework plan, section 4).
 */

export type ExerciseKind = 'note-hold' | 'scale-climb' | 'interval-jump' | 'guided-warmup';

export type ScoringStrategy = 'continuous-cents' | 'stable-hold';

export interface ExerciseTargetNote {
  midi: number;
  startMs: number;
  endMs: number;
  /** Optional on-screen label, e.g. solfège ("Do") or interval name ("5th"). */
  label?: string;
}

export interface ExerciseGenerationContext {
  /** Comfortable reference pitch — from voice type / last range test, defaults to C4 (60). */
  anchorMidi: number;
  rangeLowMidi?: number;
  rangeHighMidi?: number;
}

export interface ExerciseDefinition {
  id: string;
  kind: ExerciseKind;
  scoringStrategy: ScoringStrategy;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  estSeconds: number;
  xpBase: number;
  /** Only meaningful when scoringStrategy === 'stable-hold'. */
  holdDurationMs?: number;
  generate(ctx: ExerciseGenerationContext): ExerciseTargetNote[];
}

export interface ExerciseTargetResult {
  target: ExerciseTargetNote;
  achievedMidi: number | null;
  hit: boolean;
}

export interface ExerciseAttemptResult {
  exerciseId: string;
  startedAt: string;
  completedAt: string;
  perTarget: ExerciseTargetResult[];
  accuracyPct: number;
  xpEarned: number;
}

export const DEFAULT_ANCHOR_MIDI = 60; // C4

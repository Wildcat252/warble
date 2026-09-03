/**
 * Scoring functions for the two ScoringStrategy values (see types.ts).
 * Both are built on pitch/accuracy.ts's existing cents math so "in tune"
 * means the same thing here as it does everywhere else in the app.
 */
import { centsOffPitch, GREEN_CENTS_THRESHOLD, MIN_CONFIDENCE_FOR_DOT } from '../pitch/accuracy';
import type { StableNoteState } from '../pitch/stable-note';
import type { ExerciseTargetNote } from './types';

export interface ContinuousCentsResult {
  hit: boolean;
  /** Average |cents off pitch| across confident frames; Infinity if none were confident. */
  avgAbsCents: number;
}

/** A collected pitch frame, timestamped in the same elapsed-ms base as targets. */
export interface ScoredFrame {
  t: number;
  midi: number;
  conf: number;
}

/**
 * Opening slice of each target that is NOT scored.
 *
 * Targets are back-to-back, so the time a singer spends travelling from the
 * previous pitch to this one falls inside this target's window. Averaging it
 * in scores the journey as if it were the destination: simulated against the
 * real catalog, a singer holding pitch PERFECTLY scored 3% on the guided
 * warm-up's siren phase (5-7 semitone jumps every 800ms) — only a singer who
 * teleported between pitches could pass it. Excluding the opening restores
 * that to 100% while still failing anyone genuinely off pitch: at 60 cents of
 * error the phase still scores 0%.
 */
export const SETTLE_MS = 250;

/** Never swallow more than half a target, so short notes stay scoreable. */
const MAX_SETTLE_FRACTION = 0.5;

/**
 * Scores a moving-target window (scale-climb, interval-jump, guided-warmup)
 * by averaging |cents off pitch| across frames collected while the target
 * was active. Frames below MIN_CONFIDENCE_FOR_DOT are excluded — same
 * confidence bar the live pitch dot itself uses, so a silent/unvoiced gap in
 * the window doesn't get scored as "off pitch" — as are frames inside the
 * target's settle period (see SETTLE_MS).
 */
export function scoreContinuousCents(
  framesInWindow: ScoredFrame[],
  target: ExerciseTargetNote,
): ContinuousCentsResult {
  const confident = framesInWindow.filter((f) => f.conf >= MIN_CONFIDENCE_FOR_DOT);
  if (confident.length === 0) {
    return { hit: false, avgAbsCents: Infinity };
  }

  const settleMs = Math.min(SETTLE_MS, (target.endMs - target.startMs) * MAX_SETTLE_FRACTION);
  const settled = confident.filter((f) => f.t >= target.startMs + settleMs);
  // If every confident frame landed in the settle period the singer sang only
  // at the very start of the note; score them rather than returning a
  // guaranteed miss for frames we did hear.
  const scored = settled.length > 0 ? settled : confident;

  const totalAbsCents = scored.reduce(
    (sum, f) => sum + Math.abs(centsOffPitch(f.midi, target.midi)),
    0,
  );
  const avgAbsCents = totalAbsCents / scored.length;
  return { hit: avgAbsCents <= GREEN_CENTS_THRESHOLD, avgAbsCents };
}

export interface StableHoldResult {
  hit: boolean;
  achievedMidi: number | null;
}

/**
 * Scores a note-hold target: did StableNoteDetector ever report a stable
 * pitch within `toleranceCents` of the target while the target was active?
 * `states` is the sequence of StableNoteDetector.pushFrame() results
 * collected during the target's window.
 */
export function scoreStableHold(
  states: StableNoteState[],
  targetMidi: number,
  toleranceCents: number = GREEN_CENTS_THRESHOLD,
): StableHoldResult {
  for (const state of states) {
    if (state.stableMidi === null) continue;
    if (Math.abs(centsOffPitch(state.stableMidi, targetMidi)) <= toleranceCents) {
      return { hit: true, achievedMidi: state.stableMidi };
    }
  }
  return { hit: false, achievedMidi: null };
}

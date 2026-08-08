/**
 * Scoring functions for the two ScoringStrategy values (see types.ts).
 * Both are built on pitch/accuracy.ts's existing cents math so "in tune"
 * means the same thing here as it does everywhere else in the app.
 */
import { centsOffPitch, GREEN_CENTS_THRESHOLD, MIN_CONFIDENCE_FOR_DOT } from '../pitch/accuracy';
import type { StableNoteState } from '../pitch/stable-note';

export interface ContinuousCentsResult {
  hit: boolean;
  /** Average |cents off pitch| across confident frames; Infinity if none were confident. */
  avgAbsCents: number;
}

/**
 * Scores a moving-target window (scale-climb, interval-jump, guided-warmup)
 * by averaging |cents off pitch| across frames collected while the target
 * was active. Frames below MIN_CONFIDENCE_FOR_DOT are excluded — same
 * confidence bar the live pitch dot itself uses, so a silent/unvoiced gap in
 * the window doesn't get scored as "off pitch".
 */
export function scoreContinuousCents(
  framesInWindow: { midi: number; conf: number }[],
  targetMidi: number,
): ContinuousCentsResult {
  const confidentFrames = framesInWindow.filter((f) => f.conf >= MIN_CONFIDENCE_FOR_DOT);
  if (confidentFrames.length === 0) {
    return { hit: false, avgAbsCents: Infinity };
  }

  const totalAbsCents = confidentFrames.reduce(
    (sum, f) => sum + Math.abs(centsOffPitch(f.midi, targetMidi)),
    0,
  );
  const avgAbsCents = totalAbsCents / confidentFrames.length;
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

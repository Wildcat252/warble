/**
 * Derives a MIDI pitch range from an exercise's target notes, padded for
 * display. Replaces score-analyser.ts::analysePartPitchRange (which needed
 * a ScoreModel) now that targets come from exercises/catalog.ts instead of
 * a parsed score.
 */
import type { ExerciseTargetNote } from './types';

export interface MidiRange {
  minMidi: number;
  maxMidi: number;
}

const DEFAULT_PADDING_SEMITONES = 3;

/** Falls back to a one-octave range centered on C4 when there are no targets. */
const FALLBACK_RANGE: MidiRange = { minMidi: 60 - 6, maxMidi: 60 + 6 };

export function rangeFromTargets(
  targets: ExerciseTargetNote[],
  paddingSemitones: number = DEFAULT_PADDING_SEMITONES,
): MidiRange {
  if (targets.length === 0) return FALLBACK_RANGE;

  let min = targets[0].midi;
  let max = targets[0].midi;
  for (const target of targets) {
    if (target.midi < min) min = target.midi;
    if (target.midi > max) max = target.midi;
  }

  return { minMidi: min - paddingSemitones, maxMidi: max + paddingSemitones };
}

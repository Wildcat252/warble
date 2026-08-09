export type DotColor = 'green' | 'amber' | 'red' | 'grey';
export type CentsBand = 'green' | 'amber' | 'red';

export const GREEN_CENTS_THRESHOLD = 50;
export const AMBER_CENTS_THRESHOLD = 100;
// Kept in sync with backend/audio/pitch.py's CONFIDENCE_THRESHOLD — a
// frontend floor HIGHER than the backend's would silently re-gate frames the
// backend already decided were good enough to send. Both were 0.6, which
// measurement showed accepts 0% of real singing through a laptop mic (see
// that constant's comment for the measured ambient-vs-voice separation).
export const MIN_CONFIDENCE_FOR_DOT = 0.25;
export const MIN_CONFIDENCE_FOR_SUMMARY = 0.25;

// expectedNoteAtBeat() lived here until the Warble rework. It resolved the
// active note from a parsed MusicXML score by beat position; exercises are
// scheduled in milliseconds instead, so its replacement is
// exercises/timing.ts::expectedTargetAtTime.

export function centsOffPitch(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

export function classifyByCents(absCents: number): CentsBand {
  if (absCents <= GREEN_CENTS_THRESHOLD) return 'green';
  if (absCents <= AMBER_CENTS_THRESHOLD) return 'amber';
  return 'red';
}

export function isWithinTolerance(absCents: number): boolean {
  return absCents <= GREEN_CENTS_THRESHOLD;
}

export function classifyPitchColor(
  sungMidi: number,
  expectedMidi: number,
  conf: number,
  confidenceThreshold = MIN_CONFIDENCE_FOR_DOT,
): DotColor {
  if (conf < confidenceThreshold) return 'grey';
  return classifyByCents(Math.abs(centsOffPitch(sungMidi, expectedMidi)));
}

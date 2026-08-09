export type VoiceTypeId = 'bass' | 'baritone' | 'tenor' | 'alto' | 'mezzo-soprano' | 'soprano';

export interface VoiceType {
  id: VoiceTypeId;
  label: string;
  lowMidi: number;
  highMidi: number;
  male: boolean;
}

export interface VoiceTypeClassificationInput {
  lowestMidi: number;
  highestMidi: number;
  stableNoteCount: number;
}

export const VOICE_TYPES: VoiceType[] = [
  { id: 'bass', label: 'Bass', lowMidi: 40, highMidi: 64, male: true },
  { id: 'baritone', label: 'Baritone', lowMidi: 43, highMidi: 67, male: true },
  { id: 'tenor', label: 'Tenor', lowMidi: 48, highMidi: 72, male: true },
  { id: 'alto', label: 'Alto', lowMidi: 55, highMidi: 79, male: false },
  { id: 'mezzo-soprano', label: 'Mezzo-soprano', lowMidi: 57, highMidi: 81, male: false },
  { id: 'soprano', label: 'Soprano', lowMidi: 60, highMidi: 84, male: false },
];

const MIN_STABLE_NOTES = 10;
const MIN_SEMITONE_SPAN = 5;
/**
 * Wider than ~4 octaves is not a human comfortable range — it means the
 * measurement picked up octave errors or noise, so classifying it would be
 * inventing a confident answer from bad input.
 */
const MAX_SEMITONE_SPAN = 48;

/**
 * Classify from a measured range alone, matching the range's midpoint to the
 * nearest voice type's midpoint.
 *
 * Deliberately has NO opinion about how the range was measured — that is the
 * caller's business, because the two callers have genuinely different quality
 * signals:
 *
 *   - The vocal range test asks the singer to glide to each extreme, so its
 *     evidence is "we captured both endpoints with a plausible span". Gliding
 *     by design never settles on discrete pitches.
 *   - Passive tracking across a practice session has no deliberate endpoints,
 *     so it needs a proxy for "we have heard enough of this voice" — see
 *     classifyVoiceType() below.
 *
 * Conflating the two is what made a perfectly good G2–E5 range test return no
 * suggestion: it was being judged by the passive tracker's stable-note count,
 * which gliding cannot satisfy.
 */
export function voiceTypeForRange(lowestMidi: number, highestMidi: number): VoiceType | null {
  if (!Number.isFinite(lowestMidi) || !Number.isFinite(highestMidi)) return null;
  const span = highestMidi - lowestMidi;
  if (!Number.isFinite(span) || span < MIN_SEMITONE_SPAN || span > MAX_SEMITONE_SPAN) return null;

  const midpoint = (lowestMidi + highestMidi) / 2;
  let bestMatch: VoiceType | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const voiceType of VOICE_TYPES) {
    const voiceMidpoint = (voiceType.lowMidi + voiceType.highMidi) / 2;
    const distance = Math.abs(midpoint - voiceMidpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = voiceType;
    }
  }

  return bestMatch;
}

/**
 * Classify a range gathered incidentally over a practice session, where the
 * singer was not deliberately probing their limits. Requires enough distinct
 * stable notes to trust that the extremes are real rather than stray frames.
 */
export function classifyVoiceType(input: VoiceTypeClassificationInput): VoiceType | null {
  if (input.stableNoteCount < MIN_STABLE_NOTES) return null;
  return voiceTypeForRange(input.lowestMidi, input.highestMidi);
}

export function getVoiceTypeById(id: string | null): VoiceType | null {
  if (!id) return null;
  return VOICE_TYPES.find((voiceType) => voiceType.id === id) ?? null;
}

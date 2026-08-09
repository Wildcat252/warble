/**
 * Resolves the singer's anchor pitch — the reference every exercise's note
 * offsets are built around.
 *
 * Extracted from exercise-player, which owned this privately until the
 * exercise editor needed the same number to show what a given semitone offset
 * actually sounds like. Two copies of this would drift, and a preview that
 * disagreed with playback is worse than no preview.
 */
import { getVoiceTypeById } from '../pitch/voice-type';
import { loadUserVoiceTypeId } from '../services/user-settings';
import { DEFAULT_ANCHOR_MIDI } from './types';

/**
 * Midpoint of the voice type's range, or C4 when no voice type is set.
 * The midpoint (rather than the low end) leaves headroom in both directions,
 * since exercises commonly reach an octave above the anchor.
 */
export function resolveAnchorMidi(): number {
  const voiceType = getVoiceTypeById(loadUserVoiceTypeId());
  if (!voiceType) return DEFAULT_ANCHOR_MIDI;
  return Math.round((voiceType.lowMidi + voiceType.highMidi) / 2);
}

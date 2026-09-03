/**
 * `WarmupTonePlayer` used to be defined here; it's now `TonePlayer` in
 * audio/tone-player.ts (promoted so every exercise kind can use it, not
 * just guided warm-ups). Re-exported under the old name for the
 * still-on-disk-but-unregistered features/pitch-overlay — removed for real
 * in the Phase 9 cleanup pass, at which point this alias goes too.
 */
export { TonePlayer as WarmupTonePlayer } from '../audio/tone-player';

export interface WarmupSegment {
  exercise: 'sirens' | 'sustain' | 'scale' | 'range';
  startMs: number;
  endMs: number;
  midi: number;
  label: string;
}

/**
 * Shortest segment worth scoring. Mirrors MIN_SLOT_MS in
 * exercises/custom-types.ts (kept as a local constant rather than an import so
 * this module stays below exercises/ in the dependency order): under ~400ms a
 * note is shorter than the pitch pipeline's own settling time and can never be
 * scored as a hit. A phase whose remaining time is below this ends early
 * instead of emitting an unhittable stub.
 */
const MIN_SEGMENT_MS = 400;

/**
 * Rest inserted after each full pass of a pattern.
 *
 * Segments used to run back-to-back for the whole two minutes, which left the
 * singer no room to breathe — and because a breath produces no confident
 * pitch frames, every breath was scored as a missed note. A rest per phrase
 * (rather than per note) is how singers actually breathe.
 */
const BREATH_MS = 600;

export function buildWarmupSequence(totalSeconds: number, anchorMidi = 60): WarmupSegment[] {
  const clampedSeconds = Math.max(30, Math.min(300, totalSeconds));
  const totalMs = clampedSeconds * 1000;
  const phaseMs = totalMs / 4;
  const segments: WarmupSegment[] = [];

  const appendPattern = (
    exercise: WarmupSegment['exercise'],
    startMs: number,
    durationMs: number,
    pattern: number[],
    holdMs: number,
  ): void => {
    const phaseEnd = startMs + durationMs;
    let t = startMs;
    let i = 0;
    while (t < phaseEnd) {
      // Breathe between phrases, not between notes.
      if (i > 0 && i % pattern.length === 0) {
        t += BREATH_MS;
        if (t >= phaseEnd) break;
      }
      const midi = pattern[i % pattern.length] ?? anchorMidi;
      const endMs = Math.min(phaseEnd, t + holdMs);
      // Trailing stub at the phase boundary — end the phase rather than emit it.
      if (endMs - t < MIN_SEGMENT_MS) break;
      segments.push({
        exercise,
        startMs: t,
        endMs,
        midi,
        label: `${exercise}: ${midi}`,
      });
      t = endMs;
      i += 1;
    }
  };

  appendPattern('sirens', 0, phaseMs, [anchorMidi - 5, anchorMidi, anchorMidi + 5, anchorMidi + 12, anchorMidi + 5, anchorMidi], 800);
  appendPattern('sustain', phaseMs, phaseMs, [anchorMidi - 2, anchorMidi + 2, anchorMidi + 4], 3000);
  appendPattern('scale', phaseMs * 2, phaseMs, [anchorMidi, anchorMidi + 2, anchorMidi + 4, anchorMidi + 5, anchorMidi + 7, anchorMidi + 5, anchorMidi + 4, anchorMidi + 2], 650);
  appendPattern('range', phaseMs * 3, phaseMs, [anchorMidi - 4, anchorMidi - 2, anchorMidi, anchorMidi + 2, anchorMidi + 4, anchorMidi + 2, anchorMidi], 1000);

  return segments;
}

export function warmupMidiAt(elapsedMs: number, sequence: WarmupSegment[]): number | null {
  const seg = sequence.find((s) => elapsedMs >= s.startMs && elapsedMs < s.endMs);
  return seg?.midi ?? null;
}

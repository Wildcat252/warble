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
    let t = startMs;
    let i = 0;
    while (t < startMs + durationMs) {
      const midi = pattern[i % pattern.length] ?? anchorMidi;
      const endMs = Math.min(startMs + durationMs, t + holdMs);
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

import { GREEN_CENTS_THRESHOLD } from './accuracy';

export type GraphTraceColor = 'green' | 'red' | 'grey';

/**
 * Graph trace uses the same in-tune threshold as the score dot/phrase summary
 * so all pitch feedback surfaces remain visually consistent for singers.
 */
export const GRAPH_IN_TUNE_CENTS = GREEN_CENTS_THRESHOLD;

export function centsError(sungMidi: number, expectedMidi: number): number {
  return (sungMidi - expectedMidi) * 100;
}

export function classifyGraphTraceColor(sungMidi: number, expectedMidi: number | null): GraphTraceColor {
  if (expectedMidi === null) return 'grey';
  return Math.abs(centsError(sungMidi, expectedMidi)) <= GRAPH_IN_TUNE_CENTS ? 'green' : 'red';
}

/**
 * Rainbow pitch-height color scale (the "note highway" look) — the sung
 * trace and vertical scale bar are colored by WHERE a pitch sits in the
 * visible range, not by in-tune/out-of-tune accuracy. Accuracy feedback
 * still exists (see pitch/graph.ts's puck ring color), it's just no
 * longer the trace's own color.
 *
 * t=0 is the top of the visible range (highest pitch, green) sweeping
 * down through yellow/orange/red/magenta/purple to t=1 at the bottom
 * (lowest pitch, blue/teal) — a ~310° hue sweep, not a full 360° wrap,
 * so the two ends of the range don't visually collide back into green.
 */
const HUE_SWEEP_START_DEG = 150;
const HUE_SWEEP_SPAN_DEG = 310;

export function hueForNormalizedHeight(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const hue = HUE_SWEEP_START_DEG - clamped * HUE_SWEEP_SPAN_DEG;
  return ((hue % 360) + 360) % 360;
}

export function colorForMidi(
  midi: number,
  minMidi: number,
  maxMidi: number,
  saturation = 72,
  lightness = 58,
): string {
  const span = Math.max(1, maxMidi - minMidi);
  const normalizedFromBottom = Math.max(0, Math.min(1, (midi - minMidi) / span));
  const t = 1 - normalizedFromBottom; // 0 = top/high pitch, 1 = bottom/low pitch
  const hue = hueForNormalizedHeight(t);
  return `hsl(${hue.toFixed(1)}, ${saturation}%, ${lightness}%)`;
}

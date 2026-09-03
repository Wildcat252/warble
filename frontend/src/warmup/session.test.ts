import { describe, expect, it } from 'vitest';
import { buildWarmupSequence, warmupMidiAt } from './session';

/** Mirrors MIN_SEGMENT_MS in session.ts. */
const MIN_SEGMENT_MS = 400;

describe('warmup sequence', () => {
  it('fills the configured duration without overrunning it', () => {
    const sequence = buildWarmupSequence(120, 60);
    expect(sequence.length).toBeGreaterThan(10);
    expect(sequence[0]?.startMs).toBe(0);
    // Deliberately NOT an exact-fit assertion. The sequence used to land
    // precisely on the total only because each phase emitted a stub note to
    // fill its boundary — one of them 100ms long, far too short to ever be
    // sung or scored. Phases now end early rather than emit that stub, so the
    // contract is "fits inside, covers nearly all of it".
    const last = sequence.at(-1);
    expect(last?.endMs).toBeLessThanOrEqual(120000);
    expect(last?.endMs).toBeGreaterThan(118000);
  });

  it('never emits a note too short to sing', () => {
    for (const seconds of [30, 60, 120, 300]) {
      for (const segment of buildWarmupSequence(seconds, 60)) {
        expect(segment.endMs - segment.startMs).toBeGreaterThanOrEqual(MIN_SEGMENT_MS);
      }
    }
  });

  it('leaves gaps to breathe in', () => {
    // Back-to-back notes for two minutes gave the singer nowhere to breathe,
    // and a breath scores as a missed note because it produces no confident
    // pitch frames.
    const sequence = buildWarmupSequence(120, 60);
    let totalGapMs = 0;
    for (let i = 1; i < sequence.length; i += 1) {
      const gap = sequence[i].startMs - sequence[i - 1].endMs;
      expect(gap).toBeGreaterThanOrEqual(0); // never overlapping
      totalGapMs += gap;
    }
    expect(totalGapMs).toBeGreaterThan(5000);
  });

  it('respects minimum and maximum duration clamps', () => {
    const shortSeq = buildWarmupSequence(5, 60);
    const longSeq = buildWarmupSequence(1000, 60);
    expect(shortSeq.at(-1)?.endMs).toBeLessThanOrEqual(30000);
    expect(shortSeq.at(-1)?.endMs).toBeGreaterThan(29000);
    expect(longSeq.at(-1)?.endMs).toBeLessThanOrEqual(300000);
    expect(longSeq.at(-1)?.endMs).toBeGreaterThan(298000);
  });

  it('returns current target midi based on elapsed time', () => {
    const sequence = buildWarmupSequence(60, 60);
    const first = sequence[0];
    expect(warmupMidiAt(first.startMs, sequence)).toBe(first.midi);
    expect(warmupMidiAt((first.startMs + first.endMs) / 2, sequence)).toBe(first.midi);
    expect(warmupMidiAt(60000, sequence)).toBeNull();
  });

  it('reports no target during a breath', () => {
    const sequence = buildWarmupSequence(120, 60);
    const gapIndex = sequence.findIndex((s, i) => i > 0 && s.startMs > sequence[i - 1].endMs);
    expect(gapIndex).toBeGreaterThan(0);
    const midGap = (sequence[gapIndex - 1].endMs + sequence[gapIndex].startMs) / 2;
    expect(warmupMidiAt(midGap, sequence)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  AMBER_CENTS_THRESHOLD,
  GREEN_CENTS_THRESHOLD,
  MIN_CONFIDENCE_FOR_DOT,
  centsOffPitch,
  classifyByCents,
  classifyPitchColor,
  isWithinTolerance,
} from './accuracy';

describe('classifyPitchColor', () => {
  it('returns grey below MIN_CONFIDENCE_FOR_DOT, and colours at/above it', () => {
    // Derived from the constant rather than hardcoded, so retuning the
    // confidence threshold against real-mic data doesn't break this test.
    expect(classifyPitchColor(60, 60, MIN_CONFIDENCE_FOR_DOT - 0.01)).toBe('grey');
    expect(classifyPitchColor(60, 60, MIN_CONFIDENCE_FOR_DOT)).toBe('green');
  });

  // classifyPitchColor is only called when a target note is active, so it
  // does not accept null as expectedMidi.


  it('accepts a custom confidence threshold', () => {
    expect(classifyPitchColor(60, 60, 0.74, 0.75)).toBe('grey');
    expect(classifyPitchColor(60, 60, 0.75, 0.75)).toBe('green');
  });

  it('applies cents thresholds for green/amber/red', () => {
    expect(classifyPitchColor(60.49, 60, 0.8)).toBe('green');
    expect(classifyPitchColor(60.75, 60, 0.8)).toBe('amber');
    expect(classifyPitchColor(61.2, 60, 0.8)).toBe('red');
  });

  it('classifies a note exactly on the green boundary (50 cents inclusive)', () => {
    // 0.50 semitones = exactly 50 cents — boundary is inclusive for green
    expect(classifyPitchColor(60.50, 60, 0.8)).toBe('green');
  });

  it('classifies a note just inside amber (51 cents)', () => {
    // 0.51 semitones = 51 cents — just above green threshold
    expect(classifyPitchColor(60.51, 60, 0.8)).toBe('amber');
  });
});

describe('shared cents helpers', () => {
  it('computes signed cents from midi deltas', () => {
    expect(centsOffPitch(60.2, 60)).toBeCloseTo(20, 5);
    expect(centsOffPitch(59.8, 60)).toBeCloseTo(-20, 5);
  });

  it('classifies tolerance bands using shared constants', () => {
    expect(classifyByCents(GREEN_CENTS_THRESHOLD)).toBe('green');
    expect(classifyByCents(GREEN_CENTS_THRESHOLD + 1)).toBe('amber');
    expect(classifyByCents(AMBER_CENTS_THRESHOLD + 1)).toBe('red');
  });

  it('reports in-tolerance based on green threshold only', () => {
    expect(isWithinTolerance(49)).toBe(true);
    expect(isWithinTolerance(50)).toBe(true);
    expect(isWithinTolerance(51)).toBe(false);
  });
});

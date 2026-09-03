import { describe, expect, it } from 'vitest';
import { colorForMidi, colorForMidiAndRegister, traceWidthForRegister } from './graph-colors';

describe('register shading', () => {
  it('is byte-identical to the unshaded colour when register is unknown', () => {
    // Guards the promise that an uncalibrated graph looks exactly as before.
    for (const midi of [40, 55, 60, 72, 84]) {
      expect(colorForMidiAndRegister(midi, 36, 84, null)).toBe(colorForMidi(midi, 36, 84));
    }
  });

  it('darkens toward chest and lightens toward head', () => {
    const lightness = (s: string): number => Number(s.match(/,\s*([\d.]+)%\)$/)![1]);
    const chest = lightness(colorForMidiAndRegister(60, 36, 84, 0));
    const head = lightness(colorForMidiAndRegister(60, 36, 84, 1));
    expect(chest).toBeLessThan(head);
  });

  it('keeps hue reserved for pitch — register does not change it', () => {
    const hue = (s: string): number => Number(s.match(/hsl\(([\d.]+),/)![1]);
    expect(hue(colorForMidiAndRegister(60, 36, 84, 0)))
      .toBe(hue(colorForMidiAndRegister(60, 36, 84, 1)));
  });

  it('gives chest a thicker stroke than head, and the default when unknown', () => {
    expect(traceWidthForRegister(0, 7)).toBeGreaterThan(traceWidthForRegister(1, 7));
    expect(traceWidthForRegister(null, 7)).toBe(7);
  });
});

import { describe, expect, it } from 'vitest';

import { classifyVoiceType, getVoiceTypeById, voiceTypeForRange } from './voice-type';

describe('voiceTypeForRange', () => {
  it('classifies from range alone, with no stable-note requirement', () => {
    // The exact case that failed in the app: a valid glide-measured G2-E5
    // range returned no suggestion because it was judged by the passive
    // tracker's 10-stable-note gate, which gliding cannot satisfy.
    expect(voiceTypeForRange(43, 76)?.id).toBe('tenor'); // G2-E5
  });

  it('matches the nearest voice-type midpoint', () => {
    expect(voiceTypeForRange(41, 63)?.id).toBe('bass');
    expect(voiceTypeForRange(49, 71)?.id).toBe('tenor');
    expect(voiceTypeForRange(61, 83)?.id).toBe('soprano');
  });

  it('rejects a span too narrow to be a real vocal range', () => {
    expect(voiceTypeForRange(60, 64)).toBeNull();
  });

  it('rejects an implausibly wide span rather than inventing a confident answer', () => {
    // >4 octaves means octave errors or noise got into the measurement.
    expect(voiceTypeForRange(30, 90)).toBeNull();
  });

  it('rejects non-finite input', () => {
    expect(voiceTypeForRange(Number.NaN, 72)).toBeNull();
    expect(voiceTypeForRange(48, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('classifyVoiceType', () => {
  it('classifies bass ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 41, highestMidi: 63, stableNoteCount: 12 });
    expect(result?.id).toBe('bass');
  });

  it('classifies baritone ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 44, highestMidi: 66, stableNoteCount: 12 });
    expect(result?.id).toBe('baritone');
  });

  it('classifies tenor ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 49, highestMidi: 71, stableNoteCount: 12 });
    expect(result?.id).toBe('tenor');
  });

  it('classifies alto ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 55, highestMidi: 78, stableNoteCount: 12 });
    expect(result?.id).toBe('alto');
  });

  it('classifies mezzo-soprano ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 58, highestMidi: 80, stableNoteCount: 12 });
    expect(result?.id).toBe('mezzo-soprano');
  });

  it('classifies soprano ranges', () => {
    const result = classifyVoiceType({ lowestMidi: 61, highestMidi: 83, stableNoteCount: 12 });
    expect(result?.id).toBe('soprano');
  });

  it('returns null when there are not enough stable notes or span', () => {
    expect(classifyVoiceType({ lowestMidi: 48, highestMidi: 72, stableNoteCount: 9 })).toBeNull();
    expect(classifyVoiceType({ lowestMidi: 60, highestMidi: 64, stableNoteCount: 15 })).toBeNull();
  });

  it('still applies the stable-note gate that voiceTypeForRange deliberately omits', () => {
    const range = { lowestMidi: 43, highestMidi: 76 } as const;
    expect(voiceTypeForRange(range.lowestMidi, range.highestMidi)?.id).toBe('tenor');
    expect(classifyVoiceType({ ...range, stableNoteCount: 3 })).toBeNull();
  });
});

describe('getVoiceTypeById', () => {
  it('returns voice type for known id', () => {
    expect(getVoiceTypeById('tenor')?.label).toBe('Tenor');
  });

  it('returns null for unknown id', () => {
    expect(getVoiceTypeById('countertenor')).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const playInstrumentNote = vi.fn();
const getAudioContext = vi.fn(() => ({ state: 'running', currentTime: 0 }));

vi.mock('./instruments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./instruments')>()),
  playInstrumentNote,
}));
vi.mock('../services/audio-context', () => ({ getAudioContext }));

const { TonePlayer } = await import('./tone-player');

beforeEach(() => {
  playInstrumentNote.mockClear();
  getAudioContext.mockClear();
});

describe('TonePlayer', () => {
  it('sounds a target exactly once no matter how many frames call it', () => {
    const player = new TonePlayer('synth');
    // The exercise player calls this every animation frame for the whole
    // duration of a target — a 6s note at 60fps is ~360 calls.
    for (let i = 0; i < 360; i += 1) player.playTargetOnce(0, 60, 2);
    expect(playInstrumentNote).toHaveBeenCalledTimes(1);
  });

  it('sounds each target in turn', () => {
    const player = new TonePlayer('synth');
    player.playTargetOnce(0, 60, 2);
    player.playTargetOnce(1, 64, 2);
    player.playTargetOnce(2, 67, 2);
    expect(playInstrumentNote).toHaveBeenCalledTimes(3);
  });

  it('sounds both of two consecutive targets on the SAME pitch', () => {
    // The previous pitch-keyed guard collapsed this pair into one cue.
    const player = new TonePlayer('synth');
    player.playTargetOnce(0, 60, 2);
    player.playTargetOnce(1, 60, 2);
    expect(playInstrumentNote).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a null target or a null pitch', () => {
    const player = new TonePlayer('synth');
    player.playTargetOnce(null, 60, 2);
    player.playTargetOnce(0, null, 2);
    expect(playInstrumentNote).not.toHaveBeenCalled();
  });

  it('passes the target duration through, so the cue fills the note', () => {
    new TonePlayer('synth').playTargetOnce(0, 60, 3.5);
    expect(playInstrumentNote).toHaveBeenCalledWith(expect.anything(), 'synth', 60, expect.any(Number), 3.5);
  });

  it('migrates the legacy "piano" id to the struck variant', async () => {
    const { normalizeInstrumentId } = await import('./instruments');
    expect(normalizeInstrumentId('piano')).toBe('piano-struck');
  });

  it('passes the configured instrument through', () => {
    new TonePlayer('piano-struck').playTargetOnce(0, 60, 2);
    expect(playInstrumentNote).toHaveBeenCalledWith(expect.anything(), 'piano-struck', 60, expect.any(Number), 2);
  });

  it('re-cues the same target after reset, so a replay sounds again', () => {
    const player = new TonePlayer('synth');
    player.playTargetOnce(0, 60, 2);
    player.reset();
    player.playTargetOnce(0, 60, 2);
    expect(playInstrumentNote).toHaveBeenCalledTimes(2);
  });

  it('resumes a suspended AudioContext before scheduling', () => {
    const resume = vi.fn();
    getAudioContext.mockReturnValueOnce({ state: 'suspended', currentTime: 0, resume } as never);
    new TonePlayer('synth').playTargetOnce(0, 60, 2);
    expect(resume).toHaveBeenCalled();
  });
});

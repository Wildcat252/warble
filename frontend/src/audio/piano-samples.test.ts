import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_MIDIS, playPianoSample, preloadPianoSamples, resetPianoSamplesForTest,
} from './piano-samples';

const SAMPLE_RATE = 44100;

/**
 * Builds a fake decoded buffer: `silenceSec` of dead air (standing in for the
 * codec priming the real files carry) followed by a constant-amplitude body.
 */
function fakeBuffer(amplitude: number, silenceSec = 0): AudioBuffer {
  const silence = Math.floor(silenceSec * SAMPLE_RATE);
  const data = new Float32Array(silence + SAMPLE_RATE * 2);
  for (let i = silence; i < data.length; i += 1) {
    data[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return {
    sampleRate: SAMPLE_RATE,
    length: data.length,
    duration: data.length / SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

/**
 * Stereo buffer whose two channels sit at different levels — the real
 * recordings do this (up to 4.3dB apart), and normalising off channel 0 alone
 * measures a signal nobody hears.
 */
function fakeStereoBuffer(left: number, right: number): AudioBuffer {
  const make = (amplitude: number): Float32Array => {
    const data = new Float32Array(SAMPLE_RATE * 2);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 2 === 0 ? amplitude : -amplitude;
    return data;
  };
  const channels = [make(left), make(right)];
  return {
    sampleRate: SAMPLE_RATE,
    length: channels[0].length,
    duration: 2,
    numberOfChannels: 2,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

interface StartedSource {
  playbackRate: { value: number };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

let sources: StartedSource[] = [];
let gains: number[] = [];

function fakeContext(): AudioContext {
  return {
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    destination: {},
    decodeAudioData: vi.fn(),
    createBufferSource: () => {
      const source = {
        buffer: null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source as unknown as StartedSource);
      return source;
    },
    createGain: () => ({
      gain: {
        setValueAtTime: (value: number) => { gains.push(value); },
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }),
  } as unknown as AudioContext;
}

/** Serves every sample as `buffers[midi]`, or a default if unlisted. */
function mockFetch(buffers: Record<number, AudioBuffer>, fallback = fakeBuffer(0.5)): AudioContext {
  const ctx = fakeContext();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const midi = Number(/piano\/(\d+)\.aac/.exec(url)?.[1]);
    return {
      ok: true,
      arrayBuffer: async () => ({ midi }) as unknown as ArrayBuffer,
    };
  }));
  (ctx.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (raw: { midi: number }) => buffers[raw.midi] ?? fallback,
  );
  return ctx;
}

beforeEach(() => {
  resetPianoSamplesForTest();
  sources = [];
  gains = [];
  vi.unstubAllGlobals();
});

describe('preloadPianoSamples', () => {
  it('loads every recorded pitch', async () => {
    const ctx = mockFetch({});
    await preloadPianoSamples(ctx);
    expect(fetch).toHaveBeenCalledTimes(SAMPLE_MIDIS.length);
    expect(playPianoSample(ctx, 60, 0, 2)).toBe(true);
  });

  it('fetches only once however many callers ask', async () => {
    const ctx = mockFetch({});
    await Promise.all([preloadPianoSamples(ctx), preloadPianoSamples(ctx)]);
    await preloadPianoSamples(ctx);
    expect(fetch).toHaveBeenCalledTimes(SAMPLE_MIDIS.length);
  });

  it('survives a file that will not decode', async () => {
    const ctx = mockFetch({});
    (ctx.decodeAudioData as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (raw: { midi: number }) => {
        if (raw.midi === 60) throw new Error('EncodingError');
        return fakeBuffer(0.5);
      },
    );
    await preloadPianoSamples(ctx);
    // The broken pitch is simply absent; its neighbours still play.
    expect(playPianoSample(ctx, 63, 0, 2)).toBe(true);
  });
});

describe('playPianoSample', () => {
  it('reports a miss when nothing has been loaded, so the caller can fall back', () => {
    expect(playPianoSample(fakeContext(), 60, 0, 2)).toBe(false);
  });

  it('declines a note too far outside the recorded range to resample cleanly', async () => {
    const ctx = mockFetch({});
    await preloadPianoSamples(ctx);
    // The custom-exercise editor allows +/-24 semitones off the anchor, which
    // can land an octave past the top sample. Resampling that far sounds
    // absurd and shortens the cue, so the synth fallback takes it instead.
    expect(playPianoSample(ctx, 96, 0, 2)).toBe(false);
    expect(playPianoSample(ctx, 28, 0, 2)).toBe(false);
    // Just outside the set is still close enough to a sample to play.
    expect(playPianoSample(ctx, 86, 0, 2)).toBe(true);
    expect(playPianoSample(ctx, 34, 0, 2)).toBe(true);
  });

  it('plays a recorded pitch at its native rate', async () => {
    const ctx = mockFetch({});
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    expect(sources[0].playbackRate.value).toBeCloseTo(1, 10);
  });

  it('reaches an unrecorded pitch from the nearest sample, never further than a semitone', async () => {
    const ctx = mockFetch({});
    await preloadPianoSamples(ctx);
    // 61 is a semitone above the 60 sample; 62 is a semitone BELOW the 63 one.
    playPianoSample(ctx, 61, 0, 2);
    playPianoSample(ctx, 62, 0, 2);
    expect(sources[0].playbackRate.value).toBeCloseTo(2 ** (1 / 12), 10);
    expect(sources[1].playbackRate.value).toBeCloseTo(2 ** (-1 / 12), 10);
  });

  it('skips the silence the encoder leaves at the head of each file', async () => {
    const ctx = mockFetch({ 60: fakeBuffer(0.5, 0.047) });
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    // Second argument to start() is the offset into the buffer.
    expect(sources[0].start.mock.calls[0][1]).toBeCloseTo(0.047, 3);
  });

  it('does not trim anything when the buffer already starts on the attack', async () => {
    const ctx = mockFetch({ 60: fakeBuffer(0.5, 0) });
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    expect(sources[0].start.mock.calls[0][1]).toBe(0);
  });

  it('evens out the recorded level differences between notes', async () => {
    // The real set spans 10.8dB; a quiet note must come back louder than a
    // loud one by roughly the ratio between them.
    const ctx = mockFetch({ 60: fakeBuffer(0.4), 63: fakeBuffer(0.1) });
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    const loud = gains[0];
    gains = [];
    playPianoSample(ctx, 63, 0, 2);
    const quiet = gains[0];
    expect(quiet / loud).toBeCloseTo(4, 5);
  });

  it('measures loudness across both channels, not just the first', async () => {
    // Both notes carry the same total energy, just distributed differently
    // across the channels. Judged on channel 0 alone the second would come
    // back much louder; judged on both, they match.
    const ctx = mockFetch({
      60: fakeStereoBuffer(0.3, 0.3),
      63: fakeStereoBuffer(0.1, Math.sqrt(2 * 0.3 * 0.3 - 0.1 * 0.1)),
    });
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    const balanced = gains[0];
    gains = [];
    playPianoSample(ctx, 63, 0, 2);
    expect(gains[0]).toBeCloseTo(balanced, 5);
  });

  it('finds the onset from the earliest channel to attack', async () => {
    const stereo = fakeStereoBuffer(0.5, 0.5);
    // Silence only the left channel's opening, as an off-centre attack would.
    const left = stereo.getChannelData(0);
    for (let i = 0; i < Math.floor(0.2 * SAMPLE_RATE); i += 1) left[i] = 0;
    const ctx = mockFetch({ 60: stereo });
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    // The right channel starts immediately, so nothing should be trimmed.
    expect(sources[0].start.mock.calls[0][1]).toBe(0);
  });

  it('never boosts a sample into clipping', async () => {
    const ctx = mockFetch({ 60: fakeBuffer(0.001) });
    await preloadPianoSamples(ctx);
    playPianoSample(ctx, 60, 0, 2);
    expect(gains[0] * 0.001).toBeLessThanOrEqual(0.9);
  });
});

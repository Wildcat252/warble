import { beforeEach, describe, expect, it, vi } from 'vitest';

const playInstrumentNote = vi.fn();
vi.mock('./instruments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./instruments')>()),
  playInstrumentNote,
}));

const { KEY_PREVIEW_MS, playKeyPreview } = await import('./key-preview');

interface GainCall { value: number; time: number }

let ramps: GainCall[] = [];
let gainNode: { gain: Record<string, unknown> } | null = null;

function fakeContext(currentTime = 0): AudioContext {
  return {
    currentTime,
    destination: { id: 'speakers' },
    createGain: () => {
      const node = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: (value: number, time: number) => { ramps.push({ value, time }); },
        },
        connect: vi.fn(),
      };
      gainNode = node as never;
      return node;
    },
  } as unknown as AudioContext;
}

/** [midi, startAt, durationSec, destination] for each scheduled note, in call order. */
function scheduled(): { midi: number; at: number; dur: number; dest: unknown }[] {
  return playInstrumentNote.mock.calls.map((c) => ({ midi: c[2], at: c[3], dur: c[4], dest: c[5] }));
}

beforeEach(() => {
  playInstrumentNote.mockClear();
  ramps = [];
  gainNode = null;
  vi.useFakeTimers();
});

describe('playKeyPreview', () => {
  const opts = { anchorMidi: 60, firstTargetMidi: 67, instrument: 'piano' as const };

  it('states the key: root, perfect 5th, octave, then the triad', () => {
    playKeyPreview(fakeContext(), opts);
    const midis = scheduled().map((n) => n.midi);
    expect(midis.slice(0, 3)).toEqual([60, 67, 72]); // root, 5th, octave
    expect(midis.slice(3, 7)).toEqual([60, 64, 67, 72]); // major triad + octave
  });

  it('sounds the three opening notes one after another, not together', () => {
    playKeyPreview(fakeContext(), opts);
    const [root, fifth, octave] = scheduled();
    expect(fifth.at - root.at).toBeCloseTo(0.8, 5);
    expect(octave.at - fifth.at).toBeCloseTo(0.8, 5);
  });

  it('rolls the chord instead of striking it flat', () => {
    playKeyPreview(fakeContext(), opts);
    const chord = scheduled().slice(3, 7);
    for (let i = 1; i < chord.length; i += 1) {
      expect(chord[i].at - chord[i - 1].at).toBeCloseTo(0.045, 5);
    }
    // Rolled, but still one gesture — the whole spread is far shorter than a note.
    expect(chord[3].at - chord[0].at).toBeLessThan(0.2);
  });

  it("ends on the exercise's own first note, after a silence", () => {
    playKeyPreview(fakeContext(), opts);
    const notes = scheduled();
    const comeIn = notes.at(-1)!;
    const chordStart = notes[3].at;
    expect(comeIn.midi).toBe(67);
    // The gap is what marks this note out as the cue — nothing on screen does.
    // (Chord runs 1.7s from its start; the cue follows 0.4s after that.)
    expect(comeIn.at - chordStart).toBeCloseTo(2.1, 5);
  });

  it('cues the first target even when it is not the root', () => {
    playKeyPreview(fakeContext(), { ...opts, anchorMidi: 60, firstTargetMidi: 55 });
    expect(scheduled().at(-1)!.midi).toBe(55);
  });

  it('omits the come-in note when the exercise has no targets', () => {
    playKeyPreview(fakeContext(), { ...opts, firstTargetMidi: null });
    expect(scheduled()).toHaveLength(7); // 3 singles + 4 chord notes, nothing more
  });

  it('routes every note through one shared node, not the speakers', () => {
    const ctx = fakeContext();
    playKeyPreview(ctx, opts);
    // Skipping has to be able to cancel notes that are already scheduled,
    // which is only possible if they share a node the caller controls.
    const destinations = new Set(scheduled().map((n) => n.dest));
    expect(destinations.size).toBe(1);
    expect(destinations.has(ctx.destination)).toBe(false);
    expect(gainNode).not.toBeNull();
  });

  it('schedules against the audio clock, not from now', () => {
    playKeyPreview(fakeContext(1000), opts);
    // Every note is placed relative to the context's current time.
    expect(scheduled()[0].at).toBeGreaterThanOrEqual(1000);
  });

  describe('skip', () => {
    it('fades the passage out rather than cutting it dead', async () => {
      const handle = playKeyPreview(fakeContext(), opts);
      handle.skip();
      await handle.done;
      expect(ramps).toHaveLength(1);
      expect(ramps[0].value).toBeLessThan(0.001); // ramped to silence
      expect(ramps[0].time).toBeCloseTo(0.08, 5); // over a short, click-free fade
    });

    it('resolves immediately instead of waiting out the passage', async () => {
      const handle = playKeyPreview(fakeContext(), opts);
      let resolved = false;
      void handle.done.then(() => { resolved = true; });
      handle.skip();
      await handle.done;
      expect(resolved).toBe(true);
      // Nowhere near the full passage length.
      expect(KEY_PREVIEW_MS).toBeGreaterThan(4000);
    });

    it('is safe to call more than once', async () => {
      const handle = playKeyPreview(fakeContext(), opts);
      handle.skip();
      handle.skip();
      await handle.done;
      expect(ramps).toHaveLength(1);
    });

    it('resolves on its own when never skipped', async () => {
      const handle = playKeyPreview(fakeContext(), opts);
      let resolved = false;
      void handle.done.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(KEY_PREVIEW_MS + 100);
      expect(resolved).toBe(true);
      expect(ramps).toHaveLength(0); // no fade — it simply finished
    });
  });
});

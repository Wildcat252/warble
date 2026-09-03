import { beforeEach, describe, expect, it, vi } from 'vitest';

const playInstrumentNote = vi.fn();
vi.mock('../../audio/instruments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../audio/instruments')>()),
  playInstrumentNote,
}));

const { auditionNote, auditionSequence } = await import('./audition');
const INSTRUMENT = 'piano' as const;

let ramps: { value: number; time: number }[] = [];

function fakeContext(currentTime = 0): AudioContext {
  return {
    currentTime,
    destination: { id: 'speakers' },
    createGain: () => ({
      gain: {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: (value: number, time: number) => { ramps.push({ value, time }); },
      },
      connect: vi.fn(),
    }),
  } as unknown as AudioContext;
}

/** [midi, startAt, durationSec, destination] per scheduled note, in call order. */
function scheduled(): { midi: number; at: number; dur: number; dest: unknown }[] {
  return playInstrumentNote.mock.calls.map((c) => ({ midi: c[2], at: c[3], dur: c[4], dest: c[5] }));
}

beforeEach(() => {
  playInstrumentNote.mockClear();
  ramps = [];
  vi.useFakeTimers();
});

describe('auditionNote', () => {
  it('sounds the pitch asked for', () => {
    auditionNote(fakeContext(), 67, INSTRUMENT);
    expect(scheduled()).toHaveLength(1);
    expect(scheduled()[0].midi).toBe(67);
  });
});

describe('auditionSequence', () => {
  // Root at column 0 (2 wide), a rest at column 2, 5th at column 3.
  const notes = [
    { offset: 0, startSlot: 0, lengthSlots: 2 },
    { offset: 7, startSlot: 3, lengthSlots: 1 },
  ];
  const SLOT_MS = 1000;

  it('transposes each offset off the anchor', () => {
    auditionSequence(fakeContext(), notes, SLOT_MS, 60, INSTRUMENT);
    expect(scheduled().map((n) => n.midi)).toEqual([60, 67]);
  });

  it('keeps the rests — notes hold their grid positions', () => {
    auditionSequence(fakeContext(), notes, SLOT_MS, 60, INSTRUMENT);
    const [root, fifth] = scheduled();
    expect(root.dur).toBeCloseTo(2, 5);       // 2 columns
    expect(fifth.at - root.at).toBeCloseTo(3, 5); // starts at column 3, not packed after the root
  });

  it('plays notes in grid order however they were drawn', () => {
    const drawnBackwards = [notes[1], notes[0]];
    auditionSequence(fakeContext(), drawnBackwards, SLOT_MS, 60, INSTRUMENT);
    expect(scheduled().map((n) => n.midi)).toEqual([60, 67]);
  });

  it('schedules against the audio clock, not from zero', () => {
    auditionSequence(fakeContext(500), notes, SLOT_MS, 60, INSTRUMENT);
    expect(scheduled()[0].at).toBeGreaterThanOrEqual(500);
  });

  it('routes every note through one shared node, not the speakers', () => {
    const ctx = fakeContext();
    auditionSequence(ctx, notes, SLOT_MS, 60, INSTRUMENT);
    const destinations = new Set(scheduled().map((n) => n.dest));
    expect(destinations.size).toBe(1);
    expect(destinations.has(ctx.destination)).toBe(false);
  });

  it('fades out on stop rather than cutting dead', async () => {
    // Everything is scheduled up front, so stopping has to cancel notes that
    // have not started yet — only possible via the shared node.
    const handle = auditionSequence(fakeContext(), notes, SLOT_MS, 60, INSTRUMENT);
    handle.stop();
    await handle.done;
    expect(ramps).toHaveLength(1);
    expect(ramps[0].value).toBeLessThan(0.001);
    expect(ramps[0].time).toBeCloseTo(0.08, 5);
  });

  it('is safe to stop twice', async () => {
    const handle = auditionSequence(fakeContext(), notes, SLOT_MS, 60, INSTRUMENT);
    handle.stop();
    handle.stop();
    await handle.done;
    expect(ramps).toHaveLength(1);
  });

  it('resolves on its own at the end of the grid', async () => {
    const handle = auditionSequence(fakeContext(), notes, SLOT_MS, 60, INSTRUMENT);
    let resolved = false;
    void handle.done.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(4 * SLOT_MS + 100);
    expect(resolved).toBe(true);
    expect(ramps).toHaveLength(0); // finished, not faded
  });

  it('handles an empty grid without scheduling anything', async () => {
    const handle = auditionSequence(fakeContext(), [], SLOT_MS, 60, INSTRUMENT);
    expect(scheduled()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await expect(handle.done).resolves.toBeUndefined();
  });
});

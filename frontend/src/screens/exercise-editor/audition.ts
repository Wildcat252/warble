/**
 * Hearing what you are drawing.
 *
 * The editor was silent: you could place a dozen notes and never hear one of
 * them, which for a singing app is the wrong way round — the grid is a score,
 * and a score you cannot play back is guesswork.
 *
 * Notes are scheduled up front against the AudioContext clock rather than
 * fired from a chain of timers, so the sequence keeps time even when the main
 * thread is busy repainting the grid. That makes stopping the harder problem:
 * by the time the user hits Stop, everything is already scheduled. Hence the
 * shared gain node — the same approach audio/key-preview.ts uses, where
 * ramping one node down was measured to silence the entire passage.
 */
import { playInstrumentNote, type InstrumentId } from '../../audio/instruments';
import { sortedNotes, type CustomExerciseNote } from '../../exercises/custom-types';

/** Length of the note sounded when you place or select one — a confirmation, not a performance. */
const SINGLE_NOTE_SEC = 0.6;
/** Lead so the first envelope ramp is never scheduled in the past. */
const SCHEDULE_LEAD_SEC = 0.02;
/** Matches key-preview's fade: long enough not to click, short enough to feel instant. */
const STOP_FADE_SEC = 0.08;
/** Web Audio rejects a true zero as an exponential ramp target. */
const SILENT = 0.0001;

export interface AuditionHandle {
  /** Resolves when the sequence ends, or immediately once stopped. */
  done: Promise<void>;
  /** Silences the sequence, including notes scheduled but not yet sounding. */
  stop(): void;
}

/** Sounds one note, for feedback while editing. */
export function auditionNote(ctx: AudioContext, midi: number, instrument: InstrumentId): void {
  playInstrumentNote(ctx, instrument, midi, ctx.currentTime + SCHEDULE_LEAD_SEC, SINGLE_NOTE_SEC);
}

/**
 * Plays the whole grid at its real tempo, so the exercise can be heard before
 * it is saved. Rests are preserved: notes keep their grid positions rather
 * than being packed end to end.
 */
export function auditionSequence(
  ctx: AudioContext,
  notes: CustomExerciseNote[],
  slotMs: number,
  anchorMidi: number,
  instrument: InstrumentId,
): AuditionHandle {
  const bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(ctx.destination);

  const t0 = ctx.currentTime + SCHEDULE_LEAD_SEC;
  let endMs = 0;
  for (const note of sortedNotes(notes)) {
    const startMs = note.startSlot * slotMs;
    const durationMs = note.lengthSlots * slotMs;
    playInstrumentNote(ctx, instrument, anchorMidi + note.offset, t0 + startMs / 1000, durationMs / 1000, bus);
    endMs = Math.max(endMs, startMs + durationMs);
  }

  let finish: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish(), endMs + 60);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    const now = ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(Math.max(bus.gain.value, SILENT), now);
    bus.gain.exponentialRampToValueAtTime(SILENT, now + STOP_FADE_SEC);
    finish();
  };

  return { done, stop };
}

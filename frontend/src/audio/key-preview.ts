/**
 * Key preview — the short passage played before an exercise starts, so the
 * singer knows what key they are about to sing in and where to come in.
 *
 * Root, then the perfect 5th, then the octave, then the triad; finally, after
 * a beat of silence, the exercise's OWN first note.
 *
 * That last step is the "come in here" cue, and nothing on screen labels it
 * (deliberately — the preview is audio-only). Its meaning is carried entirely
 * by its position: it is the note that arrives alone, after the silence that
 * follows the chord. The silence is therefore load-bearing, not decoration —
 * shortening it to nothing would make the cue just another note in the run.
 *
 * Everything is scheduled up front against the AudioContext clock rather than
 * fired from timers, so the passage stays in time even if the main thread
 * stalls. The cost is that a skip must be able to cancel notes that are
 * already scheduled, which is why every note is routed through one shared gain
 * node instead of straight to the speakers.
 */
import { playInstrumentNote, type InstrumentId } from './instruments';

/** Semitones above the root for each step of the preview. */
const FIFTH = 7;
const OCTAVE = 12;
/** Major third — see the caveat on major tonality in playKeyPreview's doc. */
const THIRD = 4;

const SINGLE_NOTE_MS = 700;
/** Gap between the single notes; slightly longer than the notes so they don't run together. */
const SINGLE_STEP_MS = 800;
const CHORD_MS = 1700;
/**
 * Chord notes are spread by this much rather than struck together — a pianist
 * rolls a chord, and it reads as one gesture rather than a stab. (It is not a
 * headroom measure: four notes together peak at 0.36, nowhere near clipping.)
 */
const CHORD_ROLL_MS = 45;
/** Silence between the chord and the come-in note. See the module comment. */
const BEFORE_FIRST_NOTE_MS = 400;
const FIRST_NOTE_MS = 900;

/** Fade applied by skip() — long enough not to click, short enough to feel instant. */
const SKIP_FADE_SEC = 0.08;
/** Web Audio rejects a true zero as an exponential ramp target. */
const SILENT = 0.0001;

export interface KeyPreviewOptions {
  /** Tonal centre the exercise is built around. */
  anchorMidi: number;
  /** The exercise's first target, sounded last as the come-in cue. */
  firstTargetMidi: number | null;
  instrument: InstrumentId;
}

export interface KeyPreviewHandle {
  /** Resolves when the passage finishes, or immediately once skipped. */
  done: Promise<void>;
  /** Silences the passage — including notes scheduled but not yet sounding. */
  skip(): void;
}

/**
 * Total length of the passage, so callers can reason about start-up time
 * without re-deriving it from the constants.
 */
export const KEY_PREVIEW_MS =
  SINGLE_STEP_MS * 2 + SINGLE_NOTE_MS + CHORD_MS + BEFORE_FIRST_NOTE_MS + FIRST_NOTE_MS;

/**
 * Plays the passage and returns a handle.
 *
 * The chord is a MAJOR triad, i.e. the preview assumes a major tonality. That
 * holds for every built-in exercise, but a custom exercise built on minor
 * offsets will sound slightly at odds with it — the catalog carries no mode
 * information to derive anything better from, and a major triad is the
 * conventional way to state a key.
 */
export function playKeyPreview(ctx: AudioContext, opts: KeyPreviewOptions): KeyPreviewHandle {
  const { anchorMidi, firstTargetMidi, instrument } = opts;

  // One node for the whole passage: ramping it down cancels every note routed
  // through it, whether or not it has started. Connecting each note straight
  // to the destination would leave a skipped chord ringing on.
  const bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.02; // small lead so the first ramp isn't in the past
  const at = (ms: number) => t0 + ms / 1000;
  const note = (midi: number, ms: number, durationMs: number) =>
    playInstrumentNote(ctx, instrument, midi, at(ms), durationMs / 1000, bus);

  note(anchorMidi, 0, SINGLE_NOTE_MS);
  note(anchorMidi + FIFTH, SINGLE_STEP_MS, SINGLE_NOTE_MS);
  note(anchorMidi + OCTAVE, SINGLE_STEP_MS * 2, SINGLE_NOTE_MS);

  const chordAt = SINGLE_STEP_MS * 3;
  [0, THIRD, FIFTH, OCTAVE].forEach((interval, i) => {
    note(anchorMidi + interval, chordAt + i * CHORD_ROLL_MS, CHORD_MS - i * CHORD_ROLL_MS);
  });

  const comeInAt = chordAt + CHORD_MS + BEFORE_FIRST_NOTE_MS;
  if (firstTargetMidi !== null) {
    note(firstTargetMidi, comeInAt, FIRST_NOTE_MS);
  }

  let finish: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const timer = setTimeout(() => finish(), KEY_PREVIEW_MS + 60);

  let skipped = false;
  const skip = (): void => {
    if (skipped) return;
    skipped = true;
    clearTimeout(timer);
    const now = ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(Math.max(bus.gain.value, SILENT), now);
    bus.gain.exponentialRampToValueAtTime(SILENT, now + SKIP_FADE_SEC);
    finish();
  };

  return { done, skip };
}

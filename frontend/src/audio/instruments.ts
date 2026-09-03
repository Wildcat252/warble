/**
 * Reference-tone voices.
 *
 * These used to be seven oscillator-built voices (synth, three pianos, three
 * violins), synthesised because a sample set was judged too heavy for the
 * bundle. That trade was revisited once a real piano was recorded for the app:
 * the set is 17 files and ~2.3MB, and a recorded piano is a far better thing
 * to tune against than a stack of sine partials. The synth voices are gone and
 * the sampler in ./piano-samples.ts is the only voice offered.
 *
 * `playSynth` survives but is NOT in INSTRUMENTS — it is the fallback for when
 * a sample fails to load. With the other voices removed there is nothing else
 * to fall back to, and a silent cue leaves the singer with no reference at all,
 * which is worse than a plain tone.
 *
 * Each voice is handed the TARGET'S OWN DURATION and sounds for that long,
 * rather than a fixed blip — a cue that stops after 600ms while the singer
 * is still meant to be holding a 2s note gives them nothing to tune against
 * for the rest of it.
 *
 * TRADEOFF: the microphone is live while these play, so a tone ringing for a
 * whole note bleeds into pitch detection and can be picked up as the
 * singer's own voice. The recorded piano is richer in harmonics than the sine
 * voices it replaced, so it bleeds more readily; if detection regresses,
 * shortening these is the first thing to try.
 */
import { midiToFrequency } from '../pitch/note-name';
import { playPianoSample } from './piano-samples';

export type InstrumentId = 'piano';

export type InstrumentFamily = 'Piano';

export interface InstrumentOption {
  id: InstrumentId;
  family: InstrumentFamily;
  label: string;
  description: string;
  /** False for voices that decay by nature — surfaced in Settings so the choice isn't a surprise. */
  sustains: boolean;
}

export const INSTRUMENTS: readonly InstrumentOption[] = [
  {
    id: 'piano', family: 'Piano', label: 'Piano', sustains: false,
    description: 'A recorded piano — struck and left to decay, the way a real one behaves.',
  },
];

export const DEFAULT_INSTRUMENT: InstrumentId = 'piano';

const INSTRUMENT_IDS = new Set<string>(INSTRUMENTS.map((i) => i.id));

/**
 * Ids shipped by earlier builds, all of them synth voices that no longer
 * exist. They map to the one remaining voice so a value left in localStorage
 * can't leave the player with no audible cue.
 */
const LEGACY_INSTRUMENT_IDS: Record<string, InstrumentId> = {
  synth: 'piano',
  piano: 'piano',
  'piano-struck': 'piano',
  'piano-sustained': 'piano',
  rhodes: 'piano',
  'violin-solo': 'piano',
  'violin-ensemble': 'piano',
  'violin-close': 'piano',
};

export function normalizeInstrumentId(value: string | null): InstrumentId | null {
  if (value === null) return null;
  if (INSTRUMENT_IDS.has(value)) return value as InstrumentId;
  return LEGACY_INSTRUMENT_IDS[value] ?? null;
}

export function getInstrument(id: InstrumentId): InstrumentOption | undefined {
  return INSTRUMENTS.find((i) => i.id === id);
}

/** Peak gain of the fallback voice; the sampler matches its loudness to this. */
const PEAK = 0.06;
/** Floor for exponential ramps — Web Audio rejects a true zero target. */
const SILENT = 0.0001;
/** Every voice fades out over this long, so a cue never ends in a click. */
const RELEASE_SEC = 0.14;

/** Shortest note a voice is asked to fill; guards the envelope maths against zero/negative spans. */
const MIN_DURATION_SEC = 0.15;

/**
 * Fallback voice: one triangle wave, soft attack, flat sustain — deliberately
 * unwavering. Only reached when the sample set failed to load.
 */
function playSynth(
  ctx: AudioContext,
  midi: number,
  t0: number,
  dur: number,
  destination: AudioNode,
): void {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = midiToFrequency(midi);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENT, t0);
  gain.gain.exponentialRampToValueAtTime(PEAK, t0 + 0.03);
  gain.gain.setValueAtTime(PEAK, t0 + Math.max(0.04, dur - RELEASE_SEC));
  gain.gain.exponentialRampToValueAtTime(SILENT, t0 + dur);

  osc.connect(gain);
  gain.connect(destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * Sounds one note of `instrument`.
 *
 * `durationSec` is the target's own length — the cue fills the note rather
 * than blipping at its start. Callers that just want an audition (the
 * Settings preview) can pass a short fixed value.
 *
 * Callers must have awaited preloadPianoSamples(); this is synchronous, so an
 * un-loaded sample set silently degrades to the synth fallback.
 *
 * `destination` defaults to the speakers; pass a node to route the note
 * through it instead (see key-preview.ts, which needs one gain node it can
 * ramp down to cancel notes it has already scheduled).
 */
export function playInstrumentNote(
  ctx: AudioContext,
  instrument: InstrumentId,
  midi: number,
  startAt: number,
  durationSec: number,
  destination: AudioNode = ctx.destination,
): void {
  const dur = Math.max(MIN_DURATION_SEC, durationSec);
  void instrument; // Only one voice today; kept in the signature for future ones.
  if (playPianoSample(ctx, midi, startAt, dur, destination)) return;
  playSynth(ctx, midi, startAt, dur, destination);
}

/**
 * Reference-tone voices.
 *
 * All synthesised with Web Audio rather than sampled: a sample set is
 * multiple megabytes of bundle for what is one cue note per target, and a
 * one-shot sampler needs round-robins to avoid sounding obviously looped.
 *
 * Each voice is handed the TARGET'S OWN DURATION and sounds for that long,
 * rather than a fixed blip — a cue that stops after 600ms while the singer
 * is still meant to be holding a 2s note gives them nothing to tune against
 * for the rest of it. The struck voices are the exception by nature: a real
 * piano string decays, so "sustain" there means stretching the tail, not
 * holding a level tone.
 *
 * TRADEOFF: the microphone is live while these play, so a tone ringing for a
 * whole note bleeds into pitch detection and can be picked up as the
 * singer's own voice. If detection regresses, shortening these is the first
 * thing to try — see the branch's earlier confidence/centre-frequency fixes
 * for the same class of problem.
 */
import { midiToFrequency } from '../pitch/note-name';

export type InstrumentId =
  | 'synth'
  | 'piano-struck'
  | 'piano-sustained'
  | 'rhodes'
  | 'violin-solo'
  | 'violin-ensemble'
  | 'violin-close';

export type InstrumentFamily = 'Synth' | 'Piano' | 'Violin';

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
    id: 'synth', family: 'Synth', label: 'Synth', sustains: true,
    description: 'A clean, steady tone — the plainest thing to tune against.',
  },
  {
    id: 'piano-struck', family: 'Piano', label: 'Struck piano', sustains: false,
    description: 'Hammer attack with natural decay, the way a real piano behaves.',
  },
  {
    id: 'piano-sustained', family: 'Piano', label: 'Sustained piano', sustains: true,
    description: 'The same strike with its tail stretched across the note, like holding the pedal.',
  },
  {
    id: 'rhodes', family: 'Piano', label: 'Electric piano', sustains: true,
    description: 'Rhodes-style tine: bell attack, ringing body, slow tremolo.',
  },
  {
    id: 'violin-solo', family: 'Violin', label: 'Solo violin', sustains: true,
    description: 'Bowed and sustained, with vibrato that settles in after the attack.',
  },
  {
    id: 'violin-ensemble', family: 'Violin', label: 'Violin section', sustains: true,
    description: 'Three detuned bows layered — wider and warmer than a single player.',
  },
  {
    id: 'violin-close', family: 'Violin', label: 'Violin, close-miked', sustains: true,
    description: 'Solo bow plus the breathy grip of rosin at the attack.',
  },
];

export const DEFAULT_INSTRUMENT: InstrumentId = 'synth';

/** Ordered family list for grouping the Settings picker, derived so it can't drift from INSTRUMENTS. */
export const INSTRUMENT_FAMILIES: readonly InstrumentFamily[] = [
  ...new Set(INSTRUMENTS.map((i) => i.family)),
];

const INSTRUMENT_IDS = new Set<string>(INSTRUMENTS.map((i) => i.id));

/**
 * `'piano'` was the id shipped before the voice list expanded; it maps to the
 * struck variant so anyone who chose it keeps the sound they picked.
 */
const LEGACY_INSTRUMENT_IDS: Record<string, InstrumentId> = { piano: 'piano-struck' };

export function normalizeInstrumentId(value: string | null): InstrumentId | null {
  if (value === null) return null;
  if (INSTRUMENT_IDS.has(value)) return value as InstrumentId;
  return LEGACY_INSTRUMENT_IDS[value] ?? null;
}

export function getInstrument(id: InstrumentId): InstrumentOption | undefined {
  return INSTRUMENTS.find((i) => i.id === id);
}

/** Peak gain shared by every voice, so switching instrument doesn't change loudness. */
const PEAK = 0.06;
/** Floor for exponential ramps — Web Audio rejects a true zero target. */
const SILENT = 0.0001;
/** Every voice fades out over this long, so a cue never ends in a click. */
const RELEASE_SEC = 0.14;

/** Shortest note a voice is asked to fill; guards the envelope maths against zero/negative spans. */
const MIN_DURATION_SEC = 0.15;

function noiseBuffer(ctx: AudioContext, seconds: number, fade: boolean): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (fade ? 1 - i / length : 1);
  }
  return buffer;
}

/** Synth: one triangle wave, soft attack, flat sustain — deliberately unwavering. */
function playSynth(ctx: AudioContext, midi: number, t0: number, dur: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = midiToFrequency(midi);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENT, t0);
  gain.gain.exponentialRampToValueAtTime(PEAK, t0 + 0.03);
  gain.gain.setValueAtTime(PEAK, t0 + Math.max(0.04, dur - RELEASE_SEC));
  gain.gain.exponentialRampToValueAtTime(SILENT, t0 + dur);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/* Piano partials: roughly 1/n falloff with the octave lifted, because real
   strings put more energy there than a plain 1/n series does. */
const PIANO_PARTIALS: ReadonlyArray<readonly [number, number]> = [
  [1, 1.0], [2, 0.60], [3, 0.24], [4, 0.14], [5, 0.07], [6, 0.04],
];
/** Stiff strings stretch partials slightly sharp of exact integer multiples. */
const INHARMONICITY = 0.0004;
/** Decay of the struck voice at its natural (un-stretched) length. */
const PIANO_BASE_DECAY_SEC = 0.9;

/**
 * Struck piano. `stretch` > 1 lengthens the decay toward the note's duration
 * (the "sustained" variant); at 1 the note dies away on its own schedule.
 */
function playPiano(ctx: AudioContext, midi: number, t0: number, dur: number, stretch: number): void {
  const fundamental = midiToFrequency(midi);
  const total = Math.min(dur, PIANO_BASE_DECAY_SEC * stretch);

  for (const [n, rel] of PIANO_PARTIALS) {
    const freq = fundamental * n * Math.sqrt(1 + INHARMONICITY * n * n);
    // Above Nyquist a partial aliases back down as an audible artefact.
    if (freq >= ctx.sampleRate / 2) continue;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    // Higher partials die faster than the fundamental — the main "piano" cue.
    const decay = total / (1 + 0.55 * (n - 1));
    gain.gain.setValueAtTime(SILENT, t0);
    gain.gain.exponentialRampToValueAtTime(PEAK * rel, t0 + 0.004);
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + decay);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + decay + 0.02);
  }

  // Hammer thump — a very short filtered noise burst that gives the onset body.
  const thump = ctx.createBufferSource();
  thump.buffer = noiseBuffer(ctx, 0.03, true);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(fundamental * 4, ctx.sampleRate / 2 - 1);
  const gain = ctx.createGain();
  gain.gain.value = PEAK * 0.35;
  thump.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  thump.start(t0);
}

/** Rhodes-style electric piano: bell attack over a tine that genuinely rings. */
function playRhodes(ctx: AudioContext, midi: number, t0: number, dur: number): void {
  const fundamental = midiToFrequency(midi);
  const sustainStart = t0 + Math.max(0.05, dur - RELEASE_SEC);

  const partial = (mult: number, level: number, holdLevel: number, decaySec: number): void => {
    const freq = fundamental * mult;
    if (freq >= ctx.sampleRate / 2) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    const hold = Math.max(SILENT, PEAK * holdLevel);
    gain.gain.setValueAtTime(SILENT, t0);
    gain.gain.exponentialRampToValueAtTime(PEAK * level, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(hold, t0 + Math.min(decaySec, dur));
    gain.gain.setValueAtTime(hold, sustainStart);
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  };

  partial(1, 0.9, 0.42, 0.5);   // tine body, rings on
  partial(4, 0.5, 0.002, 0.22); // bell strike, gone quickly
  partial(2, 0.18, 0.06, 0.7);
}

interface BowedOptions {
  voices: number;
  detuneCents: number;
  vibratoDepthCents: number;
  attackSec: number;
  bowNoise: number;
}

/**
 * Bowed string. A violin sustains as long as the bow moves, so these hold for
 * the whole note with no trickery.
 *
 * Three things do the work: a lowpass that OPENS as bow pressure builds,
 * vibrato that arrives late (a player settles into a note rather than
 * wobbling from the first instant), and a fixed peak around 520Hz standing in
 * for the instrument's body resonance.
 */
function playBowed(ctx: AudioContext, midi: number, t0: number, dur: number, opts: BowedOptions): void {
  const fundamental = midiToFrequency(midi);
  const nyquist = ctx.sampleRate / 2;
  const attack = Math.min(opts.attackSec, dur * 0.4);

  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.setValueAtTime(Math.min(fundamental * 2.2, nyquist - 1), t0);
  body.frequency.linearRampToValueAtTime(Math.min(fundamental * 6, nyquist - 1), t0 + attack * 2.2);
  body.Q.value = 1.4;

  const resonance = ctx.createBiquadFilter();
  resonance.type = 'peaking';
  resonance.frequency.value = 520;
  resonance.Q.value = 1.1;
  resonance.gain.value = 5;

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(SILENT, t0);
  amp.gain.exponentialRampToValueAtTime(PEAK * 0.9, t0 + attack);
  amp.gain.setValueAtTime(PEAK * 0.9, t0 + Math.max(attack, dur - RELEASE_SEC));
  amp.gain.exponentialRampToValueAtTime(SILENT, t0 + dur);

  body.connect(resonance);
  resonance.connect(amp);
  amp.connect(ctx.destination);

  const vibrato = ctx.createOscillator();
  vibrato.frequency.value = 5.2;
  const vibratoDepth = ctx.createGain();
  vibratoDepth.gain.setValueAtTime(0, t0);
  vibratoDepth.gain.setValueAtTime(0, t0 + Math.min(0.28, dur * 0.3));
  vibratoDepth.gain.linearRampToValueAtTime(opts.vibratoDepthCents, t0 + Math.min(0.7, dur * 0.6));
  vibrato.connect(vibratoDepth);
  vibrato.start(t0);
  vibrato.stop(t0 + dur + 0.05);

  for (let v = 0; v < opts.voices; v += 1) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = fundamental;
    osc.detune.value = opts.voices === 1 ? 0 : (v - (opts.voices - 1) / 2) * opts.detuneCents;
    vibratoDepth.connect(osc.detune);

    const perVoice = ctx.createGain();
    perVoice.gain.value = 1 / opts.voices;
    osc.connect(perVoice);
    perVoice.connect(body);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  if (opts.bowNoise > 0) {
    // Rosin grip at the attack, fading as the tone settles.
    const noiseSec = Math.min(0.35, dur);
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx, noiseSec, false);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = Math.min(fundamental * 3, nyquist - 1);
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(PEAK * opts.bowNoise, t0);
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + noiseSec);
    source.connect(band);
    band.connect(gain);
    gain.connect(ctx.destination);
    source.start(t0);
  }
}

/**
 * Sounds one note of `instrument`.
 *
 * `durationSec` is the target's own length — the cue fills the note rather
 * than blipping at its start. Callers that just want an audition (the
 * Settings preview) can pass a short fixed value.
 */
export function playInstrumentNote(
  ctx: AudioContext,
  instrument: InstrumentId,
  midi: number,
  startAt: number,
  durationSec: number,
): void {
  const dur = Math.max(MIN_DURATION_SEC, durationSec);
  switch (instrument) {
    case 'piano-struck':
      playPiano(ctx, midi, startAt, dur, 1);
      break;
    case 'piano-sustained':
      // Stretch the decay to reach the end of the note, never shorten it.
      playPiano(ctx, midi, startAt, dur, Math.max(1, dur / PIANO_BASE_DECAY_SEC));
      break;
    case 'rhodes':
      playRhodes(ctx, midi, startAt, dur);
      break;
    case 'violin-solo':
      playBowed(ctx, midi, startAt, dur, { voices: 1, detuneCents: 0, vibratoDepthCents: 6, attackSec: 0.11, bowNoise: 0 });
      break;
    case 'violin-ensemble':
      playBowed(ctx, midi, startAt, dur, { voices: 3, detuneCents: 14, vibratoDepthCents: 7, attackSec: 0.14, bowNoise: 0 });
      break;
    case 'violin-close':
      playBowed(ctx, midi, startAt, dur, { voices: 2, detuneCents: 6, vibratoDepthCents: 5.5, attackSec: 0.09, bowNoise: 0.5 });
      break;
    default:
      playSynth(ctx, midi, startAt, dur);
  }
}

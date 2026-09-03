/**
 * Sampled piano reference tones.
 *
 * Replaces the oscillator voices this module's sibling used to synthesise: the
 * app now ships a real recorded piano in `public/piano/`, one file per sample,
 * named by MIDI number (`60.aac` is middle C). Naming by number rather than by
 * note name keeps enharmonics unambiguous (C#4 and Db4 are one file, `61`) and
 * lets the lookup be arithmetic instead of a name table.
 *
 * The set is recorded every THREE semitones from MIDI 36 to 84, so any note is
 * at most one semitone from a sample and is reached by resampling. One
 * semitone of playback-rate shift does not audibly distort the formants; three
 * would, which is why the set isn't sparser.
 *
 * TWO DEFECTS IN THE SOURCE FILES ARE CORRECTED HERE RATHER THAN IN THE FILES,
 * so that replacing the recordings doesn't require re-running an offline
 * mastering step:
 *
 *   1. Every file opens with ~47ms of silence — AAC encoder priming, not part
 *      of the performance. Left alone it delays every cue by that much, which
 *      matters because the cue is meant to land on the target's start.
 *   2. Recorded levels vary by 10.8dB across the set (MIDI 81 is the quietest,
 *      72 the loudest). Uncorrected, the cue jumps in volume between notes.
 *
 * Both are measured per-buffer at load time rather than hard-coded, so they
 * self-correct: if a future decoder strips the priming itself, the measured
 * onset is simply ~0 and nothing is trimmed.
 */

/** Recorded pitches, every 3 semitones (C2 to C6). Must match the files in public/piano/. */
export const SAMPLE_MIDIS: readonly number[] = [
  36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84,
];

/**
 * Onset threshold, as a fraction of the buffer's peak. 1% sits well above the
 * codec's noise floor but below the quietest real attack in the set, so it
 * finds the note rather than the encoder's warm-up.
 */
const ONSET_THRESHOLD = 0.01;

/**
 * Window used to measure each sample's loudness. One second covers the attack
 * and early decay — the part a singer actually pitches against — without
 * letting a long tail drag the average down differently per note.
 */
const LOUDNESS_WINDOW_SEC = 1;

/**
 * Target RMS over that window, matched across every sample. Chosen to sit near
 * the RMS of the synth voice this replaced (a triangle wave at its 0.06 peak),
 * so the cue's loudness didn't change when the voices did.
 */
const TARGET_RMS = 0.03;

/** Ceiling on the normalisation boost, so a pathologically quiet file can't clip. */
const MAX_PEAK_AFTER_GAIN = 0.9;

/**
 * Largest resample the sampler will do before handing the note back to the
 * caller's fallback voice.
 *
 * Within the recorded range no note is ever more than 1.5 semitones from a
 * sample, so this only bites outside it. The custom-exercise editor allows
 * offsets of +/-24 semitones (see exercises/custom-types.ts), which off a
 * soprano anchor reaches MIDI 96 — an octave above the highest sample. Played
 * by resampling, that is both grotesque and half as long (rate 2.0 burns
 * through the buffer twice as fast), so a plain synthesised tone at the
 * correct pitch is the better cue. Pitch is never compromised either way.
 */
const MAX_SHIFT_SEMITONES = 2;

/** Floor for exponential ramps — Web Audio rejects a true zero target. */
const SILENT = 0.0001;

/** Fade-out at the end of a cue, so it never stops on a click. */
const RELEASE_SEC = 0.14;

interface LoadedSample {
  buffer: AudioBuffer;
  /** Seconds of dead air to skip at the start (see the module comment). */
  offsetSec: number;
  /** Per-sample gain that equalises loudness across the set. */
  gain: number;
}

const samples = new Map<number, LoadedSample>();
/** In-flight (or settled) preload, so concurrent callers share one fetch pass. */
let preload: Promise<void> | null = null;

function sampleUrl(midi: number): string {
  // Resolved against the document, NOT written as an absolute "/piano/…": the
  // Electron shell loads the app with loadFile(), so the page origin is
  // file:// and a root-relative path would resolve to the filesystem root and
  // 404. Relative to baseURI it lands next to index.html under both file://
  // and the dev server.
  return new URL(`piano/${midi}.aac`, document.baseURI).href;
}

/**
 * Measures onset and normalisation gain for a decoded buffer.
 *
 * Reads EVERY channel, not just the first. The recordings are stereo with
 * decorrelated channels — one note measured 4.3dB louder on the right than the
 * left — so normalising off channel 0 alone corrects against a signal nobody
 * hears and leaves most of the level spread in place.
 */
function analyse(buffer: AudioBuffer): { offsetSec: number; gain: number } {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  const frames = buffer.length;

  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < frames; i += 1) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) return { offsetSec: 0, gain: 1 };

  // Onset is the earliest attack on any channel.
  const threshold = peak * ONSET_THRESHOLD;
  let onset = frames;
  for (const data of channels) {
    for (let i = 0; i < onset; i += 1) {
      if (Math.abs(data[i]) > threshold) {
        onset = i;
        break;
      }
    }
  }
  if (onset >= frames) onset = 0;

  // Mean energy across channels — the level actually delivered to the speakers,
  // and independent of how a given output downmixes.
  const windowEnd = Math.min(frames, onset + Math.floor(LOUDNESS_WINDOW_SEC * buffer.sampleRate));
  let sum = 0;
  for (const data of channels) {
    for (let i = onset; i < windowEnd; i += 1) sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, (windowEnd - onset) * channels.length));

  const gain = rms > 0 ? Math.min(TARGET_RMS / rms, MAX_PEAK_AFTER_GAIN / peak) : 1;
  return { offsetSec: onset / buffer.sampleRate, gain };
}

/**
 * Fetches and decodes the sample set. Idempotent and safe to call from several
 * places; the work happens once.
 *
 * MUST be awaited before the first cue. Playback is synchronous (it is driven
 * from an animation-frame loop), so a sample that is still downloading is a
 * silent note, and the first note of an exercise is the one that matters most.
 *
 * Individual failures are swallowed: a missing or undecodable file leaves that
 * pitch out of the map, and playPianoSample reports the miss so the caller can
 * fall back rather than leaving the singer with no reference at all.
 */
export function preloadPianoSamples(ctx: AudioContext): Promise<void> {
  if (preload) return preload;
  preload = Promise.all(
    SAMPLE_MIDIS.map(async (midi) => {
      try {
        const response = await fetch(sampleUrl(midi));
        if (!response.ok) return;
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        samples.set(midi, { buffer, ...analyse(buffer) });
      } catch {
        // Left out of the map on purpose — see the doc comment.
      }
    }),
  ).then(() => undefined);
  return preload;
}

/** Nearest recorded pitch to `midi`. */
function nearestSampleMidi(midi: number): number {
  let best = SAMPLE_MIDIS[0];
  for (const candidate of SAMPLE_MIDIS) {
    if (Math.abs(candidate - midi) < Math.abs(best - midi)) best = candidate;
  }
  return best;
}

/**
 * Sounds one note. Returns false if no sample is loaded for it, or if the note
 * sits too far outside the recorded range to resample cleanly, so the caller
 * can fall back to a synthesised tone.
 *
 * `durationSec` is the target's own length: the cue is faded out at the end of
 * the note rather than being allowed to ring past it.
 *
 * `destination` lets a caller route the note through its own node instead of
 * straight to the speakers — key-preview.ts uses a shared gain node so that
 * skipping can silence notes it already scheduled.
 */
export function playPianoSample(
  ctx: AudioContext,
  midi: number,
  startAt: number,
  durationSec: number,
  destination: AudioNode = ctx.destination,
): boolean {
  if (samples.size === 0) return false;
  const sampleMidi = nearestSampleMidi(midi);
  if (Math.abs(midi - sampleMidi) > MAX_SHIFT_SEMITONES) return false;
  const sample = samples.get(sampleMidi);
  if (!sample) return false;

  const source = ctx.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = 2 ** ((midi - sampleMidi) / 12);

  const gain = ctx.createGain();
  const release = Math.min(RELEASE_SEC, durationSec * 0.5);
  gain.gain.setValueAtTime(sample.gain, startAt);
  gain.gain.setValueAtTime(sample.gain, startAt + durationSec - release);
  gain.gain.exponentialRampToValueAtTime(SILENT, startAt + durationSec);

  source.connect(gain);
  gain.connect(destination);
  // Offset past the dead air; the shift means it elapses faster than real time.
  source.start(startAt, sample.offsetSec);
  source.stop(startAt + durationSec + 0.02);
  return true;
}

/** Test seam — drops cached buffers so a suite can re-run the loader. */
export function resetPianoSamplesForTest(): void {
  samples.clear();
  preload = null;
}

/**
 * Reference-tone player — sounds one cue note at the start of each exercise
 * target. Promoted out of warmup/session.ts (where it was WarmupTonePlayer,
 * warm-up-only) so every exercise kind can play a reference tone.
 *
 * ONE SOUND PER NOTE. The player calls this from its animation-frame loop, so
 * it fires many times per target; the previous guard suppressed repeats of the
 * same PITCH within 450ms, which meant a 2s target re-triggered about four
 * times and a 6s note-hold target about thirteen. Keying on the target's
 * identity instead makes the cue fire exactly once per target — including for
 * two consecutive targets on the same pitch, which a pitch-based guard
 * collapsed into one.
 */
import { getAudioContext } from '../services/audio-context';
import { loadInstrumentId } from '../services/user-settings';
import { playInstrumentNote, type InstrumentId } from './instruments';

export class TonePlayer {
  /** Identity of the target already sounded; null before the first note. */
  private lastKey: string | null = null;
  /**
   * Instrument is read once per exercise, not per note — changing it mid-run
   * would make an exercise change timbre halfway through.
   */
  private readonly instrument: InstrumentId;

  constructor(instrument: InstrumentId = loadInstrumentId()) {
    this.instrument = instrument;
  }

  /**
   * Sounds the cue for a target, if it hasn't already been sounded.
   *
   * `targetKey` must uniquely identify the target within the exercise — the
   * caller passes the target's index. Pitch alone is not enough (see the class
   * comment). `durationSec` is the target's own length, so the cue fills the
   * note instead of blipping at its start.
   */
  playTargetOnce(targetKey: string | number | null, midi: number | null, durationSec: number): void {
    if (targetKey === null || midi === null) return;
    const key = String(targetKey);
    if (this.lastKey === key) return;
    this.lastKey = key;

    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    // Small lead so the envelope's first ramp isn't scheduled in the past.
    playInstrumentNote(ctx, this.instrument, midi, ctx.currentTime + 0.01, durationSec);
  }

  /** Forgets what was last sounded, so a replay of the same exercise cues again. */
  reset(): void {
    this.lastKey = null;
  }
}

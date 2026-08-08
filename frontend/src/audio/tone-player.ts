/**
 * Reference-tone player — a short Web Audio triangle-wave blip for a given
 * MIDI pitch. Promoted out of warmup/session.ts (where it was
 * WarmupTonePlayer, warm-up-only) so every exercise kind can play a
 * reference tone, not just guided warm-ups.
 */
import { midiToFrequency } from '../pitch/note-name';
import { getAudioContext } from '../services/audio-context';

/** Suppresses re-triggering the same pitch within this window (avoids stutter on rapid re-renders). */
const REPEAT_SUPPRESSION_MS = 450;

export class TonePlayer {
  private lastMidi: number | null = null;
  private lastPlayedAt = 0;

  playExpectedMidi(midi: number | null): void {
    if (midi === null) return;
    const now = performance.now();
    if (this.lastMidi === midi && (now - this.lastPlayedAt) < REPEAT_SUPPRESSION_MS) return;

    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const t0 = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToFrequency(midi);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.3);

    this.lastMidi = midi;
    this.lastPlayedAt = now;
  }
}

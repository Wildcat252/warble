/**
 * Lazy singleton AudioContext.
 *
 * Features must not construct AudioContext directly; they call
 * getAudioContext() so the context is shared across the app and created only
 * once (on first user gesture).
 *
 * Clock hierarchy contract:
 *   AudioContext.currentTime is the master clock — nothing else may be used
 *   for audio/visual synchronisation.
 *
 * The soundfont loader that used to live here was removed in the Warble
 * rework: it existed to play back a MusicXML score with piano samples.
 * Exercises play a single reference tone instead, synthesised by
 * audio/tone-player.ts, so there is no sample bank to fetch or fall back on.
 */

let ctx: AudioContext | null = null;

/** Return (creating if necessary) the shared AudioContext. */
export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

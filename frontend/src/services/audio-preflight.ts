/**
 * Opener registration for the mic-test modal.
 *
 * The modal used to be a gate shown before every exercise, and owned mic
 * device / latency / octave-compensation / voice-type settings. Those were
 * either duplicated by the Settings screen or written but never read, so the
 * modal is now purely an on-demand microphone level test opened from
 * Settings. Voice type moved to services/user-settings.ts.
 */

let openModal: (() => Promise<boolean>) | null = null;

export function registerAudioPreflightOpener(opener: () => Promise<boolean>): void {
  openModal = opener;
}

/** Resolves true if the test was completed, false if dismissed. */
export function openAudioPreflightModal(): Promise<boolean> {
  if (!openModal) return Promise.resolve(false);
  return openModal();
}

/**
 * Settings screen — v1 slice (pulled forward from Phase 8, same way
 * exercise-picker was pulled forward from Phase 4): right now this is just
 * a deliberate entry point to the mic/audio setup modal, replacing the old
 * behavior where that modal auto-popped-up before every exercise. Pitch-
 * detection tuning (confidence threshold, stable-note settings, etc.) and
 * the full Advanced/Diagnostics panel land here later, in Phase 8 proper.
 */
import type { Screen } from '../../screen-types';
import { openAudioPreflightModal, loadUserVoiceTypeId } from '../../services/audio-preflight';
import { getVoiceTypeById } from '../../pitch/voice-type';
import './settings.css';

function render(container: HTMLElement): void {
  const voiceType = getVoiceTypeById(loadUserVoiceTypeId());

  container.innerHTML = `
    <div class="settings-screen fade-in">
      <div class="settings-screen__header">
        <h1>Settings</h1>
        <p>Mic setup and voice type. More tuning options land in a later build phase.</p>
      </div>
      <div class="card settings-card">
        <div class="settings-card__text">
          <h2>Mic &amp; audio setup</h2>
          <p>Choose your microphone, test your input level, and set your voice type.</p>
          <p class="settings-card__hint">Voice type: <strong>${voiceType ? voiceType.label : 'Not set'}</strong></p>
        </div>
        <button type="button" class="btn btn-primary" id="settings-open-preflight">Open mic setup</button>
      </div>
    </div>
  `;

  container.querySelector<HTMLButtonElement>('#settings-open-preflight')?.addEventListener('click', () => {
    // Re-render on close so the voice-type readout reflects any change
    // made inside the modal (e.g. picking a voice type, or one getting
    // auto-suggested after a completed session).
    void openAudioPreflightModal().then(() => render(container));
  });
}

export const settingsScreen: Screen = {
  id: 'settings',
  mount(container) {
    render(container);
  },
};

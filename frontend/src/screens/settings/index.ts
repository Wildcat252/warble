/**
 * Settings screen — microphone, voice type, daily goal, and pitch-engine
 * diagnostics.
 *
 * The microphone picker here is populated from the BACKEND's /audio/devices
 * list, because the backend captures audio itself (Python/sounddevice) and
 * /playback/start expects a PortAudio integer index. The separate "mic
 * setup" modal tests levels through the *browser's* getUserMedia and uses a
 * different device namespace — see services/audio-device.ts for why the two
 * are kept apart.
 */
import type { Screen } from '../../screen-types';
import { openAudioPreflightModal } from '../../services/audio-preflight';
import { loadUserVoiceTypeId, persistUserVoiceTypeId } from '../../services/user-settings';
import { VOICE_TYPES, getVoiceTypeById } from '../../pitch/voice-type';
import {
  fetchAudioDevices, fetchPitchEngine, loadBackendDeviceId,
  persistBackendDeviceId, setForceCpu,
  type BackendAudioDeviceList, type PitchEngineInfo,
} from '../../services/audio-device';
import { loadDailyGoal, persistDailyGoal } from '../../gamification/settings';
import { clearPracticeLog } from '../../gamification/practice-log';
import { midiToNoteName } from '../../pitch/note-name';
import { showToast } from '../../services/toast';
import './settings.css';

const DAILY_GOAL_OPTIONS = [1, 2, 3, 5];

let devices: BackendAudioDeviceList | null = null;
let engine: PitchEngineInfo | null = null;
let loadError: string | null = null;
let disposed = false;

function deviceOptions(): string {
  if (!devices) return '<option value="">Loading…</option>';
  const selected = loadBackendDeviceId();
  const opts = devices.devices.map((d) => {
    const isDefault = d.id === devices?.default_device_id;
    const label = `${d.name}${isDefault ? ' (system default)' : ''}`;
    return `<option value="${d.id}" ${selected === d.id ? 'selected' : ''}>${label}</option>`;
  });
  return [
    `<option value="" ${selected === null ? 'selected' : ''}>Use system default</option>`,
    ...opts,
  ].join('');
}

function voiceTypeOptions(): string {
  const current = loadUserVoiceTypeId();
  return [
    `<option value="" ${!current ? 'selected' : ''}>Not set</option>`,
    ...VOICE_TYPES.map((v) => {
      const range = `${midiToNoteName(v.lowMidi)}–${midiToNoteName(v.highMidi)}`;
      return `<option value="${v.id}" ${current === v.id ? 'selected' : ''}>${v.label} (${range})</option>`;
    }),
  ].join('');
}

function goalOptions(): string {
  const current = loadDailyGoal();
  return DAILY_GOAL_OPTIONS
    .map((n) => `<option value="${n}" ${current === n ? 'selected' : ''}>${n} exercise${n === 1 ? '' : 's'} per day</option>`)
    .join('');
}

function engineSummary(): string {
  if (loadError) return `<p class="settings-note settings-note--warn">Backend unavailable — ${loadError}</p>`;
  if (!engine) return '<p class="settings-note">Loading engine info…</p>';
  const cpuOnly = !engine.cuda;
  return `
    <dl class="settings-facts">
      <div><dt>Active engine</dt><dd>${engine.active_engine}</dd></div>
      <div><dt>Device</dt><dd>${engine.device}</dd></div>
      <div><dt>Dropped buffers</dt><dd>${engine.xrun_count}</dd></div>
    </dl>
    ${cpuOnly ? '<p class="settings-note settings-note--warn">Running on CPU — pitch detection latency may be higher than on a CUDA GPU.</p>' : ''}
    <label class="settings-check">
      <input type="checkbox" id="settings-force-cpu" ${engine.force_cpu ? 'checked' : ''} ${engine.switchable ? '' : 'disabled'} />
      <span>Force CPU pitch engine${engine.switchable ? '' : ' (unavailable)'}</span>
    </label>
  `;
}

function render(container: HTMLElement): void {
  const voiceType = getVoiceTypeById(loadUserVoiceTypeId());

  container.innerHTML = `
    <div class="settings-screen fade-in">
      <div class="settings-screen__header">
        <h1>Settings</h1>
      </div>

      <section class="card settings-section">
        <h2>Microphone</h2>
        <p class="settings-hint">Which input the pitch detector listens to.</p>
        <label class="settings-field">
          <span>Input device</span>
          <select id="settings-device">${deviceOptions()}</select>
        </label>
        <button type="button" class="btn btn-secondary" id="settings-open-preflight">Test my mic</button>
      </section>

      <section class="card settings-section">
        <h2>Voice</h2>
        <p class="settings-hint">Sets the starting pitch exercises are built around.${voiceType ? '' : ' Take the range test to find yours.'}</p>
        <label class="settings-field">
          <span>Voice type</span>
          <select id="settings-voice-type">${voiceTypeOptions()}</select>
        </label>
      </section>

      <section class="card settings-section">
        <h2>Daily goal</h2>
        <p class="settings-hint">How many exercises count as a complete day.</p>
        <label class="settings-field">
          <span>Goal</span>
          <select id="settings-daily-goal">${goalOptions()}</select>
        </label>
      </section>

      <details class="card settings-section settings-advanced">
        <summary>Advanced</summary>
        <div class="settings-advanced__body">
          ${engineSummary()}
          <hr class="settings-divider" />
          <p class="settings-hint">Clearing history removes all streaks, XP and session records. This cannot be undone.</p>
          <button type="button" class="btn btn-ghost settings-danger" id="settings-clear">Clear practice history</button>
        </div>
      </details>
    </div>
  `;

  container.querySelector<HTMLSelectElement>('#settings-device')?.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    persistBackendDeviceId(value === '' ? null : Number.parseInt(value, 10));
    showToast('Microphone updated. It applies to your next exercise.');
  });

  container.querySelector<HTMLSelectElement>('#settings-voice-type')?.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    persistUserVoiceTypeId(value === '' ? null : value);
    render(container); // refresh the hint text
  });

  container.querySelector<HTMLSelectElement>('#settings-daily-goal')?.addEventListener('change', (ev) => {
    persistDailyGoal(Number.parseInt((ev.target as HTMLSelectElement).value, 10));
  });

  container.querySelector<HTMLButtonElement>('#settings-open-preflight')?.addEventListener('click', () => {
    void openAudioPreflightModal().then(() => {
      if (!disposed) render(container);
    });
  });

  container.querySelector<HTMLInputElement>('#settings-force-cpu')?.addEventListener('change', (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    void setForceCpu(checked)
      .then(() => fetchPitchEngine())
      .then((info) => {
        engine = info;
        if (!disposed) render(container);
      })
      .catch((err: unknown) => {
        showToast(`Couldn't change engine: ${String(err)}`, { variant: 'warning' });
      });
  });

  container.querySelector<HTMLButtonElement>('#settings-clear')?.addEventListener('click', () => {
    if (window.confirm('Clear all practice history? This cannot be undone.')) {
      clearPracticeLog();
      showToast('Practice history cleared.');
    }
  });
}

export const settingsScreen: Screen = {
  id: 'settings',
  mount(container) {
    disposed = false;
    render(container); // render immediately; backend info fills in when it arrives

    void Promise.all([fetchAudioDevices(), fetchPitchEngine()])
      .then(([deviceList, engineInfo]) => {
        devices = deviceList;
        engine = engineInfo;
        loadError = null;
      })
      .catch((err: unknown) => {
        loadError = String(err);
      })
      .finally(() => {
        // Guard against the screen having been unmounted mid-request.
        if (!disposed) render(container);
      });
  },
  unmount() {
    disposed = true;
  },
};

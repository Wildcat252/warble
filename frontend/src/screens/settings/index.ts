/**
 * Settings screen — microphone, voice type, daily goal, and pitch-engine
 * diagnostics.
 *
 * The vocal range test launches from the Voice section here, and this is now
 * its ONLY entry point (it previously also had a nav-rail item and a Home
 * tile). The test exists to determine one setting — your voice type — so it
 * reads as a top-level destination it never earned; consolidating it next to
 * the dropdown it writes to also makes the retake path obvious, which being
 * stranded in the nav rail did not.
 *
 * The microphone picker here is populated from the BACKEND's /audio/devices
 * list, because the backend captures audio itself (Python/sounddevice) and
 * /playback/start expects a PortAudio integer index. The separate "mic
 * setup" modal tests levels through the *browser's* getUserMedia and uses a
 * different device namespace — see services/audio-device.ts for why the two
 * are kept apart.
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import { openAudioPreflightModal } from '../../services/audio-preflight';
import {
  loadUserVoiceTypeId, persistUserVoiceTypeId,
  loadInstrumentId, persistInstrumentId,
  loadToneLeadMs, persistToneLeadMs, MIN_TONE_LEAD_MS, MAX_TONE_LEAD_MS,
  loadLeadInMs, persistLeadInMs, MIN_LEAD_IN_MS, MAX_LEAD_IN_MS,
} from '../../services/user-settings';
import {
  INSTRUMENTS, INSTRUMENT_FAMILIES, getInstrument, playInstrumentNote, type InstrumentId,
} from '../../audio/instruments';
import { getAudioContext } from '../../services/audio-context';
import { resolveAnchorMidi } from '../../exercises/anchor';
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

/** Grouped by instrument family — a flat list of seven voices is hard to scan. */
function instrumentOptions(): string {
  const current = loadInstrumentId();
  return INSTRUMENT_FAMILIES.map((family) => {
    const opts = INSTRUMENTS
      .filter((i) => i.family === family)
      .map((i) => `<option value="${i.id}" ${current === i.id ? 'selected' : ''}>${i.label}</option>`)
      .join('');
    return `<optgroup label="${family}">${opts}</optgroup>`;
  }).join('');
}

/** Length used when auditioning a voice in Settings — a typical exercise note. */
const AUDITION_SECONDS = 2;

function auditionInstrument(instrument: InstrumentId): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  playInstrumentNote(ctx, instrument, resolveAnchorMidi(), ctx.currentTime + 0.02, AUDITION_SECONDS);
}

function formatMs(ms: number): string {
  if (ms === 0) return 'Off';
  if (ms < 1000) return `${ms} ms`;
  // Trim a trailing .0 so 2000ms reads "2s", not "2.0s".
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
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
  const instrument = loadInstrumentId();
  const toneLeadMs = loadToneLeadMs();
  const leadInMs = loadLeadInMs();

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
        <p class="settings-hint">Sets the starting pitch exercises are built around.</p>
        <label class="settings-field">
          <span>Voice type</span>
          <select id="settings-voice-type">${voiceTypeOptions()}</select>
        </label>
        <p class="settings-hint">${voiceType
    ? `Currently ${voiceType.label} (${midiToNoteName(voiceType.lowMidi)}–${midiToNoteName(voiceType.highMidi)}). Retake the range test if your voice has changed.`
    : "Not sure which you are? The range test measures your lowest and highest notes and sets this for you."
}</p>
        <button type="button" class="btn btn-secondary" id="settings-open-range-test">
          ${voiceType ? 'Retake range test' : 'Take the range test'}
        </button>
      </section>

      <section class="card settings-section">
        <h2>Practice sound</h2>
        <p class="settings-hint">The reference note you hear at the start of each note in an exercise.</p>
        <label class="settings-field">
          <span>Instrument</span>
          <select id="settings-instrument">${instrumentOptions()}</select>
        </label>
        <p class="settings-hint">
          ${getInstrument(instrument)?.description ?? ''}
          ${getInstrument(instrument)?.sustains === false
    ? ' It fades away on its own rather than lasting the whole note — that is how a struck string behaves.'
    : ''
}
        </p>
        <button type="button" class="btn btn-secondary" id="settings-hear-instrument">Hear it</button>

        <label class="settings-field settings-field--slider">
          <span>Play note early</span>
          <input type="range" id="settings-tone-lead"
                 min="${MIN_TONE_LEAD_MS}" max="${MAX_TONE_LEAD_MS}" step="50" value="${toneLeadMs}" />
          <output for="settings-tone-lead" id="settings-tone-lead-out">${formatMs(toneLeadMs)}</output>
        </label>
        <p class="settings-hint">How far ahead of each note you hear its reference tone, so you have time to pitch it.</p>

        <label class="settings-field settings-field--slider">
          <span>Count-in before first note</span>
          <input type="range" id="settings-lead-in"
                 min="${MIN_LEAD_IN_MS}" max="${MAX_LEAD_IN_MS}" step="250" value="${leadInMs}" />
          <output for="settings-lead-in" id="settings-lead-in-out">${formatMs(leadInMs)}</output>
        </label>
        <p class="settings-hint">Silence at the start of every exercise before the first note is due.</p>
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

  container.querySelector<HTMLButtonElement>('#settings-open-range-test')?.addEventListener('click', () => {
    navigate('range-test');
  });

  container.querySelector<HTMLSelectElement>('#settings-instrument')?.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value as InstrumentId;
    persistInstrumentId(value);
    // Audition it immediately — picking a practice sound blind, then only
    // hearing it once an exercise is underway, makes the setting untestable.
    auditionInstrument(value);
    render(container); // refresh the description line
  });

  container.querySelector<HTMLButtonElement>('#settings-hear-instrument')?.addEventListener('click', () => {
    auditionInstrument(loadInstrumentId());
  });

  // 'input' (not 'change') so the readout tracks the thumb while dragging.
  // Neither slider re-renders: a re-render mid-drag would rebuild the input
  // and drop the pointer capture, stalling the drag.
  const toneLead = container.querySelector<HTMLInputElement>('#settings-tone-lead');
  toneLead?.addEventListener('input', () => {
    const value = Number.parseInt(toneLead.value, 10);
    persistToneLeadMs(value);
    const out = container.querySelector<HTMLElement>('#settings-tone-lead-out');
    if (out) out.textContent = formatMs(value);
  });

  const leadIn = container.querySelector<HTMLInputElement>('#settings-lead-in');
  leadIn?.addEventListener('input', () => {
    const value = Number.parseInt(leadIn.value, 10);
    persistLeadInMs(value);
    const out = container.querySelector<HTMLElement>('#settings-lead-in-out');
    if (out) out.textContent = formatMs(value);
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

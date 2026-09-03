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
  loadInstrumentId,
  loadToneLeadMs, persistToneLeadMs, MIN_TONE_LEAD_MS, MAX_TONE_LEAD_MS,
  loadLeadInMs, persistLeadInMs, MIN_LEAD_IN_MS, MAX_LEAD_IN_MS,
  loadRegisterDebugEnabled, persistRegisterDebugEnabled,
} from '../../services/user-settings';
import { diagnosticJson, diagnosticCount, clearDiagnostics } from '../../pitch/register-diagnostics';
import {
  loadRawCalibration, modelSeparates, separationDb, describeSeparation,
  clearRegisterCalibration,
} from '../../pitch/register-calibration';
import {
  getInstrument, playInstrumentNote, type InstrumentId,
} from '../../audio/instruments';
import { preloadPianoSamples } from '../../audio/piano-samples';
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

/** Length used when auditioning a voice in Settings — a typical exercise note. */
const AUDITION_SECONDS = 2;

function auditionInstrument(instrument: InstrumentId): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  // Await the sample set here too: without it the first press of "Hear it"
  // would fall back to the synth tone and misrepresent the practice sound.
  void preloadPianoSamples(ctx).then(() => {
    playInstrumentNote(ctx, instrument, resolveAnchorMidi(), ctx.currentTime + 0.02, AUDITION_SECONDS);
  });
}

function formatMs(ms: number): string {
  if (ms === 0) return 'Off';
  if (ms < 1000) return `${ms} ms`;
  // Trim a trailing .0 so 2000ms reads "2s", not "2.0s".
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

/**
 * Explains the state of register calibration, INCLUDING why it isn't working.
 *
 * Uses loadRawCalibration rather than loadRegisterCalibration so a stored-but-
 * unusable calibration can be described instead of silently reading as "never
 * set up" — the failure modes here (lines too close, microphone changed) are
 * actionable, and hiding them would leave the singer stuck.
 */
function registerStatus(): string {
  const cal = loadRawCalibration();
  if (!cal) {
    return `
      <p class="settings-hint">
        Not set up. The range test ends with two short patterns — five notes in chest voice,
        five in head voice — which teaches Warble to tell your registers apart while you practise.
      </p>
      <p class="settings-hint">
        It's an estimate, not a measurement: microphone, vowel and loudness all affect it.
      </p>
    `;
  }

  const sep = separationDb(cal.h1h2);
  const usable = modelSeparates(cal.h1h2);
  const deviceChanged = cal.deviceId !== loadBackendDeviceId();
  const captured = new Date(cal.capturedAt);

  return `
    <p class="settings-hint">
      ${usable
    ? `Working — your chest and head voice measured <strong>${sep.toFixed(1)} dB apart</strong>
         (${describeSeparation(sep)}), calibrated ${captured.toLocaleDateString()}.`
    : `Not usable — the two patterns measured only ${sep.toFixed(1)} dB apart,
         ${describeSeparation(sep)}. Retake the range test and make the head-voice set much lighter.`}
    </p>
    ${deviceChanged
    ? `<p class="settings-note settings-note--warn">
         You've changed microphone since calibrating. Register readings will be off until you redo it —
         the measurement depends on the mic's frequency response.
       </p>`
    : ''}
    ${cal.h1h2.slopeEstimated
    ? ''
    : `<p class="settings-hint">
         Both patterns landed on nearly one pitch, so readings far from those notes are rougher.
         Singing a wider spread next time would improve it.
       </p>`}
    <button type="button" class="btn btn-ghost" id="settings-clear-register">Clear calibration</button>
  `;
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
  const registerDebug = loadRegisterDebugEnabled();
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
        <h2>Register detection</h2>
        ${registerStatus()}
      </section>

      <section class="card settings-section">
        <h2>Practice sound</h2>
        <p class="settings-hint">The reference note you hear at the start of each note in an exercise.</p>
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
          <label class="settings-check">
            <input type="checkbox" id="settings-register-debug" ${registerDebug ? 'checked' : ''} />
            <span>Show vocal-register measurements during exercises</span>
          </label>
          <p class="settings-hint">
            Diagnostic only. Displays the raw spectral numbers behind chest/head detection so they
            can be checked against real singing — there is no classifier yet, so no label is shown.
          </p>
          <button type="button" class="btn btn-ghost" id="settings-copy-register">Copy register data (JSON)</button>
          <hr class="settings-divider" />
          <p class="settings-hint">Clearing history removes all streaks, XP and session records. This cannot be undone.</p>
          <button type="button" class="btn btn-ghost settings-danger" id="settings-clear">Clear practice history</button>
        </div>
      </details>
    </div>
  `;

  container.querySelector<HTMLSelectElement>('#settings-device')?.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    // Store the NAME too: a PortAudio index moves when devices come and go,
    // and the name is what the user actually chose. See audio-device.ts.
    const id = value === '' ? null : Number.parseInt(value, 10);
    const chosen = devices?.devices.find((d) => d.id === id);
    persistBackendDeviceId(id, chosen?.name ?? '');
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

  container.querySelector<HTMLButtonElement>('#settings-clear-register')?.addEventListener('click', () => {
    clearRegisterCalibration();
    showToast('Register calibration cleared.');
    render(container);
  });

  container.querySelector<HTMLInputElement>('#settings-register-debug')?.addEventListener('change', (ev) => {
    const enabled = (ev.target as HTMLInputElement).checked;
    persistRegisterDebugEnabled(enabled);
    // Starting a fresh measurement session: stale samples from a previous
    // run would contaminate the medians used to compare chest against head.
    if (enabled) clearDiagnostics();
    showToast(enabled ? 'Register measurements will show during exercises.' : 'Register measurements hidden.');
  });

  container.querySelector<HTMLButtonElement>('#settings-copy-register')?.addEventListener('click', () => {
    const count = diagnosticCount();
    if (count === 0) {
      showToast('No register data yet — sing through an exercise first.', { variant: 'warning' });
      return;
    }
    void navigator.clipboard.writeText(diagnosticJson())
      .then(() => showToast(`Copied ${count} frames of register data.`))
      .catch(() => showToast("Couldn't copy — clipboard access was blocked.", { variant: 'warning' }));
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

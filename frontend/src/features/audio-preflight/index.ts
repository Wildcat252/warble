/**
 * Microphone level test.
 *
 * Scope is deliberately narrow: show the user that their mic is picking up
 * sound, and how loud. Everything else this modal used to carry — mic device
 * picker, latency compensation, octave compensation, voice type — was either
 * duplicated by the Settings screen or written to storage that nothing ever
 * read, so it was removed rather than left as controls that appear to do
 * something.
 *
 * Note this measures the BROWSER's microphone via getUserMedia. Actual pitch
 * detection happens backend-side (Python/sounddevice) on the device chosen in
 * Settings, so this is an indicative check that audio reaches the machine —
 * not a test of the exact capture path.
 *
 * Permission is requested only when the user presses Start, never on open:
 * auto-requesting meant simply opening the modal could raise a permission
 * error the user hadn't asked for.
 */
import { type Feature } from '../../feature-types';
import { registerAudioPreflightOpener } from '../../services/audio-preflight';

let modalEl: HTMLDivElement | null = null;
let resolver: ((value: boolean) => void) | null = null;

let monitorCtx: AudioContext | null = null;
let monitorStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let monitorSource: MediaStreamAudioSourceNode | null = null;
let meterRaf: number | null = null;
let meterRunToken = 0;
let isMonitoring = false;
let sessionPeak = 0;

let meterFillEl: HTMLDivElement | null = null;
let resultEl: HTMLDivElement | null = null;
let testButtonEl: HTMLButtonElement | null = null;
let removeEscapeListener: (() => void) | null = null;

/** Scales the 0-1 peak into a meter width that reads well for speech/singing. */
const METER_GAIN_SCALE = 140;
// Below ~1.5% peak amplitude, treat the run as silence / no usable signal.
const NO_SIGNAL_THRESHOLD = 0.015;
// Between ~1.5% and 8% there is signal, but likely too quiet to track reliably.
const TOO_QUIET_THRESHOLD = 0.08;
// Above ~75% the input is close to clipping.
const TOO_LOUD_THRESHOLD = 0.75;

type Verdict = 'idle' | 'listening' | 'no-signal' | 'too-quiet' | 'good' | 'too-loud';

function amplitudeToDbfs(amplitude: number): number | null {
  return amplitude <= 0 ? null : 20 * Math.log10(amplitude);
}

function formatDbfs(dbfs: number | null): string {
  return dbfs === null ? '—' : `${dbfs.toFixed(1)} dBFS`;
}

export function classifyPeak(peak: number): { verdict: Verdict; message: string } {
  const level = `peak ${formatDbfs(amplitudeToDbfs(peak))}`;
  if (peak < NO_SIGNAL_THRESHOLD) {
    return { verdict: 'no-signal', message: 'No sound detected. Check that the right microphone is selected in Settings and that it isn\'t muted.' };
  }
  if (peak < TOO_QUIET_THRESHOLD) {
    return { verdict: 'too-quiet', message: `Quite quiet (${level}). Try moving closer or raising your input gain.` };
  }
  if (peak > TOO_LOUD_THRESHOLD) {
    return { verdict: 'too-loud', message: `Very loud (${level}) and close to clipping. Move back slightly or lower your input gain.` };
  }
  return { verdict: 'good', message: `Sounds good (${level}).` };
}

function setResult(verdict: Verdict, message: string): void {
  if (!resultEl) return;
  resultEl.dataset.state = verdict;
  resultEl.textContent = message;
}

function stopMonitoring(): void {
  meterRunToken += 1;
  if (meterRaf !== null) {
    cancelAnimationFrame(meterRaf);
    meterRaf = null;
  }
  try {
    monitorSource?.disconnect();
  } catch {
    // Some Web Audio implementations throw if already disconnected.
  }
  monitorStream?.getTracks().forEach((t) => t.stop());
  monitorStream = null;
  analyser = null;
  monitorSource = null;
  if (monitorCtx) {
    void monitorCtx.close().catch(() => undefined);
    monitorCtx = null;
  }
  isMonitoring = false;
  if (meterFillEl) meterFillEl.style.width = '0%';
  if (testButtonEl) testButtonEl.textContent = 'Start test';
}

function runMeter(): void {
  if (!analyser || !meterFillEl) return;
  const data = new Uint8Array(analyser.fftSize);
  const runToken = meterRunToken;

  const tick = (): void => {
    if (runToken !== meterRunToken || !analyser || !meterFillEl) return;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const mag = Math.abs((data[i] - 128) / 128);
      if (mag > peak) peak = mag;
    }
    sessionPeak = Math.max(sessionPeak, peak);
    meterFillEl.style.width = `${Math.min(100, Math.round(peak * METER_GAIN_SCALE))}%`;
    meterRaf = requestAnimationFrame(tick);
  };
  meterRaf = requestAnimationFrame(tick);
}

async function startMonitoring(): Promise<void> {
  stopMonitoring();
  sessionPeak = 0;

  let stream: MediaStream;
  try {
    // No deviceId constraint: the browser's default input is enough for an
    // indicative level check, and requesting a specific one here would imply
    // this picks the capture device (Settings does, backend-side).
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setResult('no-signal', denied
      ? 'Microphone access was blocked. Allow it for this app in your browser or system settings, then try again.'
      : `Couldn't open the microphone: ${String(err)}`);
    return;
  }

  monitorStream = stream;
  monitorCtx = new AudioContext();
  monitorSource = monitorCtx.createMediaStreamSource(stream);
  analyser = monitorCtx.createAnalyser();
  analyser.fftSize = 2048;
  // Analyser only — never routed to destination, so the mic is not echoed
  // back through the speakers (which would feed straight back into it).
  monitorSource.connect(analyser);

  isMonitoring = true;
  if (testButtonEl) testButtonEl.textContent = 'Stop test';
  setResult('listening', 'Listening… speak or sing, then stop the test.');
  runMeter();
}

function finishTest(): void {
  const peak = sessionPeak;
  stopMonitoring();
  const { verdict, message } = classifyPeak(peak);
  setResult(verdict, message);
}

function buildModal(): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.id = 'audio-preflight-modal';
  wrapper.className = 'audio-preflight hidden';
  wrapper.innerHTML = `
    <div class="audio-preflight-backdrop"></div>
    <div class="audio-preflight-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-preflight-title">
      <button id="audio-preflight-close" class="audio-preflight-close" aria-label="Close">Close</button>
      <h2 id="audio-preflight-title">Test your microphone</h2>
      <p class="audio-preflight-help">Start the test and make some sound — the bar should move.</p>

      <div class="audio-meter"><div id="audio-preflight-meter-fill" class="audio-meter-fill"></div></div>

      <div id="audio-preflight-result" class="audio-preflight-test-result" data-state="idle">
        Press Start test, then speak or sing.
      </div>

      <div class="audio-preflight-tip">
        Use headphones so the sound you're matching doesn't leak into the mic.
      </div>

      <div class="audio-preflight-actions">
        <button id="audio-preflight-test" class="btn btn-primary">Start test</button>
        <button id="audio-preflight-done" class="btn btn-secondary">Done</button>
      </div>
    </div>
  `;
  return wrapper;
}

function ensureStyles(): void {
  if (document.getElementById('audio-preflight-style')) return;
  const style = document.createElement('style');
  style.id = 'audio-preflight-style';
  style.textContent = `
    .audio-preflight.hidden { display: none; }
    .audio-preflight {
      position: fixed; inset: 0; z-index: 3000;
      display: flex; align-items: center; justify-content: center;
      padding: var(--space-5);
    }
    .audio-preflight-backdrop { position: absolute; inset: 0; background: rgba(43, 36, 56, 0.45); }
    .audio-preflight-dialog {
      position: relative;
      width: min(460px, 100%);
      background: var(--color-surface);
      color: var(--color-text);
      border-radius: var(--radius-xl);
      padding: var(--space-6);
      box-shadow: var(--shadow-lg);
    }
    .audio-preflight-dialog h2 { font-size: var(--text-lg); margin-bottom: var(--space-2); }
    .audio-preflight-help { color: var(--color-text-muted); font-size: var(--text-sm); margin-bottom: var(--space-5); }
    .audio-preflight-close {
      position: absolute; top: var(--space-3); right: var(--space-3);
      border: none; border-radius: var(--radius-full);
      background: var(--color-surface-alt); color: var(--color-text-muted);
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-xs); cursor: pointer;
    }
    .audio-preflight-close:hover { background: var(--color-border); color: var(--color-text); }
    .audio-meter {
      height: 14px; border-radius: var(--radius-full);
      border: 1px solid var(--color-border); background: var(--color-surface-alt);
      overflow: hidden; margin-bottom: var(--space-4);
    }
    .audio-meter-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, var(--color-good), var(--color-warn), var(--color-bad));
      transition: width 60ms linear;
    }
    .audio-preflight-tip, .audio-preflight-test-result {
      background: var(--color-surface-alt);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      margin-bottom: var(--space-3);
      font-size: var(--text-sm);
    }
    .audio-preflight-test-result[data-state="good"] { border-color: var(--color-good); background: rgba(52,211,153,0.12); color: #1a8a63; }
    .audio-preflight-test-result[data-state="too-quiet"],
    .audio-preflight-test-result[data-state="too-loud"] { border-color: var(--color-warn); background: rgba(255,176,32,0.12); color: #a06400; }
    .audio-preflight-test-result[data-state="no-signal"] { border-color: var(--color-bad); background: rgba(239,68,68,0.12); color: #b91c1c; }
    .audio-preflight-actions { display: flex; gap: var(--space-2); margin-top: var(--space-4); }
    @media (max-width: 640px) {
      .audio-preflight-dialog { border-radius: 0; width: 100%; min-height: 100vh; }
    }
  `;
  document.head.appendChild(style);
}

function closeModal(completed: boolean): void {
  stopMonitoring();
  modalEl?.classList.add('hidden');
  removeEscapeListener?.();
  if (resolver) {
    resolver(completed);
    resolver = null;
  }
}

function openModal(): Promise<boolean> {
  if (!modalEl) return Promise.resolve(false);
  if (resolver) {
    resolver(false);
    resolver = null;
  }

  sessionPeak = 0;
  setResult('idle', 'Press Start test, then speak or sing.');
  if (meterFillEl) meterFillEl.style.width = '0%';
  modalEl.classList.remove('hidden');

  removeEscapeListener?.();
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || modalEl?.classList.contains('hidden')) return;
    event.preventDefault();
    closeModal(false);
  };
  window.addEventListener('keydown', onEscape);
  removeEscapeListener = () => {
    window.removeEventListener('keydown', onEscape);
    removeEscapeListener = null;
  };

  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

function mount(_slot: HTMLElement): void {
  ensureStyles();
  modalEl = buildModal();
  document.body.appendChild(modalEl);

  meterFillEl = modalEl.querySelector('#audio-preflight-meter-fill');
  resultEl = modalEl.querySelector('#audio-preflight-result');
  testButtonEl = modalEl.querySelector('#audio-preflight-test');

  modalEl.querySelector('#audio-preflight-close')?.addEventListener('click', () => closeModal(false));
  modalEl.querySelector('.audio-preflight-backdrop')?.addEventListener('click', () => closeModal(false));
  modalEl.querySelector('#audio-preflight-done')?.addEventListener('click', () => closeModal(true));

  testButtonEl?.addEventListener('click', () => {
    if (isMonitoring) finishTest();
    else void startMonitoring();
  });

  registerAudioPreflightOpener(openModal);
}

function unmount(): void {
  stopMonitoring();
  removeEscapeListener?.();
  if (resolver) {
    resolver(false);
    resolver = null;
  }
  modalEl?.remove();
  modalEl = null;
  meterFillEl = null;
  resultEl = null;
  testButtonEl = null;
}

export const audioPreflightFeature: Feature = {
  id: 'slot-audio-preflight',
  mount,
  unmount,
};

/**
 * Vocal Range Test — a short guided flow: glide down to your lowest
 * comfortable note, then up to your highest, and get a voice-type
 * suggestion from the measured range.
 *
 * Like exercise-player, this owns its own capture/clock loop end-to-end
 * (no playback-sync/timeline-sync — see that file's comment for why) and,
 * per the same UX decision that removed the auto-popup mic modal from
 * exercise start, does NOT gate itself on audio-preflight either — it just
 * starts capturing.
 *
 * Each phase asks for a brief GLIDE, not a single static held note, because
 * sliding into the extreme finds a true limit more reliably than trying to
 * pitch it cold.
 *
 * That makes SessionRangeTracker's stable-note count useless as a quality
 * signal here — gliding never settles within 40 cents of a semitone for the
 * 250ms a "stable note" requires. So classification uses
 * voiceTypeForRange() (range + span sanity) rather than
 * classifyVoiceType() (which additionally demands 10 stable notes, the
 * right gate only for range picked up passively during practice). If the
 * span is implausible the reveal still shows the measured low/high without
 * a guess, rather than failing outright.
 */
import type { Screen } from '../../screen-types';
import { navigate, goBack } from '../../navigation/router';
import { SessionRangeTracker } from '../../pitch/session-range';
import { voiceTypeForRange } from '../../pitch/voice-type';
import { persistUserVoiceTypeId } from '../../services/user-settings';
import { recordPracticeEntry } from '../../gamification/practice-log';
import { loadBackendDeviceId } from '../../services/audio-device';
import { PitchConnection } from '../../pitch/pitch-connection';
import type { PitchFrame } from '../../pitch/socket';
import { MIN_CONFIDENCE_FOR_DOT } from '../../pitch/accuracy';
import { midiToNoteName } from '../../pitch/note-name';
import { getAudioContext } from '../../services/audio-context';
import { startPlayback, postPlayback } from '../../transport/controls';
import { setAppStatus } from '../../services/status';
import './range-test.css';

type Stage = 'intro' | 'low' | 'high' | 'reveal';

const PHASE_DURATION_MS = 6000;

let stage: Stage = 'intro';
let tracker: SessionRangeTracker | null = null;
let connection: PitchConnection | null = null;
let playbackStarted = false;
let stopped = false;
let phaseTimer: number | null = null;
let phaseStartedAtMs = 0;
let phaseRafId: number | null = null;
let container: HTMLElement | null = null;

function resetState(): void {
  stage = 'intro';
  tracker = null;
  connection = null;
  playbackStarted = false;
  stopped = false;
  phaseTimer = null;
  phaseStartedAtMs = 0;
  phaseRafId = null;
  container = null;
}

function clearPhaseTimer(): void {
  if (phaseTimer !== null) {
    window.clearTimeout(phaseTimer);
    phaseTimer = null;
  }
  if (phaseRafId !== null) {
    cancelAnimationFrame(phaseRafId);
    phaseRafId = null;
  }
}

/**
 * Finishing returns the singer to whichever screen launched the test, rather
 * than dumping them on Home. In practice that's Settings → Voice (the only
 * entry point), where the voice type they just saved is now visible in the
 * dropdown — landing on Home instead hid the result of the thing they'd just
 * done. goBack() is used rather than a hardcoded navigate('settings') so a
 * future second entry point doesn't silently misroute; Home is the fallback
 * for the case where the back-stack is somehow empty (e.g. a deep link
 * straight into the test).
 */
function returnToOrigin(): void {
  if (!goBack()) navigate('home');
}

function render(): void {
  if (!container) return;
  if (stage === 'intro') return renderIntro(container);
  if (stage === 'low' || stage === 'high') return renderCapture(container);
  renderReveal(container);
}

function renderIntro(root: HTMLElement): void {
  root.innerHTML = `
    <div class="range-test range-test--intro fade-in">
      <div class="card range-test__card">
        <h1>Find your voice type</h1>
        <p>You'll glide down to your lowest comfortable note, then up to your highest. No need to strain — comfortable is better than extreme.</p>
        <button type="button" class="btn btn-primary" id="range-test-begin">Begin</button>
      </div>
    </div>
  `;
  root.querySelector<HTMLButtonElement>('#range-test-begin')?.addEventListener('click', () => {
    void beginCapture();
  });
}

function renderCapture(root: HTMLElement): void {
  const isLow = stage === 'low';
  root.innerHTML = `
    <div class="range-test fade-in">
      <div class="range-test__prompt">
        <h1>${isLow ? 'Glide down to your lowest note' : 'Now glide up to your highest note'}</h1>
        <p>${isLow ? 'Start comfortable, then slide down as low as you can, and hold there.' : 'Slide up as high as you can comfortably reach, and hold there.'}</p>
      </div>
      <div class="range-test__progress-track"><div class="range-test__progress-fill" id="range-test-progress"></div></div>
      <div class="card range-test__readout-card">
        <div class="range-test__detected" id="range-test-detected">Detected: —</div>
        <div class="range-test__span" id="range-test-span">Captured range: —</div>
      </div>
      <button type="button" class="btn btn-secondary" id="range-test-next">
        ${isLow ? "Got it, that's my lowest" : "Got it, that's my highest"}
      </button>
    </div>
  `;
  root.querySelector<HTMLButtonElement>('#range-test-next')?.addEventListener('click', () => {
    advanceStage();
  });
}

function renderReveal(root: HTMLElement): void {
  const summary = tracker?.summary() ?? null;
  // voiceTypeForRange, NOT classifyVoiceType: the latter also demands 10
  // distinct stable notes, which is the right gate for range picked up
  // passively during practice but impossible to satisfy here — this screen
  // asks the singer to GLIDE to each extreme, and gliding never settles on
  // discrete pitches. Using it rejected valid measurements outright.
  const voiceType = summary ? voiceTypeForRange(summary.lowMidi, summary.highMidi) : null;

  const rangeText = summary ? `${midiToNoteName(summary.lowMidi)} – ${midiToNoteName(summary.highMidi)}` : 'Not enough signal captured';

  root.innerHTML = `
    <div class="range-test range-test--reveal fade-in">
      <div class="card range-test__card">
        ${voiceType
    ? `<h1>You're a ${voiceType.label}!</h1>`
    : '<h1>Here\'s your measured range</h1>'
}
        <p class="range-test__range-readout">${rangeText}</p>
        ${!voiceType && summary
    ? '<p class="range-test__hint">That range looks too narrow or too wide to match a voice type confidently — try again, going as low and as high as is comfortable without straining.</p>'
    : ''
}
        ${!summary ? '<p class="range-test__hint">We couldn\'t detect enough of your voice — check your mic in Settings and try again.</p>' : ''}
        <div class="range-test__actions">
          ${voiceType ? '<button type="button" class="btn btn-primary" id="range-test-save">Save as my voice type</button>' : ''}
          <button type="button" class="btn btn-secondary" id="range-test-done">${voiceType ? 'Skip' : 'Done'}</button>
        </div>
      </div>
    </div>
  `;

  root.querySelector<HTMLButtonElement>('#range-test-save')?.addEventListener('click', () => {
    if (voiceType) persistUserVoiceTypeId(voiceType.id);
    returnToOrigin();
  });
  root.querySelector<HTMLButtonElement>('#range-test-done')?.addEventListener('click', () => {
    returnToOrigin();
  });
}

function updateCaptureReadout(frame: PitchFrame | null): void {
  if (!container) return;
  const detectedEl = container.querySelector<HTMLElement>('#range-test-detected');
  const spanEl = container.querySelector<HTMLElement>('#range-test-span');
  if (detectedEl) {
    detectedEl.textContent = frame && frame.conf >= MIN_CONFIDENCE_FOR_DOT
      ? `Detected: ${midiToNoteName(frame.midi)}`
      : 'Detected: —';
  }
  if (spanEl) {
    const summary = tracker?.summary() ?? null;
    spanEl.textContent = summary
      ? `Captured range: ${midiToNoteName(summary.lowMidi)} – ${midiToNoteName(summary.highMidi)}`
      : 'Captured range: —';
  }
}

function updateProgressBar(): void {
  if (!container) return;
  const fillEl = container.querySelector<HTMLElement>('#range-test-progress');
  if (!fillEl) return;
  const elapsed = performance.now() - phaseStartedAtMs;
  const pct = Math.max(0, Math.min(100, (elapsed / PHASE_DURATION_MS) * 100));
  fillEl.style.width = `${pct}%`;
  if (elapsed < PHASE_DURATION_MS && !stopped) {
    phaseRafId = requestAnimationFrame(updateProgressBar);
  }
}

function handleFrame(frame: PitchFrame): void {
  if (!tracker) return;
  tracker.ingest(frame, MIN_CONFIDENCE_FOR_DOT);
  updateCaptureReadout(frame);
}

function startPhaseTimer(): void {
  clearPhaseTimer();
  phaseStartedAtMs = performance.now();
  phaseRafId = requestAnimationFrame(updateProgressBar);
  phaseTimer = window.setTimeout(() => {
    advanceStage();
  }, PHASE_DURATION_MS);
}

function advanceStage(): void {
  if (stopped) return;
  clearPhaseTimer();
  if (stage === 'low') {
    stage = 'high';
    render();
    startPhaseTimer();
    return;
  }
  if (stage === 'high') {
    finishCapture();
  }
}

/** Flat award — the range test isn't scored on accuracy, so XP can't scale with it. */
const RANGE_TEST_XP = 40;

function finishCapture(): void {
  stage = 'reveal';
  connection?.close();
  connection = null;
  if (playbackStarted) void postPlayback('/playback/stop').catch(() => {});

  // Log it so the range test counts toward streaks/XP like any other
  // session, and so the Progress screen's range trend has data points.
  // Only when a range was actually measured — logging a no-signal run would
  // inflate the streak for something the user didn't really complete.
  const summary = tracker?.summary() ?? null;
  if (summary) {
    recordPracticeEntry({
      timestamp: new Date().toISOString(),
      exerciseId: 'range-test',
      exerciseKind: 'range-test',
      accuracyPct: 100,
      durationMs: PHASE_DURATION_MS * 2,
      xpEarned: RANGE_TEST_XP,
      minMidi: summary.lowMidi,
      maxMidi: summary.highMidi,
    });
  }

  render();
}

async function beginCapture(): Promise<void> {
  tracker = new SessionRangeTracker();
  stage = 'low';
  render();

  try {
    const ctx = getAudioContext();
    // Same suspended-clock pitfall as exercise-player — resume() before
    // anything that depends on real-time progressing matters here too,
    // even though this screen's own clock is just a UI countdown (not a
    // scoring anchor), because starting the tone/analysis pipeline while
    // still suspended would delay the very first frames.
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    // Backend PortAudio device index from Settings (null = backend default).
    await startPlayback(loadBackendDeviceId());
    playbackStarted = true;
  } catch (err) {
    setAppStatus('range test start failed', 'error');
    if (container) {
      container.innerHTML = `
        <div class="range-test range-test--intro fade-in">
          <div class="card range-test__card">
            <h1>Couldn't start</h1>
            <p>${String(err)}</p>
            <button type="button" class="btn btn-secondary" id="range-test-back">Back</button>
          </div>
        </div>
      `;
      container.querySelector<HTMLButtonElement>('#range-test-back')?.addEventListener('click', () => goBack());
    }
    return;
  }
  if (stopped) return; // unmounted mid-start

  connection = new PitchConnection({ onFrame: handleFrame });
  connection.connect();
  startPhaseTimer();
}

function mount(root: HTMLElement): void {
  resetState();
  container = root;
  render();
}

function unmount(): void {
  stopped = true;
  clearPhaseTimer();
  connection?.close();
  connection = null;
  if (playbackStarted) void postPlayback('/playback/stop').catch(() => {});
  container = null;
}

export const rangeTestScreen: Screen = {
  id: 'range-test',
  mount,
  unmount,
};

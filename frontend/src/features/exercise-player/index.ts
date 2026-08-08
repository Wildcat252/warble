/**
 * Exercise Player — the live pitch-matching gameplay screen. Drives every
 * exercise kind (note-hold, scale-climb, interval-jump, guided-warmup)
 * through one shared clock/graph/WS-connection/scoring loop; only
 * generate() and scoringStrategy (see exercises/types.ts) differ per
 * exercises/catalog.ts entry — this file itself doesn't change when Phase 4
 * adds the remaining exercise kinds to the picker.
 *
 * Clock: unlike the old features/playback + features/pitch-overlay split,
 * this screen owns the whole real-time loop end-to-end (no score-following,
 * no accompaniment track, no seeking), so it doesn't need
 * services/playback-sync.ts's cross-feature event bus or
 * pitch/timeline-sync.ts's offset reconciliation — that machinery exists to
 * keep multiple independent features in sync with each other, and here
 * there's only one. AudioContext.currentTime is captured once as
 * `startAudioTimeSec` right before /playback/start is called; elapsed local
 * time (ctx.currentTime - startAudioTimeSec) and the backend's own frame.t
 * (ms since that same call) are both zero-based at that instant, so they're
 * used directly and interchangeably below.
 */
import type { Screen } from '../../screen-types';
import { navigate, goBack } from '../../navigation/router';
import { getExerciseById } from '../../exercises/catalog';
import { DEFAULT_ANCHOR_MIDI, type ExerciseDefinition, type ExerciseTargetNote, type ExerciseTargetResult } from '../../exercises/types';
import { expectedTargetAtTime, exerciseDurationMs } from '../../exercises/timing';
import { scoreContinuousCents, scoreStableHold } from '../../exercises/scoring';
import { rangeFromTargets } from '../../exercises/range';
import { PitchGraphCanvas } from '../../pitch/graph';
import { PitchConnection } from '../../pitch/pitch-connection';
import { StableNoteDetector, type StableNoteState } from '../../pitch/stable-note';
import type { PitchFrame } from '../../pitch/socket';
import { centsOffPitch, GREEN_CENTS_THRESHOLD, MIN_CONFIDENCE_FOR_DOT } from '../../pitch/accuracy';
import { midiToFrequency, midiToNoteName } from '../../pitch/note-name';
import { getVoiceTypeById } from '../../pitch/voice-type';
import { TonePlayer } from '../../audio/tone-player';
import { getAudioContext } from '../../services/audio-context';
import { ensureAudioPreflightReady, loadUserVoiceTypeId } from '../../services/audio-preflight';
import { startPlayback, postPlayback } from '../../transport/controls';
import { setAppStatus } from '../../services/status';
import '../../screens/placeholder.css'; // shares .screen-placeholder/.card for the not-found state
import './exercise-player.css';

interface Els {
  status: HTMLElement;
  targetReadout: HTMLElement;
  detectedReadout: HTMLElement;
  progressDots: HTMLElement;
  graphContainer: HTMLElement;
  summary: HTMLElement;
}

let definition: ExerciseDefinition | null = null;
let targets: ExerciseTargetNote[] = [];
let graph: PitchGraphCanvas | null = null;
let connection: PitchConnection | null = null;
let stableDetector: StableNoteDetector | null = null;
let tonePlayer: TonePlayer | null = null;
let rafId: number | null = null;
let startAudioTimeSec = 0;
let playbackStarted = false;
let stopped = false;
let els: Els | null = null;

let activeTargetIndex: number | null = null;
let framesForActiveTarget: { midi: number; conf: number }[] = [];
let statesForActiveTarget: StableNoteState[] = [];
/** Indexed by target index, not append order — see the Phase 3 build note in
 * finalizeActiveTarget() for why sparse indexing matters here. */
let perTargetResults: (ExerciseTargetResult | undefined)[] = [];

function resetState(): void {
  definition = null;
  targets = [];
  graph = null;
  connection = null;
  stableDetector = null;
  tonePlayer = null;
  rafId = null;
  startAudioTimeSec = 0;
  playbackStarted = false;
  stopped = false;
  els = null;
  activeTargetIndex = null;
  framesForActiveTarget = [];
  statesForActiveTarget = [];
  perTargetResults = [];
}

/**
 * Always null — /playback/start's device_id must be a `sounddevice`
 * (PortAudio) integer index, from the backend's own /audio/devices list.
 * services/audio-preflight.ts's stored device id is a BROWSER
 * `navigator.mediaDevices` deviceId (an opaque hash string, used for the
 * preflight modal's own getUserMedia level-meter check) — a completely
 * different numbering scheme. An earlier version of this function
 * `parseInt()`'d that hash string, which for many devices "succeeds" with
 * a small-looking number that isn't a real backend device index, and the
 * backend would crash opening the wrong device
 * (sounddevice.PortAudioError, PaErrorCode -9986).
 * `null` here means "use the backend's own default input device," which
 * is what most users want anyway. Phase 8 (Settings screen) is where a
 * real backend-device-list-driven picker belongs, fed by /audio/devices
 * like the old features/pitch-overlay settings panel did — not this
 * shortcut.
 */
function resolveDeviceId(): number | null {
  return null;
}

function resolveAnchorMidi(): number {
  const voiceType = getVoiceTypeById(loadUserVoiceTypeId());
  if (!voiceType) return DEFAULT_ANCHOR_MIDI;
  return Math.round((voiceType.lowMidi + voiceType.highMidi) / 2);
}

function targetIndexAt(elapsedMs: number): number | null {
  const target = expectedTargetAtTime(elapsedMs, targets);
  return target ? targets.indexOf(target) : null;
}

function renderNotFound(container: HTMLElement): void {
  container.innerHTML = `
    <div class="screen-placeholder">
      <div class="card">
        <h1>Exercise not found</h1>
        <p>Go back and pick an exercise to start.</p>
        <button type="button" class="btn btn-secondary" id="ex-back-btn">Back</button>
      </div>
    </div>
  `;
  container.querySelector<HTMLButtonElement>('#ex-back-btn')?.addEventListener('click', () => goBack());
}

function renderShell(container: HTMLElement, def: ExerciseDefinition): void {
  container.innerHTML = `
    <div class="exercise-player fade-in">
      <div class="exercise-player__header">
        <h1>${def.title}</h1>
        <p>${def.description}</p>
        <div class="exercise-player__progress" id="ex-progress-dots"></div>
      </div>
      <div class="exercise-player__status" id="ex-status" aria-live="polite">Getting ready…</div>
      <div class="exercise-player__graph-card card">
        <div class="exercise-player__readouts">
          <div class="exercise-player__target" id="ex-target">Target: —</div>
          <div class="exercise-player__detected" id="ex-detected">Detected: —</div>
        </div>
        <div class="exercise-player__graph" id="ex-graph"></div>
      </div>
      <div class="exercise-player__summary hidden" id="ex-summary"></div>
    </div>
  `;

  els = {
    status: container.querySelector('#ex-status')!,
    targetReadout: container.querySelector('#ex-target')!,
    detectedReadout: container.querySelector('#ex-detected')!,
    progressDots: container.querySelector('#ex-progress-dots')!,
    graphContainer: container.querySelector('#ex-graph')!,
    summary: container.querySelector('#ex-summary')!,
  };
}

function renderProgressDots(): void {
  if (!els) return;
  els.progressDots.innerHTML = targets
    .map((_, i) => {
      const result = perTargetResults[i];
      if (result) return `<span class="dot ${result.hit ? 'dot--hit' : 'dot--miss'}"></span>`;
      if (i === activeTargetIndex) return '<span class="dot dot--current"></span>';
      return '<span class="dot dot--pending"></span>';
    })
    .join('');
}

function updateTargetReadout(): void {
  if (!els) return;
  if (activeTargetIndex === null) {
    els.targetReadout.textContent = 'Target: —';
    return;
  }
  const target = targets[activeTargetIndex];
  const label = target.label ? ` (${target.label})` : '';
  els.targetReadout.textContent = `Target: ${midiToNoteName(target.midi)}${label}`;
}

function updateDetectedReadout(frame: PitchFrame, expectedMidi: number | null): void {
  if (!els) return;
  if (frame.conf < MIN_CONFIDENCE_FOR_DOT) {
    els.detectedReadout.textContent = 'Detected: —';
    els.detectedReadout.dataset.tone = 'none';
    return;
  }
  els.detectedReadout.textContent = `Detected: ${midiToNoteName(frame.midi)}`;
  if (expectedMidi === null) {
    els.detectedReadout.dataset.tone = 'none';
    return;
  }
  const cents = Math.abs(centsOffPitch(frame.midi, expectedMidi));
  els.detectedReadout.dataset.tone = cents <= GREEN_CENTS_THRESHOLD ? 'good' : 'off';
}

/**
 * Scores and records the target at `activeTargetIndex`, writing into
 * perTargetResults BY INDEX rather than appending. If a RAF tick is ever
 * delayed long enough to skip an entire target window (e.g. a backgrounded/
 * throttled tab), targetIndexAt() jumps straight to the new active index —
 * appending would silently misalign perTargetResults with `targets` from
 * that point on. Indexed assignment leaves the skipped slot `undefined`
 * (computeAccuracyPct() below treats that as a miss) instead of corrupting
 * every result after it.
 */
function finalizeActiveTarget(): void {
  if (activeTargetIndex === null || !definition) return;
  const target = targets[activeTargetIndex];
  let hit: boolean;
  let achievedMidi: number | null = null;

  if (definition.scoringStrategy === 'stable-hold') {
    const result = scoreStableHold(statesForActiveTarget, target.midi);
    hit = result.hit;
    achievedMidi = result.achievedMidi;
  } else {
    hit = scoreContinuousCents(framesForActiveTarget, target.midi).hit;
  }

  perTargetResults[activeTargetIndex] = { target, achievedMidi, hit };
  renderProgressDots();
}

function computeAccuracyPct(): number {
  if (targets.length === 0) return 0;
  const hits = targets.reduce((count, _t, i) => count + (perTargetResults[i]?.hit ? 1 : 0), 0);
  return Math.round((hits / targets.length) * 100);
}

function handleFrame(frame: PitchFrame): void {
  if (!definition || !graph) return;
  const frameTargetIndex = targetIndexAt(frame.t);
  const expectedMidi = frameTargetIndex !== null ? targets[frameTargetIndex].midi : null;

  graph.pushFrame(frame, expectedMidi);
  updateDetectedReadout(frame, expectedMidi);

  // Only accumulate into the buffer for whichever target the RAF loop
  // currently has active — a frame whose own timestamp maps to a different
  // target (arrived late, or during a gap) is shown on the graph but not
  // scored against a target it doesn't belong to.
  if (frameTargetIndex !== null && frameTargetIndex === activeTargetIndex) {
    framesForActiveTarget.push({ midi: frame.midi, conf: frame.conf });
    if (definition.scoringStrategy === 'stable-hold' && stableDetector) {
      statesForActiveTarget.push(stableDetector.pushFrame(frame));
    }
  }
}

function showSummary(): void {
  if (!els) return;
  els.status.textContent = 'Exercise complete!';
  const accuracyPct = computeAccuracyPct();
  const rows = targets
    .map((t, i) => {
      const icon = perTargetResults[i]?.hit ? '✅' : '❌';
      const label = t.label ? ` — ${t.label}` : '';
      return `<li>${icon} ${midiToNoteName(t.midi)}${label}</li>`;
    })
    .join('');

  els.summary.classList.remove('hidden');
  els.summary.innerHTML = `
    <div class="card pop-in exercise-summary">
      <h2>Accuracy: ${accuracyPct}%</h2>
      <ul class="exercise-summary__list">${rows}</ul>
      <p class="exercise-summary__note">
        This is a Phase 3 verification view — XP, streaks, and the real Results
        screen land in a later build phase.
      </p>
      <button type="button" class="btn btn-primary" id="ex-done-btn">Done</button>
    </div>
  `;
  els.summary.querySelector<HTMLButtonElement>('#ex-done-btn')?.addEventListener('click', () => {
    navigate('home');
  });
}

function finishExercise(): void {
  if (stopped) return;
  finalizeActiveTarget();
  activeTargetIndex = null;
  stopped = true;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  connection?.close();
  if (playbackStarted) void postPlayback('/playback/stop').catch(() => {});
  showSummary();
}

function tick(): void {
  if (stopped || !definition || !graph) return;

  const ctx = getAudioContext();
  const elapsedSec = ctx.currentTime - startAudioTimeSec;
  const elapsedMs = elapsedSec * 1000;

  graph.tick(elapsedSec);

  if (elapsedMs >= exerciseDurationMs(targets)) {
    finishExercise();
    return;
  }

  const newIndex = targetIndexAt(elapsedMs);
  if (newIndex !== activeTargetIndex) {
    finalizeActiveTarget();
    activeTargetIndex = newIndex;
    framesForActiveTarget = [];
    statesForActiveTarget = [];
    stableDetector?.reset();
    updateTargetReadout();
  }
  if (activeTargetIndex !== null) {
    tonePlayer?.playExpectedMidi(targets[activeTargetIndex].midi);
  }

  rafId = requestAnimationFrame(tick);
}

async function start(): Promise<void> {
  if (!els || !definition) return;
  const def = definition;

  els.status.textContent = 'Checking microphone…';
  const ready = await ensureAudioPreflightReady();
  if (stopped) return; // unmounted while awaiting preflight
  if (!ready) {
    els.status.textContent = 'Microphone setup is required to start this exercise.';
    return;
  }

  const anchorMidi = resolveAnchorMidi();
  targets = def.generate({ anchorMidi });
  renderProgressDots();

  graph = new PitchGraphCanvas(els.graphContainer, { bandCentsTolerance: GREEN_CENTS_THRESHOLD });
  const range = rangeFromTargets(targets);
  graph.setRange(midiToFrequency(range.minMidi), midiToFrequency(range.maxMidi));

  tonePlayer = new TonePlayer();
  if (def.scoringStrategy === 'stable-hold') {
    stableDetector = new StableNoteDetector();
  }

  els.status.textContent = 'Starting…';
  try {
    const ctx = getAudioContext();
    // AudioContext starts (or resumes) in a "suspended" state until a user
    // gesture unlocks it, and its currentTime is FROZEN while suspended —
    // anchoring startAudioTimeSec before resume() completes would freeze
    // elapsedSec at ~0 for the rest of the exercise (graph never advances,
    // scoring windows never close). Clicking into this exercise was itself
    // a user gesture, so resume() reliably succeeds here; just await it
    // before reading currentTime for the anchor.
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    startAudioTimeSec = ctx.currentTime;
    await startPlayback(resolveDeviceId());
    playbackStarted = true;
  } catch (err) {
    els.status.textContent = `Couldn't start: ${String(err)}`;
    setAppStatus('exercise start failed', 'error');
    return;
  }
  if (stopped) return; // unmounted mid-start

  connection = new PitchConnection({ onFrame: handleFrame });
  connection.connect();
  els.status.textContent = 'Sing along!';
  rafId = requestAnimationFrame(tick);
}

function mount(container: HTMLElement, params: Readonly<Record<string, string>>): void {
  resetState();
  const def = params.exerciseId ? getExerciseById(params.exerciseId) : undefined;
  if (!def) {
    renderNotFound(container);
    return;
  }
  definition = def;
  renderShell(container, def);
  void start();
}

function unmount(): void {
  stopped = true;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  connection?.close();
  connection = null;
  if (playbackStarted) void postPlayback('/playback/stop').catch(() => {});
  graph?.destroy();
  graph = null;
  els = null;
}

export const exercisePlayerScreen: Screen = {
  id: 'exercise-player',
  mount,
  unmount,
};

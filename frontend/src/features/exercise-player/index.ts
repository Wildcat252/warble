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
import { type ExerciseDefinition, type ExerciseTargetNote, type ExerciseTargetResult } from '../../exercises/types';
import { resolveAnchorMidi } from '../../exercises/anchor';
import { expectedTargetAtTime, exerciseDurationMs, withLeadIn } from '../../exercises/timing';
import { loadToneLeadMs, loadLeadInMs, loadInstrumentId, DEFAULT_TONE_LEAD_MS } from '../../services/user-settings';
import { scoreContinuousCents, scoreStableHold, type ScoredFrame } from '../../exercises/scoring';
import { rangeFromTargets } from '../../exercises/range';
import { PitchGraphCanvas } from '../../pitch/graph';
import { PitchConnection } from '../../pitch/pitch-connection';
import {
  DEFAULT_STABLE_NOTE_SETTINGS, StableNoteDetector, type StableNoteState,
} from '../../pitch/stable-note';
import type { PitchFrame } from '../../pitch/socket';
import { centsOffPitch, GREEN_CENTS_THRESHOLD, MIN_CONFIDENCE_FOR_DOT } from '../../pitch/accuracy';
import { midiToFrequency, midiToNoteName } from '../../pitch/note-name';
import { preloadPianoSamples } from '../../audio/piano-samples';
import { playKeyPreview, type KeyPreviewHandle } from '../../audio/key-preview';
import { TonePlayer } from '../../audio/tone-player';
import { recordDiagnosticFrame, diagnosticSummary } from '../../pitch/register-diagnostics';
import { loadRegisterDebugEnabled } from '../../services/user-settings';
import {
  registerPosition, RegisterSmoother, describeRegister, labelForPosition,
  type RegisterLabel,
} from '../../pitch/register';
import { loadRegisterCalibration, type RegisterCalibration } from '../../pitch/register-calibration';
import { recordPracticeEntry } from '../../gamification/practice-log';
import { computeXp } from '../../gamification/xp';
import { getAudioContext } from '../../services/audio-context';
import { fetchAudioDevices, persistBackendDeviceId, resolveBackendDeviceId } from '../../services/audio-device';
import { startPlayback, postPlayback } from '../../transport/controls';
import { setAppStatus } from '../../services/status';
import './exercise-player.css';

interface Els {
  status: HTMLElement;
  targetReadout: HTMLElement;
  detectedReadout: HTMLElement;
  progressDots: HTMLElement;
  graphContainer: HTMLElement;
  summary: HTMLElement;
  registerDebug: HTMLElement;
  registerBadge: HTMLElement;
}

let definition: ExerciseDefinition | null = null;
let targets: ExerciseTargetNote[] = [];
let graph: PitchGraphCanvas | null = null;
let connection: PitchConnection | null = null;
let stableDetector: StableNoteDetector | null = null;
let tonePlayer: TonePlayer | null = null;
/** Live only while the pre-exercise key preview is sounding; see runKeyPreview. */
let keyPreview: KeyPreviewHandle | null = null;
/** Index of the next target whose tone has not sounded yet — see cueUpcomingTone. */
let toneCursor = 0;
let toneLeadMs = DEFAULT_TONE_LEAD_MS;
/** Read once per exercise — toggling mid-run would be surprising and costs a storage read per frame. */
let registerDebugEnabled = false;
/**
 * Frames needed before a target gets a register label (~0.4s). Below this,
 * reporting "—" is more honest than a label from three frames.
 */
const MIN_FRAMES_FOR_TARGET_REGISTER = 8;
/** Above this interquartile spread the singer changed register mid-note. */
const REGISTER_STABLE_IQR = 0.3;

/** Read once per exercise — calibration can't change mid-run. */
let registerCalibration: RegisterCalibration | null = null;
let registerSmoother: RegisterSmoother | null = null;
let rafId: number | null = null;
let startAudioTimeSec = 0;
let playbackStarted = false;
let stopped = false;
let els: Els | null = null;

let activeTargetIndex: number | null = null;
let framesForActiveTarget: ScoredFrame[] = [];
let statesForActiveTarget: StableNoteState[] = [];
/** Smoothed register positions for the active target — see aggregateRegister. */
let registerForActiveTarget: number[] = [];
let registerPerTarget: (number[] | undefined)[] = [];
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
  keyPreview = null;
  toneCursor = 0;
  toneLeadMs = DEFAULT_TONE_LEAD_MS;
  registerDebugEnabled = false;
  registerCalibration = null;
  registerSmoother = null;
  rafId = null;
  startAudioTimeSec = 0;
  playbackStarted = false;
  stopped = false;
  els = null;
  activeTargetIndex = null;
  framesForActiveTarget = [];
  statesForActiveTarget = [];
  registerForActiveTarget = [];
  registerPerTarget = [];
  perTargetResults = [];
}

/**
 * Backend PortAudio device index chosen in Settings, or null to let the
 * backend use its own default input.
 *
 * Deliberately NOT services/audio-preflight.ts's stored device id — that is
 * a browser `navigator.mediaDevices` hash string for the preflight level
 * meter, a different namespace entirely. Passing it here previously crashed
 * the backend opening a nonexistent device (PortAudioError -9986). See
 * services/audio-device.ts.
 *
 * Resolved against the CURRENT device list rather than used as stored,
 * because PortAudio indices move: the same saved index pointed at a working
 * microphone one day and at the speakers the next, once an iPhone connected
 * and renumbered everything after it. Opening an output as input fails with
 * PortAudio -9998, which reached the singer as an unexplained HTTP 500.
 */
async function resolveDeviceId(): Promise<number | null> {
  let list;
  try {
    list = await fetchAudioDevices();
  } catch {
    // The list is unreachable, so a stored index cannot be checked. Sending it
    // blind is what caused the unexplained failure this guard exists to
    // prevent; the backend's own default is the safer choice.
    return null;
  }

  const resolved = resolveBackendDeviceId(list);
  if (resolved.repaired && resolved.id !== null) {
    // The chosen device moved to a new index. Write the new one back so the
    // repair is permanent rather than repeated on every exercise.
    persistBackendDeviceId(resolved.id, resolved.name ?? '');
    setAppStatus(`Microphone moved to a new slot — using ${resolved.name}`, 'info');
  } else if (resolved.fellBack) {
    // Clear the dead entry so Settings stops showing a device that isn't there.
    persistBackendDeviceId(null);
    setAppStatus(
      resolved.name
        ? `"${resolved.name}" is no longer connected — using the default microphone`
        : 'Your saved microphone is gone — using the default',
      'info',
    );
  }
  return resolved.id;
}


/**
 * Sounds each target's reference tone `toneLeadMs` BEFORE the target begins,
 * so the singer hears the pitch with time to place it rather than at the
 * instant they're already meant to be on it.
 *
 * Scans forward from `toneCursor` instead of deriving the note from the
 * current time: with a lead, the note being cued is not the active one, and
 * at lead values longer than a note two cues can fall due in the same frame.
 * The cursor also guarantees no target is ever cued twice or skipped, which a
 * time-window test alone does not.
 */
function cueUpcomingTone(elapsedMs: number): void {
  while (toneCursor < targets.length && targets[toneCursor].startMs - toneLeadMs <= elapsedMs) {
    const target = targets[toneCursor];
    // Cue lasts the target's own length, so it is still sounding while the
    // singer is meant to be holding the note.
    tonePlayer?.playTargetOnce(toneCursor, target.midi, (target.endMs - target.startMs) / 1000);
    toneCursor += 1;
  }
}

function targetIndexAt(elapsedMs: number): number | null {
  const target = expectedTargetAtTime(elapsedMs, targets);
  return target ? targets.indexOf(target) : null;
}

function renderNotFound(container: HTMLElement): void {
  container.innerHTML = `
    <div class="exercise-notfound">
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
        <!-- Register badge. aria-live is deliberately OFF for the same reason
             as the diagnostics below: it updates ~21x/sec. Register reaches
             assistive tech via the static results screen instead. -->
        <div class="exercise-player__register hidden" id="ex-register" aria-live="off"></div>
        <!-- Phase 0 register diagnostics. aria-live is deliberately OFF: this
             updates ~21x/sec and would flood a screen reader, unlike the
             neighbouring #ex-status. Hidden unless enabled in Settings. -->
        <div class="exercise-player__register-debug hidden" id="ex-register-debug" aria-live="off"></div>
        <div class="exercise-player__graph" id="ex-graph"></div>
      </div>
      <div class="exercise-player__summary hidden" id="ex-summary"></div>
    </div>
  `;

  els = {
    status: container.querySelector('#ex-status')!,
    targetReadout: container.querySelector('#ex-target')!,
    detectedReadout: container.querySelector('#ex-detected')!,
    registerDebug: container.querySelector('#ex-register-debug')!,
    registerBadge: container.querySelector('#ex-register')!,
    progressDots: container.querySelector('#ex-progress-dots')!,
    graphContainer: container.querySelector('#ex-graph')!,
    summary: container.querySelector('#ex-summary')!,
  };
}

/**
 * Sounds the key preview and waits for it, letting the singer cut it short.
 *
 * Two ways out, and BOTH must remove the listener and the button: leaving them
 * behind would leave Space bound for the rest of the exercise, where it means
 * nothing.
 */
async function runKeyPreview(ctx: AudioContext, anchorMidi: number): Promise<void> {
  if (!els) return;

  keyPreview = playKeyPreview(ctx, {
    anchorMidi,
    firstTargetMidi: targets[0]?.midi ?? null,
    instrument: loadInstrumentId(),
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary exercise-player__skip';
  button.textContent = 'Skip';
  const previousStatus = els.status.textContent;
  els.status.textContent = 'Listen for your key — Space to skip';
  els.status.appendChild(button);

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      keyPreview?.skip();
    }
  };
  window.addEventListener('keydown', onKey);
  button.addEventListener('click', () => keyPreview?.skip());

  try {
    await keyPreview.done;
  } finally {
    window.removeEventListener('keydown', onKey);
    button.remove();
    if (els) els.status.textContent = previousStatus;
    keyPreview = null;
  }
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
/**
 * Reduces a target's register readings to one label.
 *
 * Median of the SMOOTHED positions, then the band boundaries WITHOUT
 * hysteresis — hysteresis is a temporal display device and is meaningless for
 * a static summary. Median beats mean (outlier-robust) and beats
 * mode-of-labels, which would quantise twice and throw away the continuum.
 *
 * `stable` is false when the interquartile spread is wide, i.e. the singer
 * changed register mid-note.
 */
function aggregateRegister(positions: number[]):
{ position: number; label: RegisterLabel; stable: boolean } | null {
  if (positions.length < MIN_FRAMES_FOR_TARGET_REGISTER) return null;
  const sorted = [...positions].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))];
  const mid = Math.floor(sorted.length / 2);
  const position = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    position,
    label: labelForPosition(position),
    stable: at(0.75) - at(0.25) <= REGISTER_STABLE_IQR,
  };
}

function finalizeActiveTarget(): void {
  if (activeTargetIndex === null || !definition) return;
  registerPerTarget[activeTargetIndex] = [...registerForActiveTarget];
  const target = targets[activeTargetIndex];
  let hit: boolean;
  let achievedMidi: number | null = null;

  if (definition.scoringStrategy === 'stable-hold') {
    const result = scoreStableHold(statesForActiveTarget, target.midi);
    hit = result.hit;
    achievedMidi = result.achievedMidi;
  } else {
    hit = scoreContinuousCents(framesForActiveTarget, target).hit;
  }

  perTargetResults[activeTargetIndex] = { target, achievedMidi, hit };
  renderProgressDots();
}

function computeAccuracyPct(): number {
  if (targets.length === 0) return 0;
  const hits = targets.reduce((count, _t, i) => count + (perTargetResults[i]?.hit ? 1 : 0), 0);
  return Math.round((hits / targets.length) * 100);
}

/**
 * Phase 0 diagnostic readout: raw feature values, live.
 *
 * This is the instrument for deciding whether register detection is viable at
 * all — sing chest, sing head, and watch whether h1h2/tilt actually separate.
 * It shows the RAW numbers rather than a label on purpose: there is no
 * calibration or classifier yet, and a label would imply a confidence that
 * does not exist.
 */
function updateRegisterDebug(frame: PitchFrame): void {
  if (!els || !registerDebugEnabled) return;
  const f = frame.features;
  if (!f) {
    els.registerDebug.textContent = 'register: — (not measurable this frame)';
    return;
  }
  const summary = diagnosticSummary();
  const medH = summary.medianH1h2 === null ? '—' : summary.medianH1h2.toFixed(1);
  const medT = summary.medianTilt === null ? '—' : summary.medianTilt.toFixed(1);
  els.registerDebug.textContent =
    `H1-H2 ${f.h1h2.toFixed(1)}dB (med ${medH})  ·  tilt ${f.tilt.toFixed(1)}dB (med ${medT})`
    + `  ·  hfrac ${f.hfrac.toFixed(2)}  ·  nh ${f.nh}  ·  ${f.lvl.toFixed(0)}dBFS`
    + `  ·  n=${summary.count}`;
}

/**
 * Live register readout. Fed the SMOOTHED position, never the raw per-frame
 * value — at ~21fps the raw number strobes and is unreadable.
 *
 * Shows nothing at all without calibration: a register guess with no anchors
 * would be a confident-looking number with nothing behind it.
 */
function updateRegisterBadge(frame: PitchFrame): number | null {
  if (!els || !registerCalibration || !registerSmoother || !frame.features) return null;

  const reading = registerPosition(frame.features, frame.midi, registerCalibration);
  if (!reading) return null;

  const { position, label } = registerSmoother.push(frame.t, reading.position);
  // Attribute to the target that was active when the FRAME was captured, not
  // whichever is active now — same reasoning as framesForActiveTarget.
  if (targetIndexAt(frame.t) === activeTargetIndex) registerForActiveTarget.push(position);
  if (label === null) return position;

  els.registerBadge.classList.remove('hidden');
  els.registerBadge.dataset.register = label;
  els.registerBadge.innerHTML = `
    <span class="exercise-player__register-label">${describeRegister(label, reading.confident)}</span>
    <span class="exercise-player__register-bar" aria-hidden="true">
      <span class="exercise-player__register-fill" style="left:${(position * 100).toFixed(1)}%"></span>
    </span>
  `;
  return position;
}

function handleFrame(frame: PitchFrame): void {
  if (!definition || !graph) return;
  const frameTargetIndex = targetIndexAt(frame.t);
  const expectedMidi = frameTargetIndex !== null ? targets[frameTargetIndex].midi : null;

  // Register must be resolved BEFORE the sample is pushed, since the graph
  // shades the stroke by it and a sample cannot be re-coloured afterwards.
  const smoothedRegister = updateRegisterBadge(frame);
  graph.pushFrame(frame, expectedMidi, smoothedRegister);
  updateDetectedReadout(frame, expectedMidi);
  recordDiagnosticFrame(frame);
  updateRegisterDebug(frame);

  // Only accumulate into the buffer for whichever target the RAF loop
  // currently has active — a frame whose own timestamp maps to a different
  // target (arrived late, or during a gap) is shown on the graph but not
  // scored against a target it doesn't belong to.
  if (frameTargetIndex !== null && frameTargetIndex === activeTargetIndex) {
    framesForActiveTarget.push({ t: frame.t, midi: frame.midi, conf: frame.conf });
    if (definition.scoringStrategy === 'stable-hold' && stableDetector) {
      statesForActiveTarget.push(stableDetector.pushFrame(frame));
    }
  }
}

/**
 * Records the attempt to the practice log and hands off to the Results
 * screen. The log entry is written BEFORE navigating so Results (and Home,
 * and Progress) can all derive level/streak from the same committed source
 * rather than from navigation params.
 */
function recordAndShowResults(): void {
  if (!definition) return;
  const accuracyPct = computeAccuracyPct();

  // Range sung during the attempt, for the Progress screen's range trend.
  const achieved = perTargetResults
    .filter((r): r is ExerciseTargetResult => Boolean(r))
    .map((r) => r.achievedMidi)
    .filter((m): m is number => m !== null);

  const entry = recordPracticeEntry({
    timestamp: new Date().toISOString(),
    exerciseId: definition.id,
    exerciseKind: definition.kind,
    accuracyPct,
    durationMs: Math.round(exerciseDurationMs(targets)),
    xpEarned: computeXp(definition.xpBase, accuracyPct),
    minMidi: achieved.length ? Math.min(...achieved) : null,
    maxMidi: achieved.length ? Math.max(...achieved) : null,
    perTarget: targets.map((target, i) => {
      const result = perTargetResults[i];
      const reg = aggregateRegister(registerPerTarget[i] ?? []);
      return {
        midi: target.midi,
        achievedMidi: result?.achievedMidi ?? null,
        hit: result?.hit ?? false,
        ...(reg
          ? { register: reg.label, registerPosition: reg.position, registerStable: reg.stable }
          : {}),
      };
    }),
  });

  navigate('results', { entryId: entry.id });
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
  recordAndShowResults();
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
    registerForActiveTarget = [];
    stableDetector?.reset();
    registerSmoother?.reset();
    updateTargetReadout();
  }
  cueUpcomingTone(elapsedMs);

  rafId = requestAnimationFrame(tick);
}

async function start(): Promise<void> {
  if (!els || !definition) return;
  const def = definition;

  // No mic-setup gate here on purpose — the audio-preflight modal used to
  // pop up before every exercise (via ensureAudioPreflightReady()), which
  // is a jarring interruption for something users only need to touch
  // occasionally. Mic device/voice-type/latency setup now lives in
  // Settings (screens/settings/index.ts), opened deliberately, not forced.
  // The actual pitch capture happens backend-side via Python/sounddevice
  // regardless — this modal was always onboarding UX, never a functional
  // requirement for /playback/start to work.
  const anchorMidi = resolveAnchorMidi();
  // Lead-in shifts every target later, giving the singer a beat of silence
  // before the first note instead of starting on it. Applied here so built-in
  // and custom exercises behave identically.
  targets = withLeadIn(def.generate({ anchorMidi }), loadLeadInMs());
  toneLeadMs = loadToneLeadMs();
  toneCursor = 0;
  registerDebugEnabled = loadRegisterDebugEnabled();

  if (registerDebugEnabled) els?.registerDebug.classList.remove('hidden');
  renderProgressDots();

  graph = new PitchGraphCanvas(els.graphContainer, { bandCentsTolerance: GREEN_CENTS_THRESHOLD });
  const range = rangeFromTargets(targets);
  graph.setRange(midiToFrequency(range.minMidi), midiToFrequency(range.maxMidi));
  // Full target list up front (not just the active one) so the "note
  // highway" can render upcoming pills ahead of the playhead.
  graph.setTargets(targets);

  tonePlayer = new TonePlayer();
  if (def.scoringStrategy === 'stable-hold') {
    // The exercise's own hold time drives the detector. Leaving it at the
    // detector default meant every stable-hold exercise scored a hit after
    // 160ms of steadiness, however long its definition (or the singer's
    // editor setting) said the note had to be held for.
    stableDetector = new StableNoteDetector({
      ...DEFAULT_STABLE_NOTE_SETTINGS,
      holdDurationMs: def.holdDurationMs ?? DEFAULT_STABLE_NOTE_SETTINGS.holdDurationMs,
    });
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
    // Sample set must be decoded BEFORE the clock is anchored: the cue is
    // played synchronously from the frame loop, so a still-downloading sample
    // silences the first note, and downloading after the anchor would count
    // the fetch as elapsed exercise time.
    await preloadPianoSamples(ctx);
    // Key preview goes HERE for two reasons beyond ordering convenience:
    // before the clock is anchored, or its ~5s would be counted as elapsed
    // exercise time; and before startPlayback opens the mic, so the preview
    // cannot bleed into pitch detection the way the in-exercise cue tone can.
    await runKeyPreview(ctx, anchorMidi);
    if (stopped) return; // unmounted while the preview was playing
    startAudioTimeSec = ctx.currentTime;
    await startPlayback(await resolveDeviceId());
    playbackStarted = true;
  } catch (err) {
    els.status.textContent = `Couldn't start: ${String(err)}`;
    setAppStatus('exercise start failed', 'error');
    return;
  }
  if (stopped) return; // unmounted mid-start

  connection = new PitchConnection({
    onFrame: handleFrame,
    // Calibration is loaded HERE, not before connecting: it is only valid for
    // the backend DSP version it was captured under, and that version arrives
    // with the handshake. Frames before the handshake simply show no badge.
    onConnected: (version) => {
      registerCalibration = version === null ? null : loadRegisterCalibration(version);
      registerSmoother = registerCalibration ? new RegisterSmoother() : null;
    },
  });
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
  // Otherwise the preview keeps sounding after the singer has left the screen.
  keyPreview?.skip();
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

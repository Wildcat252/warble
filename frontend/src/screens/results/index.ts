/**
 * Results screen — shown after an exercise completes.
 *
 * Deliberately reads its numbers from the practice log rather than taking
 * them all as navigation params: the entry has already been written by the
 * time we get here, so deriving level/streak from the log keeps this screen
 * consistent with Home and Progress instead of being a second, parallel
 * source of truth that could disagree.
 *
 * Params: { entryId } — which log entry this screen is reporting on.
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import { loadPracticeLog, totalXp, type PracticeEntry } from '../../gamification/practice-log';
import { levelForTotalXp } from '../../gamification/xp';
import { computeStreak } from '../../gamification/streaks';
import { burstConfetti } from '../../gamification/confetti';
import { getExerciseById } from '../../exercises/catalog';
import { midiToNoteName } from '../../pitch/note-name';
import './results.css';

/** Celebrate a genuinely good run or a level-up — not every completion, or it stops meaning anything. */
const CELEBRATE_ACCURACY_PCT = 90;

let cancelConfetti: (() => void) | null = null;
let xpTweenRaf: number | null = null;

function stopAnimations(): void {
  cancelConfetti?.();
  cancelConfetti = null;
  if (xpTweenRaf !== null) {
    cancelAnimationFrame(xpTweenRaf);
    xpTweenRaf = null;
  }
}

/** Counts the XP figure up from 0 so the reward reads as earned, not just printed. */
function tweenXp(el: HTMLElement, to: number): void {
  const durationMs = 700;
  let start: number | null = null;
  const step = (ts: number): void => {
    if (start === null) start = ts;
    const t = Math.min(1, (ts - start) / durationMs);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = `+${Math.round(to * eased)}`;
    if (t < 1) xpTweenRaf = requestAnimationFrame(step);
    else xpTweenRaf = null;
  };
  xpTweenRaf = requestAnimationFrame(step);
}

const REGISTER_LABEL: Record<string, string> = {
  chest: 'chest', mix: 'mix', head: 'head',
};

/**
 * Per-note breakdown, including which register each note was sung in.
 *
 * Register is omitted per note when it couldn't be measured (too few usable
 * frames, or no calibration) rather than guessed — "—" is the honest cell.
 * The whole block is skipped for entries written before per-note detail
 * existed, and for older entries whose detail has been pruned.
 */
function renderPerNote(entry: PracticeEntry): string {
  const notes = entry.perTarget;
  if (!notes || notes.length === 0) return '';

  const withRegister = notes.filter((n) => n.register !== undefined);
  const summary = withRegister.length > 0
    ? `<p class="results-notes__summary">${describeRegisterMix(withRegister)}</p>`
    : '';

  const rows = notes.map((n, i) => `
    <li class="results-note ${n.hit ? 'is-hit' : 'is-miss'}">
      <span class="results-note__index">${i + 1}</span>
      <span class="results-note__pitch">${midiToNoteName(n.midi)}</span>
      <span class="results-note__register" data-register="${n.register ?? ''}">
        ${n.register ? REGISTER_LABEL[n.register] : '—'}${n.registerStable === false ? ' *' : ''}
      </span>
    </li>
  `).join('');

  return `
    <div class="results-notes">
      <h2 class="results-notes__title">Note by note</h2>
      <ol class="results-notes__list">${rows}</ol>
      ${summary}
      ${notes.some((n) => n.registerStable === false)
    ? '<p class="results-notes__footnote">* register changed partway through the note</p>'
    : ''}
    </div>
  `;
}

/** One-line summary, e.g. "Mostly mix — 3 notes in chest". */
function describeRegisterMix(notes: { register?: string }[]): string {
  const counts = new Map<string, number>();
  for (const n of notes) counts.set(n.register!, (counts.get(n.register!) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topCount] = ranked[0];
  if (ranked.length === 1) return `All ${notes.length} notes in ${REGISTER_LABEL[top]}.`;
  const rest = ranked.slice(1)
    .map(([label, count]) => `${count} in ${REGISTER_LABEL[label]}`)
    .join(', ');
  return `Mostly ${REGISTER_LABEL[top]} (${topCount} of ${notes.length}) — ${rest}.`;
}

function render(container: HTMLElement, entry: PracticeEntry | null): void {
  if (!entry) {
    container.innerHTML = `
      <div class="results-screen fade-in">
        <div class="card results-card">
          <h1>No results to show</h1>
          <p>Finish an exercise to see how you did.</p>
          <button type="button" class="btn btn-primary" data-nav="exercise-picker">Browse exercises</button>
        </div>
      </div>
    `;
    return;
  }

  const log = loadPracticeLog();
  const progress = levelForTotalXp(totalXp(log));
  const streak = computeStreak(log);
  const exercise = getExerciseById(entry.exerciseId);
  const title = exercise?.title ?? (entry.exerciseKind === 'range-test' ? 'Vocal Range Test' : entry.exerciseId);

  // A level-up happened in this entry if removing its XP would drop a level.
  const levelBefore = levelForTotalXp(totalXp(log) - entry.xpEarned).level;
  const leveledUp = progress.level > levelBefore;
  const fillPct = progress.xpForNextLevel > 0
    ? Math.round((progress.xpIntoLevel / progress.xpForNextLevel) * 100)
    : 0;

  container.innerHTML = `
    <div class="results-screen fade-in">
      <div class="results-burst" id="results-burst"></div>
      <div class="card results-card pop-in">
        <p class="results-eyebrow">${title}</p>
        <p class="results-xp" id="results-xp">+0</p>
        <p class="results-xp-label">XP earned</p>

        ${leveledUp ? `<p class="results-levelup">Level up — you're now level ${progress.level}</p>` : ''}

        <div class="results-stats">
          <div class="results-stat">
            <span class="results-stat__value">${entry.accuracyPct}%</span>
            <span class="results-stat__label">Accuracy</span>
          </div>
          <div class="results-stat">
            <span class="results-stat__value">${streak.currentStreak}</span>
            <span class="results-stat__label">Day streak</span>
          </div>
          <div class="results-stat">
            <span class="results-stat__value">${progress.level}</span>
            <span class="results-stat__label">Level</span>
          </div>
        </div>

        <div class="results-progress">
          <div class="progress-bar"><div class="progress-bar__fill" style="width:${fillPct}%"></div></div>
          <p class="results-progress__label">${progress.xpIntoLevel} / ${progress.xpForNextLevel} XP to level ${progress.level + 1}</p>
        </div>

        ${renderPerNote(entry)}

        <div class="results-actions">
          <button type="button" class="btn btn-primary" data-nav="exercise-picker">Practice again</button>
          <button type="button" class="btn btn-secondary" data-nav="home">Done</button>
        </div>
      </div>
    </div>
  `;

  const xpEl = container.querySelector<HTMLElement>('#results-xp');
  if (xpEl) tweenXp(xpEl, entry.xpEarned);

  if (entry.accuracyPct >= CELEBRATE_ACCURACY_PCT || leveledUp) {
    const burstEl = container.querySelector<HTMLElement>('#results-burst');
    if (burstEl) cancelConfetti = burstConfetti(burstEl);
  }

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.dataset.nav;
      if (target) navigate(target as Parameters<typeof navigate>[0]);
    });
  });
}

export const resultsScreen: Screen = {
  id: 'results',
  mount(container, params) {
    stopAnimations();
    const log = loadPracticeLog();
    // Fall back to the newest entry so a refresh/direct nav still shows
    // something sensible rather than an error state.
    const entry = params.entryId
      ? log.find((e) => e.id === params.entryId) ?? null
      : log[0] ?? null;
    render(container, entry);
  },
  unmount() {
    stopAnimations();
  },
};

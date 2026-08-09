/**
 * Progress screen — streak calendar, XP/level standing, vocal range trend
 * and recent session history, all derived from gamification/practice-log.ts.
 *
 * Replaces the old features/progress-history panel, which was built on the
 * score-coupled services/progress-history.ts (piece name + part) and can't
 * represent exercise-based practice.
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import {
  clearPracticeLog, loadPracticeLog, localDayKey, subscribePracticeLog,
  totalXp, type PracticeEntry,
} from '../../gamification/practice-log';
import { levelForTotalXp } from '../../gamification/xp';
import { computeStreak } from '../../gamification/streaks';
import { getExerciseById } from '../../exercises/catalog';
import { midiToNoteName } from '../../pitch/note-name';
import './progress.css';

/** ~12 weeks of history, the usual heatmap span — long enough to show a habit forming. */
const HEATMAP_DAYS = 84;
const RECENT_LIMIT = 12;

let unsubscribe: (() => void) | null = null;

function dayKeyOffset(daysAgo: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // midday avoids DST edges shifting the key
  d.setDate(d.getDate() - daysAgo);
  return localDayKey(d.toISOString());
}

function exerciseTitle(entry: PracticeEntry): string {
  if (entry.exerciseKind === 'range-test') return 'Vocal Range Test';
  return getExerciseById(entry.exerciseId)?.title ?? entry.exerciseId;
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderHeatmap(entries: PracticeEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = localDayKey(e.timestamp);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Oldest -> newest so the grid reads left-to-right, ending today.
  const cells: string[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) {
    const key = dayKeyOffset(i);
    const n = counts.get(key) ?? 0;
    // Four intensity steps; beyond 3 sessions/day adds no extra signal.
    const level = n === 0 ? 0 : Math.min(3, n);
    cells.push(
      `<span class="heat-cell heat-cell--${level}" title="${key}: ${n} session${n === 1 ? '' : 's'}"></span>`,
    );
  }
  return cells.join('');
}

function renderRangeTrend(entries: PracticeEntry[]): string {
  const withRange = entries
    .filter((e) => e.minMidi !== null && e.maxMidi !== null)
    .slice(0, 10)
    .reverse();

  if (withRange.length === 0) {
    return '<p class="progress-empty">No range data yet — complete an exercise or the range test.</p>';
  }

  // Shared scale across all rows so bar positions are comparable.
  const lo = Math.min(...withRange.map((e) => e.minMidi as number));
  const hi = Math.max(...withRange.map((e) => e.maxMidi as number));
  const span = Math.max(1, hi - lo);

  return withRange.map((e) => {
    const min = e.minMidi as number;
    const max = e.maxMidi as number;
    const left = ((min - lo) / span) * 100;
    const width = Math.max(2, ((max - min) / span) * 100);
    return `
      <div class="range-row">
        <span class="range-row__label">${formatDay(e.timestamp)}</span>
        <span class="range-row__track">
          <span class="range-row__bar" style="left:${left}%;width:${width}%"></span>
        </span>
        <span class="range-row__notes">${midiToNoteName(min)}–${midiToNoteName(max)}</span>
      </div>
    `;
  }).join('');
}

function renderRecent(entries: PracticeEntry[]): string {
  if (entries.length === 0) return '';
  return entries.slice(0, RECENT_LIMIT).map((e) => `
    <li class="session-row">
      <span class="session-row__title">${exerciseTitle(e)}</span>
      <span class="session-row__meta">${formatDay(e.timestamp)}</span>
      <span class="session-row__accuracy">${e.accuracyPct}%</span>
      <span class="session-row__xp">+${e.xpEarned} XP</span>
    </li>
  `).join('');
}

function render(container: HTMLElement): void {
  const entries = loadPracticeLog();
  const streak = computeStreak(entries);
  const progress = levelForTotalXp(totalXp(entries));

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="progress-screen fade-in">
        <div class="progress-screen__header">
          <h1>Progress</h1>
        </div>
        <div class="card progress-empty-card">
          <h2>No practice yet</h2>
          <p>Complete an exercise and your streak, XP and vocal range will show up here.</p>
          <button type="button" class="btn btn-primary" data-nav="exercise-picker">Start an exercise</button>
        </div>
      </div>
    `;
    container.querySelector<HTMLElement>('[data-nav]')?.addEventListener('click', () => {
      navigate('exercise-picker');
    });
    return;
  }

  const totalSessions = entries.length;

  container.innerHTML = `
    <div class="progress-screen fade-in">
      <div class="progress-screen__header">
        <h1>Progress</h1>
        <p>${totalSessions} session${totalSessions === 1 ? '' : 's'} so far.</p>
      </div>

      <div class="card progress-summary">
        <div class="progress-stat">
          <span class="progress-stat__value ${streak.currentStreak > 0 ? 'progress-stat__value--streak' : ''}">${streak.currentStreak}</span>
          <span class="progress-stat__label">Current streak</span>
        </div>
        <div class="progress-stat">
          <span class="progress-stat__value">${streak.longestStreak}</span>
          <span class="progress-stat__label">Longest streak</span>
        </div>
        <div class="progress-stat">
          <span class="progress-stat__value">${progress.level}</span>
          <span class="progress-stat__label">Level</span>
        </div>
        <div class="progress-stat">
          <span class="progress-stat__value">${totalXp(entries)}</span>
          <span class="progress-stat__label">Total XP</span>
        </div>
      </div>

      <section class="card">
        <h2 class="progress-section-title">Practice calendar</h2>
        <div class="heatmap" aria-label="Practice history, last ${HEATMAP_DAYS} days">${renderHeatmap(entries)}</div>
        <div class="heatmap-legend">
          <span>Less</span>
          <span class="heat-cell heat-cell--0"></span>
          <span class="heat-cell heat-cell--1"></span>
          <span class="heat-cell heat-cell--2"></span>
          <span class="heat-cell heat-cell--3"></span>
          <span>More</span>
        </div>
      </section>

      <section class="card">
        <h2 class="progress-section-title">Vocal range over time</h2>
        <div class="range-trend">${renderRangeTrend(entries)}</div>
      </section>

      <section class="card">
        <h2 class="progress-section-title">Recent sessions</h2>
        <ul class="session-list">${renderRecent(entries)}</ul>
      </section>

      <div class="progress-actions">
        <button type="button" class="btn btn-secondary" id="progress-export">Export JSON</button>
        <button type="button" class="btn btn-ghost" id="progress-clear">Clear history</button>
      </div>
    </div>
  `;

  container.querySelector<HTMLButtonElement>('#progress-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'warble-practice-log.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  container.querySelector<HTMLButtonElement>('#progress-clear')?.addEventListener('click', () => {
    // Destructive and unrecoverable (localStorage only, no server copy).
    if (window.confirm('Clear all practice history? This cannot be undone.')) {
      clearPracticeLog();
    }
  });
}

export const progressScreen: Screen = {
  id: 'progress',
  mount(container) {
    // Fires immediately (first render) and again whenever the log changes,
    // so clearing history re-renders to the empty state without a reload.
    unsubscribe = subscribePracticeLog(() => render(container));
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
  },
};

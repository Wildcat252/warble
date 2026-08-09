/**
 * Home / Dashboard screen.
 *
 * Shows streak, level/XP progress, and today's goal — all DERIVED from
 * gamification/practice-log.ts at render time (see that module for why
 * nothing is stored pre-computed). Re-renders on log changes so finishing
 * an exercise and navigating Home shows fresh numbers without a reload.
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import { APP_NAME } from '../../branding';
import {
  countCompletedOn, loadPracticeLog, subscribePracticeLog, totalXp,
} from '../../gamification/practice-log';
import { levelForTotalXp } from '../../gamification/xp';
import { computeStreak } from '../../gamification/streaks';
import { loadDailyGoal } from '../../gamification/settings';
import './home.css';

let unsubscribe: (() => void) | null = null;

/** SVG ring showing progress toward the daily goal. */
function goalRing(done: number, goal: number): string {
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const pct = goal > 0 ? Math.min(1, done / goal) : 0;
  const offset = circumference * (1 - pct);
  return `
    <svg class="progress-ring" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle class="track" cx="32" cy="32" r="${r}"></circle>
      <circle class="fill" cx="32" cy="32" r="${r}"
        stroke-dasharray="${circumference.toFixed(1)}"
        stroke-dashoffset="${offset.toFixed(1)}"
        transform="rotate(-90 32 32)"></circle>
    </svg>
  `;
}

function render(container: HTMLElement): void {
  const log = loadPracticeLog();
  const streak = computeStreak(log);
  const progress = levelForTotalXp(totalXp(log));
  const goal = loadDailyGoal();
  const doneToday = countCompletedOn(new Date(), log);
  const goalMet = doneToday >= goal;
  const fillPct = progress.xpForNextLevel > 0
    ? Math.round((progress.xpIntoLevel / progress.xpForNextLevel) * 100)
    : 0;

  const isFirstRun = log.length === 0;
  const heroTitle = isFirstRun ? 'Ready to warm up?' : 'Welcome back';
  const heroSub = isFirstRun
    ? 'Short daily exercises to build pitch accuracy and range — no sheet music required.'
    : streak.atRiskToday
      ? `You're on a ${streak.currentStreak}-day streak — practice today to keep it going.`
      : goalMet
        ? "Today's goal is done. Anything more is a bonus."
        : `${goal - doneToday} more to hit today's goal.`;

  container.innerHTML = `
    <div class="home-screen fade-in">
      <div class="home-hero card">
        <p class="home-hero__eyebrow">Welcome to ${APP_NAME}</p>
        <h1 class="home-hero__title">${heroTitle}</h1>
        <p class="home-hero__subtitle">${heroSub}</p>
        <button type="button" class="btn btn-primary home-hero__cta" data-nav="exercise-picker">
          ${isFirstRun ? 'Start an exercise' : 'Practice now'}
        </button>
      </div>

      <div class="home-stats card">
        <div class="home-stat">
          <span class="home-stat__value ${streak.currentStreak > 0 ? 'home-stat__value--streak' : ''}">${streak.currentStreak}</span>
          <span class="home-stat__label">Day streak</span>
        </div>
        <div class="home-stat home-stat--xp">
          <div class="home-stat__level">
            <span class="home-stat__value">Level ${progress.level}</span>
            <span class="home-stat__label">${progress.xpIntoLevel} / ${progress.xpForNextLevel} XP</span>
          </div>
          <div class="progress-bar"><div class="progress-bar__fill" style="width:${fillPct}%"></div></div>
        </div>
        <div class="home-stat home-stat--goal">
          ${goalRing(doneToday, goal)}
          <div>
            <span class="home-stat__value">${doneToday} / ${goal}</span>
            <span class="home-stat__label">Today's goal</span>
          </div>
        </div>
      </div>

      <div class="home-grid">
        <button type="button" class="home-tile card" data-nav="exercise-picker">
          <span class="home-tile__label">Exercises</span>
          <span class="home-tile__hint">Pitch-matching drills</span>
        </button>
        <button type="button" class="home-tile card" data-nav="progress">
          <span class="home-tile__label">Progress</span>
          <span class="home-tile__hint">Streaks &amp; history</span>
        </button>
      </div>
    </div>
  `;

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.dataset.nav;
      if (target) navigate(target as Parameters<typeof navigate>[0]);
    });
  });
}

export const homeScreen: Screen = {
  id: 'home',
  mount(container) {
    // subscribePracticeLog fires immediately, which performs the first render.
    unsubscribe = subscribePracticeLog(() => render(container));
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
  },
};

/**
 * Home / Dashboard screen.
 *
 * v1 (Phase 1) skeleton: greeting + quick-start entry points into the other
 * screens. Streak/XP/goal widgets are added in Phase 6 once
 * gamification/practice-log.ts exists — this file is extended in place,
 * not replaced, when that lands.
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import { APP_NAME } from '../../branding';
import './home.css';

// TEMPORARY (Phase 3 → Phase 4): the exercise-picker screen is still a
// placeholder, so these two entry points jump straight to the one wired-up
// exercise (note-hold-basic) instead of routing through a picker. Phase 4
// replaces both data-nav targets below with a plain "exercise-picker"
// navigate once the real picker screen exists.
const START_EXERCISE_NAV: { screen: 'exercise-player'; params: { exerciseId: string } } = {
  screen: 'exercise-player',
  params: { exerciseId: 'note-hold-basic' },
};

function render(container: HTMLElement): void {
  container.innerHTML = `
    <div class="home-screen fade-in">
      <div class="home-hero card">
        <p class="home-hero__eyebrow">Welcome to ${APP_NAME}</p>
        <h1 class="home-hero__title">Ready to warm up?</h1>
        <p class="home-hero__subtitle">Short daily exercises to build pitch accuracy and range — no sheet music required.</p>
        <button type="button" class="btn btn-primary home-hero__cta" data-nav="start-exercise">Start an exercise</button>
      </div>

      <div class="home-grid">
        <button type="button" class="home-tile card" data-nav="range-test">
          <span class="home-tile__icon" aria-hidden="true">🎚️</span>
          <span class="home-tile__label">Vocal Range Test</span>
          <span class="home-tile__hint">Find your voice type</span>
        </button>
        <button type="button" class="home-tile card" data-nav="start-exercise">
          <span class="home-tile__icon" aria-hidden="true">🎯</span>
          <span class="home-tile__label">Exercises</span>
          <span class="home-tile__hint">Pitch-matching drills</span>
        </button>
        <button type="button" class="home-tile card" data-nav="progress">
          <span class="home-tile__icon" aria-hidden="true">📈</span>
          <span class="home-tile__label">Progress</span>
          <span class="home-tile__hint">Streaks &amp; history</span>
        </button>
      </div>
    </div>
  `;

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.dataset.nav;
      if (target === 'start-exercise') {
        navigate(START_EXERCISE_NAV.screen, START_EXERCISE_NAV.params);
        return;
      }
      if (target) navigate(target as Parameters<typeof navigate>[0]);
    });
  });
}

export const homeScreen: Screen = {
  id: 'home',
  mount(container) {
    render(container);
  },
};

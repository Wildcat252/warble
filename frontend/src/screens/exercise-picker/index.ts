/**
 * Exercise Picker — lists every exercises/catalog.ts entry as a card that
 * launches exercise-player. Kept deliberately simple for now (no filtering,
 * no XP/difficulty polish) since Phase 4 is where this screen gets its full
 * treatment — but exercise-player itself is already kind-agnostic (Phase 3),
 * so every catalog entry is fully playable today, not just note-hold-basic.
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import { EXERCISE_CATALOG } from '../../exercises/catalog';
import './exercise-picker.css';

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function render(container: HTMLElement): void {
  const cards = EXERCISE_CATALOG.map((ex) => `
    <button type="button" class="exercise-card card" data-exercise-id="${ex.id}">
      <div class="exercise-card__top">
        <span class="badge badge-${ex.difficulty === 'easy' ? 'good' : ex.difficulty === 'hard' ? 'bad' : 'warn'}">${DIFFICULTY_LABEL[ex.difficulty] ?? ex.difficulty}</span>
        <span class="exercise-card__xp">+${ex.xpBase} XP</span>
      </div>
      <h2 class="exercise-card__title">${ex.title}</h2>
      <p class="exercise-card__desc">${ex.description}</p>
      <span class="exercise-card__duration">~${ex.estSeconds}s</span>
    </button>
  `).join('');

  container.innerHTML = `
    <div class="exercise-picker fade-in">
      <div class="exercise-picker__header">
        <h1>Exercises</h1>
        <p>Pick a drill to start practicing.</p>
      </div>
      <div class="exercise-picker__grid">${cards}</div>
    </div>
  `;

  container.querySelectorAll<HTMLButtonElement>('.exercise-card').forEach((card) => {
    card.addEventListener('click', () => {
      const exerciseId = card.dataset.exerciseId;
      if (exerciseId) navigate('exercise-player', { exerciseId });
    });
  });
}

export const exercisePickerScreen: Screen = {
  id: 'exercise-picker',
  mount(container) {
    render(container);
  },
};

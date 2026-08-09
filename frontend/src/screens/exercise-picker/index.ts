/**
 * Exercise Picker — lists built-in and user-created exercises as cards that
 * launch exercise-player.
 *
 * The two groups are shown in separate sections rather than one merged grid,
 * because only custom exercises carry Edit affordances — interleaving them
 * would mean cards that look identical but behave differently. Built-ins are
 * deliberately read-only (see screens/exercise-editor).
 */
import type { Screen } from '../../screen-types';
import { navigate } from '../../navigation/router';
import { EXERCISE_CATALOG } from '../../exercises/catalog';
import { getCustomExercises } from '../../exercises/custom-catalog';
import type { ExerciseDefinition } from '../../exercises/types';
import './exercise-picker.css';

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function difficultyBadgeClass(difficulty: string): string {
  if (difficulty === 'easy') return 'badge-good';
  if (difficulty === 'hard') return 'badge-bad';
  return 'badge-warn';
}

/**
 * `editable` adds an Edit button. The card itself stays a launch target, so
 * the Edit button stops propagation — otherwise clicking Edit would also
 * start the exercise underneath it.
 */
function exerciseCard(ex: ExerciseDefinition, editable: boolean): string {
  return `
    <div class="exercise-card card ${editable ? 'exercise-card--editable' : ''}">
      <button type="button" class="exercise-card__launch" data-exercise-id="${escapeHtml(ex.id)}">
        <div class="exercise-card__top">
          <span class="badge ${difficultyBadgeClass(ex.difficulty)}">${DIFFICULTY_LABEL[ex.difficulty] ?? ex.difficulty}</span>
          <span class="exercise-card__xp">+${ex.xpBase} XP</span>
        </div>
        <h3 class="exercise-card__title">${escapeHtml(ex.title)}</h3>
        <p class="exercise-card__desc">${escapeHtml(ex.description)}</p>
        <span class="exercise-card__duration">~${ex.estSeconds}s</span>
      </button>
      ${editable
    ? `<button type="button" class="btn btn-ghost exercise-card__edit" data-edit-id="${escapeHtml(ex.id)}"
                 aria-label="Edit ${escapeHtml(ex.title)}">Edit</button>`
    : ''
}
    </div>
  `;
}

function render(container: HTMLElement): void {
  // Read fresh on every render, so returning from the editor shows the change.
  const custom = getCustomExercises();

  const customSection = custom.length > 0
    ? `<div class="exercise-picker__grid">${custom.map((ex) => exerciseCard(ex, true)).join('')}</div>`
    : `<p class="exercise-picker__empty">
         You haven't made any exercises yet. Build one to drill the intervals you're working on.
       </p>`;

  container.innerHTML = `
    <div class="exercise-picker fade-in">
      <div class="exercise-picker__header">
        <h1>Exercises</h1>
        <p>Pick a drill to start practicing.</p>
      </div>

      <section class="exercise-picker__section">
        <h2 class="exercise-picker__section-title">Built-in</h2>
        <div class="exercise-picker__grid">
          ${EXERCISE_CATALOG.map((ex) => exerciseCard(ex, false)).join('')}
        </div>
      </section>

      <section class="exercise-picker__section">
        <div class="exercise-picker__section-head">
          <h2 class="exercise-picker__section-title">Your exercises</h2>
          <button type="button" class="btn btn-primary" id="picker-new">New exercise</button>
        </div>
        ${customSection}
      </section>
    </div>
  `;

  container.querySelectorAll<HTMLButtonElement>('.exercise-card__launch').forEach((card) => {
    card.addEventListener('click', () => {
      const exerciseId = card.dataset.exerciseId;
      if (exerciseId) navigate('exercise-player', { exerciseId });
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.exercise-card__edit').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      // Without this the click also reaches the launch button and starts the exercise.
      ev.stopPropagation();
      const exerciseId = btn.dataset.editId;
      if (exerciseId) navigate('exercise-editor', { exerciseId });
    });
  });

  container.querySelector<HTMLButtonElement>('#picker-new')?.addEventListener('click', () => {
    navigate('exercise-editor');
  });
}

export const exercisePickerScreen: Screen = {
  id: 'exercise-picker',
  mount(container) {
    render(container);
  },
};

/**
 * Exercise Editor — creates and edits user-defined exercises.
 *
 * Mounted with either no params (create) or `{ exerciseId }` (edit). Built-in
 * exercises are NOT editable: this screen refuses any id without the
 * `custom:` prefix rather than silently forking a copy, so the four shipped
 * exercises stay a fixed reference point that a singer can always return to.
 *
 * Notes are entered as SEMITONE OFFSETS from the singer's anchor pitch, not
 * absolute pitches — see custom-types.ts for why. The live preview column
 * resolves those offsets against the current voice type so the abstraction
 * stays legible ("+7" is meaningless; "G4" is not).
 */
import type { Screen } from '../../screen-types';
import { navigate, goBack } from '../../navigation/router';
import {
  createCustomExercise, updateCustomExercise, deleteCustomExercise,
  getCustomExerciseSpec, type NewCustomExerciseInput,
} from '../../exercises/custom-store';
import {
  validateCustomExerciseSpec, isCustomExerciseId,
  CUSTOM_EXERCISE_SCHEMA_VERSION, CUSTOM_ID_PREFIX,
  MIN_OFFSET, MAX_OFFSET, MIN_MS_PER_NOTE, MAX_MS_PER_NOTE, MAX_STEPS, MAX_TITLE_LENGTH,
  type CustomExerciseSpec, type CustomExerciseStep, type SpecValidationError,
} from '../../exercises/custom-types';
import { resolveAnchorMidi } from '../../exercises/anchor';
import { midiToNoteName } from '../../pitch/note-name';
import { showToast } from '../../services/toast';
import './exercise-editor.css';

/** A fresh exercise starts as a root–3rd–5th triad: playable immediately, and a clear template to edit. */
const DEFAULT_STEPS: CustomExerciseStep[] = [
  { offset: 0, label: 'Root' },
  { offset: 4, label: 'Major 3rd' },
  { offset: 7, label: '5th' },
];
const DEFAULT_MS_PER_NOTE = 2000;
const DEFAULT_HOLD_MS = 1200;

/** Working copy. Edits mutate this, not storage — storage is written only on Save. */
let draft: NewCustomExerciseInput = blankDraft();
/** Non-null when editing an existing exercise; null when creating. */
let editingId: string | null = null;
let errors: SpecValidationError[] = [];
let container: HTMLElement | null = null;

function blankDraft(): NewCustomExerciseInput {
  return {
    title: '',
    description: '',
    difficulty: 'easy',
    scoringStrategy: 'stable-hold',
    steps: DEFAULT_STEPS.map((s) => ({ ...s })),
    msPerNote: DEFAULT_MS_PER_NOTE,
    holdDurationMs: DEFAULT_HOLD_MS,
  };
}

function draftToSpec(): CustomExerciseSpec {
  const now = new Date().toISOString();
  return {
    schemaVersion: CUSTOM_EXERCISE_SCHEMA_VERSION,
    id: editingId ?? `${CUSTOM_ID_PREFIX}draft`,
    ...draft,
    createdAt: now,
    updatedAt: now,
  };
}

function errorFor(field: string): string | null {
  return errors.find((e) => e.field === field)?.message ?? null;
}

function fieldError(field: string): string {
  const message = errorFor(field);
  return message ? `<p class="editor-error">${message}</p>` : '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stepRows(anchorMidi: number): string {
  return draft.steps.map((step, i) => {
    const midi = anchorMidi + step.offset;
    const inRange = step.offset >= MIN_OFFSET && step.offset <= MAX_OFFSET;
    return `
      <li class="editor-step ${inRange ? '' : 'editor-step--invalid'}">
        <span class="editor-step__index">${i + 1}</span>
        <label class="editor-step__field">
          <span class="editor-step__field-label">Semitones</span>
          <input type="number" class="editor-step__offset" data-step="${i}"
                 value="${step.offset}" min="${MIN_OFFSET}" max="${MAX_OFFSET}" step="1" />
        </label>
        <span class="editor-step__note" title="Resolved against your current voice type">${inRange ? midiToNoteName(midi) : '—'}</span>
        <label class="editor-step__field editor-step__field--grow">
          <span class="editor-step__field-label">Label (optional)</span>
          <input type="text" class="editor-step__label" data-step="${i}"
                 value="${escapeHtml(step.label ?? '')}" maxlength="24" placeholder="e.g. Root" />
        </label>
        <button type="button" class="btn btn-ghost editor-step__remove" data-remove-step="${i}"
                aria-label="Remove note ${i + 1}" ${draft.steps.length === 1 ? 'disabled' : ''}>Remove</button>
      </li>
    `;
  }).join('');
}

function render(): void {
  if (!container) return;
  const anchorMidi = resolveAnchorMidi();
  const isEditing = editingId !== null;
  const totalSeconds = Math.round((draft.steps.length * draft.msPerNote) / 1000);
  const isHold = draft.scoringStrategy === 'stable-hold';

  container.innerHTML = `
    <div class="exercise-editor fade-in">
      <div class="exercise-editor__header">
        <h1>${isEditing ? 'Edit exercise' : 'New exercise'}</h1>
        <p>Notes are set as semitones from your anchor pitch, so the exercise follows your voice type.</p>
      </div>

      <section class="card editor-section">
        <h2>Basics</h2>
        <label class="editor-field">
          <span>Name</span>
          <input type="text" id="editor-title" value="${escapeHtml(draft.title)}"
                 maxlength="${MAX_TITLE_LENGTH}" placeholder="My warm-up" />
        </label>
        ${fieldError('title')}
        <label class="editor-field">
          <span>Description</span>
          <input type="text" id="editor-description" value="${escapeHtml(draft.description)}"
                 maxlength="140" placeholder="What this drill is for" />
        </label>
        <label class="editor-field">
          <span>Difficulty</span>
          <select id="editor-difficulty">
            ${(['easy', 'medium', 'hard'] as const).map((d) => `<option value="${d}" ${draft.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase()}${d.slice(1)}</option>`).join('')}
          </select>
        </label>
      </section>

      <section class="card editor-section">
        <h2>Timing &amp; scoring</h2>
        <label class="editor-field">
          <span>Seconds per note</span>
          <input type="number" id="editor-ms-per-note" value="${draft.msPerNote / 1000}"
                 min="${MIN_MS_PER_NOTE / 1000}" max="${MAX_MS_PER_NOTE / 1000}" step="0.1" />
        </label>
        ${fieldError('msPerNote')}
        <label class="editor-field">
          <span>Scoring</span>
          <select id="editor-scoring">
            <option value="stable-hold" ${isHold ? 'selected' : ''}>Hold each note steadily</option>
            <option value="continuous-cents" ${isHold ? '' : 'selected'}>Score pitch continuously</option>
          </select>
        </label>
        ${isHold ? `
          <label class="editor-field">
            <span>Hold time (seconds)</span>
            <input type="number" id="editor-hold" value="${(draft.holdDurationMs ?? DEFAULT_HOLD_MS) / 1000}"
                   min="0.1" max="${draft.msPerNote / 1000}" step="0.1" />
          </label>
          ${fieldError('holdDurationMs')}
        ` : ''}
      </section>

      <section class="card editor-section">
        <h2>Notes</h2>
        <p class="editor-hint">
          Anchor is ${midiToNoteName(anchorMidi)} — set in Settings → Voice.
          Roughly ${totalSeconds}s total.
        </p>
        <ol class="editor-steps">${stepRows(anchorMidi)}</ol>
        ${fieldError('steps')}
        ${draft.steps.map((_, i) => fieldError(`steps.${i}`)).join('')}
        <button type="button" class="btn btn-secondary" id="editor-add-step"
                ${draft.steps.length >= MAX_STEPS ? 'disabled' : ''}>Add note</button>
      </section>

      <div class="editor-actions">
        <button type="button" class="btn btn-primary" id="editor-save">
          ${isEditing ? 'Save changes' : 'Create exercise'}
        </button>
        <button type="button" class="btn btn-secondary" id="editor-cancel">Cancel</button>
        ${isEditing ? '<button type="button" class="btn btn-ghost editor-danger" id="editor-delete">Delete</button>' : ''}
      </div>
    </div>
  `;

  bindEvents();
}

/**
 * Reads a field into the draft WITHOUT re-rendering, so the input keeps focus
 * and the caret while typing. Only changes that alter the form's structure
 * (adding/removing notes, switching scoring mode) trigger a re-render.
 */
function bindEvents(): void {
  if (!container) return;

  container.querySelector<HTMLInputElement>('#editor-title')?.addEventListener('input', (ev) => {
    draft.title = (ev.target as HTMLInputElement).value;
  });
  container.querySelector<HTMLInputElement>('#editor-description')?.addEventListener('input', (ev) => {
    draft.description = (ev.target as HTMLInputElement).value;
  });
  container.querySelector<HTMLSelectElement>('#editor-difficulty')?.addEventListener('change', (ev) => {
    draft.difficulty = (ev.target as HTMLSelectElement).value as NewCustomExerciseInput['difficulty'];
  });

  container.querySelector<HTMLInputElement>('#editor-ms-per-note')?.addEventListener('change', (ev) => {
    const seconds = Number.parseFloat((ev.target as HTMLInputElement).value);
    draft.msPerNote = Number.isFinite(seconds) ? Math.round(seconds * 1000) : draft.msPerNote;
    render(); // note-length change moves the hold-time ceiling and the total estimate
  });

  container.querySelector<HTMLSelectElement>('#editor-scoring')?.addEventListener('change', (ev) => {
    draft.scoringStrategy = (ev.target as HTMLSelectElement).value as NewCustomExerciseInput['scoringStrategy'];
    // Hold time only exists for stable-hold; seed a default so switching to it
    // doesn't immediately fail validation on a field the user never saw.
    if (draft.scoringStrategy === 'stable-hold' && !draft.holdDurationMs) {
      draft.holdDurationMs = Math.min(DEFAULT_HOLD_MS, draft.msPerNote);
    }
    render();
  });

  container.querySelector<HTMLInputElement>('#editor-hold')?.addEventListener('change', (ev) => {
    const seconds = Number.parseFloat((ev.target as HTMLInputElement).value);
    if (Number.isFinite(seconds)) draft.holdDurationMs = Math.round(seconds * 1000);
  });

  container.querySelectorAll<HTMLInputElement>('.editor-step__offset').forEach((input) => {
    input.addEventListener('change', (ev) => {
      const target = ev.target as HTMLInputElement;
      const index = Number.parseInt(target.dataset.step ?? '', 10);
      const value = Number.parseInt(target.value, 10);
      if (Number.isInteger(index) && Number.isFinite(value)) {
        draft.steps[index].offset = value;
        render(); // refresh the resolved note name beside the input
      }
    });
  });

  container.querySelectorAll<HTMLInputElement>('.editor-step__label').forEach((input) => {
    input.addEventListener('input', (ev) => {
      const target = ev.target as HTMLInputElement;
      const index = Number.parseInt(target.dataset.step ?? '', 10);
      if (Number.isInteger(index)) {
        const text = target.value.trim();
        draft.steps[index].label = text === '' ? undefined : text;
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>('[data-remove-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number.parseInt(btn.dataset.removeStep ?? '', 10);
      // Guarded rather than merely disabled: an exercise with zero notes is
      // unplayable, and the disabled attribute alone is a UI-only promise.
      if (Number.isInteger(index) && draft.steps.length > 1) {
        draft.steps.splice(index, 1);
        render();
      }
    });
  });

  container.querySelector<HTMLButtonElement>('#editor-add-step')?.addEventListener('click', () => {
    if (draft.steps.length >= MAX_STEPS) return;
    // Copy the last note's offset rather than defaulting to 0 — new notes are
    // usually a small step from the previous one, not a jump back to the root.
    const last = draft.steps[draft.steps.length - 1];
    draft.steps.push({ offset: last ? last.offset : 0 });
    render();
  });

  container.querySelector<HTMLButtonElement>('#editor-save')?.addEventListener('click', handleSave);
  container.querySelector<HTMLButtonElement>('#editor-cancel')?.addEventListener('click', () => {
    if (!goBack()) navigate('exercise-picker');
  });
  container.querySelector<HTMLButtonElement>('#editor-delete')?.addEventListener('click', handleDelete);
}

function handleSave(): void {
  errors = validateCustomExerciseSpec(draftToSpec());
  if (errors.length > 0) {
    render();
    showToast('Fix the highlighted fields first.', { variant: 'warning' });
    return;
  }

  const saved = editingId
    ? updateCustomExercise(editingId, draft)
    : createCustomExercise(draft);

  if (!saved) {
    // persistAll returned false — quota exceeded, or storage blocked entirely.
    showToast("Couldn't save — your browser is blocking local storage.", { variant: 'warning' });
    return;
  }

  showToast(editingId ? 'Exercise updated.' : 'Exercise created.');
  navigate('exercise-picker');
}

function handleDelete(): void {
  if (!editingId) return;
  if (!window.confirm('Delete this exercise? This cannot be undone.')) return;
  if (deleteCustomExercise(editingId)) {
    showToast('Exercise deleted.');
    navigate('exercise-picker');
  } else {
    showToast("Couldn't delete that exercise.", { variant: 'warning' });
  }
}

function renderNotEditable(root: HTMLElement, message: string): void {
  root.innerHTML = `
    <div class="exercise-editor fade-in">
      <div class="card editor-section">
        <h1>Can't edit this exercise</h1>
        <p class="editor-hint">${message}</p>
        <button type="button" class="btn btn-secondary" id="editor-back">Back to exercises</button>
      </div>
    </div>
  `;
  root.querySelector<HTMLButtonElement>('#editor-back')?.addEventListener('click', () => {
    navigate('exercise-picker');
  });
}

export const exerciseEditorScreen: Screen = {
  id: 'exercise-editor',
  mount(root, params) {
    container = root;
    errors = [];
    const id = params.exerciseId;

    if (!id) {
      editingId = null;
      draft = blankDraft();
      render();
      return;
    }

    if (!isCustomExerciseId(id)) {
      // Built-ins are read-only by design — see this file's header.
      renderNotEditable(root, 'Built-in exercises can\'t be changed. Create a new exercise instead.');
      return;
    }

    const spec = getCustomExerciseSpec(id);
    if (!spec) {
      renderNotEditable(root, 'That exercise no longer exists — it may have been deleted.');
      return;
    }

    editingId = spec.id;
    draft = {
      title: spec.title,
      description: spec.description,
      difficulty: spec.difficulty,
      scoringStrategy: spec.scoringStrategy,
      steps: spec.steps.map((s) => ({ ...s })),
      msPerNote: spec.msPerNote,
      holdDurationMs: spec.holdDurationMs,
    };
    render();
  },
  unmount() {
    container = null;
    editingId = null;
    errors = [];
  },
};

/**
 * Exercise Editor — a piano-roll grid for creating and editing user-defined
 * exercises. X is time (grid columns), Y is pitch (rows).
 *
 * Mounted with either no params (create) or `{ exerciseId }` (edit). Built-in
 * exercises are NOT editable: this screen refuses any id without the
 * `custom:` prefix rather than silently forking a copy, so the four shipped
 * exercises stay a fixed reference point.
 *
 * Rows are SEMITONE OFFSETS from the singer's anchor, not absolute pitches
 * (see custom-types.ts), but each row is labelled with the note name that
 * offset currently resolves to — "+7" means nothing to a singer, "G4" does.
 *
 * The grid is DOM, not canvas. Cells need to be individually hit-tested,
 * focusable and keyboard-reachable; doing that on a canvas would mean
 * re-implementing hit-testing and focus from scratch for no visual gain at
 * this size (25 rows x up to 64 columns).
 */
import type { Screen } from '../../screen-types';
import { navigate, goBack } from '../../navigation/router';
import {
  createCustomExercise, updateCustomExercise, deleteCustomExercise,
  getCustomExerciseSpec, type NewCustomExerciseInput,
} from '../../exercises/custom-store';
import {
  validateCustomExerciseSpec, isCustomExerciseId, usedSlots,
  CUSTOM_EXERCISE_SCHEMA_VERSION, CUSTOM_ID_PREFIX,
  MIN_OFFSET, MAX_OFFSET, VISIBLE_OFFSET_SPAN,
  MIN_SLOT_MS, MAX_SLOT_MS, MAX_SLOTS, MAX_NOTE_LENGTH_SLOTS, MAX_TITLE_LENGTH,
  type CustomExerciseSpec, type CustomExerciseNote, type SpecValidationError,
} from '../../exercises/custom-types';
import { resolveAnchorMidi } from '../../exercises/anchor';
import { getVoiceTypeById, type VoiceType } from '../../pitch/voice-type';
import { loadUserVoiceTypeId } from '../../services/user-settings';
import { midiToNoteName } from '../../pitch/note-name';
import { showToast } from '../../services/toast';
import { getAudioContext } from '../../services/audio-context';
import { preloadPianoSamples } from '../../audio/piano-samples';
import { loadInstrumentId } from '../../services/user-settings';
import { auditionNote, auditionSequence, type AuditionHandle } from './audition';
import './exercise-editor.css';

/** A fresh exercise starts as a root–3rd–5th triad: playable immediately, and a clear template. */
const DEFAULT_NOTES: CustomExerciseNote[] = [
  { offset: 0, startSlot: 0, lengthSlots: 2, label: 'Root' },
  { offset: 4, startSlot: 2, lengthSlots: 2, label: 'Major 3rd' },
  { offset: 7, startSlot: 4, lengthSlots: 2, label: '5th' },
];
const DEFAULT_SLOT_MS = 1000;
const DEFAULT_HOLD_MS = 800;
/** Shortest hold worth asking for; below this the detector settles before the singer has held anything. */
const MIN_HOLD_MS = 100;

/** Rounds to whole milliseconds and pins the result inside [min, max]. */
function clampMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Columns always shown, so there is empty grid to draw into beyond the last note. */
const MIN_VISIBLE_SLOTS = 16;
/** Spare columns kept past the end of the last note. */
const TRAILING_SLOTS = 4;

let draft: NewCustomExerciseInput = blankDraft();
let editingId: string | null = null;
let errors: SpecValidationError[] = [];
let selectedIndex: number | null = null;
let container: HTMLElement | null = null;
/**
 * Grid scroll position, preserved across repaints. BOTH axes matter: the grid
 * scrolls horizontally through time as well as vertically through pitch, and
 * tracking only the vertical offset sent the sheet back to column 1 every
 * time a note was placed off-screen to the right.
 */
let savedScroll: { left: number; top: number } | null = null;
/** Live only while the whole sequence is playing back; see togglePlayback. */
let playback: AuditionHandle | null = null;

/**
 * Sounds a pitch as feedback for placing or selecting a note.
 *
 * Resuming here rather than at mount: browsers only unlock an AudioContext
 * from a user gesture, and every caller of this is one.
 */
function soundNote(offset: number): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  auditionNote(ctx, resolveAnchorMidi() + offset, loadInstrumentId());
}

/** Stops sequence playback and repaints the button. Safe when nothing is playing. */
function stopPlayback(): void {
  playback?.stop();
  playback = null;
  const button = container?.querySelector<HTMLButtonElement>('#pr-play');
  if (button) button.textContent = 'Play';
}

function blankDraft(): NewCustomExerciseInput {
  return {
    title: '',
    description: '',
    difficulty: 'easy',
    scoringStrategy: 'stable-hold',
    notes: DEFAULT_NOTES.map((n) => ({ ...n })),
    slotMs: DEFAULT_SLOT_MS,
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

function fieldError(field: string): string {
  const message = errors.find((e) => e.field === field)?.message;
  return message ? `<p class="editor-error">${escapeHtml(message)}</p>` : '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Columns to render: enough for the content, never fewer than MIN_VISIBLE_SLOTS. */
function gridSlots(): number {
  return Math.min(MAX_SLOTS, Math.max(MIN_VISIBLE_SLOTS, usedSlots(draft.notes) + TRAILING_SLOTS));
}

/** Rows run high pitch to low, matching a keyboard and the pitch graph. */
function gridOffsets(): number[] {
  const offsets: number[] = [];
  for (let o = MAX_OFFSET; o >= MIN_OFFSET; o -= 1) offsets.push(o);
  return offsets;
}

/** True when a pitch sits outside the singer's voice type. False when none is set. */
function isOutOfRange(midi: number, voiceType: VoiceType | null): boolean {
  if (!voiceType) return false;
  return midi < voiceType.lowMidi || midi > voiceType.highMidi;
}

function noteAt(offset: number, slot: number): number {
  return draft.notes.findIndex(
    (n) => n.offset === offset && slot >= n.startSlot && slot < n.startSlot + n.lengthSlots,
  );
}

/**
 * True if a note occupying [slot, slot+length) would clash with an existing
 * one. Pitch is deliberately NOT considered: singing is monophonic, so two
 * notes sharing a column are invalid however far apart they sit.
 */
function collides(slot: number, length: number, ignoreIndex = -1): boolean {
  return draft.notes.some((n, i) => (
    i !== ignoreIndex && slot < n.startSlot + n.lengthSlots && n.startSlot < slot + length
  ));
}

function renderGrid(anchorMidi: number): string {
  const slots = gridSlots();
  const offsets = gridOffsets();
  // Read once, not per row: 49 rows x a storage read each would be wasteful.
  const voiceType = getVoiceTypeById(loadUserVoiceTypeId());

  const rows = offsets.map((offset) => {
    const midi = anchorMidi + offset;
    const name = midiToNoteName(midi);
    const isAnchor = offset === 0;
    const isC = name.startsWith('C') && !name.includes('#');
    // The grid spans +/-2 octaves, but a voice type covers about two — half
    // these rows are notes this singer cannot reach. Dimmed, NOT disabled:
    // range-stretching exercises deliberately sit at the edge, so this is a
    // warning, not a rule.
    const outOfRange = isOutOfRange(midi, voiceType);

    const cells = Array.from({ length: slots }, (_, slot) => {
      const index = noteAt(offset, slot);
      if (index === -1) {
        // A column already holding a note at ANY pitch cannot take another —
        // singing is monophonic, and beginDraw rejects it. Rendering those
        // cells as buttons made 37% of a fresh grid look and announce as
        // "Add note E5 at column 1" while doing nothing at all when clicked.
        // Same predicate as beginDraw's guard, so the two cannot drift apart.
        if (collides(slot, 1)) {
          return `<div class="pr-cell is-blocked" aria-hidden="true"></div>`;
        }
        return `<button type="button" class="pr-cell" data-offset="${offset}" data-slot="${slot}"
                  aria-label="Add note ${escapeHtml(name)} at column ${slot + 1}"></button>`;
      }
      const note = draft.notes[index];
      if (note.startSlot !== slot) return ''; // covered by the note block spanning from its start
      const selected = index === selectedIndex;
      return `
        <div class="pr-note ${selected ? 'is-selected' : ''}" data-index="${index}"
             style="grid-column: span ${note.lengthSlots}"
             role="button" tabindex="0"
             aria-label="${escapeHtml(name)}, ${note.lengthSlots} column${note.lengthSlots === 1 ? '' : 's'}${note.label ? `, ${escapeHtml(note.label)}` : ''}">
          <span class="pr-note__label">${escapeHtml(note.label ?? name)}</span>
          <span class="pr-note__handle" data-resize="${index}" aria-hidden="true"></span>
        </div>`;
    }).join('');

    return `
      <div class="pr-rowlabel ${isAnchor ? 'is-anchor' : ''} ${isC ? 'is-c' : ''} ${outOfRange ? 'is-out-of-range' : ''}">${escapeHtml(name)}</div>
      <div class="pr-row ${isAnchor ? 'is-anchor' : ''} ${outOfRange ? 'is-out-of-range' : ''}" style="grid-template-columns: repeat(${slots}, var(--pr-col))">${cells}</div>
    `;
  }).join('');

  const ruler = Array.from({ length: slots }, (_, i) => {
    const seconds = ((i + 1) * draft.slotMs) / 1000;
    // Label every 4th column, so the ruler stays readable at any zoom.
    return `<div class="pr-tick ${i % 4 === 3 ? 'is-major' : ''}">${i % 4 === 3 ? `${seconds.toFixed(1)}s` : ''}</div>`;
  }).join('');

  return `
    <div class="pr" id="pr-scroll">
      <div class="pr__ruler-label"></div>
      <div class="pr__ruler" style="grid-template-columns: repeat(${slots}, var(--pr-col))">${ruler}</div>
      ${rows}
    </div>
  `;
}

/** Explains the dimmed rows. Omitted when no voice type is set, since nothing is dimmed then. */
function rangeHint(): string {
  const voiceType = getVoiceTypeById(loadUserVoiceTypeId());
  if (!voiceType) return '';
  return `<p class="editor-hint">Dimmed rows are outside your ${escapeHtml(voiceType.label.toLowerCase())} range — usable, but harder to sing.</p>`;
}

function selectedNoteInspector(anchorMidi: number): string {
  if (selectedIndex === null || !draft.notes[selectedIndex]) {
    return '<p class="editor-hint">Click an empty square to add a note. Drag right to make it longer. Click a note to select it.</p>';
  }
  const note = draft.notes[selectedIndex];
  const name = midiToNoteName(anchorMidi + note.offset);
  return `
    <div class="pr-inspector">
      <span class="pr-inspector__pitch">${escapeHtml(name)}</span>
      <label class="pr-inspector__field">
        <span>Label</span>
        <input type="text" id="pr-note-label" value="${escapeHtml(note.label ?? '')}"
               maxlength="24" placeholder="optional" />
      </label>
      <div class="pr-inspector__len">
        <span>Length</span>
        <button type="button" class="btn btn-ghost" id="pr-len-minus" ${note.lengthSlots <= 1 ? 'disabled' : ''}>−</button>
        <output>${note.lengthSlots}</output>
        <button type="button" class="btn btn-ghost" id="pr-len-plus" ${note.lengthSlots >= MAX_NOTE_LENGTH_SLOTS ? 'disabled' : ''}>+</button>
      </div>
      <button type="button" class="btn btn-ghost editor-danger" id="pr-note-delete">Delete note</button>
    </div>
  `;
}

function render(): void {
  if (!container) return;
  const anchorMidi = resolveAnchorMidi();
  const isEditing = editingId !== null;
  const isHold = draft.scoringStrategy === 'stable-hold';
  const totalSeconds = (usedSlots(draft.notes) * draft.slotMs) / 1000;

  container.innerHTML = `
    <div class="exercise-editor fade-in">
      <div class="exercise-editor__header">
        <h1>${isEditing ? 'Edit exercise' : 'New exercise'}</h1>
        <p>Time runs left to right, pitch bottom to top. Rows follow your voice type, so the
           exercise transposes with you.</p>
      </div>

      <section class="card editor-section">
        <div class="pr-toolbar">
          <span class="pr-toolbar__meta" id="pr-meta">Anchor ${escapeHtml(midiToNoteName(anchorMidi))} · ${totalSeconds.toFixed(1)}s · ${draft.notes.length} note${draft.notes.length === 1 ? '' : 's'}</span>
          <label class="pr-toolbar__field">
            <span>Column</span>
            <input type="number" id="pr-slot-ms" value="${draft.slotMs / 1000}"
                   min="${MIN_SLOT_MS / 1000}" max="${MAX_SLOT_MS / 1000}" step="0.1" />
            <span class="pr-toolbar__unit">s</span>
          </label>
          <button type="button" class="btn btn-ghost" id="pr-play">Play</button>
          <button type="button" class="btn btn-ghost" id="pr-clear">Clear all</button>
        </div>
        ${renderGrid(anchorMidi)}
        ${rangeHint()}
        ${fieldError('notes')}
        ${fieldError('slotMs')}
        <div id="pr-inspector-host">${selectedNoteInspector(anchorMidi)}</div>
      </section>

      <section class="card editor-section">
        <h2>Details</h2>
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
                   min="0.1" step="0.1" />
          </label>
          ${fieldError('holdDurationMs')}
        ` : ''}
      </section>

      <div class="editor-actions">
        <button type="button" class="btn btn-primary" id="editor-save">
          ${isEditing ? 'Save changes' : 'Create exercise'}
        </button>
        <button type="button" class="btn btn-secondary" id="editor-cancel">Cancel</button>
        ${isEditing ? '<button type="button" class="btn btn-ghost editor-danger" id="editor-delete">Delete exercise</button>' : ''}
      </div>
    </div>
  `;

  const scroller = container.querySelector<HTMLElement>('#pr-scroll');
  if (scroller) attachScroll(scroller);
  bindEvents();
}

/**
 * Restores the grid's scroll on both axes; on the very first paint centres on
 * the anchor row instead, since that is where notes usually start.
 *
 * The listener is attached here rather than in bindGridEvents because this
 * runs once per grid ELEMENT — binding it on every repaint stacked up a new
 * listener each time a note was placed.
 */
function attachScroll(scroller: HTMLElement): void {
  if (savedScroll !== null) {
    scroller.scrollLeft = savedScroll.left;
    scroller.scrollTop = savedScroll.top;
  } else {
    const rowHeight = scroller.scrollHeight / (gridOffsets().length + 1);
    const anchorRow = MAX_OFFSET; // rows descend from MAX_OFFSET to MIN_OFFSET
    scroller.scrollTop = Math.max(0, (anchorRow + 1) * rowHeight - scroller.clientHeight / 2);
    savedScroll = { left: scroller.scrollLeft, top: scroller.scrollTop };
  }
  scroller.addEventListener('scroll', () => {
    savedScroll = { left: scroller.scrollLeft, top: scroller.scrollTop };
  }, { passive: true });
}

// ---- Grid interaction ----------------------------------------------------

/**
 * Draw-by-drag: pressing an empty cell creates a one-column note and keeps
 * extending it while the pointer moves right, the standard piano-roll gesture.
 * A plain click (no movement) therefore yields a one-column note.
 */
function beginDraw(cell: HTMLElement, ev: PointerEvent): void {
  const offset = Number.parseInt(cell.dataset.offset ?? '', 10);
  const slot = Number.parseInt(cell.dataset.slot ?? '', 10);
  if (!Number.isInteger(offset) || !Number.isInteger(slot)) return;
  if (collides(slot, 1)) return;

  draft.notes.push({ offset, startSlot: slot, lengthSlots: 1 });
  selectedIndex = draft.notes.length - 1;
  soundNote(offset);
  const index = selectedIndex;
  const cellWidth = cell.getBoundingClientRect().width;
  const startX = ev.clientX;

  const onMove = (moveEv: PointerEvent): void => {
    const dragged = Math.floor((moveEv.clientX - startX) / Math.max(1, cellWidth)) + 1;
    const wanted = Math.max(1, Math.min(MAX_NOTE_LENGTH_SLOTS, dragged));
    applyLength(index, wanted);
  };
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    refreshGrid();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  refreshGrid();
}

/** Resizing an existing note by dragging its right-hand handle. */
function beginResize(index: number, ev: PointerEvent): void {
  const note = draft.notes[index];
  if (!note) return;
  selectedIndex = index;
  const row = (ev.target as HTMLElement).closest('.pr-row');
  const cellWidth = row ? row.getBoundingClientRect().width / gridSlots() : 28;
  const startX = ev.clientX;
  const startLength = note.lengthSlots;

  const onMove = (moveEv: PointerEvent): void => {
    const delta = Math.round((moveEv.clientX - startX) / Math.max(1, cellWidth));
    applyLength(index, Math.max(1, Math.min(MAX_NOTE_LENGTH_SLOTS, startLength + delta)));
  };
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    refreshGrid();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/**
 * Sets a note's length, refusing any value that would run into the next note
 * or past the grid. Applied live during a drag, so the note simply stops
 * growing at the obstacle rather than the drag being rejected outright.
 */
function applyLength(index: number, wanted: number): void {
  const note = draft.notes[index];
  if (!note) return;
  let length = wanted;
  while (length > 1 && (collides(note.startSlot, length, index)
    || note.startSlot + length > MAX_SLOTS)) {
    length -= 1;
  }
  if (length === note.lengthSlots) return;
  note.lengthSlots = length;
  refreshGrid();
}

/**
 * Repaints the grid and the chrome that depends on it, WITHOUT rebuilding the
 * screen.
 *
 * Every note edit used to call render(), which replaced the whole subtree —
 * that discarded the grid's scroll position (throwing the user back to column
 * 1 after placing a note off to the right) and blew away focus in the form
 * inputs. Only genuinely structural changes call render() now.
 */
function refreshGrid(): void {
  if (!container) return;
  const scroller = container.querySelector<HTMLElement>('#pr-scroll');
  if (!scroller) return;

  const left = scroller.scrollLeft;
  const top = scroller.scrollTop;
  const anchorMidi = resolveAnchorMidi();

  const holder = document.createElement('div');
  holder.innerHTML = renderGrid(anchorMidi);
  const fresh = holder.firstElementChild as HTMLElement;
  scroller.replaceWith(fresh);
  // Assign before attachScroll so the restore is a no-op rather than a jump.
  fresh.scrollLeft = left;
  fresh.scrollTop = top;
  savedScroll = { left, top };
  attachScroll(fresh);
  bindGridEvents();

  const inspector = container.querySelector<HTMLElement>('#pr-inspector-host');
  if (inspector) {
    inspector.innerHTML = selectedNoteInspector(anchorMidi);
    bindInspectorEvents();
  }

  const meta = container.querySelector<HTMLElement>('#pr-meta');
  if (meta) meta.textContent = metaText(anchorMidi);
}

function metaText(anchorMidi: number): string {
  const totalSeconds = (usedSlots(draft.notes) * draft.slotMs) / 1000;
  const count = draft.notes.length;
  return `Anchor ${midiToNoteName(anchorMidi)} · ${totalSeconds.toFixed(1)}s · ${count} note${count === 1 ? '' : 's'}`;
}

function bindGridEvents(): void {
  if (!container) return;

  container.querySelectorAll<HTMLElement>('.pr-cell').forEach((cell) => {
    cell.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      beginDraw(cell, ev);
    });
  });

  container.querySelectorAll<HTMLElement>('.pr-note').forEach((el) => {
    const index = Number.parseInt(el.dataset.index ?? '', 10);
    el.addEventListener('pointerdown', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.dataset.resize !== undefined) {
        ev.preventDefault();
        beginResize(index, ev);
        return;
      }
      selectedIndex = index;
      soundNote(draft.notes[index].offset);
      refreshGrid();
    });
    // Keyboard parity: the grid must be operable without a pointer.
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        selectedIndex = index;
        soundNote(draft.notes[index].offset);
        refreshGrid();
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteNote(index);
      }
    });
  });

}

function deleteNote(index: number): void {
  draft.notes.splice(index, 1);
  selectedIndex = null;
  refreshGrid();
}

// ---- Form wiring ---------------------------------------------------------

function bindEvents(): void {
  if (!container) return;
  bindGridEvents();

  container.querySelector<HTMLInputElement>('#pr-slot-ms')?.addEventListener('change', (ev) => {
    // A number input's min/max only constrain the stepper arrows, never a
    // typed value: "-3" used to sail through and give the exercise a negative
    // duration, with the ruler counting down "-12.0s, -24.0s". Save-time
    // validation refused it, but only after the editor had shown nonsense.
    const input = ev.target as HTMLInputElement;
    const seconds = Number.parseFloat(input.value);
    if (Number.isFinite(seconds)) {
      draft.slotMs = clampMs(seconds * 1000, MIN_SLOT_MS, MAX_SLOT_MS);
    }
    // Write the clamped value back, so a rejected number is visibly corrected
    // rather than silently reinterpreted.
    input.value = String(draft.slotMs / 1000);
    render(); // the ruler and total duration both depend on this
  });

  container.querySelector<HTMLButtonElement>('#pr-play')?.addEventListener('click', (ev) => {
    if (playback) { stopPlayback(); return; }
    if (draft.notes.length === 0) return;
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    playback = auditionSequence(ctx, draft.notes, draft.slotMs, resolveAnchorMidi(), loadInstrumentId());
    (ev.target as HTMLButtonElement).textContent = 'Stop';
    // Reset the label whether it ended on its own or was stopped.
    void playback.done.then(() => { if (playback) stopPlayback(); });
  });

  container.querySelector<HTMLButtonElement>('#pr-clear')?.addEventListener('click', () => {
    if (draft.notes.length === 0) return;
    if (!window.confirm('Remove every note from the grid?')) return;
    draft.notes = [];
    selectedIndex = null;
    refreshGrid();
  });

  bindInspectorEvents();

  container.querySelector<HTMLInputElement>('#editor-title')?.addEventListener('input', (ev) => {
    draft.title = (ev.target as HTMLInputElement).value;
  });
  container.querySelector<HTMLInputElement>('#editor-description')?.addEventListener('input', (ev) => {
    draft.description = (ev.target as HTMLInputElement).value;
  });
  container.querySelector<HTMLSelectElement>('#editor-difficulty')?.addEventListener('change', (ev) => {
    draft.difficulty = (ev.target as HTMLSelectElement).value as NewCustomExerciseInput['difficulty'];
  });
  container.querySelector<HTMLSelectElement>('#editor-scoring')?.addEventListener('change', (ev) => {
    draft.scoringStrategy = (ev.target as HTMLSelectElement).value as NewCustomExerciseInput['scoringStrategy'];
    // Seed a default so switching to stable-hold doesn't immediately fail
    // validation on a field the user never saw.
    if (draft.scoringStrategy === 'stable-hold' && !draft.holdDurationMs) {
      draft.holdDurationMs = Math.min(DEFAULT_HOLD_MS, draft.slotMs);
    }
    render();
  });
  container.querySelector<HTMLInputElement>('#editor-hold')?.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    const seconds = Number.parseFloat(input.value);
    if (Number.isFinite(seconds)) {
      // Lower bound only. The upper bound depends on the shortest note, and
      // validation already explains that one properly ("Hold time is longer
      // than your shortest note") rather than silently shrinking the value.
      draft.holdDurationMs = clampMs(seconds * 1000, MIN_HOLD_MS, MAX_SLOT_MS * MAX_NOTE_LENGTH_SLOTS);
    }
    input.value = String((draft.holdDurationMs ?? DEFAULT_HOLD_MS) / 1000);
  });

  container.querySelector<HTMLButtonElement>('#editor-save')?.addEventListener('click', handleSave);
  container.querySelector<HTMLButtonElement>('#editor-cancel')?.addEventListener('click', () => {
    if (!goBack()) navigate('exercise-picker');
  });
  container.querySelector<HTMLButtonElement>('#editor-delete')?.addEventListener('click', handleDeleteExercise);
}

/** Bound separately from bindEvents so refreshGrid can re-wire a replaced inspector. */
function bindInspectorEvents(): void {
  if (!container) return;

  container.querySelector<HTMLInputElement>('#pr-note-label')?.addEventListener('input', (ev) => {
    if (selectedIndex === null) return;
    const text = (ev.target as HTMLInputElement).value.trim();
    draft.notes[selectedIndex].label = text === '' ? undefined : text;
    // Deliberately no repaint: rebuilding the grid mid-keystroke would pull
    // focus out of this input. The note's caption catches up on the next edit.
  });

  container.querySelector<HTMLButtonElement>('#pr-len-minus')?.addEventListener('click', () => {
    if (selectedIndex === null) return;
    applyLength(selectedIndex, draft.notes[selectedIndex].lengthSlots - 1);
    refreshGrid();
  });
  container.querySelector<HTMLButtonElement>('#pr-len-plus')?.addEventListener('click', () => {
    if (selectedIndex === null) return;
    applyLength(selectedIndex, draft.notes[selectedIndex].lengthSlots + 1);
    refreshGrid();
  });
  container.querySelector<HTMLButtonElement>('#pr-note-delete')?.addEventListener('click', () => {
    if (selectedIndex !== null) deleteNote(selectedIndex);
  });
}

function handleSave(): void {
  errors = validateCustomExerciseSpec(draftToSpec());
  if (errors.length > 0) {
    render();
    showToast(errors[0].message, { variant: 'warning' });
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

function handleDeleteExercise(): void {
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
        <p class="editor-hint">${escapeHtml(message)}</p>
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
    // Warm the sample set so the first note placed makes a sound rather than
    // the synth fallback. Not awaited: the editor must render immediately, and
    // playInstrumentNote degrades gracefully until this lands.
    void preloadPianoSamples(getAudioContext());
    errors = [];
    selectedIndex = null;
    savedScroll = null;
    const id = params.exerciseId;

    if (!id) {
      editingId = null;
      draft = blankDraft();
      render();
      return;
    }

    if (!isCustomExerciseId(id)) {
      // Built-ins are read-only by design — see this file's header.
      renderNotEditable(root, "Built-in exercises can't be changed. Create a new exercise instead.");
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
      notes: spec.notes.map((n) => ({ ...n })),
      slotMs: spec.slotMs,
      holdDurationMs: spec.holdDurationMs,
    };
    render();
  },
  unmount() {
    // Otherwise the sequence keeps playing after the user has left the screen.
    stopPlayback();
    container = null;
    editingId = null;
    errors = [];
    selectedIndex = null;
    savedScroll = null;
  },
};

// Kept exported for the row range used by the grid's scroll maths.
export const EDITOR_VISIBLE_SPAN = VISIBLE_OFFSET_SPAN;

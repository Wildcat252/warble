import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// jsdom has no Web Audio. The editor now sounds notes as you place them, so
// the audio layer is stubbed out; audition.test.ts covers it properly.
vi.mock('../../services/audio-context', () => ({
  getAudioContext: () => ({ state: 'running', currentTime: 0, resume: vi.fn() }),
}));
vi.mock('../../audio/piano-samples', () => ({ preloadPianoSamples: vi.fn(async () => undefined) }));
vi.mock('../../audio/instruments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../audio/instruments')>()),
  playInstrumentNote: vi.fn(),
}));
vi.mock('../../navigation/router', () => ({ navigate: vi.fn(), goBack: vi.fn(() => true) }));
vi.mock('../../services/toast', () => ({ showToast: vi.fn() }));

const { exerciseEditorScreen } = await import('./index');
const { MIN_SLOT_MS, MAX_SLOT_MS } = await import('../../exercises/custom-types');
const { VOICE_TYPES } = await import('../../pitch/voice-type');

let root: HTMLElement;

/** The default draft is a triad: Root 0-1, Major 3rd 2-3, 5th 4-5. */
const OCCUPIED_COLUMNS = [0, 1, 2, 3, 4, 5];

function mount(): void {
  root = document.createElement('div');
  document.body.appendChild(root);
  exerciseEditorScreen.mount(root, {});
}

function cells(): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.pr-cell'));
}

function clickableCellsIn(columns: number[]): HTMLElement[] {
  return cells().filter((c) => c.tagName === 'BUTTON' && columns.includes(Number(c.dataset.slot)));
}

function noteCount(): number {
  return root.querySelectorAll('.pr-note').length;
}

/**
 * jsdom does not implement PointerEvent, so the pointer gestures are driven
 * with a MouseEvent carrying the pointer event's name — dispatchEvent matches
 * listeners on the type string, and the handlers only read clientX/clientY.
 */
function press(cell: HTMLElement): void {
  cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
}

beforeEach(() => {
  window.localStorage.clear();
  mount();
});

afterEach(() => {
  exerciseEditorScreen.unmount?.();
  root.remove();
});

describe('piano-roll grid', () => {
  it('offers no clickable cell in a column that already holds a note', () => {
    // Singing is monophonic, so a column with a note anywhere in it is full.
    // These cells used to render as buttons labelled "Add note E5 at column 1"
    // and silently do nothing — 37% of a fresh grid.
    expect(clickableCellsIn(OCCUPIED_COLUMNS)).toHaveLength(0);
  });

  it('does not promise an "add note" action on a blocked cell', () => {
    const blocked = cells().filter((c) => c.classList.contains('is-blocked'));
    expect(blocked.length).toBeGreaterThan(0);
    for (const cell of blocked) {
      expect(cell.tagName).not.toBe('BUTTON'); // out of the tab order
      expect(cell.getAttribute('aria-hidden')).toBe('true');
      expect(cell.getAttribute('aria-label')).toBeNull();
    }
  });

  it('still lets you draw in a free column', () => {
    const free = clickableCellsIn([10]);
    expect(free.length).toBeGreaterThan(0);
    const before = noteCount();
    press(free[0]);
    expect(noteCount()).toBe(before + 1);
  });

  it('blocks the rest of a column as soon as a note lands in it', () => {
    expect(clickableCellsIn([10]).length).toBeGreaterThan(0);
    press(clickableCellsIn([10])[0]);
    expect(clickableCellsIn([10])).toHaveLength(0);
  });
});

describe('column duration input', () => {
  const setColumn = (value: string): HTMLInputElement => {
    const input = root.querySelector<HTMLInputElement>('#pr-slot-ms')!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return root.querySelector<HTMLInputElement>('#pr-slot-ms')!;
  };

  it('clamps a negative value instead of building a negative-length exercise', () => {
    // "-3" used to give the exercise a duration of -33s, with the ruler
    // counting down. A number input's min/max never constrain typed values.
    expect(setColumn('-3').value).toBe(String(MIN_SLOT_MS / 1000));
    expect(root.querySelector('#pr-meta')?.textContent).not.toContain('-');
  });

  it('clamps a value above the maximum', () => {
    expect(setColumn('99').value).toBe(String(MAX_SLOT_MS / 1000));
  });

  it('leaves a valid value alone', () => {
    expect(setColumn('1.5').value).toBe('1.5');
  });

  it('ignores a non-numeric entry rather than producing NaN', () => {
    setColumn('1.5');
    expect(setColumn('abc').value).toBe('1.5');
  });
});

describe('voice-type range marking', () => {
  it('dims exactly the rows the singer cannot reach', () => {
    window.localStorage.setItem('warble.voice-type.v1', 'soprano');
    exerciseEditorScreen.unmount?.();
    root.remove();
    mount();

    const soprano = VOICE_TYPES.find((v) => v.id === 'soprano')!;
    const inRange = soprano.highMidi - soprano.lowMidi + 1;
    const rows = Array.from(root.querySelectorAll('.pr-row'));
    const singable = rows.filter((r) => !r.classList.contains('is-out-of-range'));

    expect(rows).toHaveLength(49); // +/-24 semitones
    expect(singable).toHaveLength(inRange);
    // The anchor is the middle of the voice, so it is never dimmed.
    expect(root.querySelector('.pr-row.is-anchor')?.classList.contains('is-out-of-range')).toBe(false);
  });

  it('dims nothing when no voice type is set', () => {
    expect(root.querySelectorAll('.pr-row.is-out-of-range')).toHaveLength(0);
    expect(root.textContent).not.toContain('Dimmed rows');
  });
});

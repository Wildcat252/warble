/**
 * Shared Screen interface — the navigable-page counterpart to Feature
 * (see feature-types.ts). Screens are mounted/unmounted into #screen-root
 * by features/app-shell in response to navigation/router.ts.
 *
 * Lives here — not in screens/registry.ts — for the same reason
 * feature-types.ts is split from registry.ts: avoids a circular import
 * between the registry and the screen modules it imports.
 */
export type ScreenId =
  | 'home'
  | 'range-test'
  | 'exercise-picker'
  | 'exercise-player'
  | 'results'
  | 'progress'
  | 'settings';

/**
 * True for screens that should hide the nav rail/tab bar (full-screen focus
 * mode). Only screens with a REAL immersive flow belong here — 'range-test'
 * was excluded while it was still a placeholder card (nothing to focus on,
 * nav needed to be visible so it wasn't a dead end); its Phase 5 guided
 * flow is real now, so it's back.
 */
export const FOCUS_MODE_SCREENS: ReadonlySet<ScreenId> = new Set(['exercise-player', 'range-test']);

export interface Screen {
  id: ScreenId;
  /** `params` carries simple string values from navigate(), e.g. { exerciseId: 'note-hold-basic' }. */
  mount(container: HTMLElement, params: Readonly<Record<string, string>>): void;
  unmount?(): void;
}

/**
 * App shell — the persistent chrome (header + nav) around the currently
 * navigated Screen. This is the one top-level Feature (besides
 * audio-preflight) left standing after the Warble rework: it owns
 * #screen-root and mounts/unmounts Screens from screens/registry.ts in
 * response to navigation/router.ts.
 */
import { type Feature } from '../../feature-types';
import { type Screen, type ScreenId, FOCUS_MODE_SCREENS } from '../../screen-types';
import { getScreen } from '../../screens/registry';
import { navigate, onScreenChange, goBack, type RouterState } from '../../navigation/router';
import { APP_NAME } from '../../branding';
import './app-shell.css';

interface NavItem {
  screen: ScreenId;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { screen: 'home', label: 'Home', icon: '🏠' },
  { screen: 'exercise-picker', label: 'Exercises', icon: '🎯' },
  { screen: 'range-test', label: 'Range Test', icon: '🎚️' },
  { screen: 'progress', label: 'Progress', icon: '📈' },
  { screen: 'settings', label: 'Settings', icon: '⚙️' },
];

let activeScreen: Screen | null = null;
let unsubscribeRouter: (() => void) | null = null;
let shellEl: HTMLDivElement | null = null;

function buildShellMarkup(): string {
  const navButtons = NAV_ITEMS.map(
    (item) => `
      <button type="button" class="app-nav__item" data-nav-target="${item.screen}" title="${item.label}">
        <span class="app-nav__icon" aria-hidden="true">${item.icon}</span>
        <span class="app-nav__label">${item.label}</span>
      </button>
    `,
  ).join('');

  return `
    <div id="app-shell">
      <header id="app-header">
        <button type="button" id="app-back-btn" class="btn btn-ghost hidden" title="Back" aria-label="Back">&larr;</button>
        <span id="app-header-brand">${APP_NAME}</span>
        <div id="app-status" role="status" aria-live="polite" aria-atomic="true">
          <span id="app-status-text">checking backend…</span>
        </div>
      </header>
      <div id="app-body">
        <nav id="app-nav" aria-label="Main navigation">${navButtons}</nav>
        <main id="screen-root"></main>
      </div>
    </div>
  `;
}

function setActiveNavItem(screen: ScreenId): void {
  if (!shellEl) return;
  shellEl.querySelectorAll<HTMLButtonElement>('.app-nav__item').forEach((btn) => {
    btn.classList.toggle('app-nav__item--active', btn.dataset.navTarget === screen);
  });
}

function applyFocusMode(screen: ScreenId): void {
  if (!shellEl) return;
  const appShell = shellEl.querySelector<HTMLDivElement>('#app-shell');
  const backBtn = shellEl.querySelector<HTMLButtonElement>('#app-back-btn');
  const focus = FOCUS_MODE_SCREENS.has(screen);
  appShell?.classList.toggle('focus-mode', focus);
  backBtn?.classList.toggle('hidden', !focus);
}

function handleRouteChange(state: RouterState): void {
  if (!shellEl) return;
  const screenRoot = shellEl.querySelector<HTMLElement>('#screen-root');
  if (!screenRoot) return;

  activeScreen?.unmount?.();
  screenRoot.innerHTML = '';

  const screen = getScreen(state.screen);
  activeScreen = screen;
  screen.mount(screenRoot, state.params);

  setActiveNavItem(state.screen);
  applyFocusMode(state.screen);
}

function mount(slot: HTMLElement): void {
  slot.innerHTML = buildShellMarkup();
  shellEl = slot as HTMLDivElement;

  shellEl.querySelectorAll<HTMLButtonElement>('.app-nav__item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.navTarget as ScreenId | undefined;
      if (target) navigate(target);
    });
  });

  shellEl.querySelector<HTMLButtonElement>('#app-back-btn')?.addEventListener('click', () => {
    goBack();
  });

  unsubscribeRouter = onScreenChange(handleRouteChange);
}

function unmount(): void {
  unsubscribeRouter?.();
  unsubscribeRouter = null;
  activeScreen?.unmount?.();
  activeScreen = null;
  shellEl = null;
}

export const appShellFeature: Feature = {
  id: 'slot-app-shell',
  mount,
  unmount,
};

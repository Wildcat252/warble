/**
 * Hand-rolled screen router — no library, matching the module-singleton
 * pub/sub pattern used elsewhere in this codebase (e.g. the old
 * services/score-session.ts). A single callback list is sufficient for a
 * shallow, mostly-tree-shaped navigation structure; a full history/URL
 * router would be overkill here.
 */
import type { ScreenId } from '../screen-types';

export interface RouterState {
  screen: ScreenId;
  params: Readonly<Record<string, string>>;
}

type RouterListener = (state: RouterState) => void;

const DEFAULT_STATE: RouterState = { screen: 'home', params: {} };

let current: RouterState = DEFAULT_STATE;
/** Back-stack of previously visited states, most recent last. Does not include `current`. */
const backStack: RouterState[] = [];
const listeners = new Set<RouterListener>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

export function navigate(screen: ScreenId, params: Record<string, string> = {}): void {
  backStack.push(current);
  current = { screen, params };
  emit();
}

/**
 * Replace the current entry instead of pushing — used when a screen wants
 * to update its own params (e.g. results screen refresh) without growing
 * the back-stack.
 */
export function replace(screen: ScreenId, params: Record<string, string> = {}): void {
  current = { screen, params };
  emit();
}

export function goBack(): void {
  const previous = backStack.pop();
  if (!previous) return;
  current = previous;
  emit();
}

export function getCurrentScreen(): RouterState {
  return current;
}

export function onScreenChange(listener: RouterListener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

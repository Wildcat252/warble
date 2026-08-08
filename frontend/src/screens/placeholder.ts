/**
 * Temporary placeholder Screen factory — used for screens whose real
 * implementation lands in a later build phase (see the Warble rework plan's
 * "Build order"). Each phase replaces one placeholder with a real
 * screens/<id>/index.ts and updates the one line in screens/registry.ts
 * that points to it; nothing else needs to change.
 */
import type { Screen, ScreenId } from '../screen-types';
import './placeholder.css';

export function createPlaceholderScreen(id: ScreenId, title: string, description: string): Screen {
  return {
    id,
    mount(container) {
      container.innerHTML = `
        <div class="screen-placeholder">
          <div class="card pop-in">
            <h1>${title}</h1>
            <p>${description}</p>
          </div>
        </div>
      `;
    },
  };
}

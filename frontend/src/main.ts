/**
 * Warble entry point (formerly sing-attune).
 *
 * This file is intentionally minimal and must never contain feature-specific
 * code. Adding a feature = add a directory under features/ and one line in
 * registry.ts. This file does not change.
 *
 * Boot sequence:
 *   1. Import global stylesheets (app-shell-level concern, not a feature —
 *      see styles/ for the design-token system).
 *   2. Mount each registered feature into its DOM slot.
 *   3. Run backend health check (delegated to services/backend).
 *
 * Clock hierarchy (enforced by whichever screen drives real-time pitch
 * playback — currently exercise-player/range-test — must never be broken):
 *   AudioContext.currentTime → local elapsed-ms clock → UI
 */
import './styles/tokens.css';
import './styles/reset.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/animations.css';

import { features } from './registry';
import { checkBackend } from './services/backend';

for (const feature of features) {
  const slot = document.getElementById(feature.id);
  if (slot) {
    feature.mount(slot);
  } else {
    console.warn(`[registry] DOM slot not found: #${feature.id}`);
  }
}

void checkBackend();

/**
 * Feature registry.
 *
 * This is the ONLY file that changes when a new top-level feature is added.
 * Import the feature, add one line to the array — nothing else.
 *
 * main.ts never changes.
 *
 * Post-Warble-rework, most of the app's screens live under screens/registry.ts
 * instead — this array only holds the persistent app chrome (app-shell) and
 * features that aren't tied to a single navigable screen (audio-preflight,
 * whose modal can be opened from multiple screens).
 */
import { type Feature } from './feature-types';

import { appShellFeature } from './features/app-shell/index';
import { audioPreflightFeature } from './features/audio-preflight/index';

export type { Feature } from './feature-types';

export const features: Feature[] = [
  appShellFeature,
  audioPreflightFeature,
];

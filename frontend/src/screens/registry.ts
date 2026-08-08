/**
 * Screen registry.
 *
 * This is the ONLY file that changes when a screen's implementation is
 * swapped in (mirrors the convention in ../registry.ts for top-level
 * Features, one layer deeper for navigable Screens).
 *
 * Each build phase in the Warble rework plan replaces one placeholder entry
 * below with a real screens/<id>/index.ts import — nothing else changes.
 */
import type { Screen, ScreenId } from '../screen-types';
import { homeScreen } from './home/index';
import { createPlaceholderScreen } from './placeholder';

const screens: Record<ScreenId, Screen> = {
  home: homeScreen,
  'range-test': createPlaceholderScreen(
    'range-test',
    'Vocal Range Test',
    'Coming in a later build phase — sing your lowest and highest comfortable notes to find your voice type.',
  ),
  'exercise-picker': createPlaceholderScreen(
    'exercise-picker',
    'Exercises',
    'Coming in a later build phase — a picker for pitch-matching drills, scale climbs, interval jumps, and guided warm-ups.',
  ),
  'exercise-player': createPlaceholderScreen(
    'exercise-player',
    'Exercise',
    'Coming in a later build phase — the live pitch-matching exercise screen.',
  ),
  results: createPlaceholderScreen(
    'results',
    'Results',
    'Coming in a later build phase — XP earned, accuracy, and streak updates after each exercise.',
  ),
  progress: createPlaceholderScreen(
    'progress',
    'Progress',
    'Coming in a later build phase — your practice streak, XP trend, and vocal range history.',
  ),
  settings: createPlaceholderScreen(
    'settings',
    'Settings',
    'Coming in a later build phase — mic device, voice type, and pitch-detection tuning.',
  ),
};

export function getScreen(id: ScreenId): Screen {
  return screens[id];
}

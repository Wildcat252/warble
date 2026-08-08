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
import { exercisePlayerScreen } from '../features/exercise-player/index';
import { exercisePickerScreen } from './exercise-picker/index';
import { settingsScreen } from './settings/index';
import { rangeTestScreen } from '../features/range-test/index';

const screens: Record<ScreenId, Screen> = {
  home: homeScreen,
  'range-test': rangeTestScreen,
  'exercise-picker': exercisePickerScreen,
  'exercise-player': exercisePlayerScreen,
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
  settings: settingsScreen,
};

export function getScreen(id: ScreenId): Screen {
  return screens[id];
}

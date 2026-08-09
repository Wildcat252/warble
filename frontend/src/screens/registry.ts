/**
 * Screen registry.
 *
 * This is the ONLY file that changes when a screen's implementation is
 * swapped in (mirrors the convention in ../registry.ts for top-level
 * Features, one layer deeper for navigable Screens).
 *
 * Every screen is now a real implementation; the temporary placeholder
 * factory used during the phased rework is gone.
 */
import type { Screen, ScreenId } from '../screen-types';
import { homeScreen } from './home/index';
import { exercisePlayerScreen } from '../features/exercise-player/index';
import { exercisePickerScreen } from './exercise-picker/index';
import { settingsScreen } from './settings/index';
import { rangeTestScreen } from '../features/range-test/index';
import { resultsScreen } from './results/index';
import { progressScreen } from './progress/index';

const screens: Record<ScreenId, Screen> = {
  home: homeScreen,
  'range-test': rangeTestScreen,
  'exercise-picker': exercisePickerScreen,
  'exercise-player': exercisePlayerScreen,
  results: resultsScreen,
  progress: progressScreen,
  settings: settingsScreen,
};

export function getScreen(id: ScreenId): Screen {
  return screens[id];
}

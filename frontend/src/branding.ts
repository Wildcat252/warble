/**
 * Single source of truth for the app's display name and storage namespace.
 *
 * Kept deliberately tiny and dependency-free so a future rebrand only means
 * editing this file plus the handful of static config files that can't
 * import TS (index.html <title>, electron-builder.yml, package.json — see
 * the "Naming" section of the Warble rework plan).
 */
export const APP_NAME = 'Warble';

/** Reverse-DNS app id, used by electron-builder. */
export const APP_ID = 'com.warble.desktop';

/**
 * localStorage key prefix. Deliberately NOT derived from APP_NAME — it's a
 * technical identifier, not display text, so a future rename never forces a
 * localStorage migration for existing users.
 */
export const STORAGE_PREFIX = 'warble';

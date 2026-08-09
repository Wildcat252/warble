import { expect, test, type Page } from '@playwright/test';

/**
 * E2E for the Warble exercise flow.
 *
 * Backend routes are mocked so this runs without a FastAPI process or audio
 * hardware. Real pitch capture is server-side (Python/sounddevice), so an
 * exercise can never be *sung* here — these tests cover navigation, the
 * gamification state machine, and persistence, which is exactly the part
 * that unit tests can't verify end-to-end through the real DOM/router.
 */

/** The pitch WebSocket can't connect without a backend; not a failure. */
const IGNORED_ERRORS = ['/ws/pitch', 'WebSocket'];

async function mockBackendRoutes(page: Page): Promise<void> {
  // Exact-path matching only, so Vite's JS module requests aren't intercepted.
  await page.route((url) => url.pathname === '/health', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', version: 'e2e' }),
    });
  });

  await page.route((url) => url.pathname === '/audio/devices', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        default_device_id: 1,
        devices: [{ id: 1, name: 'Mock Mic', channels: 1, host_api: 'Core Audio', default_sample_rate: 48000 }],
      }),
    });
  });

  await page.route((url) => url.pathname === '/audio/engine', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        active_engine: 'pyin', mode: 'auto', switchable: true,
        cuda: false, device: 'CPU', force_cpu: false, xrun_count: 0,
      }),
    });
  });

  await page.route((url) => url.pathname.startsWith('/playback/'), async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ state: 'PLAYING', t_ms: 0 }),
    });
  });
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_ERRORS.some((ignored) => text.includes(ignored))) return;
    errors.push(text);
  });
  return errors;
}

/** Writes practice-log entries directly, so gamification UI can be asserted without singing. */
async function seedPracticeLog(
  page: Page,
  entries: { daysAgo: number; xpEarned: number; accuracyPct?: number }[],
): Promise<void> {
  await page.evaluate((seed) => {
    const key = 'warble.practice-log.v1';
    const rows = seed.map((e, i) => {
      const d = new Date();
      d.setDate(d.getDate() - e.daysAgo);
      d.setHours(12, 0, 0, 0);
      return {
        id: `e2e-${i}`,
        timestamp: d.toISOString(),
        exerciseId: 'note-hold-basic',
        exerciseKind: 'note-hold',
        accuracyPct: e.accuracyPct ?? 80,
        durationMs: 18000,
        xpEarned: e.xpEarned,
        minMidi: 55,
        maxMidi: 67,
      };
    });
    window.localStorage.setItem(key, JSON.stringify(rows));
  }, entries);
}

test.beforeEach(async ({ page }) => {
  await mockBackendRoutes(page);
});

test('boots to Home and reports backend health', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /ready to warm up/i })).toBeVisible();
  await expect(page.locator('#app-status-text')).toContainText('backend ok');
  expect(errors).toEqual([]);
});

test('navigates between every screen from the nav rail', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');

  for (const [label, heading] of [
    ['Exercises', /exercises/i],
    ['Range Test', /find your voice type/i],
    ['Progress', /progress/i],
    ['Settings', /settings/i],
    ['Home', /ready to warm up/i],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('exercise picker lists the catalog and opens the player', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Exercises', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Note Hold' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Major Scale Climb' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Interval Jumps' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Guided Warm-up' })).toBeVisible();

  await page.getByRole('heading', { name: 'Note Hold' }).click();

  // Focus mode hides the nav rail while an exercise is running.
  await expect(page.getByRole('heading', { name: 'Note Hold' })).toBeVisible();
  await expect(page.locator('#app-nav')).toBeHidden();
  // Starting the exercise must NOT pop the mic-setup modal (that moved to Settings).
  await expect(page.locator('#audio-preflight-modal')).toBeHidden();
});

test('Home shows streak, level and daily-goal progress from stored history', async ({ page }) => {
  await page.goto('/');
  // 3 consecutive days ending today; 150 XP total crosses into level 2.
  await seedPracticeLog(page, [
    { daysAgo: 2, xpEarned: 50 },
    { daysAgo: 1, xpEarned: 50 },
    { daysAgo: 0, xpEarned: 50 },
  ]);
  await page.reload();

  const stats = page.locator('.home-stats');
  await expect(stats).toContainText('3');          // day streak
  await expect(stats).toContainText('Level 2');
  await expect(stats).toContainText('1 / 1');      // daily goal met
  await expect(page.getByText(/today's goal is done/i)).toBeVisible();
});

test('Progress screen summarises history and can clear it', async ({ page }) => {
  await page.goto('/');
  await seedPracticeLog(page, [{ daysAgo: 1, xpEarned: 40 }, { daysAgo: 0, xpEarned: 60 }]);
  await page.reload();

  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.getByText('2 sessions so far.')).toBeVisible();
  await expect(page.locator('.progress-summary')).toContainText('100'); // total XP

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /clear history/i }).click();

  // Subscribing to the log means clearing re-renders to the empty state live.
  await expect(page.getByRole('heading', { name: /no practice yet/i })).toBeVisible();
});

test('Progress shows an empty state that routes into the picker', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Progress', exact: true }).click();

  await expect(page.getByRole('heading', { name: /no practice yet/i })).toBeVisible();
  await page.getByRole('button', { name: /start an exercise/i }).click();
  await expect(page.getByRole('heading', { name: 'Exercises' })).toBeVisible();
});

test('Settings lists backend devices and persists the choice', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const deviceSelect = page.locator('#settings-device');
  await expect(deviceSelect).toContainText('Mock Mic');

  await deviceSelect.selectOption('1');
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('warble.backend-device-id.v1')))
    .toBe('1');
});

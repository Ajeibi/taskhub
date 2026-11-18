import { defineConfig } from '@playwright/test';

// Runs against a RUNNING stack (default: the Docker Compose app on :8080). It never touches the dev database
// directly: every test signs up its own throw-away users through the UI, so no cleanup is needed.
//   docker compose up -d --build        (set AUTH_RATE_LIMIT_MAX=1000 first: the suite signs up many users)
//   npm run test:edge                   (uses the Edge already installed on Windows)
//   npm test                            (uses Playwright's Chromium: run `npx playwright install chromium` once)
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    channel: process.env.E2E_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'test-results',
});

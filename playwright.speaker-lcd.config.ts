import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'speaker-lcd.spec.ts',
  outputDir: './test-results/speaker-lcd',
  workers: 1,
  timeout: 90000,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
});

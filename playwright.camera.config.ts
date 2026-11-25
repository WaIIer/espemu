import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'camera.spec.ts',
  outputDir: './test-results/camera',
  workers: 1,
  timeout: 90000,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    permissions: ['camera'],
    // Chromium's synthetic camera stands in for a real webcam.
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
});

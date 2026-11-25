import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'roomguard.spec.ts',
  outputDir: './test-results/roomguard',
  workers: 1,
  timeout: 65000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
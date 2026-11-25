import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'creator.spec.ts',
  outputDir: './test-results/creator',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4130', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run creator -- --host 127.0.0.1 --port 4130 --strictPort',
    url: 'http://127.0.0.1:4130/create',
    reuseExistingServer: false,
    timeout: 20000,
  },
});

import { defineConfig } from '@playwright/test';

const port = process.env.PORT ?? '4146';
export default defineConfig({
  testDir: './e2e', testMatch: 'circuit.spec.ts', outputDir: './test-results/circuit',
  workers: 1, timeout: 30000, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: `npm exec -- vite --config frontend/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 20000,
  },
});

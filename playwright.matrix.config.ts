import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const port = process.env.PORT ?? '4122';
export default defineConfig({
  testDir: './e2e', testMatch: 'matrix.spec.ts', outputDir: './test-results/matrix',
  workers: 1, timeout: 30000, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm start', url: `http://127.0.0.1:${port}/health`, reuseExistingServer: false, timeout: 20000,
    env: { ...process.env, PORT: port, ESPEMU_PROJECT: resolve('tests/fixtures/max7219'), ESPEMU_FLASH: resolve('.cache/max7219/qemu_flash.bin') },
  },
});

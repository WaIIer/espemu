import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'demo.spec.ts',
  outputDir: './test-results/browser',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${process.env.PORT ?? 4000}`, headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm start', url: `http://127.0.0.1:${process.env.PORT ?? 4000}/health`,
    reuseExistingServer: !process.env.CI, timeout: 20000,
    env: { ...process.env, ESPEMU_PROJECT: process.env.ESPEMU_PROJECT ?? resolve('firmware'), ESPEMU_FLASH: process.env.ESPEMU_FLASH ?? resolve('firmware/build/qemu_flash.bin') },
  },
});

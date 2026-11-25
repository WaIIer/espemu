import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './soak',
  outputDir: './test-results/soak',
  timeout: (Number(process.env.ESPEMU_SOAK_SECONDS ?? 600) + 60) * 1000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${process.env.PORT ?? 4100}`,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ['--enable-precise-memory-info'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start', url: `http://127.0.0.1:${process.env.PORT ?? 4100}/health`,
    reuseExistingServer: false, timeout: 20000,
    env: { ...process.env, ESPEMU_PROJECT: resolve('firmware'), ESPEMU_FLASH: resolve('firmware/build/qemu_flash.bin') },
  },
});

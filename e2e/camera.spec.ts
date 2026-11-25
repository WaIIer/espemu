import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBackendServer } from '../server/http.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { ProjectManifestSchema } from '../shared/manifest.ts';

const root = resolve(import.meta.dirname, '..');
const directory = process.env.CAMERA_PROJECT;
type Capture = { len: number; decoded: number; left: number; right: number };

test('webcam and test-pattern frames reach esp32-camera firmware through emulated I2S DMA', async ({ page }, info) => {
  test.skip(!directory, 'Build tests/fixtures/camera with tools/setup-project.sh and select it with CAMERA_PROJECT');
  const project = directory!;
  const manifest = ProjectManifestSchema.parse(JSON.parse(readFileSync(resolve(project, 'espemu.json'), 'utf8')));
  const runtime = new ProjectRuntime(root, manifest, (callbacks, wiring) => new QemuProcess(root, callbacks, {
    ...process.env, ESPEMU_PROJECT: project, ESPEMU_FLASH: resolve(project, 'build/qemu_flash.bin'),
  }, wiring), project);
  const app = createBackendServer(runtime, root);
  try {
    await new Promise<void>((done, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', done); });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback address');
    await runtime.start();
    // Firmware decodes every captured JPEG and prints the mean brightness of each half.
    const captures = (): Capture[] => runtime.snapshot().console.flatMap(line => {
      const match = /CAMERA 160x120 len=(\d+) decoded=(\d) left=(\d+) right=(\d+)/.exec(line);
      return match ? [{ len: Number(match[1]), decoded: Number(match[2]), left: Number(match[3]), right: Number(match[4]) }] : [];
    });

    await page.goto(`http://127.0.0.1:${address.port}/`);
    const panel = page.getByRole('region', { name: 'camera camera' });
    await expect(panel.locator('[data-camera="sensor"]')).toHaveText('JPEG 160x120', { timeout: 30000 });
    await expect(panel.locator('[data-camera="status"]')).toHaveText('no-source');

    await panel.getByLabel('camera image source').selectOption('pattern');
    await expect(panel.getByLabel('camera frame sent to the sensor')).toBeVisible();
    // Bars run bright (white, yellow, cyan, green) to dark (magenta, red, blue, black) from left to right.
    // Mean per-channel brightness: about 170 on the bright half and 85 on the dark half after JPEG.
    await expect.poll(() => captures().filter(capture => capture.decoded && capture.left > capture.right + 50).length, { timeout: 30000 }).toBeGreaterThanOrEqual(3);
    expect(Math.max(...captures().map(capture => capture.len))).toBeLessThanOrEqual(160 * 120 / 8);
    await expect(panel.locator('[data-camera="delivered"]')).not.toHaveText('0');
    await expect(panel.locator('[data-camera="dma"]')).toContainText(/\d+ bytes, \d+ EOF/);
    await expect(panel.locator('[data-camera="dma"]')).not.toContainText('descriptor errors');
    await page.screenshot({ path: info.outputPath('camera-pattern-desktop.png'), fullPage: true });

    const before = captures().length, sequence = runtime.snapshot().camera!.source!.seq;
    await panel.getByLabel('camera image source').selectOption('webcam');
    await expect.poll(() => runtime.snapshot().camera?.source?.seq ?? 0, { timeout: 20000 }).toBeGreaterThan(sequence + 3);
    await expect.poll(() => captures().slice(before).filter(capture => capture.decoded).length, { timeout: 30000 }).toBeGreaterThanOrEqual(3);
    const webcam = captures().slice(before).filter(capture => capture.decoded).at(-1)!;
    expect(Math.abs(webcam.left - webcam.right), 'the webcam picture replaced the bar pattern').toBeLessThan(50);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('camera-webcam-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on mobile').toBe(true);
    const preview = await panel.getByLabel('camera frame sent to the sensor').boundingBox();
    expect(preview!.x + preview!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('camera-webcam-mobile.png'), fullPage: true });

    // Reset pauses the guest; the selected source survives and feeds the restarted firmware after Run.
    const epoch = runtime.snapshot().epoch;
    await page.getByRole('button', { name: 'reset' }).click();
    await expect.poll(() => runtime.snapshot().epoch).toBeGreaterThan(epoch);
    await expect.poll(() => runtime.snapshot().phase).toBe('paused');
    await page.getByRole('button', { name: 'run' }).click();
    await expect(panel.getByLabel('camera image source')).toHaveValue('webcam');
    // Counters restart with the epoch, so delivered frames here come from the rebooted firmware's own DMA.
    await expect.poll(() => runtime.snapshot().camera?.framesDelivered ?? 0, { timeout: 30000 }).toBeGreaterThanOrEqual(2);

    await panel.getByLabel('camera image source').selectOption('off');
    await expect.poll(() => runtime.snapshot().camera?.status, { timeout: 5000 }).toBe('no-source');
    const delivered = runtime.snapshot().camera!.framesDelivered;
    await page.waitForTimeout(1000);
    expect(runtime.snapshot().camera!.framesDelivered, 'Off stops frames reaching firmware').toBeLessThanOrEqual(delivered + 1);
  } finally {
    await Promise.all([app.close(), runtime.close()]);
  }
});

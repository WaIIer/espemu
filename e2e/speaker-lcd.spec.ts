import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBackendServer } from '../server/http.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { ProjectManifestSchema } from '../shared/manifest.ts';

const root = resolve(import.meta.dirname, '..');
const directory = process.env.SPEAKER_LCD_PROJECT;

test('the workbench renders the firmware LCD and plays the I2S speaker through Web Audio', async ({ page }, info) => {
  test.skip(!directory, 'Build tests/fixtures/speaker-lcd with tools/setup-project.sh and select it with SPEAKER_LCD_PROJECT');
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
    // Count audio the page actually schedules on its AudioContext.
    await page.addInitScript(() => {
      const scheduled = { buffers: 0, seconds: 0 };
      Object.assign(window, { scheduledAudio: scheduled });
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) { scheduled.buffers++; scheduled.seconds += this.buffer?.duration ?? 0; return start.apply(this, args); };
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);

    const lcd = page.getByRole('region', { name: 'lcd display' });
    const screen = lcd.getByRole('img');
    await expect(screen).toHaveAttribute('data-lcd-text', /^ESPEmu jukebox \[1\]/, { timeout: 30000 });
    await expect(screen).toHaveAttribute('data-lcd-text', /\nPlaying (440|880) Hz/);
    await expect(lcd.locator('.lcd-glyph')).toHaveCount(1);
    await expect(lcd.locator('.lcd-lit')).toHaveCount(1);
    await expect(lcd.getByRole('status')).toHaveCount(0);

    const speaker = page.getByRole('region', { name: 'speaker speaker' });
    await expect(speaker.locator('[data-speaker="route"]')).toHaveText('I2S1 · playing', { timeout: 20000 });
    await expect(speaker.locator('[data-speaker="format"]')).toHaveText('16000 Hz, 16-bit stereo');
    await expect(speaker.locator('[data-speaker="pitch"]')).toHaveText(/^(440|880) Hz$/, { timeout: 10000 });
    await expect(speaker.locator('[data-speaker="pitch"]')).toHaveText(/^(440|880) Hz$/);
    const pitches = new Set<string>();
    await expect.poll(async () => { pitches.add(await speaker.locator('[data-speaker="pitch"]').innerText()); return pitches.has('440 Hz') && pitches.has('880 Hz'); }, { timeout: 15000, intervals: [100] }).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { scheduledAudio: { buffers: number } }).scheduledAudio.buffers)).toBe(0);

    await speaker.getByRole('button', { name: 'Play sound' }).click();
    await expect(speaker.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (window as unknown as { scheduledAudio: { seconds: number } }).scheduledAudio.seconds), { timeout: 15000 }).toBeGreaterThan(1.5);
    expect(await page.evaluate(() => new AudioContext().sampleRate)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('speaker-lcd-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await lcd.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on mobile').toBe(true);
    await page.screenshot({ path: info.outputPath('speaker-lcd-mobile.png'), fullPage: true });

    await speaker.getByRole('button', { name: 'Mute' }).click();
    const muted = await page.evaluate(() => (window as unknown as { scheduledAudio: { buffers: number } }).scheduledAudio.buffers);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { scheduledAudio: { buffers: number } }).scheduledAudio.buffers) - muted, 'muting stops scheduling').toBeLessThanOrEqual(1);
  } finally {
    await Promise.all([app.close(), runtime.close()]);
  }
});

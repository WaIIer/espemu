import { test, expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';

test('actual firmware and browser stream with bounded memory for ten minutes', async ({ page }, info) => {
  const seconds = Number(process.env.ESPEMU_SOAK_SECONDS ?? 600);
  expect(seconds).toBeGreaterThanOrEqual(10);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'pause', exact: true })).toBeEnabled();
  const matrix = page.getByRole('article', { name: 'Dot matrix peripheral', includeHidden: true });
  await expect(matrix.locator('svg').first()).toHaveAttribute('data-status', 'active');
  await expect(page.locator('.runtime-bitmap')).toBeVisible();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await expect(page.getByRole('article', { name: 'bme280 QEMU state' })).toBeVisible();
  await page.getByRole('combobox', {name:'Scenario channel'}).selectOption('tmp105:temperatureC');
  await page.getByRole('combobox', {name:'Scenario mode'}).selectOption('noise');
  await page.getByRole('spinbutton',{name:'Scenario offset'}).fill('25');
  await page.getByRole('spinbutton',{name:'Scenario amplitude'}).fill('3');
  await page.getByRole('spinbutton',{name:'Scenario seed'}).fill('42');
  await page.getByRole('button', { name: 'Apply scenario', exact: true }).click();
  await expect.poll(async()=> (await (await page.request.get('/api/state')).json()).latest?.channels['tmp105.temperatureC']?.value).not.toBeUndefined();
  await page.getByRole('tab', { name: 'Application', exact: true }).click();
  await page.getByRole('combobox', { name: 'Application chart channel' }).selectOption('tmp105.temperatureC');
  await expect(page.locator('.recharts-line path').first()).toBeVisible();
  const measurements: { elapsed: number; backendRssMb: number; qemuRssMb: number; browserHeapMb: number; frames: number; nodes: number }[] = [];
  const started = Date.now();
  const initial = await (await page.request.get('/api/state')).json();
  let lastProgress = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let matrixLatches = 0;
  while (Date.now() - started < seconds * 1000) {
    const state = await (await page.request.get('/api/state')).json();
    const health = await (await page.request.get('/health')).json();
    expect(health.ready).toBe(true);
    expect(state.phase).toBe('running');
    expect(state.history.length).toBeLessThanOrEqual(600);
    expect(state.events.length).toBeLessThanOrEqual(256);
    expect(state.console.length).toBeLessThanOrEqual(200);
    expect(state.latest.channels['tmp105.temperatureC'].value).not.toBeNull();
    expect(state.latest.channels['bh1750.lux'].value).not.toBeNull();
    expect(state.latest.channels['bme280.temperatureC'].value).not.toBeNull();
    expect(state.metrics.droppedFrames).toBe(0);
    expect(state.max7219.devices).toHaveLength(1);
    expect(state.max7219.devices[0].modules).toHaveLength(2);
    expect(state.max7219.devices[0].latches).toBeGreaterThan(matrixLatches);
    matrixLatches = state.max7219.devices[0].latches;
    expect(await matrix.locator('circle').count()).toBe(128);
    expect(await matrix.locator('circle[data-on="true"]').count()).toBe(16);
    if (measurements.length > 0) {
      expect(state.metrics.samples, 'Firmware must keep emitting between wall-clock probes')
        .toBeGreaterThan(initial.metrics.samples + measurements.at(-1)!.frames);
    }
    minimum = Math.min(minimum, state.latest.channels['tmp105.temperatureC'].value);
    maximum = Math.max(maximum, state.latest.channels['tmp105.temperatureC'].value);
    const browser = await page.evaluate(() => ({
      heap: Reflect.get(performance, 'memory')?.usedJSHeapSize / (1024 * 1024),
      nodes: document.getElementsByTagName('*').length,
      image: document.querySelector<HTMLImageElement>('.runtime-bitmap')?.naturalWidth,
      paths: document.querySelectorAll('.recharts-line path').length,
    }));
    expect(browser.heap).toBeGreaterThan(0);
    expect(browser.heap).toBeLessThan(512);
    expect(browser.nodes).toBeLessThan(6000);
    expect(browser.image).toBe(1000);
    expect(browser.paths).toBeGreaterThan(0);
    expect(health.backendRssMb).toBeLessThan(256);
    expect(state.metrics.qemuRssMb).toBeLessThan(256);
    const measurement = { elapsed: (Date.now() - started) / 1000,
      backendRssMb: health.backendRssMb, qemuRssMb: state.metrics.qemuRssMb,
      browserHeapMb: browser.heap, frames: state.metrics.samples - initial.metrics.samples, nodes: browser.nodes };
    measurements.push(measurement);
    if (measurement.elapsed - lastProgress >= 30) {
      lastProgress = measurement.elapsed;
      console.log('STREAM', JSON.stringify(measurement));
    }
    await delay(1000);
  }
  const final = await (await page.request.get('/api/state')).json();
  const guestSeconds = (final.latest.guestUs - initial.latest.guestUs) / 1000000;
  expect(guestSeconds).toBeGreaterThan(0);
  expect(final.metrics.samples - initial.metrics.samples, JSON.stringify({
    wallSeconds: (Date.now() - started) / 1000,
    virtualSeconds: (final.virtualMs - initial.virtualMs) / 1000,
    guestSeconds,
  })).toBeGreaterThan(seconds * 8);
  expect(final.metrics.samples - initial.metrics.samples).toBeGreaterThan(guestSeconds * 8);
  expect(maximum - minimum).toBeGreaterThan(1);
  expect(errors).toEqual([]);
  if (seconds >= 600) {
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const early = measurements.filter(entry => entry.elapsed >= 180 && entry.elapsed < 300);
    const late = measurements.filter(entry => entry.elapsed >= 480);
    expect(average(late.map(entry => entry.backendRssMb)) - average(early.map(entry => entry.backendRssMb))).toBeLessThan(24);
    expect(average(late.map(entry => entry.qemuRssMb)) - average(early.map(entry => entry.qemuRssMb))).toBeLessThan(12);
    expect(average(late.map(entry => entry.browserHeapMb)) - average(early.map(entry => entry.browserHeapMb))).toBeLessThan(80);
    expect(final.history.length).toBe(600);
  }
  await page.getByRole('tab', { name: 'Circuit', exact: true }).click();
  await expect(matrix).toBeVisible();
  await page.screenshot({ path: info.outputPath('streaming-final.png'), fullPage: true });
  await info.attach('streaming-measurements.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  console.log('STREAM COMPLETE', JSON.stringify({ durationSeconds: (Date.now() - started) / 1000,
    guestSeconds,
    samples: final.metrics.samples - initial.metrics.samples, history: final.history.length,
    events: final.events.length, console: final.console.length, measurements: measurements.at(-1) }));
});

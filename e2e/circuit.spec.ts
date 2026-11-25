import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { circuitConnections, exportKicadNetlist } from '../shared/circuit';
import { DEMO_MANIFEST, EMPTY_MANIFEST, ProjectManifestSchema, type ProjectManifest } from '../shared/manifest';
import { ProjectStateSchema } from '../shared/runtime';

// Wiring is manifest-derived; this suite deliberately needs no QEMU or firmware.
async function openCircuit(page: Page, manifest: ProjectManifest) {
  const state = ProjectStateSchema.parse({
    v: 1, sessionId: '9ec68d49-e72a-4124-a418-e4149817dc39', projectName: 'Circuit preview',
    epoch: 0, phase: 'stopped', virtualMs: 0, wallMs: 0, manifest, inputs: manifest.inputs,
    deviceStates: {}, latest: null, history: [], gpio: null, gpioWallMs: 0,
    gpioInputs: manifest.gpioInputs, gpioError: null, peripherals: [], scenarios: [],
    events: [], console: [], error: null,
    metrics: { samples: 0, droppedFrames: 0, qemuRssMb: 0, latencyP95Ms: null, latencyCount: 0 },
  });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.routeWebSocket('**/ws', socket => socket.send(JSON.stringify({ v: 1, type: 'state', state })));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Circuit wiring', exact: true })).toBeVisible();
}

test('pin-level diagram joins shared buses and probes, traces signals and exports full connectivity', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCircuit(page, DEMO_MANIFEST);
  const viewer = page.getByRole('region', { name: 'Circuit wiring', exact: true });
  await expect(viewer.locator('[data-device-id]')).toHaveCount(DEMO_MANIFEST.devices.length);
  await expect(viewer).toContainText('SDA GPIO21 / SCL GPIO22');
  const nets = circuitConnections(DEMO_MANIFEST).nets;
  for (const net of nets) {
    await expect(viewer.locator(`.circuit-net[data-gpio="${net.gpio}"] > g`)).toHaveCount(net.nodes.length - 1);
  }
  await viewer.getByRole('combobox').selectOption('2');
  await expect(viewer.locator('.circuit-trace')).toContainText('Status LED: SIGNAL');
  await expect(viewer.locator('.circuit-trace')).toContainText('Status probe: PROBE');
  await expect(viewer.locator('.circuit-net:not(.circuit-dim)')).toHaveCount(1);
  await viewer.getByRole('combobox').selectOption('21');
  await expect(viewer.locator('.circuit-trace')).toContainText('tmp105: SDA');
  await expect(viewer.locator('.circuit-trace')).toContainText('mpu6050: SDA');
  await viewer.getByRole('button', { name: 'Reset circuit view' }).click();
  const original = await viewer.locator('.circuit-diagram').getAttribute('width');
  await viewer.getByRole('button', { name: 'Zoom in circuit' }).click();
  expect(Number(await viewer.locator('.circuit-diagram').getAttribute('width'))).toBe(Number(original) * 1.25);
  await viewer.getByRole('button', { name: 'Reset circuit view' }).click();
  const download = page.waitForEvent('download');
  await viewer.getByRole('button', { name: 'KiCad netlist' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('espemu.net');
  expect(await readFile((await file.path())!, 'utf8')).toBe(exportKicadNetlist(DEMO_MANIFEST));
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export circuit', exact: true }).click();
  expect(JSON.parse(await readFile((await (await jsonDownload).path())!, 'utf8')).devices).toEqual(DEMO_MANIFEST.devices);
  await viewer.getByRole('button', { name: 'Status LED', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Inspect', exact: true })).toHaveValue('status_led');
  await expect(viewer.locator('[data-device-id]:not(.circuit-dim)')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Inspect', exact: true }).selectOption('');
  await viewer.getByRole('button', { name: 'Reset circuit view' }).click();
  expect(await viewer.locator('.circuit-scroll').evaluate(element => [element.scrollTop, element.scrollLeft])).toEqual([0, 0]);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await viewer.screenshot({ path: info.outputPath(`wiring-${viewport.width}.png`) });
    await viewer.locator('.circuit-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await viewer.locator('[data-device-id="tmp105"] button').scrollIntoViewIfNeeded();
    await expect(viewer.locator('[data-device-id="tmp105"] button')).toBeInViewport();
    await viewer.screenshot({ path: info.outputPath(`wiring-devices-${viewport.width}.png`) });
    await viewer.locator('.circuit-scroll').evaluate(element => { element.scrollLeft = 0; });
  }
  await page.getByRole('button', { name: 'Theme settings' }).click();
  await page.getByRole('button', { name: 'dark theme', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await viewer.screenshot({ path: info.outputPath('wiring-dark.png') });
  expect(errors).toEqual([]);
});

test('camera routing connects terminals above controller pins and long identities stay readable', async ({ page }, info) => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [
    { type: 'ov2640', id: `camera_${'x'.repeat(43)}`, label: `Camera ${'long'.repeat(8)}!` },
  ] });
  await openCircuit(page, manifest);
  const viewer = page.getByRole('region', { name: 'Circuit wiring', exact: true });
  const net = viewer.locator('.circuit-net[data-gpio="39"]');
  const trunk = await net.locator('> path').getAttribute('d');
  const branch = await net.locator('> g path').getAttribute('d');
  const branchY = Number(branch!.match(/M\d+ (\d+)/)![1]);
  const [, start, end] = trunk!.match(/M\d+ (\d+) V(\d+)$/)!;
  expect(Number(start)).toBeLessThanOrEqual(branchY);
  expect(Number(end)).toBeGreaterThanOrEqual(branchY);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await viewer.locator('.circuit-card-heading').evaluate(element => element.scrollHeight <= element.parentElement!.clientHeight)).toBe(true);
    await viewer.locator('.circuit-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await viewer.screenshot({ path: info.outputPath(`camera-wiring-${viewport.width}.png`) });
  }
});

test('empty circuit has no fabricated devices or wires', async ({ page }) => {
  await openCircuit(page, EMPTY_MANIFEST);
  const viewer = page.getByRole('region', { name: 'Circuit wiring', exact: true });
  await expect(viewer).toContainText('No devices declared.');
  await expect(viewer.locator('.circuit-net')).toHaveCount(0);
  await expect(viewer.locator('[data-device-id]')).toHaveCount(0);
});

test('maximum-length sensor label, identity and bus name fit together', async ({ page }, info) => {
  const bus = 'B'.repeat(50);
  const manifest = ProjectManifestSchema.parse({
    v: 1, target: 'esp32',
    buses: [{ id: bus, type: 'i2c', controller: 0, sda: 21, scl: 22 }],
    devices: [{ type: 'tmp105', id: 'W'.repeat(50), label: 'W'.repeat(40), bus, address: 72 }],
  });
  await openCircuit(page, manifest);
  const viewer = page.getByRole('region', { name: 'Circuit wiring', exact: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await viewer.locator('.circuit-card-heading').evaluate(element => element.scrollHeight <= element.parentElement!.clientHeight)).toBe(true);
    await viewer.locator('.circuit-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await viewer.screenshot({ path: info.outputPath(`long-sensor-${viewport.width}.png`) });
  }
});

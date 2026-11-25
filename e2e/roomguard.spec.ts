import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBackendServer } from '../server/http.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { ProjectManifestSchema } from '../shared/manifest.ts';
import { connectProject } from '../tools/project-regression.ts';

const root = resolve(import.meta.dirname, '..');
const directory = process.env.ROOMGUARD_PROJECT;

test('Roomguard workbench commits once, shows live comparisons, and reconnects across lifetimes', async ({ page, browser }, info) => {
  test.skip(!directory, 'Build the Roomguard project and select it with ROOMGUARD_PROJECT');
  const project = directory!;
  const declared = ProjectManifestSchema.parse(JSON.parse(readFileSync(resolve(project, 'espemu.json'), 'utf8')));
  const probe = { type: 'probe', id: 'alarm_output_service_entrance_verification_probe', label: 'Service entrance alarm verification GPIO', pin: 4 };
  const manifest = ProjectManifestSchema.parse({ ...declared, devices: [...declared.devices, probe] });
  let runtime: ProjectRuntime | undefined;
  let app: ReturnType<typeof createBackendServer> | undefined;
  let observer: Awaited<ReturnType<typeof connectProject>> | undefined;
  let port = 0;
  async function start() {
    runtime = new ProjectRuntime(root, manifest, (callbacks, wiring) => new QemuProcess(root, callbacks, {
      ...process.env, ESPEMU_PROJECT: project, ESPEMU_FLASH: resolve(project, 'build/qemu_flash.bin'),
    }, wiring), project);
    const owned = app = createBackendServer(runtime, root);
    await new Promise<void>((done, reject) => {
      owned.server.once('error', reject);
      owned.server.listen(port, '127.0.0.1', done);
    });
    const address = owned.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback address');
    port = address.port;
    await runtime.start();
    return `http://127.0.0.1:${port}`;
  }
  async function stop() {
    observer?.close(); observer = undefined;
    await Promise.all([app?.close(), runtime?.close()]); app = undefined; runtime = undefined;
  }
  const second = await browser.newPage();
  const errors: string[] = [], commits: number[] = [];
  for (const tab of [page, second]) {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error' && !message.text().includes('WebSocket connection')) errors.push(message.text()); });
  }
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const command = JSON.parse(String(payload));
    if (command.action === 'input' && command.channel === 'temperatureC') commits.push(command.value);
  }));
  try {
    const base = await start();
    observer = await connectProject(base);
    const before = observer.state.sessionId;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await second.goto(base);
    await expect(page.getByText('Roomguard / esp32')).toBeVisible();
    for (const name of ['alarm', 'night', 'sensor_fault']) await expect(page.getByRole('article', { name: `${name} peripheral` })).toBeVisible();
    await page.getByLabel('Find device').fill('service entrance');
    const longLabel = page.getByRole('article', { name: `${probe.label} peripheral` });
    await expect(longLabel).toContainText(probe.id);
    await expect(page.getByRole('article', { name: 'night peripheral' })).toHaveCount(0);
    await page.getByLabel('Find device').clear();
    await page.getByRole('tab', { name: 'Inputs' }).click();
    const temperature = page.getByRole('spinbutton', { name: 'climate temperatureC input' });
    const model = page.getByRole('article', { name: 'climate QEMU state' }).locator('[data-channel="temperatureC"]');
    const dock = page.getByRole('complementary', { name: 'Console dock' });
    const serial = dock.getByRole('log', { name: 'UART output' });
    const timeline = dock.getByRole('log', { name: 'Runtime events' });
    await expect(page.getByRole('combobox', { name: 'Console dock' })).toHaveValue('both');
    const editorBox = (await temperature.boundingBox())!;
    const dockBox = (await dock.boundingBox())!;
    expect(dockBox.x).toBeGreaterThan(editorBox.x + editorBox.width);
    expect(dockBox.y).toBeLessThan(editorBox.y + editorBox.height);
    for (const viewport of [serial, timeline]) {
      await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(8);
      await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    }
    for (const [viewport, follow] of [[serial, dock.getByLabel('Follow', { exact: true })], [timeline, dock.getByLabel('Follow latest')]]) {
      await follow.uncheck();
      await viewport.evaluate(element => { element.scrollTop = 0; });
      await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
      if (viewport === timeline) {
        await observer.send({ action: 'input', deviceId: 'climate', channel: 'temperatureC', value: 23 });
        await expect(timeline.getByText('input', { exact: true }).first()).toBeAttached();
        await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
      }
      await follow.check();
      await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    }
    await page.getByRole('tab', { name: 'Serial' }).click();
    await expect(page.getByRole('log', { name: 'UART output' })).toHaveCount(1);
    await expect(timeline).toBeVisible();
    await page.getByRole('tab', { name: 'Inputs' }).click();
    await expect(temperature).toHaveValue('23');
    const pinSignal = page.getByLabel('Pin a signal');
    await pinSignal.selectOption('gpio:alarm:4');
    await expect(pinSignal.locator('option', { hasText: 'alarm_decision' })).toHaveCount(1);
    await pinSignal.selectOption('app:alarm_decision');
    await pinSignal.selectOption('gpio:night:16');
    const pinnedAlarm = page.locator('[data-pinned="gpio:alarm:4"] output'), pinnedDecision = page.locator('[data-pinned="app:alarm_decision"] output');
    await temperature.fill('31');
    await temperature.press('Enter');
    await expect(temperature).toHaveValue('31');
    await expect(model).toHaveText(/^31\./);
    await expect(pinnedAlarm).toHaveText('HIGH · Output');
    await expect(pinnedDecision).toHaveText('1');
    await expect(page.locator('[data-pinned]')).toHaveCount(3);
    await expect(second.getByRole('img', { name: 'alarm on', exact: true })).toBeVisible();
    await temperature.fill('-12');
    await temperature.press('Escape');
    await expect(temperature).toHaveValue('31');
    await temperature.fill('500');
    await temperature.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a value from' })).toBeVisible();
    await expect(temperature).toHaveValue('31');
    expect(commits).toEqual([31]);

    for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (viewport.width < 400) {
        const observations = await page.getByRole('region', { name: 'Pinned observations' }).boundingBox();
        const editor = await temperature.boundingBox();
        expect(observations!.y + observations!.height).toBeLessThan(editor!.y);
        expect(editor!.y + editor!.height).toBeLessThan(viewport.height);
        expect((await dock.boundingBox())!.y).toBeGreaterThan(editor!.y + editor!.height);
      }
      await page.screenshot({ path: info.outputPath(`experiment-${viewport.width}.png`), fullPage: true });
      await page.getByRole('tab', { name: 'Circuit' }).click();
      await expect(longLabel).toContainText(probe.id);
      expect(await longLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`circuit-${viewport.width}.png`), fullPage: true });
      await page.getByRole('tab', { name: 'Inputs' }).click();
    }
    await page.getByRole('tab', { name: 'Circuit' }).click();
    await page.getByRole('button', { name: 'Press acknowledge' }).click();
    await observer.waitFor(state => state.latest?.channels.acknowledgements.value === 1 && state.gpio?.pins.some(pin => pin.pin === 4 && pin.outputEnabled && pin.level === 0) === true);
    await second.getByRole('button', { name: 'Press acknowledge' }).hover();
    await second.mouse.down();
    await observer.waitFor(state => state.gpio?.pins.some(pin => pin.pin === 27 && pin.externallyDriven && pin.level === 0) === true);
    await second.close();
    await observer.waitFor(state => state.gpio?.pins.some(pin => pin.pin === 27 && !pin.externallyDriven && pin.level === 1) === true);
    await page.getByRole('tab', { name: 'Inputs' }).click();
    await expect(pinnedAlarm).toHaveText('LOW · Output');
    await page.reload();
    await page.getByRole('tab', { name: 'Inputs' }).click();
    await expect(page.locator('[data-pinned]')).toHaveCount(3, { timeout: 10000 });
    await page.getByRole('button', { name: /^Unpin .*GPIO16$/ }).click();
    await expect(page.locator('[data-pinned]')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Application' }).click();
    await expect(page.locator('.runtime-chart .recharts-line-curve')).toBeVisible();
    await page.getByRole('tab', { name: 'Inputs' }).click();

    await page.getByRole('button', { name: 'stop', exact: true }).click();
    await expect(page.locator('.phase')).toHaveText('stopped');
    await temperature.fill('-5');
    await page.getByRole('heading', { name: 'Physical Inputs' }).click();
    await expect(temperature).toHaveValue('-5');
    await expect(page.locator('.header-session')).toContainText('Staged');
    await page.getByRole('button', { name: 'run', exact: true }).click();
    await expect(model).toHaveText(/^-5\./);
    await page.getByRole('button', { name: 'reset', exact: true }).click();
    await expect(page.locator('.phase')).toHaveText('paused');
    expect(observer.state.epoch).toBeGreaterThan(0);
    await temperature.fill('35');
    await stop();
    await expect(page.locator('.header-session')).toContainText('Stale');
    await expect(temperature).toBeDisabled();
    await start();
    observer = await connectProject(base);
    expect(observer.state.sessionId).not.toBe(before);
    await expect(page.locator('.header-session')).toContainText('Epoch 0');
    await expect(temperature).toHaveValue('23');
    await expect(model).toHaveText(/^23\./);
    await page.getByRole('button', { name: 'pause', exact: true }).click();
    await expect(page.locator('.phase')).toHaveText('paused');
    expect(commits).toEqual([31, -5]);
    const playback = { deviceId: 'climate', channel: 'temperatureC', kind: 'playback' as const, offset: 0, amplitude: 0, seed: 0, periodMs: 6000,
      frames: [{ timeMs: 0, value: 26 }, { timeMs: 6000, value: 34 }] };
    await observer.send({ action: 'scenario-start', scenario: playback });
    await expect(page.getByLabel('Scenario mode')).toHaveValue('playback');
    await expect(page.getByLabel('Frame 1 value')).toHaveValue('26');
    await page.getByLabel('Frame 1 value').fill('27');
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(temperature).toHaveValue('27');
    await page.getByRole('button', { name: 'Stop scenario', exact: true }).click();
    await expect(page.getByLabel('Scenario status')).toContainText('Stopped');
    await expect(temperature).toHaveValue('27');
    expect(errors).toEqual([]);
  } finally {
    await second.close();
    await stop();
  }
});
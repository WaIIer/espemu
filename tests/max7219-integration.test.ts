import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { loadProject } from '../server/project.ts';

test('ordinary GPIO firmware drives MAX7219 matrices, mode changes, pause/reset and topology reload without telemetry', { timeout: 30000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const project = loadProject(root, { ESPEMU_PROJECT: resolve(root, 'tests/fixtures/max7219') }).manifest;
  const runtime = new ProjectRuntime(root, project, (callbacks, manifest) => new QemuProcess(root, callbacks,
    { ...process.env, ESPEMU_FLASH: resolve(root, '.cache/max7219/qemu_flash.bin') }, manifest));
  const deadline = Date.now() + 25000;
  async function until(predicate: () => boolean) {
    while (!predicate()) {
      assert.notEqual(runtime.snapshot().phase, 'error', runtime.snapshot().error ?? '');
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.snapshot().console.slice(-10)));
      await delay(20);
    }
  }
  async function command(action: 'pause' | 'run' | 'reset') {
    const ack = await runtime.command({ v: 1, id: action, epoch: runtime.snapshot().epoch, action });
    assert.equal(ack.ok, true, ack.error);
  }
  try {
    await runtime.start();
    await until(() => runtime.snapshot().console.some(line => line.includes('MAX7219 ready')) &&
      runtime.snapshot().max7219?.devices[0].modules[0].rows[0] === 0x81 &&
      runtime.snapshot().max7219?.devices[1].modules[1].digits[7] === 255);
    const state = runtime.snapshot();
    assert.equal(state.latest, null);
    assert.deepEqual(state.max7219!.devices[1].modules[1].digits, [255, 129, 189, 165, 165, 189, 129, 255]);
    await until(() => runtime.snapshot().max7219!.devices[1].modules[1].displayTest);
    assert.deepEqual(runtime.snapshot().max7219!.devices[1].modules[1].rows, Array(8).fill(255));
    await command('pause');
    const frozen = runtime.snapshot().max7219;
    await delay(250);
    assert.deepEqual(runtime.snapshot().max7219, frozen);
    await command('run');
    await until(() => !runtime.snapshot().max7219!.devices[1].modules[1].displayTest && runtime.snapshot().max7219!.devices[1].modules[1].shutdown);
    assert.deepEqual(runtime.snapshot().max7219!.devices[1].modules[1].rows, Array(8).fill(0));
    await command('reset');
    assert.equal(runtime.snapshot().epoch, 1);
    assert.ok(runtime.snapshot().max7219!.devices.every(device => device.modules.every(module => module.shutdown)));
    await command('run');
    await until(() => runtime.snapshot().max7219?.devices[0].modules[0].rows[0] === 0x81);
    const next = runtime.exportFile();
    next.devices = next.devices.filter(device => device.id === 'single');
    const ack = await runtime.importFile({ v: 1, id: 'reload', epoch: 1, file: next });
    assert.equal(ack.ok, true, ack.error);
    assert.equal(runtime.snapshot().epoch, 2);
    await until(() => runtime.snapshot().max7219?.devices.length === 1 && runtime.snapshot().max7219?.devices[0].modules[0].rows[0] === 0x81);
    assert.deepEqual(runtime.exportFile().devices, next.devices);
  } finally { await runtime.close(); }
});

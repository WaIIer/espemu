import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Backend } from '../server/backend.ts';
import { QemuProcess } from '../server/qemu.ts';

test('actual framework GPIO: firmware blink, external button read, interrupt, pause and reset without telemetry', { timeout: 20000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const backend = new Backend(root, callbacks => new QemuProcess(root, callbacks, { ...process.env, ESPEMU_FLASH: resolve(root, '.cache/gpio-firmware/qemu_flash.bin') }));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, JSON.stringify({ error: backend.snapshot().error, gpioError: backend.snapshot().gpioError, console: backend.snapshot().console.slice(-8) }));
      await delay(20);
    }
  };
  const pin = (number: number) => backend.snapshot().gpio?.pins.find(entry => entry.pin === number);
  try {
    await backend.start();
    await until(() => pin(2)?.outputEnabled === true);
    assert.equal(backend.health().ready, true);
    assert.equal(backend.snapshot().latest, null, 'GPIO support must not require custom telemetry');
    const initial = pin(2)!.level;
    await until(() => pin(2)!.level !== initial);
    assert.equal(pin(27)!.level, 1);
    const pressed = await backend.command({ v: 1, id: 'press', epoch: 0, action: 'gpio-inputs', pins: [{ pin: 27, level: 0 }] });
    assert.equal(pressed.ok, true, pressed.error);
    await until(() => pin(4)?.level === 1);
    await until(() => backend.snapshot().console.some(line => /interrupts=[1-9][0-9]* button=0/.test(line)));
    assert.equal((await backend.command({ v: 1, id: 'release', epoch: 0, action: 'gpio-inputs', pins: [] })).ok, true);
    await until(() => pin(4)?.level === 0);
    assert.equal((await backend.command({ v: 1, id: 'pause', epoch: 0, action: 'pause' })).ok, true);
    await backend.poll();
    const frozen = backend.snapshot().gpio;
    await delay(250);
    await backend.poll();
    assert.deepEqual(backend.snapshot().gpio, frozen);
    assert.equal((await backend.command({ v: 1, id: 'reset', epoch: 0, action: 'reset' })).ok, true);
    assert.equal(backend.snapshot().epoch, 1);
    assert.equal(pin(2)?.outputEnabled, false);
    assert.equal((await backend.command({ v: 1, id: 'stale', epoch: 0, action: 'gpio-inputs', pins: [] })).ok, false);
    assert.equal((await backend.command({ v: 1, id: 'run', epoch: 1, action: 'run' })).ok, true);
    await until(() => pin(2)?.outputEnabled === true);
  } finally { await backend.close(); }
});

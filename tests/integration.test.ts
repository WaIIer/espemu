import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { Backend } from '../server/backend.ts';
import { DEFAULT_INPUTS, type InputSnapshot } from '../shared/protocol.ts';

async function until(predicate: () => boolean, message: () => unknown): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    const evidence = message() as ReturnType<Backend['snapshot']>;
    assert.ok(Date.now() < deadline, JSON.stringify({ phase: evidence.phase, error: evidence.error,
      epoch: evidence.epoch, inputs: evidence.inputs, latest: evidence.latest,
      metrics: evidence.metrics, console: evidence.console?.slice(-5) }));
    await delay(10);
  }
}

test('actual QEMU: backend controls change firmware readings, scenarios freeze, and epochs reset', { timeout: 30000 }, async () => {
  const backend = new Backend(resolve(import.meta.dirname, '..'));
  try {
    await backend.start();
    await until(() => backend.health().ready === true, () => backend.snapshot());
    assert.equal(backend.snapshot().phase, 'running');
    const inputs: InputSnapshot = structuredClone(DEFAULT_INPUTS);
    inputs.tmp105.temperatureC = 28;
    inputs.bh1750.lux = 800;
    inputs.bme280 = { temperatureC: 33, pressurePa: 104000, humidityPct: 60, connected: true, invalid: false };
    const ack = await backend.command({ v: 1, id: 'physical-input', epoch: 0, action: 'inputs', inputs });
    assert.equal(ack.ok, true, ack.error);
    await until(() => {
      const latest = backend.snapshot().latest;
      return latest?.tmp105?.temperatureC === 28 && latest.bh1750?.lux === 800 &&
        latest.bme280?.error === 0 && Math.abs(latest.bme280.temperatureC! - 33) < 0.02 &&
        Math.abs(latest.bme280.pressurePa! - 104000) < 2 && Math.abs(latest.bme280.humidityPct! - 60) < 0.05;
    }, () => backend.snapshot());
    await until(() => backend.snapshot().metrics.latencyCount > 0, () => backend.snapshot());
    assert.ok(backend.snapshot().metrics.latencyP95Ms! < 250, 'Host-to-firmware latency must remain below 250ms');
    console.log('Actual backend input latency:', backend.snapshot().metrics.latencyP95Ms!.toFixed(2), 'ms');
    await until(() => backend.snapshot().events.some(event => event.source === 'i2c' && event.message.includes('0x76')), () => backend.snapshot());
    const scenarioAck = await backend.command({
      v: 1, id: 'scenario', epoch: 0, action: 'scenario',
      scenario: { deviceId: 'tmp105', channel: 'temperatureC', kind: 'sine', offset: 30, amplitude: 4, periodMs: 1000, seed: 42, frames: [] },
    });
    assert.equal(scenarioAck.ok, true, scenarioAck.error);
    await until(() => backend.snapshot().inputs.tmp105.temperatureC !== 28, () => backend.snapshot());
    assert.equal((await backend.command({ v: 1, id: 'pause', epoch: 0, action: 'pause' })).ok, true);
    const paused = backend.snapshot();
    await delay(250);
    assert.equal(backend.snapshot().virtualMs, paused.virtualMs);
    assert.deepEqual(backend.snapshot().inputs, paused.inputs);
    const file = backend.exportFile();
    assert.equal(file.v, 1);
    assert.equal(file.scenarios[0].kind, 'sine');
    const reset = await backend.command({ v: 1, id: 'reset', epoch: 0, action: 'reset' });
    assert.equal(reset.ok, true, reset.error);
    assert.equal(reset.epoch, 1);
    assert.equal(backend.snapshot().latest, null);
    assert.equal(backend.snapshot().phase, 'paused');
    const stale = await backend.command({ v: 1, id: 'stale', epoch: 0, action: 'inputs', inputs });
    assert.equal(stale.ok, false);
    assert.equal((await backend.command({ v: 1, id: 'run', epoch: 1, action: 'run' })).ok, true);
    await until(() => backend.health().ready === true && backend.snapshot().latest?.epoch === 1, () => backend.snapshot());
    assert.equal((await backend.command({ v: 1, id: 'stop', epoch: 1, action: 'stop' })).ok, true);
    assert.equal(backend.snapshot().phase, 'stopped');
    assert.equal(backend.snapshot().metrics.qemuRssMb, 0);
    const restarted = await backend.command({ v: 1, id: 'restart', epoch: 1, action: 'run' });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(restarted.epoch, 2);
    await until(() => backend.health().ready === true, () => backend.snapshot());
  } finally {
    await backend.close();
  }
});

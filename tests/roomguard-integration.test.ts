import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectManifestSchema } from '../shared/manifest.ts';
import type { ProjectState } from '../shared/runtime.ts';
import { createBackendServer } from '../server/http.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { connectProject } from '../tools/project-regression.ts';

const root = resolve(import.meta.dirname, '..');
const directory = process.env.ROOMGUARD_PROJECT;
const replayUptime = Number(process.env.ROOMGUARD_REPLAY_UPTIME_MS ?? 8000);
const value = (state: ProjectState, channel: string) => state.latest?.channels[channel]?.value;
const near = (state: ProjectState, channel: string, expected: number, precision = 0.1) => {
  const observed = value(state, channel);
  return typeof observed === 'number' && Math.abs(observed - expected) <= precision;
};
const pin = (state: ProjectState, gpio: number, level: 0 | 1) =>
  state.gpio?.pins.some(observed => observed.pin === gpio && observed.outputEnabled && observed.level === level) ?? false;

test('Roomguard drives real GPIO from sensor data and tolerates faults across lifecycle changes', { skip: !directory, timeout: replayUptime + 95000 }, async () => {
  assert.ok(directory);
  const manifest = ProjectManifestSchema.parse(JSON.parse(readFileSync(resolve(directory, 'espemu.json'), 'utf8')));
  const outside = manifest.devices.some(device => device.id === 'outside');
  const runtime = new ProjectRuntime(root, manifest, (callbacks, project) => new QemuProcess(root, callbacks, {
    ...process.env, ESPEMU_PROJECT: directory, ESPEMU_FLASH: resolve(directory, 'build/qemu_flash.bin'),
  }, project), directory);
  const app = createBackendServer(runtime, root);
  let client: Awaited<ReturnType<typeof connectProject>> | undefined;
  try {
    await new Promise<void>(done => app.server.listen(0, '127.0.0.1', done));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    await runtime.start();
    const control = client = await connectProject(base);
    const stimulus = (deviceId: string, fields: Record<string, number | boolean>) => control.send({ action: 'input-fields', deviceId, fields });
    const observed = async (description: string, predicate: (state: ProjectState) => boolean) => {
      try { return await control.waitFor(predicate); }
      catch (error) {
        const { latest, inputs, phase, error: runtimeError, events, console } = control.state;
        throw new Error(`${description}: ${JSON.stringify({ latest, inputs, phase, runtimeError, events: events.slice(-5), console: console.slice(-3) })}`, { cause: error });
      }
    };
    await observed('healthy boot', state => near(state, 'climate', 23) && pin(state, 4, 0) && pin(state, 17, 0));
    await stimulus('climate', { temperatureC: 31 });
    await observed('temperature alarm', state => near(state, 'climate', 31) && value(state, 'alarm_decision') === 1 && pin(state, 4, 1));
    await stimulus('climate', { temperatureC: 29 });
    await observed('temperature hysteresis', state => near(state, 'climate', 29) && pin(state, 4, 1));
    await control.send({ action: 'gpio-inputs', pins: [{ pin: 27, level: 0 }] });
    await control.send({ action: 'gpio-inputs', pins: [{ pin: 27, level: null }] });
    await observed('GPIO interrupt acknowledgement', state => value(state, 'acknowledgements') === 1 && pin(state, 4, 0));
    await stimulus('climate', { temperatureC: 25 });
    await observed('safe climate rearms', state => near(state, 'climate', 25));
    await stimulus('climate', { humidityPct: 72 });
    await observed('humidity alarm', state => pin(state, 4, 1));
    await stimulus('climate', { humidityPct: 67 });
    await observed('humidity hysteresis', state => state.inputs.climate.humidityPct === 67 && pin(state, 4, 1));
    await stimulus('climate', { humidityPct: 60, temperatureC: -5 });
    await observed('negative climate is valid and clears alarm', state => near(state, 'climate', -5) && pin(state, 4, 0));
    await assert.rejects(stimulus('climate', { temperatureC: 500 }));
    assert.equal(control.state.inputs.climate.temperatureC, -5);

    for (const [lux, level] of [[40, 1], [60, 1], [100, 0]] as const) {
      await stimulus('light', { lux });
      await observed(`night output at ${lux} lx`, state => near(state, 'light', lux, 1.5) && pin(state, 16, level));
    }
    await stimulus('climate', { connected: false });
    await observed('actual BME280 I2C failure', state => value(state, 'climate') === null && pin(state, 17, 1) &&
      state.events.some(event => event.source === 'i2c' && /^0x76.*nack/i.test(event.message)));
    await stimulus('climate', { connected: true, invalid: true });
    await observed('invalid BME280 reading', state => state.inputs.climate.invalid === true && value(state, 'climate') === null && pin(state, 17, 1));
    await stimulus('climate', { invalid: false });
    await observed('BME280 recovery', state => near(state, 'climate', -5) && pin(state, 17, 0));

    if (outside) {
      await stimulus('outside', { temperatureC: -12.5 });
      await observed('independent negative TMP105', state => near(state, 'outside', -12.5) && near(state, 'climate', -5));
      await stimulus('outside', { connected: false });
      await observed('actual TMP105 I2C failure', state => value(state, 'outside') === null && near(state, 'climate', -5) && pin(state, 17, 1) &&
        state.events.some(event => event.source === 'i2c' && /^0x48.*nack/i.test(event.message)));
      await stimulus('outside', { connected: true });
      await observed('TMP105 recovery', state => near(state, 'outside', -12.5) && pin(state, 17, 0));
    }

    await control.send({ action: 'pause' });
    const paused = await observed('paused', state => state.phase === 'paused');
    await delay(250);
    assert.equal(control.state.virtualMs, paused.virtualMs);
    assert.equal((await fetch(`${base}/live`)).ok, true);
    assert.equal((await fetch(`${base}/health`)).ok, false);
    await control.send({ action: 'reset' });
    await observed('reset retains environment in paused next epoch', state => state.phase === 'paused' && state.epoch > paused.epoch && state.inputs.climate.temperatureC === -5);
    await control.send({ action: 'run' });
    await observed('reset environment reaches firmware', state => near(state, 'climate', -5));
    await control.send({ action: 'stop' });
    await observed('stopped', state => state.phase === 'stopped');
    await stimulus('climate', { temperatureC: 33, connected: false });
    await observed('stopped inputs staged', state => state.phase === 'stopped' && state.inputs.climate.temperatureC === 33);
    await control.send({ action: 'run' });
    await observed('sensor absent at boot fails safe', state => value(state, 'climate') === null && pin(state, 17, 1) && pin(state, 4, 0));
    await stimulus('climate', { connected: true });
    await observed('stop/run preserved staged temperature', state => near(state, 'climate', 33) && pin(state, 4, 1));
    const finalEpoch = control.state.epoch;
    await control.send({ action: 'restore-environment' });
    await observed('restore declared default without epoch reset', state => state.epoch === finalEpoch && near(state, 'climate', 23) && pin(state, 4, 0) && pin(state, 17, 0));
    await control.waitFor(state => state.virtualMs >= replayUptime, replayUptime + 20000);
    const key = 'climate:temperatureC';
    const scenario = { deviceId: 'climate', channel: 'temperatureC', kind: 'playback' as const, offset: 0, amplitude: 0, seed: 0, periodMs: 6000,
      frames: [{ timeMs: 0, value: 24 }, { timeMs: 1700, value: 34 }, { timeMs: 3700, value: 34 }, { timeMs: 6000, value: 26 }] };
    const beforeReplay = control.state.latest!.seq;
    await control.send({ action: 'scenario-start', scenario });
    await observed('explicit replay begins near frame zero at mature uptime', state => {
      const run = state.scenarioRuns?.[key], temperature = state.inputs.climate.temperatureC;
      return !!run && run.originMs >= replayUptime && run.status === 'active' && typeof temperature === 'number' && temperature >= 24 && temperature < 25;
    });
    await observed('replay activates the real alarm', state => pin(state, 4, 1) && value(state, 'alarm_decision') === 1);
    await control.send({ action: 'pause' });
    const frozen = await observed('playback paused', state => state.phase === 'paused');
    await delay(250);
    assert.equal(control.state.virtualMs, frozen.virtualMs);
    assert.equal(control.state.inputs.climate.temperatureC, frozen.inputs.climate.temperatureC);
    await control.send({ action: 'run' });
    const finished = await observed('final playback frame clears alarm without resetting firmware', state => state.scenarioRuns?.[key]?.status === 'completed' &&
      near(state, 'climate', 26) && pin(state, 4, 0) && state.epoch === finalEpoch && (state.latest?.seq ?? 0) > beforeReplay);
    await control.send({ action: 'scenario-start', scenario });
    await observed('replay starts from a new origin', state => (state.scenarioRuns?.[key]?.originMs ?? -1) > finished.scenarioRuns![key].originMs);
    await stimulus('climate', { temperatureC: 19 });
    await observed('manual override retains scenario for portable export', state => state.scenarioRuns?.[key]?.status === 'overridden' && near(state, 'climate', 19));
    const exported = ProjectManifestSchema.parse(await (await fetch(`${base}/api/export`)).json());
    assert.deepEqual(exported.scenarios, [scenario]);
    await control.send({ action: 'scenario-stop', deviceId: 'climate', channel: 'temperatureC' });
    await observed('stopping a scenario retains the current stimulus', state => state.scenarioRuns?.[key]?.status === 'stopped' && state.inputs.climate.temperatureC === 19);

    const bootTrace = { ...scenario, frames: [{ timeMs: 0, value: 24 }, { timeMs: 3500, value: 24 }, { timeMs: 4500, value: 34 }, { timeMs: 8000, value: 34 }] };
    const firstValidClimate = (state: ProjectState) => state.history.find(sample => sample.channels.climate?.value != null);
    const assertBootFrame = async (description: string, epoch: number) => {
      const boot = await observed(description, state => state.epoch === epoch && !!firstValidClimate(state));
      const sample = firstValidClimate(boot)!;
      assert.ok(Math.abs(sample.channels.climate.value! - 24) < 0.1, JSON.stringify(sample));
      assert.equal(sample.channels.alarm_decision.value, 0);
    };
    await control.send({ action: 'scenario-start', scenario: bootTrace });
    await observed('alarm active before reset', state => pin(state, 4, 1));
    await control.send({ action: 'reset' });
    await observed('active trace applies frame zero before reset resume', state => state.phase === 'paused' && state.inputs.climate.temperatureC === 24);
    await control.send({ action: 'run' });
    await assertBootFrame('first valid firmware sample after reset', finalEpoch + 1);
    await observed('alarm active before stop', state => pin(state, 4, 1));
    await control.send({ action: 'stop' });
    await control.send({ action: 'run' });
    await assertBootFrame('first valid firmware sample after stop and run', finalEpoch + 2);
  } finally {
    client?.close();
    await Promise.all([app.close(), runtime.close()]);
  }
});
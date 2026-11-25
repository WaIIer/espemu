import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INPUTS, ScenarioSchema } from '../shared/protocol.ts';
import { applyScenarios, scenarioValue, SessionFileSchema } from '../server/scenarios.ts';

const scenario = (kind: 'manual' | 'ramp' | 'sine' | 'noise' | 'playback') => ScenarioSchema.parse({
  deviceId: 'tmp105', channel: 'temperatureC', kind, offset: 10, amplitude: 20,
  periodMs: 1000, seed: 42, frames: kind === 'playback' ? [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 20 }] : [],
});

test('scenarios use epoch-relative time and deterministic 100ms noise ticks', () => {
  assert.equal(scenarioValue(scenario('manual'), 500), undefined);
  assert.equal(scenarioValue(scenario('ramp'), 500), 20);
  assert.ok(Math.abs(scenarioValue(scenario('sine'), 250)! - 30) < 1e-9);
  assert.equal(scenarioValue(scenario('playback'), 500), 10);
  assert.equal(scenarioValue(scenario('playback'), 1500), 20);
  assert.equal(scenarioValue(scenario('noise'), 100), scenarioValue(scenario('noise'), 199));
  assert.notEqual(scenarioValue(scenario('noise'), 100), scenarioValue(scenario('noise'), 200));
});

test('scenario application clamps values, preserves faults and never mutates inputs', () => {
  const inputs = structuredClone(DEFAULT_INPUTS);
  inputs.tmp105.connected = false;
  inputs.tmp105.invalid = true;
  const next = applyScenarios(inputs, [{ ...scenario('ramp'), offset: 1000 }], 500);
  assert.deepEqual(next.tmp105, { temperatureC: 125, connected: false, invalid: true });
  assert.equal(inputs.tmp105.temperatureC, 25);
  assert.deepEqual(applyScenarios(inputs, [scenario('manual')], 500), inputs);
});

test('session files reject code, paths, duplicate channels and invalid playback', () => {
  const file = { v: 1, inputs: DEFAULT_INPUTS, scenarios: [scenario('noise')] };
  assert.equal(SessionFileSchema.safeParse(file).success, true);
  assert.equal(SessionFileSchema.safeParse({ ...file, path: '/tmp/anything' }).success, false);
  assert.equal(SessionFileSchema.safeParse({ ...file, scenarios: [scenario('noise'), scenario('ramp')] }).success, false);
  assert.equal(ScenarioSchema.safeParse({ ...scenario('playback'), frames: [] }).success, false);
  const frames = Array.from({ length: 10000 }, (_, index) => ({ timeMs: index, value: 1.123456789012345 }));
  assert.equal(SessionFileSchema.safeParse({ ...file, scenarios: [{ ...scenario('playback'), frames }] }).success, false);
});

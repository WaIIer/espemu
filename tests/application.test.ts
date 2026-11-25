import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationLine } from '../shared/application.ts';

test('application telemetry supports named channels without any required sensor fields', () => {
  const packet = { v: 1, seq: 1, channels: { counter: { value: 42, unit: 'count' }, voltage: { value: 3.3, unit: 'V' } } };
  assert.equal(parseApplicationLine(`ESP_EMU ${JSON.stringify(packet)}`)?.channels.counter.value, 42);
  assert.deepEqual(parseApplicationLine('ESP_EMU {"v":1,"seq":0,"channels":{}}')?.channels, {});
  assert.equal(parseApplicationLine('normal UART output'), null);
  assert.equal(parseApplicationLine('ESP_EMU {"v":1,"seq":0,"channels":{"counter":{"value":42,"unit":5}}}'), null);
});
test('legacy sensor packets become optional generic application channels with registry units', () => {
  const packet = { v: 1, seq: 3, guestUs: 1000, bh1750: { lux: 320, error: 0 }, tmp105: { temperatureC: null, error: 264 } };
  const sample = parseApplicationLine(`ESP_EMU ${JSON.stringify(packet)}`)!;
  assert.deepEqual(sample.channels['bh1750.lux'], { value: 320, unit: 'lx' });
  assert.equal(sample.channels['tmp105.temperatureC'].value, null);
});

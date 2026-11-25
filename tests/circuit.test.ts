import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circuitConnections } from '../shared/circuit';
import { DEMO_MANIFEST, EMPTY_MANIFEST, ProjectManifestSchema } from '../shared/manifest';
import { ESP32_CAM_SIGNALS, isSensor, wiredPins } from '../shared/registry';

test('connections share I2C nets and probes observe the same GPIO as their device', () => {
  const { parts, nets } = circuitConnections(DEMO_MANIFEST);
  assert.equal(parts.length, DEMO_MANIFEST.devices.length);
  assert.deepEqual(nets.find(net => net.gpio === 21)?.nodes.map(node => node.signal), ['GPIO21', 'SDA', 'SDA', 'SDA', 'SDA']);
  assert.deepEqual(nets.find(net => net.gpio === 2)?.nodes.map(node => node.signal), ['GPIO2', 'SIGNAL', 'PROBE']);
  assert.deepEqual(parts.find(part => part.id === 'rgb')?.terminals.map(port => [port.signal, port.gpio]), [['R', 16], ['G', 17], ['B', 23]]);
  assert.deepEqual(parts.find(part => part.id === 'matrix')?.terminals.map(port => [port.signal, port.gpio]), [['DIN', 25], ['CLK', 32], ['LOAD / CS', 33]]);
  assert.match(parts.find(part => part.id === 'button')!.description, /active-low/);
});

test('camera signals, I2S signals and unused buses are represented without fabricated power pins', () => {
  const camera = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ type: 'ov2640', id: 'camera' }] });
  const { parts, nets } = circuitConnections(camera);
  assert.deepEqual(parts[0].terminals.map(port => port.gpio), Object.values(ESP32_CAM_SIGNALS).filter(pin => pin >= 0));
  assert.ok(!parts[0].terminals.some(port => port.signal === 'RESET'));
  assert.ok(!nets.some(net => net.gpio < 0));
  const audio = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ type: 'max98357a', id: 'audio', din: 23, bclk: 18, lrclk: 19 }] });
  assert.deepEqual(circuitConnections(audio).parts[0].terminals.map(port => [port.signal, port.gpio]), [['DIN', 23], ['BCLK', 18], ['LRCLK', 19]]);
  const bus = ProjectManifestSchema.parse({ v: 1, target: 'esp32', buses: [{ id: 'empty', type: 'i2c', controller: 0, sda: 21, scl: 22 }] });
  assert.deepEqual(circuitConnections(bus).nets.map(net => net.nodes.length), [1, 1]);
  assert.deepEqual(circuitConnections(EMPTY_MANIFEST).nets, []);
});

test('every device terminal belongs to exactly its declared GPIO net', () => {
  for (const device of DEMO_MANIFEST.devices) {
    const part = circuitConnections(DEMO_MANIFEST).parts.find(part => part.id === device.id)!;
    assert.deepEqual(part.terminals.map(port => port.gpio), isSensor(device) ? [21, 22] : [...wiredPins(device)]);
    for (const terminal of part.terminals) {
      const membership = circuitConnections(DEMO_MANIFEST).nets.filter(net => net.nodes.some(node => node.ref === part.ref && node.pin === terminal.pin));
      assert.deepEqual(membership.map(net => net.gpio), [terminal.gpio]);
    }
  }
});

test('full-size circuits keep all terminals and LCD backpacks share the declared I2C bus', () => {
  const probes = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: Array.from({ length: 32 }, (_, index) => ({ type: 'probe', id: `probe_${index}`, pin: 2 })) });
  const { parts, nets } = circuitConnections(probes);
  assert.equal(parts.length, 32);
  assert.equal(nets[0].nodes.length, 33);
  const lcd = ProjectManifestSchema.parse({ ...EMPTY_MANIFEST, buses: DEMO_MANIFEST.buses, devices: [{ type: 'hd44780', id: 'lcd', bus: 'i2c0', address: 39 }] });
  assert.deepEqual(circuitConnections(lcd).parts[0].terminals.map(port => [port.signal, port.gpio]), [['SDA', 21], ['SCL', 22]]);
});

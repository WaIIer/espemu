import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circuitConnections, exportKicadNetlist } from '../shared/circuit';
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

test('KiCad export preserves nets, unique connector references and escapes user labels', () => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [
    { id: 'esp32', label: 'LED "quoted" \\ test', type: 'led', pin: 2 },
    { id: 'observer', type: 'probe', pin: 2 },
  ] });
  const exported = exportKicadNetlist(manifest);
  assert.match(exported, /^\(export \(version "E"\)/);
  assert.equal((exported.match(/\(comp \(ref /g) ?? []).length, 3);
  assert.equal((exported.match(/\(net \(code /g) ?? []).length, 1);
  for (const ref of ['J1', 'J2', 'J3']) assert.ok(exported.includes(`(node (ref "${ref}") (pin "1")`));
  assert.ok(exported.includes('LED \\"quoted\\" \\\\ test'));
  assert.ok(!exported.includes('(footprint'));
  assert.equal((exportKicadNetlist(EMPTY_MANIFEST).match(/\(comp /g) ?? []).length, 0);
});

test('full-size circuits keep all terminals and LCD backpacks share the declared I2C bus', () => {
  const probes = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: Array.from({ length: 32 }, (_, index) => ({ type: 'probe', id: `probe_${index}`, pin: 2 })) });
  const { parts, nets } = circuitConnections(probes);
  assert.equal(parts.length, 32);
  assert.equal(nets[0].nodes.length, 33);
  assert.equal((exportKicadNetlist(probes).match(/\(node /g) ?? []).length, 33);
  const lcd = ProjectManifestSchema.parse({ ...EMPTY_MANIFEST, buses: DEMO_MANIFEST.buses, devices: [{ type: 'hd44780', id: 'lcd', bus: 'i2c0', address: 39 }] });
  assert.deepEqual(circuitConnections(lcd).parts[0].terminals.map(port => [port.signal, port.gpio]), [['SDA', 21], ['SCL', 22]]);
});

test('KiCad netlist parses as complete S-expressions and each node resolves to a component terminal', () => {
  type Expression = string | Expression[];
  const manifest = ProjectManifestSchema.parse({ ...DEMO_MANIFEST, devices: DEMO_MANIFEST.devices.map(device => ({ ...device, label: 'Label "with" \\ escapes\tand\nlines' })) });
  const tokens = exportKicadNetlist(manifest).match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g)!;
  let index = 0;
  function read(): Expression {
    const token = tokens[index++];
    assert.ok(token, 'Unexpected end of netlist');
    if (token !== '(') {
      assert.notEqual(token, ')');
      return token.startsWith('"') ? JSON.parse(token) as string : token;
    }
    const list: Expression[] = [];
    while (tokens[index] !== ')') list.push(read());
    index++;
    return list;
  }
  function children(expression: Expression, name: string): Expression[][] {
    assert.ok(Array.isArray(expression));
    return expression.filter((child): child is Expression[] => Array.isArray(child) && child[0] === name);
  }
  function field(expression: Expression, name: string): Expression {
    const child = children(expression, name)[0];
    assert.ok(child, `Missing ${name}`);
    return child[1];
  }
  const tree = read();
  assert.equal(index, tokens.length, 'Trailing netlist tokens');
  assert.ok(Array.isArray(tree));
  assert.equal(tree[0], 'export');
  const components = children(children(tree, 'components')[0], 'comp');
  const { controller, parts, nets } = circuitConnections(manifest);
  assert.deepEqual(components.map(component => field(component, 'ref')), [controller, ...parts].map(part => part.ref));
  const exportedNets = children(children(tree, 'nets')[0], 'net');
  assert.deepEqual(exportedNets.map(net => field(net, 'name')), nets.map(net => net.name));
  for (const [index, net] of exportedNets.entries()) {
    assert.deepEqual(children(net, 'node').map(node => [field(node, 'ref'), field(node, 'pin'), field(node, 'pinfunction')]), nets[index].nodes.map(node => [node.ref, node.pin, node.signal]));
  }
});

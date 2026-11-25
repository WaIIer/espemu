import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectManifestSchema } from '../shared/manifest.ts';
import { kicadProjectFiles } from '../tools/kicad-export.ts';
import { kicadOmission, kicadTypeLimitation } from '../shared/kicad-support.ts';
import { generateProjectArtifacts } from '../tools/project-artifacts.ts';

const manifest = (devices: unknown[]) => ProjectManifestSchema.parse({
  v: 1, target: 'esp32', buses: [{ id: 'bus', type: 'i2c', controller: 0, sda: 21, scl: 22 }], devices,
});
const sensors = [
  { id: 'environment', type: 'bme280', bus: 'bus', address: 0x76 },
  { id: 'humidity', type: 'sht3x', bus: 'bus', address: 0x45 },
  { id: 'motion', type: 'mpu6050', bus: 'bus', address: 0x69 },
  { id: 'hall', type: 'a3144', pin: 25 },
];

test('KiCad export is opt-in, source-preserving and preserves an edited or symlinked bundle coherently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-kicad-preservation-'));
  try {
    const project = join(directory, 'project with spaces');
    mkdirSync(join(project, 'main'), { recursive: true });
    writeFileSync(join(project, 'CMakeLists.txt'), 'project(user)\n');
    writeFileSync(join(project, 'main/main.c'), 'user application\n');
    writeFileSync(join(project, 'espemu.json'), JSON.stringify(manifest(sensors)));
    generateProjectArtifacts(project);
    assert.equal(existsSync(join(project, 'kicad')), false);
    const cmake = readFileSync(join(project, 'CMakeLists.txt'), 'utf8');
    const result = generateProjectArtifacts(project, undefined, false, true);
    assert.ok(result.written.includes('kicad/espemu.kicad_sch'));
    assert.deepEqual(result.preserved, []);
    assert.equal(readFileSync(join(project, 'main/main.c'), 'utf8'), 'user application\n');
    assert.equal(readFileSync(join(project, 'CMakeLists.txt'), 'utf8'), cmake);
    assert.equal(existsSync(join(project, 'build')), false);
    writeFileSync(join(project, 'kicad/espemu.kicad_sch'), 'user edited schematic\n');
    const report = readFileSync(join(project, 'kicad/export-report.json'), 'utf8');
    writeFileSync(join(project, 'espemu.json'), JSON.stringify(manifest(sensors.slice(0, 1))));
    assert.deepEqual(generateProjectArtifacts(project, undefined, false, true).written, []);
    assert.equal(readFileSync(join(project, 'kicad/export-report.json'), 'utf8'), report);
    assert.equal(readFileSync(join(project, 'kicad/espemu.kicad_sch'), 'utf8'), 'user edited schematic\n');
    generateProjectArtifacts(project, undefined, true, true);
    writeFileSync(join(project, 'kicad/device-3-motion.kicad_sch'), 'edited old sheet\n');
    writeFileSync(join(project, 'espemu.json'), JSON.stringify(manifest([{ ...sensors[0], address: 0x77 }])));
    assert.deepEqual(generateProjectArtifacts(project, undefined, false, true).written, [], 'an edited previously-generated sheet still protects its bundle');
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    const linked = join(directory, 'linked');
    mkdirSync(linked);
    writeFileSync(join(linked, 'CMakeLists.txt'), 'project(linked)');
    symlinkSync(outside, join(linked, 'kicad'));
    assert.deepEqual(generateProjectArtifacts(linked, undefined, false, true).written, []);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('make kicad exports without compiling and reports omissions and preservation failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-make-kicad-'));
  const root = join(import.meta.dirname, '..');
  try {
    const setup = spawnSync('bash', [join(root, 'tools/setup-project.sh'), directory, '--init-only'], { encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const source = readFileSync(join(directory, 'main/main.c'), 'utf8');
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify(manifest([{ id: 'unqualified', type: 'bh1750', bus: 'bus', address: 0x23 }, ...sensors])));
    const run = () => spawnSync('make', ['--no-print-directory', '-C', directory, 'kicad'], { encoding: 'utf8' });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /KiCad omitted unqualified:.*DVI/);
    assert.equal(readFileSync(join(directory, 'main/main.c'), 'utf8'), source);
    assert.equal(existsSync(join(directory, 'build')), false);
    writeFileSync(join(directory, 'kicad/espemu.kicad_pro'), '{"userSettings":true}\n');
    const preserved = run();
    assert.notEqual(preserved.status, 0);
    assert.match(preserved.stderr, /whole bundle was preserved/);
    assert.equal(readFileSync(join(directory, 'kicad/espemu.kicad_pro'), 'utf8'), '{"userSettings":true}\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('electrical profiles include address straps, supply pins, exposed pad and special filter capacitors', () => {
  const files = kicadProjectFiles(manifest(sensors));
  const report = JSON.parse(files['kicad/export-report.json']);
  const part = (symbol: string) => report.components.find((component: { symbol: string }) => component.symbol === symbol);
  assert.deepEqual(part('Sensor:BME280').nets, { 1: 'GND', 2: '+3V3', 3: 'GPIO21', 4: 'GPIO22', 5: 'GND', 6: '+3V3', 7: 'GND', 8: '+3V3' });
  assert.deepEqual(part('Sensor_Humidity:SHT31-DIS').nets, { 1: 'GPIO21', 2: '+3V3', 3: null, 4: 'GPIO22', 5: '+3V3', 6: null, 7: 'GND', 8: 'GND', 9: 'GND' });
  assert.equal(part('Sensor_Motion:MPU-6050').nets['9'], '+3V3');
  const caps = report.components.filter((component: { instance: string; symbol: string }) => component.instance === 'motion' && component.symbol === 'Device:C');
  assert.ok(caps.some((cap: { value: string; nets: object }) => cap.value === '2.2nF 50V X7R 10%' && JSON.stringify(cap.nets) === '{"1":"D3_CPOUT","2":"GND"}'));
  assert.ok(caps.some((cap: { value: string; nets: object }) => cap.value === '100nF 10V X7R' && JSON.stringify(cap.nets) === '{"1":"D3_REGOUT","2":"GND"}'));
  const pullups = report.components.filter((component: { value: string }) => component.value === '2.2k');
  assert.deepEqual(pullups.map((component: { nets: object }) => component.nets), [{ 1: '+3V3', 2: 'GPIO21' }, { 1: '+3V3', 2: 'GPIO22' }]);
  assert.equal(part('RF_Module:ESP32-WROOM-32').nets['33'], 'GPIO21');
  assert.equal(part('RF_Module:ESP32-WROOM-32').nets['36'], 'GPIO22');
  assert.deepEqual(part('ESPEmu:A3144UA').nets, { 1: '+5V', 2: 'GND', 3: 'GPIO25' });
  const hallPullup = report.components.find((component: { instance: string; symbol: string }) => component.instance === 'hall' && component.symbol === 'Device:R');
  assert.deepEqual(hallPullup.nets, { 1: '+3V3', 2: 'GPIO25' });
  assert.ok(report.components.some((component: { value: string; nets: Record<string, string> }) => component.value === '5V HALL INPUT' && component.nets['1'] === '+5V'));
});

test('boot UART contacts and inverted bare Hall sensors are omitted, not shorted or silently remapped', () => {
  for (const activeLow of [false, true]) {
    const files = kicadProjectFiles(manifest([{ id: 'contact', type: 'button', pin: 1, activeLow }]));
    const report = JSON.parse(files['kicad/export-report.json']);
    assert.equal(report.devices[0].status, 'omitted');
    assert.match(report.devices[0].reason, /boot UART transmitter/);
  }
  const files = kicadProjectFiles(manifest([{ id: 'hall', type: 'a3144', pin: 25, activeLow: false }]));
  const report = JSON.parse(files['kicad/export-report.json']);
  assert.equal(report.devices[0].status, 'omitted');
  assert.match(report.devices[0].reason, /needs an inverter/);
  assert.ok(!files['kicad/espemu.kicad_sch'].includes('+5V'));
});

test('the creator and exporter share one set of KiCad limitations', () => {
  const device = (value: object) => manifest([value]).devices[0];
  assert.match(kicadTypeLimitation('tmp105') ?? '', /TMP105/);
  assert.equal(kicadTypeLimitation('led'), undefined);
  assert.match(kicadOmission(device({ id: 'status', type: 'led', pin: 2, activeLow: true })) ?? '', /GPIO2 is an ESP32 boot pin/);
  assert.equal(kicadOmission(device({ id: 'builtin', type: 'led', pin: 2, activeLow: false })), undefined);
  assert.match(kicadOmission(device({ id: 'boot', type: 'button', pin: 0 })) ?? '', /GPIO0 is an ESP32 boot pin/);
  assert.match(kicadOmission(device({ id: 'high', type: 'button', pin: 37 })) ?? '', /GPIO37 is not available/);
  assert.equal(kicadOmission(device({ id: 'status', type: 'led', pin: 25 })), undefined);
  assert.equal(kicadOmission(device({ id: 'hall', type: 'a3144', pin: 25 })), undefined);
  const report = (value: object) => JSON.parse(kicadProjectFiles(manifest([value]))['kicad/export-report.json']);
  assert.equal(report({ id: 'status', type: 'led', pin: 2, activeLow: true }).devices[0].reason, kicadOmission(device({ id: 'status', type: 'led', pin: 2, activeLow: true })));
  const builtin = report({ id: 'builtin', type: 'led', pin: 2, activeLow: false });
  assert.equal(builtin.devices[0].status, 'included');
  const led = builtin.components.find((component: { instance: string; symbol: string }) => component.instance === 'builtin' && component.symbol === 'Device:LED');
  assert.equal(led.nets['1'], 'GND');
});

test('all address alternatives and maximum device hierarchy remain deterministic and correctly strapped', () => {
  const files = kicadProjectFiles(manifest([
    { id: 'environment', type: 'bme280', bus: 'bus', address: 0x77 },
    { id: 'humidity', type: 'sht3x', bus: 'bus', address: 0x44 },
    { id: 'motion', type: 'mpu6050', bus: 'bus', address: 0x68 },
  ]));
  const report = JSON.parse(files['kicad/export-report.json']);
  const part = (symbol: string) => report.components.find((component: { symbol: string }) => component.symbol === symbol);
  assert.equal(part('Sensor:BME280').nets['5'], '+3V3');
  assert.equal(part('Sensor_Humidity:SHT31-DIS').nets['2'], 'GND');
  assert.equal(part('Sensor_Motion:MPU-6050').nets['9'], 'GND');
  const many = kicadProjectFiles(manifest(Array.from({ length: 32 }, (_, index) => ({ id: `probe_${index}`, type: 'probe', pin: 4 }))));
  assert.equal(Object.keys(many).filter(name => name.endsWith('.kicad_sch')).length, 33);
  assert.match(many['kicad/espemu.kicad_sch'], /\(sheet \(at 220\.98 266\.7\)/);
});

test('unqualified devices are reported without fake symbols or bus loads; polarity is preserved', () => {
  const files = kicadProjectFiles(manifest([
    { id: 'light', type: 'bh1750', bus: 'bus', address: 0x23 },
    { id: 'gas', type: 'mq_2', pin: 25 },
    { id: 'unsafe', type: 'led', pin: 12 },
    { id: 'unavailable', type: 'button', pin: 37 },
    { id: 'led', type: 'led', pin: 26, activeLow: true },
    { id: 'contact', type: 'switch', pin: 34, activeLow: false },
  ]));
  const report = JSON.parse(files['kicad/export-report.json']);
  assert.deepEqual(report.devices.map((device: { status: string }) => device.status), ['omitted', 'omitted', 'omitted', 'omitted', 'included', 'included']);
  assert.equal(Object.keys(files).filter(name => name.endsWith('.kicad_sch')).length, 3);
  assert.ok(!report.components.some((component: { value: string }) => component.value === '2.2k'));
  const led = report.components.find((component: { instance: string; symbol: string }) => component.instance === 'led' && component.symbol === 'Device:LED');
  assert.deepEqual(led.nets, { 1: 'D5_LED', 2: '+3V3' });
  const contact = report.components.filter((component: { instance: string }) => component.instance === 'contact');
  assert.deepEqual(contact[0].nets, { 1: 'GPIO34', 2: '+3V3' });
  assert.deepEqual(contact[1].nets, { 1: 'GPIO34', 2: 'GND' });
  assert.deepEqual(files, kicadProjectFiles(manifest([
    { id: 'light', type: 'bh1750', bus: 'bus', address: 0x23 }, { id: 'gas', type: 'mq_2', pin: 25 },
    { id: 'unsafe', type: 'led', pin: 12 }, { id: 'unavailable', type: 'button', pin: 37 },
    { id: 'led', type: 'led', pin: 26, activeLow: true }, { id: 'contact', type: 'switch', pin: 34, activeLow: false },
  ])));
});

test('KiCad consumes the hierarchy and exported netlist contains the actual pin connections', t => {
  const available = spawnSync('kicad-cli', ['version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT') {
    t.skip('KiCad CLI unavailable; run this integration check on a KiCad installation');
    return;
  }
  assert.equal(available.status, 0, available.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'espemu-kicad-'));
  try {
    for (const activeLow of [false, true]) {
      const files = kicadProjectFiles(manifest([
        ...sensors,
        { id: 'indicator', type: 'led', pin: 26, activeLow },
        { id: 'rgb', type: 'rgb', pins: [16, 17, 18], activeLow },
        { id: 'button', type: 'button', pin: 34, activeLow },
        { id: 'switch', type: 'switch', pin: 35, activeLow },
        { id: 'probe', type: 'probe', pin: 26 },
      ]));
      mkdirSync(join(directory, 'kicad'), { recursive: true });
      for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
      const netlist = join(directory, 'export.net');
      const result = spawnSync('kicad-cli', ['sch', 'export', 'netlist', '--output', netlist, join(directory, 'kicad/espemu.kicad_sch')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const output = readFileSync(netlist, 'utf8').split('  (nets\n')[1];
      assert.ok(output, 'netlist must have a nets section');
      const report = JSON.parse(files['kicad/export-report.json']);
      const netBlock = (net: string) => output.slice(output.indexOf(`(name "${net}")`)).split(/\n    \(net /)[0];
      const expectedNets = new Map<string, string[]>();
      for (const component of report.components) {
        if (component.symbol === 'power:PWR_FLAG') continue;
        for (const [pin, net] of Object.entries(component.nets)) {
          if (typeof net !== 'string') continue;
          assert.ok(output.includes(`(name "${net}")`), `missing net ${net}`);
          expectedNets.set(net, [...(expectedNets.get(net) ?? []), `${component.reference}.${pin}`]);
        }
      }
      for (const [net, expected] of expectedNets) {
        const actual = [...netBlock(net).matchAll(/\(node \(ref "([^"]+)"\) \(pin "([^"]+)"\)/g)].map(match => `${match[1]}.${match[2]}`);
        assert.deepEqual(actual.sort(), expected.sort(), `no unexpected connections on ${net}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

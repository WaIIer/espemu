import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESP32_CAM_SIGNALS, PERIPHERAL_REGISTRY, wiredPins } from '../shared/registry.ts';
import { EMPTY_MANIFEST, DEMO_MANIFEST, ProjectManifestSchema, qemuCircuit } from '../shared/manifest.ts';

test('empty manifests declare no implicit sensor instances, inputs or buses', () => {
  assert.deepEqual(EMPTY_MANIFEST.devices, []); assert.deepEqual(EMPTY_MANIFEST.inputs, {});
  assert.deepEqual(qemuCircuit(EMPTY_MANIFEST), { v: 1, devices: [] });
});

test('the bundled demo declares supported device types and both single/strip WS2812 instances',()=>{
  const bundled=ProjectManifestSchema.parse(JSON.parse(readFileSync(new URL('../firmware/espemu.json',import.meta.url),'utf8')));
  assert.deepEqual(bundled,DEMO_MANIFEST);
  assert.ok(bundled.devices.every(device=>Object.hasOwn(PERIPHERAL_REGISTRY,device.type)));
  assert.deepEqual(bundled.devices.filter(device=>device.type==='ws2812b').map(device=>device.length),[1,8]);
});

test('20 named digital sensor modules are registry-configurable',()=>{
  const types=[
    'hc_sr501','hc_sr505','rcwl_0516','ttp223','a3144','ss451a','sw_520d','sw_420','ky_032','ky_026',
    'fc_37','yl_69','mq_2','mq_135','ky_038','st188','reed_59170','sn04_n','lj12a3','e18_d80nk',
  ] as const;
  assert.equal(types.length,20);
  for(const type of types){
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:type,type,pin:34}]});
    assert.equal(manifest.devices[0].type,type);
  }
  assert.equal(PERIPHERAL_REGISTRY.sn04_n.config.parse({id:'sn',type:'sn04_n',pin:27}).activeLow,true);
  assert.equal(PERIPHERAL_REGISTRY.ttp223.config.parse({id:'touch',type:'ttp223',pin:27}).activeLow,false);
  assert.equal(PERIPHERAL_REGISTRY.a3144.config.parse({id:'hall',type:'a3144',pin:27}).activeLow,true);
  assert.equal(PERIPHERAL_REGISTRY.ky_038.config.parse({id:'sound',type:'ky_038',pin:27}).activeLow,false);
  assert.equal(ProjectManifestSchema.safeParse({v:1,target:'esp32',devices:[{id:'ldr',type:'ky_018',pin:34}]}).success,false);
  const defaults=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'pir',type:'hc_sr501',pin:27},{id:'touch',type:'ttp223',pin:26}]});
  assert.deepEqual(defaults.gpioInputs,[{pin:27,level:0},{pin:26,level:0}]);
  const override=ProjectManifestSchema.parse({...defaults,gpioInputs:[{pin:27,level:1}]});
  assert.deepEqual(override.gpioInputs,[{pin:27,level:1},{pin:26,level:0}]);
  const activeHigh=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'hall',type:'a3144',pin:27,activeLow:false}]});
  assert.deepEqual(activeHigh.gpioInputs,[{pin:27,level:0}]);
  assert.deepEqual(ProjectManifestSchema.parse({...activeHigh,gpioInputs:[{pin:27,level:null}]}).gpioInputs,[{pin:27,level:null}]);
  const motion=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'motion',type:'hc_sr501',pin:34}],gpioInputs:[{pin:34,level:1}]});
  assert.equal(motion.gpioInputs[0].level,1);
  assert.deepEqual(qemuCircuit(motion),{v:1,devices:[]});
  assert.equal(ProjectManifestSchema.safeParse({v:1,target:'esp32',devices:[{id:'bad',type:'hc_sr501',pin:6}]}).success,false);
});

test('WS2812 supports single pixels and configured strips while rejecting invalid length/inversion/pins',()=>{
  const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'pixel',type:'ws2812b',pin:18},{id:'strip',type:'ws2812b',pin:19,length:16}]});
  assert.equal((manifest.devices[0] as {length:number}).length,1);
  for(const device of [{id:'x',type:'ws2812b',pin:34,length:8},{id:'x',type:'ws2812b',pin:18,length:0},{id:'x',type:'ws2812b',pin:18,length:1025},{id:'x',type:'ws2812b',pin:18,activeLow:true}])assert.equal(ProjectManifestSchema.safeParse({v:1,target:'esp32',devices:[device]}).success,false);
});
test('MAX7219 wiring, chains and input topology are validated before launch', () => {
  const device = { id: 'matrix', type: 'max7219', din: 23, clk: 18, load: 5 };
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [device, { id: 'probe', type: 'probe', pin: 18 }] });
  assert.deepEqual(qemuCircuit(manifest).devices, []);
  assert.deepEqual(manifest.inputs, {});
  assert.equal(manifest.devices[0].type === 'max7219' && manifest.devices[0].length, 1);
  for (const changes of [{ din: 34 }, { clk: 6 }, { load: 40 }, { clk: 23 }, { length: 0 }, { length: 17 }, { activeLow: true }]) {
    assert.equal(ProjectManifestSchema.safeParse({ v: 1, target: 'esp32', devices: [{ ...device, ...changes }] }).success, false);
  }
  for (const pin of [23, 18, 5]) assert.equal(ProjectManifestSchema.safeParse({
    v: 1, target: 'esp32', devices: [device, { id: 'led', type: 'led', pin }],
  }).success, false);
  assert.equal(ProjectManifestSchema.safeParse({ v: 1, target: 'esp32', buses: DEMO_MANIFEST.buses, devices: [{ ...device, din: 21 }] }).success, false);
  assert.equal(ProjectManifestSchema.safeParse({ ...manifest, inputs: { matrix: {} } }).success, false);
});

test('MPU6050 instances have independent bounded motion inputs at their ordinary I2C addresses',()=>{
  const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',buses:[{id:'motion_bus',type:'i2c',controller:0,sda:21,scl:22,frequencyHz:100000}],devices:[{id:'gyro',type:'mpu6050',bus:'motion_bus',address:0x68},{id:'other',type:'mpu6050',bus:'motion_bus',address:0x69}],inputs:{gyro:{gyroXdps:90,accelXg:1}}});
  assert.equal(manifest.inputs.gyro.gyroXdps,90);
  assert.equal(manifest.inputs.other.gyroXdps,0);
  assert.equal(manifest.inputs.other.accelZg,1);
  for(const inputs of [{gyroXdps:2001},{gyroYdps:-2001},{accelZg:17},{gyroZdps:Infinity}])assert.equal(ProjectManifestSchema.safeParse({...manifest,inputs:{gyro:inputs}}).success,false);
  assert.equal(ProjectManifestSchema.safeParse({...manifest,devices:[{id:'bad',type:'mpu6050',bus:'motion_bus',address:0x70}]}).success,false);
});
test('one sensor and multiple independently addressed instances normalize through the registry', () => {
  const manifest = ProjectManifestSchema.parse({ ...DEMO_MANIFEST, devices: [{ id: 'room', type: 'tmp105', bus: 'i2c0', address: 72 }, { id: 'outside', type: 'tmp105', bus: 'i2c0', address: 73 }],
    inputs: { room: { temperatureC: 20 }, outside: { temperatureC: 35 } } });
  assert.equal(qemuCircuit(manifest).devices[1].inputs.temperatureMc, 35000);
});
test('unsupported types, routing, conflicts and unknown input/scenario channels are rejected', () => {
  const base = structuredClone(DEMO_MANIFEST);
  for (const value of [{ ...base, target: 'esp32c3' }, { ...base, buses: [{ ...base.buses[0], sda: 18 }] },
    { ...base, devices: [base.devices[0], { ...base.devices[0], id: 'other' }] }, { ...base, devices: [{ id: 'x', type: 'unknown' }] },
    { ...base, inputs: { unknown: {} } }, { ...base, devices: [{ id: 'x', type: 'led', pin: 34 }] },
    { ...base, devices: [{ id: '__proto__', type: 'tmp105', bus: 'i2c0', address: 72 }] },
    { ...base, scenarios: [{deviceId:'tmp105',channel:'constructor',kind:'sine',offset:0,amplitude:1,periodMs:1000,seed:0}] }]) assert.equal(ProjectManifestSchema.safeParse(value).success, false);
});

test('scenario fields irrelevant to the chosen mode have defaults', () => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }],
    devices: [{ id: 'room', type: 'tmp105', bus: 'i2c0', address: 72 }],
    scenarios: [{ deviceId: 'room', channel: 'temperatureC', kind: 'sine', offset: 26, amplitude: 6, periodMs: 20000 }] });
  assert.deepEqual(manifest.scenarios[0], { deviceId: 'room', channel: 'temperatureC', kind: 'sine', offset: 26, amplitude: 6, periodMs: 20000, seed: 0, frames: [] });
  assert.deepEqual(ProjectManifestSchema.parse(JSON.parse(JSON.stringify(manifest))), manifest);
});

test('pull-ups cannot make an active-high contact permanently asserted', () => {
  const manifest = (device: object) => ProjectManifestSchema.safeParse({ v: 1, target: 'esp32', devices: [device] });
  assert.equal(manifest({ id: 'door', type: 'switch', pin: 35, activeLow: false, pullUp: true }).success, false);
  assert.equal(manifest({ id: 'door', type: 'switch', pin: 35, activeLow: true, pullUp: true }).success, true);
  assert.equal(manifest({ id: 'sound', type: 'ky_038', pin: 34, activeLow: false, pullUp: true }).success, true);
});

test('SHT3x manifests accept both datasheet addresses and map physical inputs to QEMU raw units', () => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }],
    devices: [{ id: 'cabinet', type: 'sht3x', bus: 'i2c0', address: 0x44 }, { id: 'vent', type: 'sht3x', bus: 'i2c0', address: 0x45 }],
    inputs: { vent: { temperatureC: -12.25, humidityPct: 92.5 } } });
  assert.deepEqual(manifest.inputs.cabinet, { temperatureC: 25, humidityPct: 45, connected: true, invalid: false });
  assert.deepEqual(qemuCircuit(manifest).devices[1], { id: 'vent', type: 'sht3x', address: 0x45, inputs: { connected: true, invalid: false, temperatureMc: -12250, humidityMilli: 92500 } });
  for (const address of [0x40, 0x46]) assert.equal(ProjectManifestSchema.safeParse({ ...manifest, devices: [{ id: 'x', type: 'sht3x', bus: 'i2c0', address }], inputs: {} }).success, false);
  for (const inputs of [{ temperatureC: 125.01 }, { humidityPct: -0.01 }]) assert.equal(ProjectManifestSchema.safeParse({ ...manifest, inputs: { cabinet: inputs } }).success, false);
});

test('OV2640 cameras default to ESP32-CAM wiring, export VSYNC to QEMU and reject conflicting wiring', () => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'cam', type: 'ov2640' }] });
  assert.deepEqual(manifest.devices[0], { id: 'cam', type: 'ov2640', signals: ESP32_CAM_SIGNALS });
  assert.deepEqual(qemuCircuit(manifest), { v: 1, devices: [], camera: { id: 'cam', vsync: 25 } });
  assert.equal(wiredPins(manifest.devices[0]).length, 15, 'the unconnected RESET line is not a wired pin');
  const issues = (value: Record<string, unknown>) => {
    const result = ProjectManifestSchema.safeParse({ v: 1, target: 'esp32', ...value });
    return result.success ? '' : result.error.issues.map(issue => issue.message).join('; ');
  };
  assert.match(issues({ devices: [{ id: 'a', type: 'ov2640' }, { id: 'b', type: 'ov2640' }] }), /at most one camera/);
  assert.match(issues({ buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }], devices: [{ id: 'cam', type: 'ov2640' }] }), /GPIO21 is reserved for the declared I2C bus/);
  assert.match(issues({ devices: [{ id: 'cam', type: 'ov2640' }, { id: 'lamp', type: 'led', pin: 25 }] }), /Conflicting peripheral wiring on GPIO25/);
  assert.notEqual(issues({ devices: [{ id: 'cam', type: 'ov2640', signals: { ...ESP32_CAM_SIGNALS, xclk: 34 } }] }), '', 'XCLK must be an output-capable GPIO');
  assert.match(issues({ devices: [{ id: 'cam', type: 'ov2640', signals: { ...ESP32_CAM_SIGNALS, d1: 5 } }] }), /distinct GPIOs/);
  assert.equal(issues({ devices: [{ id: 'cam', type: 'ov2640', signals: { ...ESP32_CAM_SIGNALS, pwdn: -1, xclk: 4 } }] }), '');
});

test('HD44780 LCDs use PCF8574/PCF8574A addresses with a size, and one MAX98357A speaker exports its I2S pins', () => {
  const bus = [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }];
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', buses: bus, devices: [{ id: 'lcd', type: 'hd44780', bus: 'i2c0', address: 0x27 }, { id: 'spk', type: 'max98357a', din: 27, bclk: 26, lrclk: 25 }] });
  assert.deepEqual(manifest.devices[0], { id: 'lcd', type: 'hd44780', bus: 'i2c0', address: 0x27, size: '16x2' });
  assert.deepEqual(manifest.inputs.lcd, { connected: true, invalid: false });
  assert.deepEqual(qemuCircuit(manifest), { v: 1, devices: [{ id: 'lcd', type: 'hd44780', address: 0x27, inputs: { connected: true, invalid: false } }], speaker: { id: 'spk', din: 27, bclk: 26, lrclk: 25 } });
  assert.deepEqual(wiredPins(manifest.devices[1] as Extract<typeof manifest.devices[number], { type: 'max98357a' }>), [27, 26, 25]);
  const valid = (devices: unknown[]) => ProjectManifestSchema.safeParse({ v: 1, target: 'esp32', buses: bus, devices }).success;
  for (const address of [0x20, 0x3f]) assert.equal(valid([{ id: 'lcd', type: 'hd44780', bus: 'i2c0', address, size: '20x4' }]), true);
  for (const address of [0x28, 0x37]) assert.equal(valid([{ id: 'lcd', type: 'hd44780', bus: 'i2c0', address }]), false);
  assert.equal(valid([{ id: 'lcd', type: 'hd44780', bus: 'i2c0', address: 0x27, size: '16x4' }]), false);
  assert.equal(valid([{ id: 'a', type: 'max98357a', din: 27, bclk: 26, lrclk: 25 }, { id: 'b', type: 'max98357a', din: 14, bclk: 13, lrclk: 12 }]), false, 'one speaker');
  assert.equal(valid([{ id: 'a', type: 'max98357a', din: 27, bclk: 27, lrclk: 25 }]), false, 'distinct pins');
  assert.equal(valid([{ id: 'a', type: 'max98357a', din: 35, bclk: 26, lrclk: 25 }]), false, 'input-only DIN');
});

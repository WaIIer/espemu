import { z } from 'zod';
import { PERIPHERAL_REGISTRY, PIN_NUMBERS, controls, isCamera, isPeripheralInput, isSensor, isSpeaker, normalizeGpioInputs, normalizeInputs, rawInstance, wiredPins, type CircuitDevice, type DeviceType, type PhysicalInputs } from './registry.ts';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/);
export const ManifestScenarioSchema = z.object({ deviceId: identifier, channel: z.string().min(1).max(50), kind: z.enum(['manual','ramp','sine','noise','playback']),
  offset: z.number().finite().default(0), amplitude: z.number().finite().nonnegative().default(0), periodMs: z.number().min(100).max(3600000).default(10000), seed: z.number().int().min(0).max(4294967295).default(0),
  frames: z.array(z.object({ timeMs: z.number().nonnegative(), value: z.number().finite() }).strict()).max(10000).default([]),
}).strict().superRefine((value, context) => {
  if (value.kind === 'playback' && !value.frames.length) context.addIssue({ code: 'custom', message: 'Playback needs frames' });
  if (value.frames.some((frame,index) => index > 0 && frame.timeMs <= value.frames[index-1].timeMs)) context.addIssue({ code: 'custom', message: 'Playback timestamps must increase' });
});
export type CircuitScenario = z.infer<typeof ManifestScenarioSchema>;
const deviceSchema = z.unknown().transform((value, context) => {
  const candidate = value as { type?: string } | null;
  const definition = candidate?.type && Object.hasOwn(PERIPHERAL_REGISTRY, candidate.type) ? PERIPHERAL_REGISTRY[candidate.type as DeviceType] : undefined;
  if (!definition) { context.addIssue({ code: 'custom', message: `Unsupported peripheral type: ${candidate?.type ?? 'missing'}`, fatal: true }); return z.NEVER; }
  const result = definition.config.safeParse(value);
  if (!result.success) { for (const issue of result.error.issues) context.addIssue({ ...issue, fatal: true }); return z.NEVER; }
  return result.data as CircuitDevice;
});
export const ProjectManifestSchema = z.object({
  v: z.literal(1), target: z.literal('esp32'),
  buses: z.array(z.object({ id: identifier, type: z.literal('i2c'), controller: z.literal(0), sda: z.literal(21), scl: z.literal(22), frequencyHz: z.number().int().min(10000).max(400000).default(100000) }).strict()).max(1).default([]),
  devices: z.array(deviceSchema).max(32).default([]),
  inputs: z.record(z.unknown()).default({}),
  gpioInputs: z.array(z.object({ pin: z.number().int().refine(pin => PIN_NUMBERS.includes(pin), 'Invalid GPIO'), level: z.union([z.literal(0),z.literal(1),z.null()]) }).strict()).max(28).default([]),
  scenarios: z.array(ManifestScenarioSchema).max(64).default([]),
}).strict().superRefine((manifest, context) => {
  const problem = (message: string, path: (string | number)[]) => context.addIssue({ code: 'custom', message, path });
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > 256 * 1024) problem('Project manifest exceeds 256KiB; reduce scenario frames', []);
  const ids = new Set<string>(), addresses = new Set<string>(), drivers = new Set<number>();
  const strips = manifest.devices.filter(device => device.type === 'ws2812b');
  if (strips.length > 8) problem('This ESP32 RMT integration supports at most eight WS2812 instances', ['devices']);
  if (strips.reduce((total,device)=>total+device.length,0)>2048) problem('This integration supports at most 2048 total WS2812 pixels', ['devices']);
  if (manifest.devices.filter(device => device.type === 'max7219').length > 8) problem('This integration supports at most eight MAX7219 chains', ['devices']);
  if (manifest.devices.filter(isCamera).length > 1) problem('The ESP32 has one I2S camera interface; declare at most one camera', ['devices']);
  if (manifest.devices.filter(isSpeaker).length > 1) problem('This integration supports one I2S speaker', ['devices']);
  for (const [index, device] of manifest.devices.entries()) {
    if (ids.has(device.id)) problem(`Duplicate device id ${device.id}`, ['devices',index,'id']);
    ids.add(device.id);
    if (isSensor(device)) {
      if (!manifest.buses.some(bus => bus.id === device.bus)) problem(`Unknown I2C bus ${device.bus}`, ['devices',index,'bus']);
      const key = `${device.bus}:${device.address}`;
      if (addresses.has(key)) problem(`I2C address conflict at 0x${device.address.toString(16)}`, ['devices',index,'address']);
      addresses.add(key);
    } else {
      const pins = wiredPins(device);
      if (new Set(pins).size !== pins.length) problem('Peripheral signal pins must be distinct', ['devices',index]);
      for (const pin of pins) {
        if (manifest.buses.length && (pin === 21 || pin === 22)) problem(`GPIO${pin} is reserved for the declared I2C bus; matrix routing is unsupported`, ['devices',index]);
        if (device.type !== 'probe') {
          if (drivers.has(pin)) problem(`Conflicting peripheral wiring on GPIO${pin}`, ['devices',index]);
          drivers.add(pin);
        }
      }
    }
  }
  try { normalizeInputs(manifest.devices, manifest.inputs); } catch (error) { problem(error instanceof Error ? error.message : 'Invalid physical inputs', ['inputs']); }
  const scenarioKeys = new Set<string>();
  for (const [index, scenario] of manifest.scenarios.entries()) {
    const device = manifest.devices.find(device => device.id === scenario.deviceId);
    if (!device || !Object.hasOwn(controls(device.type), scenario.channel)) problem(`Unknown input channel ${scenario.deviceId}.${scenario.channel}`, ['scenarios',index]);
    const key = `${scenario.deviceId}:${scenario.channel}`;
    if (scenarioKeys.has(key)) problem(`Duplicate scenario ${key}`, ['scenarios',index]);
    scenarioKeys.add(key);
  }
  for (const [index, device] of manifest.devices.entries()) {
    const definition = PERIPHERAL_REGISTRY[device.type];
    if ('pullUp' in device && device.pullUp && !device.activeLow && (!('drive' in definition) || definition.drive === 'contact'))
      problem(`${device.id}: a pull-up holds an active-high contact at its asserted level; use activeLow: true or remove pullUp`, ['devices', index, 'pullUp']);
  }
  if (new Set(manifest.gpioInputs.map(input => input.pin)).size !== manifest.gpioInputs.length) problem('Duplicate GPIO input', ['gpioInputs']);
  for (const input of manifest.gpioInputs) if (!manifest.devices.some(device => isPeripheralInput(device) && device.pin === input.pin)) problem(`GPIO${input.pin} input has no declared digital input`, ['gpioInputs']);
}).transform(manifest => ({ ...manifest, inputs: normalizeInputs(manifest.devices, manifest.inputs), gpioInputs: normalizeGpioInputs(manifest.devices, manifest.gpioInputs) }));
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export const EMPTY_MANIFEST: ProjectManifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32' });
export const DEMO_MANIFEST: ProjectManifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }],
  devices: [{ id: 'tmp105', type: 'tmp105', bus: 'i2c0', address: 72 }, { id: 'bh1750', type: 'bh1750', bus: 'i2c0', address: 35 }, { id: 'bme280', type: 'bme280', bus: 'i2c0', address: 118 },
    { id: 'mpu6050', type: 'mpu6050', bus: 'i2c0', address: 104 }, { id: 'status_led', label: 'Status LED', type: 'led', pin: 2, color: 'green' },
    { id: 'rgb', label: 'RGB LED', type: 'rgb', pins: [16,17,23] }, { id: 'button', label: 'Button', type: 'button', pin: 27 },
    { id: 'switch', label: 'Switch', type: 'switch', pin: 26 }, { id: 'probe', label: 'Status probe', type: 'probe', pin: 2 },
    { id: 'pixel', label: 'WS2812 pixel', type: 'ws2812b', pin: 18, length: 1 }, { id: 'strip', label: 'WS2812 strip', type: 'ws2812b', pin: 19, length: 8 },
    { id: 'matrix', label: 'Dot matrix', type: 'max7219', din: 25, clk: 32, load: 33, length: 2 }] });
export function qemuCircuit(manifest: ProjectManifest, inputs: PhysicalInputs = manifest.inputs) {
  const validated = normalizeInputs(manifest.devices, inputs);
  const camera = manifest.devices.find(isCamera), speaker = manifest.devices.find(isSpeaker);
  return { v: 1, devices: manifest.devices.filter(isSensor).map(device => ({ id: device.id, type: device.type, address: device.address, inputs: rawInstance(device.type, validated[device.id]) })),
    ...(camera ? { camera: { id: camera.id, vsync: camera.signals.vsync } } : {}),
    ...(speaker ? { speaker: { id: speaker.id, din: speaker.din, bclk: speaker.bclk, lrclk: speaker.lrclk } } : {}) };
}

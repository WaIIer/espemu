import { z } from 'zod';

export const PIN_NUMBERS = [0,1,2,3,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33,34,35,36,37,38,39];
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).refine(value => !['__proto__','constructor','prototype'].includes(value), 'Reserved instance id');
const pin = z.number().int().refine(value => PIN_NUMBERS.includes(value), 'Invalid or flash-reserved GPIO');
const outputPin = pin.refine(value => value < 34, 'GPIO34-39 are input-only');
const base = { id, label: z.string().min(1).max(40).optional() };
// AI-Thinker ESP32-CAM wiring; -1 means the board does not connect that signal.
export const ESP32_CAM_SIGNALS = { pwdn: 32, reset: -1, xclk: 0, sda: 26, scl: 27, d0: 5, d1: 18, d2: 19, d3: 21, d4: 36, d5: 39, d6: 34, d7: 35, vsync: 25, href: 23, pclk: 22 } as const;
const optionalOutput = z.union([z.literal(-1), outputPin]);
const cameraSignals = z.object({ pwdn: optionalOutput, reset: optionalOutput, xclk: outputPin, sda: outputPin, scl: outputPin,
  d0: pin, d1: pin, d2: pin, d3: pin, d4: pin, d5: pin, d6: pin, d7: pin, vsync: pin, href: pin, pclk: pin }).strict()
  .refine(signals => { const used = Object.values(signals).filter(value => value >= 0); return new Set(used).size === used.length; }, 'Camera signals must use distinct GPIOs')
  .default(ESP32_CAM_SIGNALS);
const flags = { connected: z.boolean().default(true), invalid: z.boolean().default(false) };
// Board or external resistor that holds a released open-collector/contact output HIGH.
const pullUp = { pullUp: z.boolean().optional() };
export type ChannelControl = { label: string; unit: string; minimum: number; maximum: number; step: number; initial: number; rawKey: string; scale: number };
const channel = (label: string, unit: string, minimum: number, maximum: number, step: number, initial: number, rawKey: string, scale = 1): ChannelControl => ({ label, unit, minimum, maximum, step, initial, rawKey, scale });
const temperature = channel('Temperature', 'C', -55, 125, .25, 25, 'temperatureMc', 1000);
const digitalInput = <Type extends string>(type: Type, label: string, momentary = false, activeLow = false, drive: 'push-pull' | 'open-collector' | 'contact' = 'push-pull') => ({
  label, kind: 'gpio' as const, ui: momentary ? 'button' as const : 'switch' as const,
  drive,
  capabilities: [momentary ? 'digital-input-momentary' : 'digital-input-latched', 'active-low'] as const, channels: {},
  config: z.object({ ...base, type: z.literal(type), pin, activeLow: z.boolean().default(activeLow), ...(drive === 'push-pull' ? {} : pullUp) }).strict(),
});

export const PERIPHERAL_REGISTRY = {
  tmp105: { label: 'TMP105', kind: 'i2c', ui: 'sensor', model: 'tmp105', addresses: [72,73,74,75,76,77,78,79],
    capabilities: ['temperature', 'config', 'conversion', 'shutdown', 'one-shot', 'nack'],
    channels: { temperatureC: temperature },
    inputs: z.object({ temperatureC: z.number().min(-55).max(125).default(25), ...flags }).strict(),
    config: z.object({ ...base, type: z.literal('tmp105'), bus: id, address: z.number().int().min(72).max(79) }).strict() },
  bh1750: { label: 'BH1750', kind: 'i2c', ui: 'sensor', model: 'espemu-bh1750', addresses: [35,92],
    capabilities: ['light', 'conversion', 'power', 'measurement-time', 'nack'],
    channels: { lux: channel('Illuminance', 'lx', 0, 54000, 1, 320, 'luxMilli', 1000) },
    inputs: z.object({ lux: z.number().min(0).max(54000).default(320), ...flags }).strict(),
    config: z.object({ ...base, type: z.literal('bh1750'), bus: id, address: z.union([z.literal(35), z.literal(92)]) }).strict() },
  bme280: { label: 'BME280', kind: 'i2c', ui: 'sensor', model: 'espemu-bme280', addresses: [118,119],
    capabilities: ['environment', 'calibration', 'conversion', 'reset', 'nack'],
    channels: { temperatureC: channel('Temperature', 'C', -40, 85, .1, 23, 'temperatureMc', 1000),
      pressurePa: channel('Pressure', 'Pa', 30000, 110000, 1, 101325, 'pressurePa'),
      humidityPct: channel('Humidity', '%RH', 0, 100, .1, 45, 'humidityMilli', 1000) },
    inputs: z.object({ temperatureC: z.number().min(-40).max(85).default(23), pressurePa: z.number().min(30000).max(110000).default(101325), humidityPct: z.number().min(0).max(100).default(45), ...flags }).strict(),
    config: z.object({ ...base, type: z.literal('bme280'), bus: id, address: z.union([z.literal(118), z.literal(119)]) }).strict() },
  mpu6050: { label: 'MPU6050 gyroscope / accelerometer', kind: 'i2c', ui: 'gyro', model: 'espemu-mpu6050', addresses: [104,105],
    capabilities: ['angular-rate', 'acceleration', 'temperature', 'full-scale', 'sample-rate', 'sleep', 'reset', 'nack'],
    channels: {
      gyroXdps: channel('Rotation X', 'deg/s', -2000, 2000, .1, 0, 'gyroXmilliDps', 1000),
      gyroYdps: channel('Rotation Y', 'deg/s', -2000, 2000, .1, 0, 'gyroYmilliDps', 1000),
      gyroZdps: channel('Rotation Z', 'deg/s', -2000, 2000, .1, 0, 'gyroZmilliDps', 1000),
      accelXg: channel('Acceleration X', 'g', -16, 16, .01, 0, 'accelXmilliG', 1000),
      accelYg: channel('Acceleration Y', 'g', -16, 16, .01, 0, 'accelYmilliG', 1000),
      accelZg: channel('Acceleration Z', 'g', -16, 16, .01, 1, 'accelZmilliG', 1000),
      temperatureC: channel('Temperature', 'C', -40, 85, .1, 25, 'temperatureMc', 1000),
    },
    inputs: z.object({ gyroXdps: z.number().min(-2000).max(2000).default(0), gyroYdps: z.number().min(-2000).max(2000).default(0), gyroZdps: z.number().min(-2000).max(2000).default(0),
      accelXg: z.number().min(-16).max(16).default(0), accelYg: z.number().min(-16).max(16).default(0), accelZg: z.number().min(-16).max(16).default(1), temperatureC: z.number().min(-40).max(85).default(25), ...flags }).strict(),
    config: z.object({ ...base, type: z.literal('mpu6050'), bus: id, address: z.union([z.literal(104), z.literal(105)]) }).strict() },
  led: { label: 'LED', kind: 'gpio', ui: 'led', capabilities: ['digital-output', 'active-low'], channels: {},
    config: z.object({ ...base, type: z.literal('led'), pin: outputPin, activeLow: z.boolean().default(false), color: z.enum(['red','green','blue','amber','white']).default('red') }).strict() },
  rgb: { label: 'RGB LED', kind: 'gpio', ui: 'rgb', capabilities: ['digital-rgb', 'active-low'], channels: {},
    config: z.object({ ...base, type: z.literal('rgb'), pins: z.tuple([outputPin,outputPin,outputPin]).refine(pins => new Set(pins).size === 3, 'RGB pins must be distinct'), activeLow: z.boolean().default(false) }).strict() },
  button: { label: 'Button', kind: 'gpio', ui: 'button', capabilities: ['digital-input', 'momentary'], channels: {},
    config: z.object({ ...base, type: z.literal('button'), pin, activeLow: z.boolean().default(true), ...pullUp }).strict() },
  switch: { label: 'Switch', kind: 'gpio', ui: 'switch', capabilities: ['digital-input', 'latched'], channels: {},
    config: z.object({ ...base, type: z.literal('switch'), pin, activeLow: z.boolean().default(false), ...pullUp }).strict() },
  probe: { label: 'Logic probe', kind: 'gpio', ui: 'probe', capabilities: ['digital-observation'], channels: {},
    config: z.object({ ...base, type: z.literal('probe'), pin, activeLow: z.boolean().default(false) }).strict() },
  ws2812b: { label: 'WS2812B pixel / strip', kind: 'rmt', ui: 'ws2812b', capabilities: ['rmt-tx','grb24','addressable-pixels'], channels: {},
    config: z.object({ ...base, type: z.literal('ws2812b'), pin: outputPin, length: z.number().int().min(1).max(1024).default(1), activeLow: z.literal(false).default(false) }).strict() },
  max7219: { label: 'MAX7219 dot matrix', kind: 'serial', ui: 'matrix', capabilities: ['gpio-serial','8x8-matrix','daisy-chain','code-b','scan-limit','intensity','shutdown','display-test'], channels: {},
    config: z.object({ ...base, type: z.literal('max7219'), din: outputPin, clk: outputPin, load: outputPin,
      length: z.number().int().min(1).max(16).default(1), color: z.enum(['red','green','blue','amber','white']).default('red'),
      activeLow: z.literal(false).default(false) }).strict() },
  hc_sr501: digitalInput('hc_sr501', 'HC-SR501 PIR motion sensor'),
  hc_sr505: digitalInput('hc_sr505', 'HC-SR505 mini PIR sensor'),
  rcwl_0516: digitalInput('rcwl_0516', 'RCWL-0516 microwave motion sensor'),
  ttp223: digitalInput('ttp223', 'TTP223 capacitive touch sensor', true),
  a3144: digitalInput('a3144', 'A3144 Hall-effect switch', false, true, 'open-collector'),
  ss451a: digitalInput('ss451a', 'SS451A Hall-effect latch', false, true, 'open-collector'),
  sw_520d: digitalInput('sw_520d', 'SW-520D tilt switch', false, true, 'contact'),
  sw_420: digitalInput('sw_420', 'SW-420 vibration sensor (DOUT)', false, true, 'open-collector'),
  ky_032: digitalInput('ky_032', 'KY-032 infrared obstacle sensor', false, true, 'open-collector'),
  ky_026: digitalInput('ky_026', 'KY-026 flame sensor (DOUT)', false, true, 'open-collector'),
  fc_37: digitalInput('fc_37', 'FC-37 rain sensor (DOUT)', false, true, 'open-collector'),
  yl_69: digitalInput('yl_69', 'YL-69 soil moisture sensor (DOUT)', false, true, 'open-collector'),
  mq_2: digitalInput('mq_2', 'MQ-2 gas sensor (DOUT)', false, true, 'open-collector'),
  mq_135: digitalInput('mq_135', 'MQ-135 air-quality sensor (DOUT)', false, true, 'open-collector'),
  ky_038: digitalInput('ky_038', 'KY-038 sound sensor (DOUT)', false, false, 'open-collector'),
  st188: digitalInput('st188', 'ST188 reflective sensor (DOUT)', false, true, 'open-collector'),
  reed_59170: digitalInput('reed_59170', 'Littelfuse 59170 reed switch', false, true, 'contact'),
  sn04_n: digitalInput('sn04_n', 'SN04-N inductive proximity sensor', false, true, 'open-collector'),
  lj12a3: digitalInput('lj12a3', 'LJ12A3-4-Z/BX inductive sensor', false, true, 'open-collector'),
  e18_d80nk: digitalInput('e18_d80nk', 'E18-D80NK infrared proximity sensor', false, true, 'open-collector'),
  // New types are appended so numbered wizard answers in existing scripts keep their meaning.
  sht3x: { label: 'SHT3x humidity / temperature (SHT30/31/35)', kind: 'i2c', ui: 'sensor', model: 'espemu-sht3x', addresses: [68,69],
    capabilities: ['temperature', 'humidity', 'single-shot', 'crc', 'heater-status', 'reset', 'nack'],
    channels: { temperatureC: channel('Temperature', 'C', -40, 125, .01, 25, 'temperatureMc', 1000),
      humidityPct: channel('Humidity', '%RH', 0, 100, .01, 45, 'humidityMilli', 1000) },
    inputs: z.object({ temperatureC: z.number().min(-40).max(125).default(25), humidityPct: z.number().min(0).max(100).default(45), ...flags }).strict(),
    config: z.object({ ...base, type: z.literal('sht3x'), bus: id, address: z.union([z.literal(68), z.literal(69)]) }).strict() },
  max98357a: { label: 'MAX98357A I2S speaker amplifier', kind: 'i2s', ui: 'speaker', capabilities: ['i2s-tx-dma', 'pcm16', 'pcm32', 'mono-mix'], channels: {},
    config: z.object({ ...base, type: z.literal('max98357a'), din: outputPin, bclk: outputPin, lrclk: outputPin }).strict() },
  hd44780: { label: 'HD44780 character LCD (PCF8574 I2C backpack)', kind: 'i2c', ui: 'lcd', model: 'espemu-hd44780', addresses: [39,63,32,33,34,35,36,37,38,56,57,58,59,60,61,62],
    capabilities: ['character-display', '4-bit-interface', 'busy-flag', 'cgram', 'display-shift', 'backlight', 'nack'], channels: {},
    inputs: z.object(flags).strict(),
    config: z.object({ ...base, type: z.literal('hd44780'), bus: id, address: z.number().int().refine(value => (value >= 32 && value <= 39) || (value >= 56 && value <= 63), 'PCF8574 uses 0x20-0x27, PCF8574A uses 0x38-0x3f'), size: z.enum(['16x2', '20x4']).default('16x2') }).strict() },
  ov2640: { label: 'OV2640 camera (ESP32-CAM)', kind: 'camera', ui: 'camera', model: 'espemu-ov2640', sccbAddress: 0x30,
    capabilities: ['sccb', 'dvp-8bit', 'i2s0-camera-dma', 'jpeg', 'rgb565', 'yuv422', 'vsync-interrupt'], channels: {},
    config: z.object({ ...base, type: z.literal('ov2640'), signals: cameraSignals }).strict() },
} as const;
export type DeviceType = keyof typeof PERIPHERAL_REGISTRY;
export type CameraSignals = z.infer<typeof cameraSignals>;
export type CircuitDevice = { [Key in DeviceType]: z.infer<(typeof PERIPHERAL_REGISTRY)[Key]['config']> }[DeviceType];
export type PhysicalInputs = Record<string, Record<string, number | boolean>>;
export function wiredPins(device: { pin: number } | { pins: readonly number[] } | { din: number; clk: number; load: number } | { din: number; bclk: number; lrclk: number } | { signals: CameraSignals }): readonly number[] {
  return 'lrclk' in device ? [device.din, device.bclk, device.lrclk] : 'signals' in device ? Object.values(device.signals).filter(value => value >= 0) : 'pins' in device ? device.pins : 'din' in device ? [device.din, device.clk, device.load] : [device.pin];
}
export function isCamera(device: CircuitDevice): device is Extract<CircuitDevice, { type: 'ov2640' }> { return device.type === 'ov2640'; }
export function isSpeaker(device: CircuitDevice): device is Extract<CircuitDevice, { type: 'max98357a' }> { return device.type === 'max98357a'; }
export function controls(type: DeviceType): Record<string, ChannelControl> { return PERIPHERAL_REGISTRY[type].channels; }
export function isSensor(device: CircuitDevice): device is Extract<CircuitDevice, { bus: string }> { return PERIPHERAL_REGISTRY[device.type].kind === 'i2c'; }
export function peripheralFamily(type: DeviceType) {
  return PERIPHERAL_REGISTRY[type].ui;
}
export const PERIPHERAL_GROUPS = ['I2C sensors', 'Outputs and displays', 'Buttons, switches and probes', 'Digital sensor modules', 'Cameras'] as const;
export function peripheralGroup(type: DeviceType): (typeof PERIPHERAL_GROUPS)[number] {
  const definition = PERIPHERAL_REGISTRY[type];
  if (definition.ui === 'lcd') return 'Outputs and displays';
  if (definition.kind === 'i2c') return 'I2C sensors';
  if (definition.kind === 'camera') return 'Cameras';
  if ('drive' in definition) return 'Digital sensor modules';
  const family = peripheralFamily(type);
  return family === 'button' || family === 'switch' || family === 'probe' ? 'Buttons, switches and probes' : 'Outputs and displays';
}
export function isPeripheralInput(device: CircuitDevice): device is Extract<CircuitDevice, { pin: number }> {
  const family = peripheralFamily(device.type);
  return family === 'button' || family === 'switch';
}
export function digitalInputLevel(type: DeviceType, activeLow: boolean, asserted: boolean, pullUp = false): 0 | 1 | null {
  const definition = PERIPHERAL_REGISTRY[type];
  const drive = 'drive' in definition ? definition.drive : 'contact';
  const level = (activeLow ? !asserted : asserted) ? 1 : 0;
  if ((drive === 'contact' && !asserted) || (drive === 'open-collector' && level === 1)) return pullUp ? 1 : null;
  return level;
}
export function normalizeGpioInputs(devices: CircuitDevice[], provided: { pin: number; level: 0 | 1 | null }[]) {
  const inputs = provided.map(input => ({ ...input }));
  for (const device of devices) {
    const definition = PERIPHERAL_REGISTRY[device.type];
    if (!isPeripheralInput(device) || inputs.some(input => input.pin === device.pin)) continue;
    const pulled = 'pullUp' in device && device.pullUp === true;
    if (!('drive' in definition) && !pulled) continue;
    const level = digitalInputLevel(device.type, device.activeLow, false, pulled);
    if (level !== null) inputs.push({ pin: device.pin, level });
  }
  return inputs;
}
export function normalizeInputs(devices: CircuitDevice[], value: unknown): PhysicalInputs {
  const values = z.record(z.unknown()).parse(value);
  const sensors = devices.filter(isSensor);
  for (const key of Object.keys(values)) if (!sensors.some(device => device.id === key)) throw new Error(`Unknown physical-input instance: ${key}`);
  return Object.fromEntries(sensors.map(device => {
    const definition = PERIPHERAL_REGISTRY[device.type];
    return [device.id, definition.inputs.parse(values[device.id] ?? {})];
  }));
}
export function rawInstance(type: DeviceType, value: Record<string, number | boolean>) {
  const result: Record<string, number | boolean> = { connected: value.connected, invalid: value.invalid };
  for (const [key, control] of Object.entries(controls(type))) result[control.rawKey] = Math.round(Number(value[key]) * control.scale);
  return result;
}

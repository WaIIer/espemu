import { z } from 'zod';
import { ApplicationChannelSchema } from './application.ts';
import { wiredPins } from './registry.ts';

export const GPIO_PINS = [0,1,2,3,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33,34,35,36,37,38,39] as const;
export const GpioPinNumberSchema = z.number().int().refine(pin => (GPIO_PINS as readonly number[]).includes(pin), 'Invalid or flash-reserved ESP32 pin');
export const GpioInputSchema = z.object({ pin: GpioPinNumberSchema, level: z.union([z.literal(0), z.literal(1), z.null()]) }).strict();
export const GpioInputsSchema = z.array(GpioInputSchema).max(28).refine(pins => new Set(pins.map(pin => pin.pin)).size === pins.length, 'Duplicate GPIO input');
export const GpioStateSchema = z.object({
  v: z.literal(1), virtualMs: z.number().nonnegative(),
  pins: z.array(z.object({ pin: z.number().int().min(0).max(39), level: z.union([z.literal(0), z.literal(1)]),
    outputLatch: z.union([z.literal(0), z.literal(1)]), outputEnabled: z.boolean(), externallyDriven: z.boolean(),
    openDrain: z.boolean(), pullUp: z.boolean(), pullDown: z.boolean(), contended: z.boolean() }).strict()).max(40),
}).strict();
export type GpioState = z.infer<typeof GpioStateSchema>;
const peripheralBase = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/), label: z.string().min(1).max(40), activeLow: z.boolean() };
const digitalKinds = [
  'hc_sr501','hc_sr505','rcwl_0516','ttp223','a3144','ss451a','sw_520d','sw_420','ky_032','ky_026',
  'fc_37','yl_69','mq_2','mq_135','ky_038','st188','reed_59170','sn04_n','lj12a3','e18_d80nk',
] as const;
export const PeripheralSchema = z.discriminatedUnion('kind', [
  z.object({ ...peripheralBase, kind: z.literal('led'), pin: GpioPinNumberSchema, color: z.enum(['red','green','blue','amber','white']) }).strict(),
  z.object({ ...peripheralBase, kind: z.literal('rgb'), pins: z.tuple([GpioPinNumberSchema, GpioPinNumberSchema, GpioPinNumberSchema]) }).strict(),
  z.object({ ...peripheralBase, kind: z.enum(['button','switch','probe']), pin: GpioPinNumberSchema, pullUp: z.boolean().optional() }).strict(),
  z.object({ ...peripheralBase, kind: z.enum(digitalKinds), pin: GpioPinNumberSchema, pullUp: z.boolean().optional() }).strict(),
  z.object({ ...peripheralBase, kind: z.literal('ws2812b'), pin: GpioPinNumberSchema, length: z.number().int().min(1).max(1024), activeLow: z.literal(false) }).strict(),
  z.object({ ...peripheralBase, kind: z.literal('max7219'), din: GpioPinNumberSchema, clk: GpioPinNumberSchema, load: GpioPinNumberSchema,
    length: z.number().int().min(1).max(16), color: z.enum(['red','green','blue','amber','white']), activeLow: z.literal(false) }).strict(),
]);
export const PeripheralsSchema = z.array(PeripheralSchema).max(32).superRefine((devices, context) => {
  if (new Set(devices.map(device => device.id)).size !== devices.length) context.addIssue({ code: 'custom', message: 'Duplicate peripheral id' });
  for (const device of devices) {
    const pins = wiredPins(device);
    if (new Set(pins).size !== pins.length) context.addIssue({ code: 'custom', message: 'Peripheral signals require distinct pins' });
    if ((device.kind === 'led' || device.kind === 'rgb' || device.kind === 'ws2812b' || device.kind === 'max7219') && pins.some(pin => pin >= 34)) context.addIssue({ code: 'custom', message: 'GPIO34-39 are input-only' });
  }
});
export type Peripheral = z.infer<typeof PeripheralSchema>;
export type GpioInput = z.infer<typeof GpioInputSchema>;

export const DeviceIdSchema = z.enum(['tmp105', 'bh1750', 'bme280']);
export type DeviceId = z.infer<typeof DeviceIdSchema>;
const faults = { connected: z.boolean(), invalid: z.boolean() };
export const InputsSchema = z.object({
  tmp105: z.object({ temperatureC: z.number().min(-55).max(125), ...faults }).strict(),
  bh1750: z.object({ lux: z.number().min(0).max(54000), ...faults }).strict(),
  bme280: z.object({ temperatureC: z.number().min(-40).max(85), pressurePa: z.number().min(30000).max(110000), humidityPct: z.number().min(0).max(100), ...faults }).strict(),
}).strict();
export type InputSnapshot = z.infer<typeof InputsSchema>;
export const DEFAULT_INPUTS: InputSnapshot = {
  tmp105: { temperatureC: 25, connected: true, invalid: false },
  bh1750: { lux: 320, connected: true, invalid: false },
  bme280: { temperatureC: 23, pressurePa: 101325, humidityPct: 45, connected: true, invalid: false },
};

const reading = z.number().finite().nullable();
export const FirmwareSampleSchema = z.object({
  v: z.literal(1), seq: z.number().int().nonnegative(), guestUs: z.number().int().nonnegative(),
  tmp105: z.object({ temperatureC: reading, error: z.number().int() }).optional(),
  bh1750: z.object({ lux: reading, error: z.number().int() }).optional(),
  bme280: z.object({ temperatureC: reading, pressurePa: reading, humidityPct: reading, error: z.number().int() }).optional(),
  channels: z.record(ApplicationChannelSchema).optional(),
}).passthrough();
export type FirmwareSample = z.infer<typeof FirmwareSampleSchema>;
export type Channel = 'temperatureC' | 'lux' | 'pressurePa' | 'humidityPct';
export const CHANNELS: Record<DeviceId, Channel[]> = {
  tmp105: ['temperatureC'], bh1750: ['lux'], bme280: ['temperatureC', 'pressurePa', 'humidityPct'],
};
export const ScenarioSchema = z.object({
  deviceId: DeviceIdSchema,
  channel: z.enum(['temperatureC', 'lux', 'pressurePa', 'humidityPct']),
  kind: z.enum(['manual', 'ramp', 'sine', 'noise', 'playback']),
  offset: z.number().finite(), amplitude: z.number().finite().nonnegative(),
  periodMs: z.number().min(100).max(3600000), seed: z.number().int().min(0).max(4294967295),
  frames: z.array(z.object({ timeMs: z.number().nonnegative(), value: z.number().finite() })).max(10000).default([]),
}).strict().superRefine((scenario, context) => {
  if (!CHANNELS[scenario.deviceId].includes(scenario.channel)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Channel does not exist on this device' });
  if (scenario.kind === 'playback' && scenario.frames.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Playback requires frames' });
  if (scenario.frames.some((frame, index) => index > 0 && frame.timeMs <= scenario.frames[index - 1].timeMs)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Playback timestamps must increase' });
});
export type Scenario = z.infer<typeof ScenarioSchema>;
const commandBase = { v: z.literal(1), id: z.string().min(1).max(100), epoch: z.number().int().nonnegative() };
export const CommandSchema = z.discriminatedUnion('action', [
  z.object({ ...commandBase, action: z.literal('inputs'), inputs: InputsSchema }).strict(),
  z.object({ ...commandBase, action: z.literal('scenario'), scenario: ScenarioSchema }).strict(),
  z.object({ ...commandBase, action: z.literal('gpio-inputs'), pins: GpioInputsSchema }).strict(),
  z.object({ ...commandBase, action: z.literal('peripherals'), peripherals: PeripheralsSchema }).strict(),
  z.object({ ...commandBase, action: z.enum(['run', 'pause', 'reset', 'stop']) }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export type Phase = 'starting' | 'running' | 'paused' | 'stopped' | 'error';
export interface EventEntry {
  seq: number; epoch: number; virtualMs: number; wallMs: number;
  source: 'i2c' | 'gpio' | 'control' | 'firmware' | 'system'; message: string;
}
export interface SamplePoint extends FirmwareSample { epoch: number; wallMs: number; virtualMs: number }
export interface SessionState {
  v: 1; epoch: number; phase: Phase; wallMs: number; virtualMs: number;
  inputs: InputSnapshot; latest: SamplePoint | null; history: SamplePoint[];
  events: EventEntry[]; console: string[]; scenarios: Scenario[]; error: string | null;
  gpio?: GpioState | null; gpioWallMs?: number; gpioInputs?: GpioInput[]; peripherals?: Peripheral[]; gpioError?: string | null;
  metrics: { samples: number; droppedFrames: number; qemuRssMb: number; latencyP95Ms: number | null; latencyCount: number };
}
export type ServerMessage = { v: 1; type: 'state'; state: SessionState }
  | { v: 1; type: 'ack'; id: string; epoch: number; ok: boolean; error?: string };

export const TOPOLOGY = {
  v: 1, target: 'esp32', clockHz: 100000,
  bus: { id: 'i2c0', sda: 21, scl: 22, routing: 'logical bus; pin matrix not emulated' },
  devices: [
    { id: 'tmp105', name: 'TMP105', address: 0x48, channels: ['temperatureC'], conversionMs: 55 },
    { id: 'bh1750', name: 'BH1750', address: 0x23, channels: ['lux'], conversionMs: 120 },
    { id: 'bme280', name: 'BME280', address: 0x76, channels: ['temperatureC', 'pressurePa', 'humidityPct'], conversionMs: 10 },
  ],
  limitations: ['Classic ESP32 only', 'Logical I2C, not electrical or cycle-accurate', 'No GPIO matrix/IOMUX, Wi-Fi, Bluetooth, GP SPI, or ADC', 'Full VM migration/replay is not supported'],
} as const;

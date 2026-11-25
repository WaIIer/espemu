import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { FirmwareSampleSchema, InputsSchema, type FirmwareSample, type InputSnapshot } from '../shared/protocol.ts';

const rawFaults = { connected: z.boolean(), invalid: z.boolean() };
export const RawInputsSchema = z.object({
  v: z.literal(1),
  tmp105: z.object({ temperatureMc: z.number().int().min(-55000).max(125000), ...rawFaults }).strict(),
  bh1750: z.object({ luxMilli: z.number().int().min(0).max(54000000), ...rawFaults }).strict(),
  bme280: z.object({ temperatureMc: z.number().int().min(-40000).max(85000), pressurePa: z.number().int().min(30000).max(110000), humidityMilli: z.number().int().min(0).max(100000), ...rawFaults }).strict(),
}).strict();
export const PhysicalStateSchema = z.object({
  v: z.literal(1), virtualMs: z.number().finite().nonnegative(), inputs: RawInputsSchema,
}).strict();
export const TraceSchema = z.object({
  v: z.literal(1), events: z.array(z.object({
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    virtualMs: z.number().finite().nonnegative(), address: z.number().int().min(0).max(127),
    read: z.boolean(), length: z.number().int().nonnegative().max(65536), status: z.enum(['ok', 'nack']),
  }).strict()).max(128),
}).strict();

export function rawInputs(inputs: InputSnapshot): z.infer<typeof RawInputsSchema> {
  const validated = InputsSchema.parse(inputs);
  return {
    v: 1,
    tmp105: { temperatureMc: Math.round(validated.tmp105.temperatureC * 1000), connected: validated.tmp105.connected, invalid: validated.tmp105.invalid },
    bh1750: { luxMilli: Math.round(validated.bh1750.lux * 1000), connected: validated.bh1750.connected, invalid: validated.bh1750.invalid },
    bme280: { temperatureMc: Math.round(validated.bme280.temperatureC * 1000), pressurePa: Math.round(validated.bme280.pressurePa), humidityMilli: Math.round(validated.bme280.humidityPct * 1000), connected: validated.bme280.connected, invalid: validated.bme280.invalid },
  };
}

export function physicalInputs(raw: z.infer<typeof RawInputsSchema>): InputSnapshot {
  const validated = RawInputsSchema.parse(raw);
  return InputsSchema.parse({
    tmp105: { temperatureC: validated.tmp105.temperatureMc / 1000, connected: validated.tmp105.connected, invalid: validated.tmp105.invalid },
    bh1750: { lux: validated.bh1750.luxMilli / 1000, connected: validated.bh1750.connected, invalid: validated.bh1750.invalid },
    bme280: { temperatureC: validated.bme280.temperatureMc / 1000, pressurePa: validated.bme280.pressurePa, humidityPct: validated.bme280.humidityMilli / 1000, connected: validated.bme280.connected, invalid: validated.bme280.invalid },
  });
}

export class LineBuffer {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private discarding = false;

  constructor(private readonly line: (value: string) => void, private readonly dropped: () => void, private readonly limit = 16384) {}

  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(start, end);
      if (!this.discarding) {
        if (this.buffer.length + segment.length > this.limit) {
          this.buffer = '';
          this.discarding = true;
          this.dropped();
        } else this.buffer += segment;
      }
      if (newline < 0) break;
      if (!this.discarding) this.line(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
      this.discarding = false;
      start = newline + 1;
    }
  }

  reset(): void {
    if (this.buffer || this.discarding) this.dropped();
    this.buffer = '';
    this.discarding = false;
    this.decoder = new StringDecoder('utf8');
  }
}

export function parseFirmwareLine(line: string): FirmwareSample | null {
  if (!line.startsWith('ESP_EMU ')) return null;
  try {
    return FirmwareSampleSchema.parse(JSON.parse(line.slice(8)));
  } catch {
    return null;
  }
}

export function matchesObservation(inputs: InputSnapshot, sample: FirmwareSample, devices: (keyof InputSnapshot)[]): boolean {
  return devices.every(deviceId => {
    const input = inputs[deviceId];
    const observed = sample[deviceId];
    if (!observed || !input.connected || input.invalid || observed.error !== 0) return false;
    if (deviceId === 'tmp105') return sample.tmp105?.temperatureC != null && Math.abs(sample.tmp105.temperatureC - inputs.tmp105.temperatureC) <= 0.250001;
    if (deviceId === 'bh1750') return sample.bh1750?.lux != null && Math.abs(sample.bh1750.lux - inputs.bh1750.lux) <= 0.834;
    const bme = sample.bme280;
    return bme?.temperatureC != null && bme.pressurePa !== null && bme.humidityPct !== null
      && Math.abs(bme.temperatureC - inputs.bme280.temperatureC) <= 0.05
      && Math.abs(bme.pressurePa - inputs.bme280.pressurePa) <= 5
      && Math.abs(bme.humidityPct - inputs.bme280.humidityPct) <= 0.1;
  });
}

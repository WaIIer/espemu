import { z } from 'zod';
import { PERIPHERAL_REGISTRY, controls, type DeviceType } from './registry.ts';

export const ApplicationChannelSchema = z.object({ value: z.number().finite().nullable(), unit: z.string().max(30).default('') }).strict();
export const ApplicationSampleSchema = z.object({ v: z.literal(1), seq: z.number().int().nonnegative(), guestUs: z.number().nonnegative().default(0),
  channels: z.record(z.string().min(1).max(150), ApplicationChannelSchema).refine(channels => Object.keys(channels).length <= 64, 'Too many application channels'),
}).strict();
export type ApplicationSample = z.infer<typeof ApplicationSampleSchema>;

export function parseApplicationLine(line: string): ApplicationSample | null {
  if (!line.startsWith('ESP_EMU ')) return null;
  try {
    const raw = JSON.parse(line.slice(8));
    const direct = ApplicationSampleSchema.safeParse(raw);
    if (direct.success) return direct.data;
    if (raw && Object.hasOwn(raw, 'channels')) return null;
    if (!raw || raw.v !== 1 || !Number.isInteger(raw.seq) || raw.seq < 0) return null;
    const channels: ApplicationSample['channels'] = {};
    for (const [name, value] of Object.entries(raw)) {
      if (name === 'v' || name === 'seq' || name === 'guestUs') continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const metadata = Object.hasOwn(PERIPHERAL_REGISTRY, name) ? controls(name as DeviceType) : {};
      for (const [channel, sample] of Object.entries(record)) {
        if (channel === 'error' || (sample !== null && typeof sample !== 'number')) continue;
        channels[`${name}.${channel}`] = { value: record.error && record.error !== 0 ? null : sample as number | null, unit: metadata[channel]?.unit ?? '' };
      }
    }
    return ApplicationSampleSchema.parse({ v: 1, seq: raw.seq, guestUs: raw.guestUs ?? 0, channels });
  } catch { return null; }
}

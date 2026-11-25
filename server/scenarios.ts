import { z } from 'zod';
import { InputsSchema, ScenarioSchema, type InputSnapshot, type Scenario } from '../shared/protocol.ts';
import type { CircuitScenario } from '../shared/manifest.ts';

export const MAX_SCENARIO_BYTES = 256 * 1024;

export const SessionFileSchema = z.object({
  v: z.literal(1), inputs: InputsSchema, scenarios: z.array(ScenarioSchema).max(6),
}).strict().superRefine((file, context) => {
  const keys = file.scenarios.map(scenario => `${scenario.deviceId}:${scenario.channel}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate scenario channel' });
  if (Buffer.byteLength(JSON.stringify(file.scenarios)) > MAX_SCENARIO_BYTES) context.addIssue({ code: 'custom', message: 'Scenario data exceeds limit' });
});

const ranges = {
  tmp105: { temperatureC: [-55, 125] },
  bh1750: { lux: [0, 54000] },
  bme280: { temperatureC: [-40, 85], pressurePa: [30000, 110000], humidityPct: [0, 100] },
} as const;

export function noiseAt(seed: number, tick: number): number {
  let hash = (seed ^ Math.imul(tick >>> 0, 0x9e3779b9)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967295 * 2 - 1;
}

export function scenarioValue(scenario: CircuitScenario, virtualMs: number): number | undefined {
  const time = Math.max(0, virtualMs);
  switch (scenario.kind) {
    case 'manual': return undefined;
    case 'ramp': return scenario.offset + scenario.amplitude * (time % scenario.periodMs) / scenario.periodMs;
    case 'sine': return scenario.offset + scenario.amplitude * Math.sin(2 * Math.PI * time / scenario.periodMs);
    case 'noise': return scenario.offset + scenario.amplitude * noiseAt(scenario.seed, Math.floor(time / 100));
    case 'playback': {
      const frames = scenario.frames;
      if (time <= frames[0].timeMs) return frames[0].value;
      let lower = 0;
      let upper = frames.length - 1;
      if (time >= frames[upper].timeMs) return frames[upper].value;
      while (upper - lower > 1) {
        const middle = Math.floor((lower + upper) / 2);
        if (frames[middle].timeMs <= time) lower = middle;
        else upper = middle;
      }
      const fraction = (time - frames[lower].timeMs) / (frames[upper].timeMs - frames[lower].timeMs);
      return frames[lower].value + (frames[upper].value - frames[lower].value) * fraction;
    }
  }
}

export function applyScenarios(inputs: InputSnapshot, scenarios: Scenario[], virtualMs: number): InputSnapshot {
  const next = structuredClone(inputs);
  for (const scenario of scenarios) {
    const value = scenarioValue(scenario, virtualMs);
    if (value === undefined) continue;
    const deviceRanges = ranges[scenario.deviceId] as Partial<Record<Scenario['channel'], readonly [number, number]>>;
    const range = deviceRanges[scenario.channel];
    if (!range) throw new Error('Channel does not exist on this device');
    const device = next[scenario.deviceId] as unknown as Record<string, number | boolean>;
    device[scenario.channel] = Math.min(range[1], Math.max(range[0], value));
  }
  return InputsSchema.parse(next);
}

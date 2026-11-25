import { z } from 'zod';
import { DEMO_MANIFEST, ProjectManifestSchema } from './manifest.ts';
import { devicePinsHeader } from './device-pins.ts';

export const ProjectCreatorConfigSchema = z.object({
  v: z.literal(1),
  starter: z.enum(['empty', 'blinky', 'demo']),
  language: z.enum(['c', 'cpp']).default('c'),
  manifest: ProjectManifestSchema,
  blink: z.object({
    deviceId: z.string().min(1).max(50),
    intervalMs: z.number().int().min(1).max(60000),
  }).strict().optional(),
}).strict().superRefine((config, context) => {
  if (config.starter === 'demo') {
    if (!config.manifest.buses.some(bus => bus.id === 'i2c0')) context.addIssue({ code: 'custom', path: ['manifest','buses'], message: 'The bundled demo needs its i2c0 bus name. Use Empty for custom firmware.' });
    for (const required of DEMO_MANIFEST.devices) {
      const device = config.manifest.devices.find(device => device.id === required.id);
      if (!device || device.type !== required.type) context.addIssue({ code: 'custom', path: ['manifest','devices'], message: `The bundled demo needs ${required.id} (${required.type}). Use Empty for a custom circuit.` });
      if (device && (device.type === 'button' || device.type === 'switch') && device.pin >= 34) context.addIssue({ code: 'custom', path: ['manifest','devices'], message: `The bundled demo's ${device.id} uses an internal pull resistor and needs GPIO0-33.` });
    }
  }
  if (config.starter === 'blinky') {
    if (!config.blink || !config.manifest.devices.some(device => device.id === config.blink?.deviceId && device.type === 'led')) {
      context.addIssue({ code: 'custom', path: ['blink'], message: 'Blinky requires a declared LED and blink settings.' });
    }
  } else if (config.blink) {
    context.addIssue({ code: 'custom', path: ['blink'], message: 'Blink settings require the blinky starter.' });
  }
  try { devicePinsHeader(config.manifest); }
  catch (error) { context.addIssue({ code: 'custom', path: ['manifest', 'devices'], message: error instanceof Error ? error.message : 'Invalid device pin names.' }); }
});

export type ProjectCreatorConfig = z.infer<typeof ProjectCreatorConfigSchema>;

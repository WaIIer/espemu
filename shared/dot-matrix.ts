import { z } from 'zod';

const byte = z.number().int().min(0).max(255);
const rows = z.array(byte).length(8);
export const Max7219ModuleSchema = z.object({
  digits: rows, rows, decodeMode: byte, intensity: z.number().int().min(0).max(15),
  scanLimit: z.number().int().min(0).max(7), shutdown: z.boolean(), displayTest: z.boolean(),
  duty32: z.number().int().min(1).max(31), shift: z.number().int().min(0).max(65535), dout: z.boolean(),
}).strict();
export const Max7219StateSchema = z.object({
  v: z.literal(1), virtualMs: z.number().nonnegative(),
  devices: z.array(z.object({
    id: z.string().min(1).max(50), din: z.number().int(), clk: z.number().int(), load: z.number().int(),
    length: z.number().int().min(1).max(16), latches: z.number().int().nonnegative(),
    modules: z.array(Max7219ModuleSchema).min(1).max(16),
  }).strict().refine(device => device.modules.length === device.length, 'MAX7219 module count mismatch')).max(8),
}).strict().refine(state => new Set(state.devices.map(device => device.id)).size === state.devices.length, 'Duplicate MAX7219 state id');
export type Max7219State = z.infer<typeof Max7219StateSchema>;
export type Max7219Module = z.infer<typeof Max7219ModuleSchema>;

export function matrixPixel(module: Max7219Module | undefined, row: number, column: number) {
  return !!module && !!(module.rows[row] & (0x80 >> column));
}

export function matrixDuty(module: Max7219Module) {
  return module.duty32 / (32 * (module.displayTest ? 8 : module.scanLimit + 1));
}

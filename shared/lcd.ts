import { z } from 'zod';

const hexBytes = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
export const LcdStateSchema = z.object({
  status: z.string(), backlight: z.boolean(), displayOn: z.boolean(), cursor: z.boolean(), blink: z.boolean(),
  twoLines: z.boolean(), font5x10: z.boolean(), eightBit: z.boolean(), cgramSelected: z.boolean(),
  addressCounter: z.number().int().min(0).max(127), shift: z.number().int().min(0).max(79),
  ddram: hexBytes(80), cgram: hexBytes(64),
  instructions: z.number().int().nonnegative(), dataWrites: z.number().int().nonnegative(), ignoredWhileBusy: z.number().int().nonnegative(),
}).passthrough();
export type LcdState = z.infer<typeof LcdStateSchema>;

// HD44780U character ROM A00 (Japanese) upper half: 0xA1-0xDF half-width katakana, 0xE0-0xFF symbols.
const A00_HIGH = '。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛°αäβεμσρg√⁻j×¢£ñöpqθ∞ΩüΣπxy千万円÷ █';

/** Unicode for a ROM character code, or null for CGRAM codes 0-15 that are drawn from their bitmap. */
export function lcdCharacter(code: number): string | null {
  if (code < 16) return null;
  if (code === 0x5c) return '¥';
  if (code === 0x7e) return '→';
  if (code === 0x7f) return '←';
  if (code >= 0x20 && code < 0x7e) return String.fromCharCode(code);
  if (code >= 0xa1) return [...A00_HIGH][code - 0xa1] ?? ' ';
  return ' ';
}

const bytes = (hex: string) => Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));

export type LcdCell = { code: number; character: string | null; glyph: number[] | null; cursor: boolean };

/** Visible cells for a columns x rows module; row 2/3 continue DDRAM lines 0/1 on four-line modules. */
export function lcdCells(state: LcdState, columns: number, rows: number): LcdCell[][] {
  const ddram = bytes(state.ddram), cgram = bytes(state.cgram);
  const lineLength = state.twoLines ? 40 : 80;
  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const line = state.twoLines ? row % 2 : 0;
    const visible = state.twoLines ? true : row === 0 || (rows === 4 && row === 2);
    const start = state.twoLines ? (row >= 2 ? columns : 0) : row === 2 ? columns : 0;
    const offset = (start + column + state.shift) % lineLength;
    const address = (line ? 0x40 : 0) + offset;
    const code = visible ? ddram[line * 40 + offset] : 0x20;
    const slot = code & 7;
    return { code, character: lcdCharacter(code), glyph: code < 16 ? [...cgram.subarray(slot * 8, slot * 8 + 8)] : null,
      cursor: visible && !state.cgramSelected && state.addressCounter === address };
  }));
}

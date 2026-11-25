import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64Bytes, rgbaToRgb565, rgbaToYuyv, testPattern } from '../shared/camera.ts';
import { LcdStateSchema, lcdCells } from '../shared/lcd.ts';
import { pcmSamples } from '../shared/speaker.ts';
import { CommandSchema, DEFAULT_INPUTS, FirmwareSampleSchema, InputsSchema, ScenarioSchema } from '../shared/protocol.ts';

test('versioned inputs reject unknown fields, nonfinite and out-of-range values', () => {
  assert.deepEqual(InputsSchema.parse(DEFAULT_INPUTS), DEFAULT_INPUTS);
  assert.equal(InputsSchema.safeParse({ ...DEFAULT_INPUTS, extra: true }).success, false);
  assert.equal(InputsSchema.safeParse({ ...DEFAULT_INPUTS, tmp105: { ...DEFAULT_INPUTS.tmp105, temperatureC: NaN } }).success, false);
  assert.equal(InputsSchema.safeParse({ ...DEFAULT_INPUTS, bh1750: { ...DEFAULT_INPUTS.bh1750, lux: 65535 } }).success, false);
});
test('commands require a matching protocol shape and reset epoch', () => {
  assert.equal(CommandSchema.safeParse({ v: 1, id: 'x', epoch: 0, action: 'pause' }).success, true);
  assert.equal(CommandSchema.safeParse({ v: 2, id: 'x', epoch: 0, action: 'pause' }).success, false);
  assert.equal(CommandSchema.safeParse({ v: 1, id: 'x', epoch: -1, action: 'pause' }).success, false);
});
test('scenarios validate channel ownership and ordered playback', () => {
  const scenario = { deviceId: 'tmp105', channel: 'temperatureC', kind: 'playback', offset: 0, amplitude: 1, periodMs: 1000, seed: 42, frames: [{ timeMs: 0, value: 10 }, { timeMs: 1000, value: 20 }] };
  assert.equal(ScenarioSchema.safeParse(scenario).success, true);
  assert.equal(ScenarioSchema.safeParse({ ...scenario, channel: 'pressurePa' }).success, false);
  assert.equal(ScenarioSchema.safeParse({ ...scenario, frames: [{ timeMs: 0, value: 10 }, { timeMs: 0, value: 20 }] }).success, false);
});
test('firmware errors carry unavailable readings rather than fabricated numbers', () => {
  const sample = { v: 1, seq: 2, guestUs: 1000, tmp105: { temperatureC: null, error: 263 } };
  assert.deepEqual(FirmwareSampleSchema.parse(sample), sample);
});

test('camera encoders produce the OV2640 byte order, BT.601 YUYV and moving test bars', () => {
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
  assert.deepEqual([...rgbaToRgb565(pixels, 2, 1)], [0xf8, 0x00, 0x00, 0x1f], 'big-endian RGB565: red then blue');
  const gray = new Uint8Array([128, 128, 128, 255, 128, 128, 128, 255]);
  assert.deepEqual([...rgbaToYuyv(gray, 2, 1)], [126, 128, 126, 128], 'neutral gray has centred chroma');
  assert.deepEqual([...rgbaToYuyv(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1)].filter((_, index) => index % 2 === 0), [235, 16], 'limited-range luma');
  assert.throws(() => rgbaToYuyv(new Uint8Array(12), 3, 1), /even width/);
  const first = testPattern(16, 2, 0), later = testPattern(16, 2, 8);
  assert.deepEqual([...later.slice(0, 4)], [255, 255, 255, 255], 'leftmost bar is white');
  assert.deepEqual([...first.slice(0, 4)], [128, 128, 128, 255], 'the frame marker starts at the left edge');
  assert.deepEqual([...first.slice(15 * 4, 16 * 4)], [0, 0, 0, 255], 'rightmost bar is black');
  assert.notDeepEqual(first, later, 'the marker moves between frames');
  const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index & 0xff);
  assert.equal(base64Bytes(bytes), Buffer.from(bytes).toString('base64'), 'chunked encoding matches for frames larger than one chunk');
});

test('LCD cells follow HD44780 DDRAM line mapping, shift, CGRAM glyphs and the A00 ROM; PCM decodes little-endian', () => {
  const ddram = Array(80).fill(0x20);
  'Hello'.split('').forEach((character, index) => { ddram[index] = character.charCodeAt(0); });
  ddram[40] = 0x00; ddram[41] = 0xdf; ddram[42] = 0x7e; ddram[20] = 0x5c; ddram[60] = 0xb1;
  const cgram = Array(64).fill(0); cgram[0] = 0x1f;
  const hex = (values: number[]) => values.map(value => value.toString(16).padStart(2, '0')).join('');
  const state = LcdStateSchema.parse({ status: 'idle', backlight: true, displayOn: true, cursor: true, blink: false, twoLines: true, font5x10: false, eightBit: false, cgramSelected: false,
    addressCounter: 0x41, shift: 0, ddram: hex(ddram), cgram: hex(cgram), instructions: 1, dataWrites: 1, ignoredWhileBusy: 0 });
  const cells = lcdCells(state, 20, 4);
  assert.equal(cells[0].slice(0, 5).map(cell => cell.character).join(''), 'Hello');
  assert.deepEqual(cells[1][0].glyph?.slice(0, 2), [0x1f, 0], 'CGRAM slot 0 on line 2');
  assert.equal(cells[1][1].character, '°'); assert.equal(cells[1][2].character, '→');
  assert.equal(cells[1][1].cursor, true, 'cursor at address 0x41');
  assert.equal(cells[2][0].character, '¥', 'row 3 continues line 1 at address 0x14');
  assert.equal(cells[3][0].character, 'ア', 'row 4 continues line 2 at address 0x54');
  assert.equal(lcdCells({ ...state, shift: 1 }, 16, 2)[0][0].character, 'e', 'display shift scrolls left');
  assert.deepEqual([...pcmSamples(Buffer.from(new Int16Array([1, -2, 32767]).buffer).toString('base64'))], [1, -2, 32767]);
});

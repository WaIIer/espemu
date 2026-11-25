import { z } from 'zod';

export const CAMERA_FORMATS = ['jpeg', 'rgb565', 'yuv422'] as const;
export type CameraFormat = (typeof CAMERA_FORMATS)[number];
/** Matches the QEMU OV2640 model's frame limit; base64 keeps the command under the 1 MiB WebSocket frame limit. */
export const CAMERA_FRAME_MAX_BYTES = 512 * 1024;
export const CAMERA_FRAME_MAX_BASE64 = Math.ceil(CAMERA_FRAME_MAX_BYTES / 3) * 4;

export const CameraFrameSchema = z.object({
  format: z.enum(CAMERA_FORMATS), width: z.number().int().min(4).max(1600).multipleOf(4), height: z.number().int().min(4).max(1200).multipleOf(4),
  data: z.string().min(4).max(CAMERA_FRAME_MAX_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Frame data must be base64'),
}).strict();
export type CameraFrame = z.infer<typeof CameraFrameSchema>;

const Dimensions = { format: z.enum(CAMERA_FORMATS), width: z.number().int().nonnegative(), height: z.number().int().nonnegative() };
export const CameraStateSchema = z.object({
  v: z.literal(1), configured: z.boolean(), id: z.string().max(64), vsync: z.number().int(),
  sensor: z.object(Dimensions).strict(),
  source: z.object({ ...Dimensions, seq: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict().nullable(),
  status: z.enum(['absent', 'no-source', 'mismatch', 'streaming', 'waiting-for-dma', 'running']),
  framesStarted: z.number().int().nonnegative(), framesDelivered: z.number().int().nonnegative(), framesMissed: z.number().int().nonnegative(),
  dma: z.object({ bytes: z.number().int().nonnegative(), eofInterrupts: z.number().int().nonnegative(), descriptorErrors: z.number().int().nonnegative(), receiving: z.boolean() }).strict(),
  error: z.string().max(256),
}).strict();
export type CameraState = z.infer<typeof CameraStateSchema>;

/** RGBA pixels to big-endian RGB565, the byte order the OV2640 puts on D0-D7. */
export function rgbaToRgb565(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const red = rgba[pixel * 4], green = rgba[pixel * 4 + 1], blue = rgba[pixel * 4 + 2];
    const value = ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
    out[pixel * 2] = value >> 8; out[pixel * 2 + 1] = value & 0xff;
  }
  return out;
}

/** RGBA pixels to YUYV 4:2:2 (BT.601 limited range), averaging chroma over each pixel pair. */
export function rgbaToYuyv(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (width % 2) throw new Error('YUV422 needs an even width');
  const out = new Uint8Array(width * height * 2);
  const luma = (offset: number) => Math.round(16 + (65.738 * rgba[offset] + 129.057 * rgba[offset + 1] + 25.064 * rgba[offset + 2]) / 256);
  for (let pixel = 0; pixel < width * height; pixel += 2) {
    const first = pixel * 4, second = first + 4;
    const red = (rgba[first] + rgba[second]) / 2, green = (rgba[first + 1] + rgba[second + 1]) / 2, blue = (rgba[first + 2] + rgba[second + 2]) / 2;
    const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
    out[pixel * 2] = luma(first);
    out[pixel * 2 + 1] = clamp(128 + (-37.945 * red - 74.494 * green + 112.439 * blue) / 256);
    out[pixel * 2 + 2] = luma(second);
    out[pixel * 2 + 3] = clamp(128 + (112.439 * red - 94.154 * green - 18.285 * blue) / 256);
  }
  return out;
}

/** Eight vertical color bars, with a moving marker so successive frames differ. */
export function testPattern(width: number, height: number, frame = 0): Uint8ClampedArray {
  const bars = [[255,255,255],[255,255,0],[0,255,255],[0,255,0],[255,0,255],[255,0,0],[0,0,255],[0,0,0]];
  const out = new Uint8ClampedArray(width * height * 4), marker = frame % Math.max(1, width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = Math.abs(x - marker) < 2 ? [128,128,128] : bars[Math.min(7, Math.floor(x * 8 / width))];
    out.set([...color, 255], (y * width + x) * 4);
  }
  return out;
}

export function base64Bytes(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}

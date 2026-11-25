import { z } from 'zod';

export const SpeakerStateSchema = z.object({
  v: z.literal(1), configured: z.boolean(), id: z.string().max(64), controller: z.union([z.literal(0), z.literal(1)]).nullable(),
  playing: z.boolean(), rate: z.number().int().nonnegative(), bits: z.number().int().nonnegative(), mono: z.boolean(),
  samples: z.number().int().nonnegative(), underrunFrames: z.number().int().nonnegative(), eofInterrupts: z.number().int().nonnegative(),
  descriptorErrors: z.number().int().nonnegative(), dropped: z.number().int().nonnegative(), peak: z.number().int().min(0).max(32768),
  error: z.string().max(256),
}).strict();
export type SpeakerState = z.infer<typeof SpeakerStateSchema>;

/** Drained PCM: little-endian int16 mono samples starting at sample index `start` of this reset epoch. */
export const SpeakerAudioSchema = z.object({
  v: z.literal(1), rate: z.number().int().nonnegative(), start: z.number().int().nonnegative(), data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();
export const AudioMessageSchema = z.object({
  v: z.literal(1), type: z.literal('audio'), deviceId: z.string().max(50), epoch: z.number().int().nonnegative(),
  rate: z.number().int().min(4000).max(192000), start: z.number().int().nonnegative(), data: z.string().max(1_400_000),
}).strict();
export type AudioMessage = z.infer<typeof AudioMessageSchema>;

export function pcmSamples(base64: string): Int16Array {
  const text = atob(base64), samples = new Int16Array(text.length >> 1);
  for (let index = 0; index < samples.length; index++) samples[index] = text.charCodeAt(index * 2) | (text.charCodeAt(index * 2 + 1) << 8);
  return samples;
}

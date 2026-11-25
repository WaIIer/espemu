import { z } from 'zod';
import { ProjectManifestSchema, ManifestScenarioSchema, type ProjectManifest, type CircuitScenario } from './manifest.ts';
import { ApplicationSampleSchema, type ApplicationSample } from './application.ts';
import { GpioStateSchema, GpioInputSchema, GpioInputsSchema, PeripheralsSchema, type GpioState, type GpioInput, type Peripheral, type EventEntry, type Phase } from './protocol.ts';
import type { PhysicalInputs } from './registry.ts';
import { Max7219StateSchema, type Max7219State } from './dot-matrix.ts';
import { CameraFrameSchema, CameraStateSchema, type CameraState } from './camera.ts';
import { SpeakerStateSchema, type SpeakerState } from './speaker.ts';

const SessionIdSchema = z.string().uuid();
const base = { v: z.literal(1), id: z.string().min(1).max(100), epoch: z.number().int().nonnegative(), sessionId: SessionIdSchema.optional() };
export const RuntimeAckSchema = z.object({
  v: z.literal(1), type: z.literal('ack'), id: z.string().max(100), epoch: z.number().int().nonnegative(),
  sessionId: SessionIdSchema, ok: z.boolean(), error: z.string().max(2000).optional(),
});
export const RuntimeCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('input'), deviceId: z.string().min(1).max(50), channel: z.string().min(1).max(50), value: z.union([z.number().finite(),z.boolean()]) }).strict(),
  z.object({ ...base, action: z.literal('input-fields'), deviceId: z.string().min(1).max(50), fields: z.record(z.union([z.number().finite(),z.boolean()])).refine(fields=>Object.keys(fields).length>0&&Object.keys(fields).length<=32,'Provide 1-32 input fields') }).strict(),
  z.object({ ...base, action: z.literal('inputs'), inputs: z.record(z.record(z.union([z.number().finite(), z.boolean()]))) }).strict(),
  z.object({ ...base, action: z.literal('scenario'), scenario: ManifestScenarioSchema }).strict(),
  z.object({ ...base, action: z.literal('scenario-start'), scenario: ManifestScenarioSchema }).strict(),
  z.object({ ...base, action: z.literal('scenario-stop'), deviceId: z.string().min(1).max(50), channel: z.string().min(1).max(50) }).strict(),
  z.object({ ...base, action: z.literal('gpio-inputs'), pins: GpioInputsSchema }).strict(),
  z.object({ ...base, action: z.literal('gpio-pin'), input: GpioInputSchema }).strict(),
  z.object({ ...base, action: z.literal('gpio-momentary'), deviceId: z.string().min(1).max(50), pressed: z.boolean() }).strict(),
  z.object({ ...base, action: z.literal('peripherals'), peripherals: PeripheralsSchema }).strict(),
  z.object({ ...base, action: z.literal('manifest'), manifest: ProjectManifestSchema }).strict(),
  z.object({ ...base, action: z.literal('camera-frame'), deviceId: z.string().min(1).max(50), frame: CameraFrameSchema }).strict(),
  z.object({ ...base, action: z.literal('camera-clear'), deviceId: z.string().min(1).max(50) }).strict(),
  z.object({ ...base, action: z.enum(['run','pause','reset','stop','console-clear','restore-environment']) }).strict(),
]);
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;
export const DeviceStateSchema = z.object({ status: z.string().max(50), channels: z.record(z.number().finite().nullable()) }).passthrough();
export const CircuitStateSchema = z.object({ v: z.literal(1), virtualMs: z.number().nonnegative(), devices: z.array(z.object({
  id: z.string(), type: z.string(), address: z.number().int(), inputs: z.record(z.union([z.number(),z.boolean()])), state: DeviceStateSchema,
}).strict()).max(32) }).strict();
export type ModelState = z.infer<typeof DeviceStateSchema>;
export const Ws2812StateSchema = z.object({v:z.literal(1),virtualMs:z.number().nonnegative(),error:z.string().max(200),devices:z.array(z.object({id:z.string(),pin:z.number().int(),length:z.number().int().min(1).max(1024),frames:z.number().int().nonnegative(),pixels:z.array(z.tuple([z.number().int().min(0).max(255),z.number().int().min(0).max(255),z.number().int().min(0).max(255)])).max(1024)}).strict()).max(8)}).strict();
export type Ws2812State = z.infer<typeof Ws2812StateSchema>;
export type ApplicationPoint = ApplicationSample & { epoch: number; virtualMs: number; wallMs: number };
const ScenarioRunSchema = z.object({ originMs: z.number().nonnegative(), status: z.enum(['active','completed','stopped','overridden']) }).strict();
export interface ProjectState {
  v: 1; sessionId: string; projectName?: string; epoch: number; phase: Phase; virtualMs: number; wallMs: number; manifest: ProjectManifest;
  inputs: PhysicalInputs; deviceStates: Record<string, ModelState>; latest: ApplicationPoint | null; history: ApplicationPoint[];
  gpio: GpioState | null; gpioWallMs: number; gpioInputs: GpioInput[]; gpioError: string | null; peripherals: Peripheral[];
  scenarios: CircuitScenario[]; events: EventEntry[]; console: string[]; error: string | null;
  scenarioRuns?: Record<string, z.infer<typeof ScenarioRunSchema>>;
  metrics: { samples: number; droppedFrames: number; qemuRssMb: number; latencyP95Ms: number | null; latencyCount: number };
  ws2812?: Ws2812State | null;
  max7219?: Max7219State | null;
  camera?: CameraState | null;
  speaker?: SpeakerState | null;
}
export const ProjectStateSchema = z.object({
  v: z.literal(1), sessionId: SessionIdSchema, projectName: z.string().max(255).optional(), epoch: z.number().int().nonnegative(), phase: z.enum(['starting','running','paused','stopped','error']), virtualMs: z.number(), wallMs: z.number(), manifest: ProjectManifestSchema,
  inputs: z.record(z.record(z.union([z.number(),z.boolean()]))), deviceStates: z.record(DeviceStateSchema),
  latest: ApplicationSampleSchema.extend({ epoch: z.number(), virtualMs: z.number(), wallMs: z.number() }).nullable(),
  history: z.array(ApplicationSampleSchema.extend({ epoch: z.number(), virtualMs: z.number(), wallMs: z.number() })).max(600),
  gpio: GpioStateSchema.nullable(), gpioWallMs: z.number(), gpioInputs: GpioInputsSchema, gpioError: z.string().nullable(), peripherals: PeripheralsSchema,
  scenarios: z.array(ManifestScenarioSchema).max(64), events: z.array(z.object({ seq: z.number(), epoch: z.number(), virtualMs: z.number(), wallMs: z.number(), source: z.enum(['i2c','gpio','control','firmware','system']), message: z.string() })).max(256),
  scenarioRuns: z.record(ScenarioRunSchema).refine(runs=>Object.keys(runs).length<=64).optional(),
  console: z.array(z.string()).max(200), error: z.string().nullable(),
  metrics: z.object({ samples: z.number(), droppedFrames: z.number(), qemuRssMb: z.number(), latencyP95Ms: z.number().nullable(), latencyCount: z.number() }),
  ws2812: Ws2812StateSchema.nullable().optional(),
  max7219: Max7219StateSchema.nullable().optional(),
  camera: CameraStateSchema.nullable().optional(),
  speaker: SpeakerStateSchema.nullable().optional(),
});

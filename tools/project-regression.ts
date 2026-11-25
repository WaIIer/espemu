import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ProjectStateSchema, RuntimeAckSchema, RuntimeCommandSchema, type ProjectState, type RuntimeCommand } from '../shared/runtime.ts';
import { digitalInputLevel, isPeripheralInput } from '../shared/registry.ts';
import { loadProject } from '../server/project.ts';
import type { CameraFormat } from '../shared/camera.ts';
import { AudioMessageSchema, pcmSamples } from '../shared/speaker.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { createBackendServer } from '../server/http.ts';
import type { z } from 'zod';

const frameworkRoot = fileURLToPath(new URL('../', import.meta.url));

type Payload = RuntimeCommand extends infer Command ? Command extends RuntimeCommand ? Omit<Command,'v'|'id'|'epoch'|'sessionId'> : never : never;

export async function connectProject(base: string) {
  const address = new URL('/ws', base);
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(address, { maxPayload: 1024 * 1024, handshakeTimeout: 5000 });
  let state: ProjectState | undefined, failure: Error | undefined;
  // Last 10 s of speaker PCM per device for the current reset epoch.
  const audio = new Map<string, { epoch: number; rate: number; chunks: Int16Array[]; length: number }>();
  const refresh = new Set<() => void>();
  const pending = new Map<string, (result: z.infer<typeof RuntimeAckSchema> | Error) => void>();
  function disconnected(error: Error) {
    failure = error;
    for (const settle of pending.values()) settle(error);
    for (const notify of refresh) notify();
  }
  socket.on('error', disconnected);
  socket.on('close', () => disconnected(new Error('Project connection closed')));
  socket.on('message', bytes => {
    try {
      const packet = JSON.parse(bytes.toString());
      if (packet.v !== 1) throw new Error('Unsupported project protocol');
      if (packet.type === 'state') {
        const next = ProjectStateSchema.parse(packet.state);
        if (state && next.sessionId !== state.sessionId) throw new Error('Runtime lifetime changed on an open socket');
        if (!state || next.epoch >= state.epoch) { state = next; for (const notify of refresh) notify(); }
      } else if (packet.type === 'audio') {
        const message = AudioMessageSchema.parse(packet);
        let track = audio.get(message.deviceId);
        if (!track || track.epoch !== message.epoch || track.rate !== message.rate) audio.set(message.deviceId, track = { epoch: message.epoch, rate: message.rate, chunks: [], length: 0 });
        const samples = pcmSamples(message.data);
        track.chunks.push(samples); track.length += samples.length;
        while (track.length - track.chunks[0].length >= track.rate * 10) track.length -= track.chunks.shift()!.length;
      } else if (packet.type === 'ack') {
        const ack = RuntimeAckSchema.parse(packet);
        if (ack.sessionId === state?.sessionId) pending.get(ack.id)?.(ack);
      }
    } catch (error) { disconnected(error instanceof Error ? error : new Error(String(error))); close(); }
  });
  function close() { socket.terminate(); }
  function waitFor(predicate: (sample: ProjectState) => boolean, timeout = 8000): Promise<ProjectState> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(undefined, new Error('Timed out waiting for project state')), timeout);
      function settle(sample?: ProjectState, error?: unknown) {
        clearTimeout(timer);refresh.delete(check);
        if (sample) resolve(sample);else reject(error);
      }
      function check() {
        if (failure) { settle(undefined, failure); return; }
        if (state) try { if (predicate(state)) settle(state); } catch (error) { settle(undefined, error); }
      }
      refresh.add(check);check();
    });
  }
  async function send(payload: Payload) {
    if (!state || failure || socket.readyState !== WebSocket.OPEN) throw new Error('No synchronized project connection');
    if (pending.size >= 8) throw new Error('Command queue is full');
    const command = RuntimeCommandSchema.parse({ ...payload, v: 1, id: randomUUID(), sessionId: state.sessionId, epoch: state.epoch });
    const epoch = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { settle(new Error('Acknowledgement timed out; reconnect and inspect state before retrying'));close(); }, 8000);
      function settle(result: z.infer<typeof RuntimeAckSchema> | Error) {
        clearTimeout(timer);
        pending.delete(command.id);
        if (result instanceof Error) reject(result);
        else if (!result.ok) reject(new Error(result.error ?? 'Command rejected'));
        else resolve(result.epoch);
      }
      pending.set(command.id, settle);
      try { socket.send(JSON.stringify(command), error => { if (error) settle(error); }); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
    await waitFor(sample => sample.epoch >= epoch);
  }
  try { await waitFor(() => true); } catch (error) { close();throw error; }
  const declared = (deviceId: string) => {
    const device = state?.manifest.devices.find(entry => entry.id === deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);
    return device;
  };
  /** Logical output state from the real GPIO pad: true/false, or null while firmware has not enabled the output. */
  function isOn(deviceId: string, sample: ProjectState = state!): boolean | null {
    const device = declared(deviceId);
    if (!('pin' in device)) throw new Error(`${deviceId} is not a single-pin GPIO device`);
    const pad = sample.gpio?.pins.find(entry => entry.pin === device.pin);
    if (!pad?.outputEnabled) return null;
    return pad.level === (device.activeLow ? 0 : 1);
  }
  /** Latest optional application telemetry value, or undefined when the channel has not been reported. */
  function channel(name: string, sample: ProjectState = state!) { return sample.latest?.channels[name]?.value; }
  const input = (deviceId: string, fields: Record<string, number | boolean>) => send({ action: 'input-fields', deviceId, fields });
  /** Drives a declared switch-style input to its asserted or released electrical level. */
  async function setInput(deviceId: string, asserted: boolean) {
    const device = declared(deviceId);
    if (!isPeripheralInput(device)) throw new Error(`${deviceId} is not a digital input`);
    await send({ action: 'gpio-pin', input: { pin: device.pin, level: digitalInputLevel(device.type, device.activeLow, asserted, 'pullUp' in device && device.pullUp === true) } });
  }
  /** Presses and releases a declared button through the same path as the workbench pointer handler. */
  async function press(deviceId: string, holdMs = 50) {
    await send({ action: 'gpio-momentary', deviceId, pressed: true });
    try { await delay(holdMs); } finally { await send({ action: 'gpio-momentary', deviceId, pressed: false }); }
  }
  /** Supplies the picture the emulated camera streams over DMA; format and size must match what firmware configured. */
  function cameraFrame(deviceId: string, frame: { format: CameraFormat; width: number; height: number; data: Uint8Array }) {
    return send({ action: 'camera-frame', deviceId, frame: { ...frame, data: Buffer.from(frame.data).toString('base64') } });
  }
  /** Speaker PCM (mono int16) heard so far in this reset epoch, up to the last 10 s. */
  function speakerAudio(deviceId: string): { rate: number; samples: Int16Array } {
    const track = audio.get(deviceId);
    if (!track || track.epoch !== state?.epoch) return { rate: 0, samples: new Int16Array() };
    const samples = new Int16Array(track.length);
    let offset = 0;
    for (const chunk of track.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    return { rate: track.rate, samples };
  }
  /** Removes the camera's picture; the sensor stops producing frames until the next cameraFrame. */
  const cameraClear = (deviceId: string) => send({ action: 'camera-clear', deviceId });
  return { get state() { return state!; }, send, waitFor, close, isOn, channel, input, setInput, press, cameraFrame, cameraClear, speakerAudio };
}

export type ProjectClient = Awaited<ReturnType<typeof connectProject>>;
export type StartedProject = ProjectClient & { base: string; stop(): Promise<void> };

/**
 * Starts a test-owned workbench for a built project on an unused loopback port and connects to it.
 * Always call stop() (for example in finally) to close QEMU, the server and the socket.
 */
export async function startProject(directory = process.env.ESPEMU_PROJECT, options: { flash?: string; env?: NodeJS.ProcessEnv } = {}): Promise<StartedProject> {
  if (!directory) throw new Error('Pass a project directory or set ESPEMU_PROJECT.');
  const projectDirectory = resolve(directory), flash = resolve(projectDirectory, options.flash ?? 'build/qemu_flash.bin');
  if (!existsSync(flash)) throw new Error(`Firmware image not found: ${flash}. Run make build first.`);
  const env = { ...process.env, ...options.env, ESPEMU_PROJECT: projectDirectory, ESPEMU_FLASH: flash };
  const { manifest } = loadProject(frameworkRoot, env);
  const runtime = new ProjectRuntime(frameworkRoot, manifest, (callbacks, project) => new QemuProcess(frameworkRoot, callbacks, env, project), projectDirectory);
  const app = createBackendServer(runtime, frameworkRoot);
  let client: ProjectClient | undefined;
  const stop = async () => { client?.close(); await Promise.allSettled([app.close(), runtime.close()]); };
  try {
    await new Promise<void>((done, fail) => { app.server.once('error', fail); app.server.listen(0, '127.0.0.1', done); });
    const address = app.server.address();
    if (!address || typeof address !== 'object') throw new Error('Workbench did not bind a loopback port');
    const base = `http://127.0.0.1:${address.port}`;
    await runtime.start();
    client = await connectProject(base);
    const { send, waitFor, close, isOn, channel, input, setInput, press, cameraFrame, cameraClear, speakerAudio } = client;
    const connected = client;
    return { base, stop, send, waitFor, close, isOn, channel, input, setInput, press, cameraFrame, cameraClear, speakerAudio, get state() { return connected.state; } };
  } catch (error) { await stop(); throw error; }
}

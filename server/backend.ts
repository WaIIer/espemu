import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  CommandSchema, DEFAULT_INPUTS, GpioStateSchema, type EventEntry, type FirmwareSample, type InputSnapshot,
  type ServerMessage, type SessionState,
} from '../shared/protocol.ts';
import { applyScenarios, MAX_SCENARIO_BYTES, SessionFileSchema } from './scenarios.ts';
import { DEMO_MANIFEST, ProjectManifestSchema } from '../shared/manifest.ts';
import { TOPOLOGY } from '../shared/protocol.ts';
import { QemuProcess, type Bridge, type BridgeCallbacks } from './qemu.ts';
import { LineBuffer, matchesObservation, parseFirmwareLine, physicalInputs, PhysicalStateSchema, rawInputs, TraceSchema } from './telemetry.ts';

const StatusSchema = z.object({ running: z.boolean(), status: z.string().max(100) });
const ImportSchema = z.object({ v: z.literal(1), id: z.string().min(1).max(100), epoch: z.number().int().nonnegative(), file: SessionFileSchema }).strict();
type Ack = Extract<ServerMessage, { type: 'ack' }>;
type PendingLatency = { inputs: InputSnapshot; devices: (keyof InputSnapshot)[]; started: number; seq: number; epoch: number };
const LEGACY_MANIFEST = ProjectManifestSchema.parse({ v: 1, target: 'esp32', buses: DEMO_MANIFEST.buses,
  devices: DEMO_MANIFEST.devices.filter(device=>['tmp105','bh1750','bme280'].includes(device.type)) });

function boundedPush<Value>(array: Value[], value: Value, limit: number): void {
  array.push(value);
  if (array.length > limit) array.splice(0, array.length - limit);
}

function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }

function boundedText(text: string, limit: number): string {
  let candidate = text.slice(0, limit);
  while (Buffer.byteLength(JSON.stringify(candidate)) > limit) candidate = candidate.slice(0, Math.floor(candidate.length / 2));
  return candidate;
}

export class Backend extends EventEmitter {
  private state: SessionState = {
    v: 1, epoch: 0, phase: 'starting', wallMs: Date.now(), virtualMs: 0,
    inputs: structuredClone(DEFAULT_INPUTS), latest: null, history: [], events: [], console: [], scenarios: [], error: null,
    gpio: null, gpioWallMs: 0, gpioInputs: [], peripherals: [{ id: 'led2', label: 'LED', kind: 'led', pin: 2, color: 'red', activeLow: false }], gpioError: null,
    metrics: { samples: 0, droppedFrames: 0, qemuRssMb: 0, latencyP95Ms: null, latencyCount: 0 },
  };
  private bridge: Bridge | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private baseline = 0;
  private lastAbsolute = 0;
  private lastFirmwareSeq = -1;
  private lastTraceSeq = -1;
  private eventSeq = 0;
  private bridgeReady = false;
  private gpioSupported = true;
  private firmwareBooted = false;
  private firmwareCatalog = false;
  private firmwareWall = 0;
  private firmwareMono = 0;
  private acceptingSamples = false;
  private pendingLatency: PendingLatency[] = [];
  private latencies: number[] = [];
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private stdout = new LineBuffer(line => this.onStdout(line), () => this.drop());
  private stderr = new LineBuffer(line => this.log(`stderr: ${line}`), () => this.drop());

  constructor(
    private readonly root: string,
    private readonly bridgeFactory: (callbacks: BridgeCallbacks) => Bridge = callbacks => new QemuProcess(root, callbacks, process.env, LEGACY_MANIFEST),
    private readonly wallNow = Date.now,
    private readonly monotonicNow = () => performance.now(),
  ) { super(); }

  snapshot(): SessionState {
    this.state.wallMs = this.wallNow();
    return structuredClone(this.state);
  }
  topology() { return TOPOLOGY; }

  health(): Record<string, unknown> {
    const firmwareFresh = this.firmwareCatalog && this.monotonicNow() - this.firmwareMono <= 2000;
    return {
      v: 1, ready: this.bridgeReady && (firmwareFresh || this.firmwareBooted) && this.state.phase === 'running',
      bridgeReady: this.bridgeReady, firmwareReady: firmwareFresh || this.firmwareBooted, firmwareCatalog: this.firmwareCatalog,
      gpioReady: !!this.state.gpio && !this.state.gpioError,
      firmwareLastWallMs: this.firmwareWall || null, phase: this.state.phase,
      epoch: this.state.epoch, error: this.state.error,
      backendRssMb: process.memoryUsage().rss / (1024 * 1024),
      backendHeapMb: process.memoryUsage().heapUsed / (1024 * 1024),
    };
  }

  drop(count = 1): void { this.state.metrics.droppedFrames += count; }

  private log(line: string): void { boundedPush(this.state.console, boundedText(line, 512), 200); }

  private event(source: EventEntry['source'], message: string, virtualMs = this.state.virtualMs): void {
    boundedPush(this.state.events, { seq: ++this.eventSeq, epoch: this.state.epoch, virtualMs, wallMs: this.wallNow(), source, message: boundedText(message, 256) }, 256);
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.closing) return Promise.reject(new Error('Backend is closing'));
    if (this.queued >= 64) return Promise.reject(new Error('Control queue is full'));
    this.queued++;
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {}).finally(() => { this.queued--; });
    return result;
  }

  async start(schedule = true): Promise<void> {
    await this.enqueue(async () => {
      if (this.bridge) throw new Error('Backend already started');
      try {
        await this.startBridge();
        await this.bridge!.command('cont');
        await this.readStatus();
      } catch (error) {
        this.fail(error);
        await this.closeBridge();
      }
    });
    if (schedule && !this.closing) this.timer ??= setInterval(() => { void this.poll(); }, 100);
  }

  private closeBridge(): Promise<void> { return this.bridge?.close() ?? Promise.resolve(); }

  private async startBridge(): Promise<void> {
    this.state.phase = 'starting';
    this.state.error = null;
    this.acceptingSamples = false;
    this.bridgeReady = false;
    const bridge = this.bridgeFactory({
      stdout: chunk => { if (this.bridge === bridge) this.stdout.push(chunk); },
      stderr: chunk => { if (this.bridge === bridge) this.stderr.push(chunk); },
      exited: message => {
        if (this.bridge === bridge && !this.closing && this.state.phase !== 'stopped') {
          this.fail(message);
          void bridge.close().catch(error => this.log(errorText(error)));
        }
      },
    });
    this.bridge = bridge;
    await bridge.start();
    const initial = await this.readPhysical();
    this.baseline = initial.virtualMs;
    this.lastAbsolute = initial.virtualMs;
    await this.setInputs(this.state.inputs, false);
    await this.readTrace();
    this.gpioSupported = true;
    await this.readGpio();
    await this.readStatus();
    this.bridgeReady = true;
    this.acceptingSamples = true;
    this.event('system', 'QEMU bridge ready; awaiting firmware catalog telemetry');
  }

  private fail(error: unknown): void {
    this.state.error = errorText(error);
    this.state.phase = 'error';
    this.bridgeReady = false;
    this.acceptingSamples = false;
    this.pendingLatency = [];
    this.event('system', this.state.error);
  }

  private async readPhysical() {
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc', property: 'espemu-state' });
    if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid espemu-state QOM string');
    return PhysicalStateSchema.parse(JSON.parse(value));
  }

  private async readStatus(): Promise<void> {
    const status = StatusSchema.parse(await this.bridge!.command('query-status'));
    if (status.running) this.state.phase = 'running';
    else if (status.status === 'paused' || status.status === 'prelaunch') this.state.phase = 'paused';
    else throw new Error(`Unexpected QEMU status: ${status.status}`);
  }

  private async readGpio(): Promise<void> {
    if (!this.gpioSupported) return;
    try {
      const value = await this.bridge!.command('qom-get', { path: '/machine/soc/gpio', property: 'espemu-state' });
      if (typeof value !== 'string' || value.length > 32768) throw new Error('Invalid GPIO state');
      const next = GpioStateSchema.parse(JSON.parse(value));
      const previous = this.state.gpio;
      if (previous) for (const pin of next.pins) {
        const old = previous.pins.find(entry => entry.pin === pin.pin);
        if (old && (old.level !== pin.level || old.outputEnabled !== pin.outputEnabled))
          this.event('gpio', `GPIO${pin.pin} ${pin.outputEnabled ? 'output' : 'input'} ${pin.level}`, Math.max(0, next.virtualMs - this.baseline));
      }
      this.state.gpio = next;
      this.state.gpioWallMs = this.wallNow();
      this.state.gpioError = null;
    } catch (error) {
      this.state.gpio = null;
      this.state.gpioError = errorText(error);
      this.gpioSupported = false;
    }
  }

  private async setGpioInputs(pins: NonNullable<SessionState['gpioInputs']>): Promise<void> {
    if (!this.gpioSupported) throw new Error(this.state.gpioError ?? 'GPIO bridge unavailable');
    await this.bridge!.command('qom-set', { path: '/machine/soc/gpio', property: 'espemu-inputs', value: JSON.stringify({ v: 1, pins }) });
    this.state.gpioInputs = structuredClone(pins);
    await this.readGpio();
    if (!this.state.gpio) throw new Error(this.state.gpioError ?? 'GPIO readback failed');
  }

  private async readTrace(): Promise<void> {
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc/i2c0', property: 'espemu-trace' });
    if (typeof value !== 'string' || value.length > 65536) throw new Error('Invalid espemu-trace QOM string');
    const trace = TraceSchema.parse(JSON.parse(value));
    for (const entry of [...trace.events].sort((first, second) => first.seq - second.seq)) {
      if (entry.seq <= this.lastTraceSeq) continue;
      this.lastTraceSeq = entry.seq;
      this.event('i2c', `#${entry.seq} 0x${entry.address.toString(16).padStart(2, '0')} ${entry.read ? 'read' : 'write'} ${entry.length} ${entry.status}`, Math.max(0, entry.virtualMs - this.baseline));
    }
  }

  private synchronizeClock(absoluteMs: number): void {
    if (absoluteMs < this.lastAbsolute) throw new Error('QEMU virtual clock moved backwards outside reset');
    this.lastAbsolute = absoluteMs;
    if (this.state.phase === 'running') this.state.virtualMs = Math.max(0, absoluteMs - this.baseline);
  }

  private async setInputs(inputs: InputSnapshot, manual: boolean): Promise<void> {
    const raw = rawInputs(inputs);
    const previous = this.state.inputs;
    await this.bridge!.command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(raw) });
    const started = this.monotonicNow();
    const acknowledgedSeq = this.lastFirmwareSeq;
    const confirmed = await this.readPhysical();
    if (JSON.stringify(confirmed.inputs) !== JSON.stringify(raw)) {
      if (JSON.stringify(rawInputs(physicalInputs(confirmed.inputs))) !== JSON.stringify(raw)) throw new Error('QEMU did not confirm requested physical inputs');
    }
    this.state.inputs = physicalInputs(confirmed.inputs);
    this.synchronizeClock(confirmed.virtualMs);
    const changed = (Object.keys(previous) as (keyof InputSnapshot)[]).filter(deviceId => JSON.stringify(previous[deviceId]) !== JSON.stringify(this.state.inputs[deviceId]));
    this.pendingLatency = this.pendingLatency.filter(pending => !pending.devices.some(deviceId => changed.includes(deviceId)));
    if (manual) {
      const devices = changed.filter(deviceId => this.state.inputs[deviceId].connected && !this.state.inputs[deviceId].invalid);
      if (devices.length) boundedPush(this.pendingLatency, { inputs: structuredClone(this.state.inputs), devices, started, seq: acknowledgedSeq, epoch: this.state.epoch }, 128);
    }
  }

  private onStdout(line: string): void {
    if (!line.startsWith('ESP_EMU ')) {
      if (line.includes('Calling app_main()')) this.firmwareBooted = true;
      this.log(`stdout: ${line}`); return;
    }
    const sample = parseFirmwareLine(line);
    if (!sample || !this.acceptingSamples || sample.seq <= this.lastFirmwareSeq) { this.drop(); return; }
    this.observe(sample);
  }

  private observe(sample: FirmwareSample): void {
    this.lastFirmwareSeq = sample.seq;
    const point = { ...sample, epoch: this.state.epoch, wallMs: this.wallNow(), virtualMs: this.state.virtualMs };
    this.state.latest = point;
    boundedPush(this.state.history, point, 600);
    this.state.metrics.samples++;
    this.firmwareWall = point.wallMs;
    this.firmwareMono = this.monotonicNow();
    this.firmwareCatalog = sample.tmp105?.error === 0 && sample.tmp105.temperatureC !== null
      && sample.bh1750?.error === 0 && sample.bh1750.lux !== null
      && sample.bme280?.error === 0 && sample.bme280.temperatureC !== null
      && sample.bme280.pressurePa !== null && sample.bme280.humidityPct !== null;
    const now = this.monotonicNow();
    this.pendingLatency = this.pendingLatency.filter(pending => {
      if (pending.epoch !== this.state.epoch || now - pending.started > 10000) return false;
      if (sample.seq <= pending.seq || !matchesObservation(pending.inputs, sample, pending.devices)) return true;
      boundedPush(this.latencies, now - pending.started, 600);
      this.state.metrics.latencyCount++;
      const sorted = [...this.latencies].sort((first, second) => first - second);
      this.state.metrics.latencyP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
      return false;
    });
    this.emit('sample');
  }

  async poll(): Promise<boolean> {
    if (this.closing || this.polling || this.queued || !this.bridgeReady || !this.bridge) return false;
    this.polling = true;
    try {
      await this.enqueue(async () => {
        try {
          const physical = await this.readPhysical();
          this.synchronizeClock(physical.virtualMs);
          this.state.inputs = physicalInputs(physical.inputs);
          await this.readStatus();
          await this.readTrace();
          await this.readGpio();
          this.state.metrics.qemuRssMb = await this.bridge!.rssMb();
          this.pendingLatency = this.pendingLatency.filter(pending => this.monotonicNow() - pending.started <= 10000);
          if (this.state.phase === 'running') {
            const next = applyScenarios(this.state.inputs, this.state.scenarios, this.state.virtualMs);
            if (JSON.stringify(rawInputs(next)) !== JSON.stringify(rawInputs(this.state.inputs))) await this.setInputs(next, false);
          }
        } catch (error) {
          this.fail(error);
          await this.bridge?.close();
        }
      });
      return true;
    } catch (error) {
      if (!this.closing) this.fail(error);
      return false;
    } finally { this.polling = false; }
  }

  private ack(id: string, ok: boolean, error?: string): Ack {
    return { v: 1, type: 'ack', id, epoch: this.state.epoch, ok, ...(error ? { error } : {}) };
  }

  async command(value: unknown): Promise<Ack> {
    const parsed = CommandSchema.safeParse(value);
    const id = typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' ? value.id.slice(0, 100) : '';
    if (!parsed.success) return this.ack(id, false, 'Invalid command');
    try {
      return await this.enqueue(async () => {
        const command = parsed.data;
        if (command.epoch !== this.state.epoch) return this.ack(command.id, false, 'Stale reset epoch');
        if (this.state.phase === 'error') return this.ack(command.id, false, this.state.error ?? 'Bridge unavailable');
        if (command.action !== 'run' && command.action !== 'stop' && this.state.phase === 'stopped') return this.ack(command.id, false, 'QEMU is stopped');
        try {
          switch (command.action) {
            case 'gpio-inputs':
              await this.setGpioInputs(command.pins);
              break;
            case 'peripherals':
              this.state.peripherals = structuredClone(command.peripherals);
              break;
            case 'inputs': {
              const previous = this.state.inputs;
              await this.setInputs(command.inputs, true);
              this.state.scenarios = this.state.scenarios.map(scenario => {
                const before = previous[scenario.deviceId] as unknown as Record<string, number | boolean>;
                const after = this.state.inputs[scenario.deviceId] as unknown as Record<string, number | boolean>;
                return before[scenario.channel] === after[scenario.channel] ? scenario : { ...scenario, kind: 'manual' };
              });
              break;
            }
            case 'scenario': {
              const scenarios = this.state.scenarios.filter(scenario => scenario.deviceId !== command.scenario.deviceId || scenario.channel !== command.scenario.channel);
              scenarios.push(command.scenario);
              if (Buffer.byteLength(JSON.stringify(scenarios)) > MAX_SCENARIO_BYTES) return this.ack(command.id, false, 'Scenario data exceeds limit');
              this.state.scenarios = scenarios;
              break;
            }
            case 'run':
              if (this.state.phase === 'stopped') { this.beginEpoch(); await this.startBridge(); }
              await this.bridge!.command('cont');
              await this.readStatus();
              break;
            case 'pause': {
              await this.bridge!.command('stop');
              const physical = await this.readPhysical();
              this.synchronizeClock(physical.virtualMs);
              await this.readStatus();
              break;
            }
            case 'reset': {
              await this.bridge!.command('stop');
              this.acceptingSamples = false;
              this.beginEpoch();
              await this.bridge!.command('system_reset');
              this.bridge!.resetOutput();
              this.stdout.reset();
              const physical = await this.readPhysical();
              this.baseline = physical.virtualMs;
              this.lastAbsolute = physical.virtualMs;
              this.state.phase = 'paused';
              await this.setInputs(this.state.inputs, false);
              await this.readTrace();
              if (this.gpioSupported) await this.setGpioInputs(this.state.gpioInputs ?? []);
              await this.readStatus();
              this.acceptingSamples = true;
              break;
            }
            case 'stop':
              this.state.phase = 'stopped';
              this.bridgeReady = false;
              this.acceptingSamples = false;
              this.pendingLatency = [];
              await this.bridge?.close();
              this.state.metrics.qemuRssMb = 0;
              break;
          }
          this.event('control', command.action);
          return this.ack(command.id, true);
        } catch (error) {
          this.fail(error);
          await this.bridge?.close();
          return this.ack(command.id, false, errorText(error));
        }
      });
    } catch (error) { return this.ack(parsed.data.id, false, errorText(error)); }
  }

  private beginEpoch(): void {
    this.state.epoch++;
    this.state.virtualMs = 0;
    this.state.latest = null;
    this.lastFirmwareSeq = -1;
    this.lastTraceSeq = -1;
    this.firmwareCatalog = false;
    this.firmwareBooted = false;
    this.state.gpio = null;
    this.firmwareWall = 0;
    this.pendingLatency = [];
    this.latencies = [];
    this.state.metrics.latencyCount = 0;
    this.state.metrics.latencyP95Ms = null;
    this.stdout.reset();
    this.stderr.reset();
  }

  exportFile(): z.infer<typeof SessionFileSchema> {
    return structuredClone({ v: 1, inputs: this.state.inputs, scenarios: this.state.scenarios });
  }

  async importFile(value: unknown): Promise<Ack> {
    const parsed = ImportSchema.safeParse(value);
    if (!parsed.success) return this.ack('', false, 'Invalid import; expected {v:1,id,epoch,file:{v:1,inputs,scenarios}}');
    try {
      return await this.enqueue(async () => {
        if (parsed.data.epoch !== this.state.epoch) return this.ack(parsed.data.id, false, 'Stale reset epoch');
        if (!this.bridgeReady) return this.ack(parsed.data.id, false, 'Bridge unavailable');
        try {
          await this.setInputs(parsed.data.file.inputs, false);
          this.state.scenarios = parsed.data.file.scenarios;
          this.pendingLatency = [];
          this.event('control', 'import');
          return this.ack(parsed.data.id, true);
        } catch (error) {
          this.fail(error);
          await this.bridge?.close();
          return this.ack(parsed.data.id, false, errorText(error));
        }
      });
    } catch (error) { return this.ack(parsed.data.id, false, errorText(error)); }
  }

  close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.queue;
    this.acceptingSamples = false;
    this.bridgeReady = false;
    if (this.state.phase !== 'error') this.state.phase = 'stopped';
    await this.bridge?.close();
    this.state.metrics.qemuRssMb = 0;
    this.stdout.reset();
    this.stderr.reset();
  }
}

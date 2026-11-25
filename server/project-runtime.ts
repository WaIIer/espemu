import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectManifestSchema, qemuCircuit, type CircuitScenario, type ProjectManifest } from '../shared/manifest.ts';
import { controls, digitalInputLevel, isCamera, isPeripheralInput, isSensor, isSpeaker, normalizeInputs, peripheralFamily, PERIPHERAL_REGISTRY, wiredPins, type DeviceType, type PhysicalInputs } from '../shared/registry.ts';
import { parseApplicationLine } from '../shared/application.ts';
import { CircuitStateSchema, RuntimeCommandSchema, Ws2812StateSchema, type ProjectState } from '../shared/runtime.ts';
import { GpioStateSchema, PeripheralsSchema, type GpioInput } from '../shared/protocol.ts';
import { QemuProcess, type Bridge, type BridgeCallbacks } from './qemu.ts';
import { LineBuffer, TraceSchema } from './telemetry.ts';
import { loadProject } from './project.ts';
import { scenarioValue } from './scenarios.ts';
import { Max7219StateSchema } from '../shared/dot-matrix.ts';
import { CameraStateSchema } from '../shared/camera.ts';
import { SpeakerAudioSchema, SpeakerStateSchema, type AudioMessage } from '../shared/speaker.ts';

function push<Value>(array: Value[], value: Value, maximum: number) { array.push(value); if (array.length > maximum) array.splice(0, array.length - maximum); }
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
const scenarioKey = (scenario: Pick<CircuitScenario,'deviceId'|'channel'>) => `${scenario.deviceId}:${scenario.channel}`;
function wiring(manifest: ProjectManifest) {
  return PeripheralsSchema.parse(manifest.devices.filter(device => !isSensor(device) && !isCamera(device) && !isSpeaker(device)).map(device => { const { type, ...config } = device; return { ...config, kind: type, label: device.label ?? PERIPHERAL_REGISTRY[type].label }; }));
}

export class ProjectRuntime extends EventEmitter {
  private state: ProjectState;
  private confirmedDuringImport: ProjectState | null = null;
  private bridge: Bridge | null = null;
  private bridgeGeneration = 0;
  private momentary = new Map<number, { source: object; level: GpioInput['level'] }>();
  private disconnected = new WeakSet<object>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private polling = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private baseline = 0;
  private eventSequence = 0;
  private cameraSequence = 0;
  private traceSequence = -1;
  private appSequence = -1;
  private booted = false;
  private bridgeReady = false;
  private stdout = new LineBuffer(line => this.output(line), () => this.drop());
  private stderr = new LineBuffer(line => this.log(`stderr: ${line}`), () => this.drop());

  constructor(private readonly root: string, manifest = loadProject(root).manifest, private readonly factory?: (callbacks: BridgeCallbacks, manifest: ProjectManifest) => Bridge, projectDirectory = root) {
    super();
    const project = ProjectManifestSchema.parse(manifest);
    this.state = { v: 1, sessionId: randomUUID(), projectName: basename(projectDirectory).slice(0,255), epoch: 0, phase: 'starting', virtualMs: 0, wallMs: Date.now(), manifest: project,
      inputs: structuredClone(project.inputs), scenarios: structuredClone(project.scenarios), scenarioRuns: {}, deviceStates: {}, latest: null, history: [],
      gpio: null, gpioWallMs: 0, gpioInputs: structuredClone(project.gpioInputs), gpioError: null, peripherals: wiring(project), events: [], console: [], error: null,
      metrics: { samples: 0, droppedFrames: 0, qemuRssMb: 0, latencyP95Ms: null, latencyCount: 0 }, ws2812:null, max7219:null, camera:null, speaker:null };
  }
  snapshot(): ProjectState {
    const snapshot=structuredClone(this.confirmedDuringImport ?? this.state);
    snapshot.wallMs = Date.now();
    while(snapshot.history.length>1&&Buffer.byteLength(JSON.stringify(snapshot))>800*1024)
      snapshot.history.splice(0,Math.max(1,Math.ceil(snapshot.history.length/2)));
    return snapshot;
  }
  topology() { const { manifest } = this.confirmedDuringImport ?? this.state; return { v: 1, target: manifest.target, buses: manifest.buses, devices: manifest.devices }; }
  drop() { this.state.metrics.droppedFrames++; }
  health(): Record<string, unknown> { return { v: 1, ready: this.bridgeReady && this.state.phase === 'running', bridgeReady: this.bridgeReady,
    firmwareBootObserved: this.booted, gpioReady: !!this.state.gpio, phase: this.state.phase, epoch: this.state.epoch, error: this.state.error,
    backendRssMb: process.memoryUsage().rss / 1048576, backendHeapMb: process.memoryUsage().heapUsed / 1048576 }; }
  private log(line: string) { push(this.state.console, line.slice(0, 512), 200); }
  private event(source: ProjectState['events'][number]['source'], text: string, time = this.state.virtualMs) { push(this.state.events, { seq: ++this.eventSequence, epoch: this.state.epoch, wallMs: Date.now(), virtualMs: time, source, message: text.slice(0,256) }, 256); }
  private enqueue<Value>(operation: () => Promise<Value>, cleanup = false): Promise<Value> {
    if (this.closed || (!cleanup && this.queued >= 64)) return Promise.reject(new Error('Control queue unavailable'));
    this.queued++; const result = this.queue.then(operation); this.queue = result.catch(() => {}).finally(() => { this.queued--; }); return result;
  }
  private output(line: string) {
    if (line.includes('Calling app_main()')) this.booted = true;
    const sample = parseApplicationLine(line);
    if (!sample) { this.log(`stdout: ${line}`); return; }
    if (sample.seq <= this.appSequence || this.state.phase !== 'running') return;
    this.appSequence = sample.seq;
    const point = { ...sample, epoch: this.state.epoch, virtualMs: this.state.virtualMs, wallMs: Date.now() };
    this.state.latest = point; push(this.state.history, point, 600); this.state.metrics.samples++; this.emit('sample');
  }
  async start() {
    this.timer ??= setInterval(() => { void this.poll(); }, 100);
    await this.enqueue(async () => {
      try { await this.launch(); await this.bridge!.command('cont'); await this.status(); }
      catch (error) { if (this.bridge) { this.fail(error); await this.closeBridge(); } throw error; }
    });
  }
  private async closeBridge() {
    const bridge = this.bridge;
    this.bridge = null;
    this.momentary.clear();
    this.bridgeGeneration++;
    this.bridgeReady = false;
    this.stdout.reset();
    this.stderr.reset();
    await bridge?.close();
  }
  private async launch() {
    const generation = ++this.bridgeGeneration;
    const active = () => generation === this.bridgeGeneration && !this.closed;
    const callbacks: BridgeCallbacks = { stdout: chunk => { if (active()) this.stdout.push(chunk); }, stderr: chunk => { if (active()) this.stderr.push(chunk); }, exited: error => { if (active()) this.fail(error); } };
    this.state.phase = 'starting'; this.state.error = null; this.booted = false;
    try {
      this.bridge = this.factory ? this.factory(callbacks, this.state.manifest) : new QemuProcess(this.root, callbacks, process.env, this.state.manifest);
      await this.bridge.start();
      this.baseline = (await this.setInputs(this.epochInputs()))!.virtualMs;
      this.state.virtualMs = 0;
      await this.setGpio(this.state.gpioInputs); await this.status(); this.bridgeReady = true;
    } catch (error) { this.fail(error); await this.closeBridge(); throw error; }
  }
  private fail(error: unknown) { this.state.error = message(error); this.state.phase = 'error'; this.bridgeReady = false; this.event('system', this.state.error); }
  private async status() {
    const value = await this.bridge!.command('query-status') as { running: boolean; status: string };
    if (typeof value?.running !== 'boolean') throw new Error('Invalid QEMU status');
    this.state.phase = value.running ? 'running' : 'paused';
  }
  private async readCircuit() {
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc', property: 'espemu-circuit' });
    if (typeof value !== 'string' || value.length > 65536) throw new Error('Invalid circuit state');
    const physical = CircuitStateSchema.parse(JSON.parse(value));
    const devices = this.state.manifest.devices.filter(isSensor);
    if (physical.devices.length !== devices.length) throw new Error('QEMU circuit does not match project manifest');
    const inputs: PhysicalInputs = {}, states: ProjectState['deviceStates'] = {};
    for (const device of devices) {
      const observed = physical.devices.find(entry => entry.id === device.id);
      if (!observed || observed.type !== device.type || observed.address !== device.address) throw new Error(`QEMU device mismatch: ${device.id}`);
      const values: Record<string, number | boolean> = { connected: observed.inputs.connected, invalid: observed.inputs.invalid };
      for (const [name, control] of Object.entries(controls(device.type))) values[name] = Number(observed.inputs[control.rawKey]) / control.scale;
      inputs[device.id] = values; states[device.id] = observed.state;
    }
    this.state.inputs = normalizeInputs(this.state.manifest.devices, inputs); this.state.deviceStates = states;
    this.state.virtualMs = Math.max(0, physical.virtualMs - this.baseline); return physical;
  }
  private async setInputs(value: PhysicalInputs) {
    const inputs = normalizeInputs(this.state.manifest.devices, value);
    if (this.state.phase === 'stopped') { this.state.inputs = inputs; return; }
    const raw = qemuCircuit(this.state.manifest, inputs);
    await this.bridge!.command('qom-set', { path: '/machine/soc', property: 'espemu-circuit-inputs', value: JSON.stringify({ v: 1, devices: Object.fromEntries(raw.devices.map(device => [device.id, device.inputs])) }) });
    return this.readCircuit();
  }
  private async readGpio() {
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc/gpio', property: 'espemu-state' });
    if (typeof value !== 'string' || value.length > 32768) throw new Error('Invalid GPIO state');
    const next = GpioStateSchema.parse(JSON.parse(value));
    if (this.state.gpio) for (const pin of next.pins) { const old = this.state.gpio.pins.find(entry => entry.pin === pin.pin); if (old && old.level !== pin.level) this.event('gpio', `GPIO${pin.pin} ${pin.level}`); }
    this.state.gpio = next; this.state.gpioWallMs = Date.now(); this.state.gpioError = null;
  }
  private async setGpio(pins: ProjectState['gpioInputs']) {
    const validated = ProjectManifestSchema.parse({ ...this.state.manifest, inputs: this.state.inputs, gpioInputs: pins, scenarios: this.state.scenarios });
    if (this.state.phase === 'stopped') { this.state.gpioInputs = validated.gpioInputs; return; }
    const drives = validated.gpioInputs.filter(input => !this.momentary.has(input.pin));
    for (const [pin, { level }] of this.momentary) drives.push({ pin, level });
    await this.bridge!.command('qom-set', { path: '/machine/soc/gpio', property: 'espemu-inputs', value: JSON.stringify({ v: 1, pins: drives }) });
    await this.readGpio(); this.state.gpioInputs = validated.gpioInputs;
  }
  async releaseControls(source: object) {
    if (this.disconnected.has(source)) return;
    this.disconnected.add(source);
    if (!Array.from(this.momentary.values()).some(hold => hold.source === source)) return;
    await this.enqueue(async () => {
      let changed = false;
      for (const [pin, hold] of this.momentary) if (hold.source === source) { this.momentary.delete(pin); changed = true; }
      if (changed && this.bridgeReady) await this.applyMomentary();
    }, true);
  }
  private async applyMomentary() {
    try { await this.setGpio(this.state.gpioInputs); }
    catch (error) { this.fail(error); await this.closeBridge(); throw error; }
  }
  private async readWs2812() {
    if(!this.state.manifest.devices.some(device=>device.type==='ws2812b')){this.state.ws2812=null;return;}
    const value=await this.bridge!.command('qom-get',{path:'/machine/soc/rmt',property:'ws2812-state'});
    if(typeof value!=='string'||value.length>256*1024)throw new Error('Invalid WS2812 state');
    this.state.ws2812=Ws2812StateSchema.parse(JSON.parse(value));
  }
  private async readMax7219() {
    const devices = this.state.manifest.devices.filter(device => device.type === 'max7219');
    if (!devices.length) { this.state.max7219 = null; return; }
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc/gpio', property: 'max7219-state' });
    if (typeof value !== 'string' || value.length > 128 * 1024) throw new Error('Invalid MAX7219 state');
    const next = Max7219StateSchema.parse(JSON.parse(value));
    if (next.devices.length !== devices.length || devices.some(device => !next.devices.some(observed =>
      observed.id === device.id && observed.din === device.din && observed.clk === device.clk &&
      observed.load === device.load && observed.length === device.length))) throw new Error('QEMU MAX7219 wiring does not match project manifest');
    this.state.max7219 = next;
  }
  private async readCamera() {
    const device = this.state.manifest.devices.find(isCamera);
    if (!device) { this.state.camera = null; return; }
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc', property: 'espemu-camera-state' });
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid camera state');
    const next = CameraStateSchema.parse(JSON.parse(value));
    if (!next.configured || next.id !== device.id || next.vsync !== device.signals.vsync) throw new Error('QEMU camera wiring does not match project manifest');
    this.state.camera = next;
  }
  private async readSpeaker() {
    const device = this.state.manifest.devices.find(isSpeaker);
    if (!device) { this.state.speaker = null; return; }
    const value = await this.bridge!.command('qom-get', { path: '/machine/soc', property: 'espemu-speaker-state' });
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid speaker state');
    const next = SpeakerStateSchema.parse(JSON.parse(value));
    if (!next.configured || next.id !== device.id) throw new Error('QEMU speaker wiring does not match project manifest');
    this.state.speaker = next;
    const text = await this.bridge!.command('qom-get', { path: '/machine/soc', property: 'espemu-speaker-audio' });
    if (typeof text !== 'string' || text.length > 1_400_000) throw new Error('Invalid speaker audio');
    const audio = SpeakerAudioSchema.parse(JSON.parse(text));
    if (audio.data && audio.rate) this.emit('audio', { v: 1, type: 'audio', deviceId: device.id, epoch: this.state.epoch, rate: audio.rate, start: audio.start, data: audio.data } satisfies AudioMessage);
  }
  private applyScenario(inputs: PhysicalInputs, scenario: CircuitScenario, elapsed: number) {
    const device = this.state.manifest.devices.find(device => device.id === scenario.deviceId)!;
    const control = controls(device.type)[scenario.channel];
    const value = scenarioValue(scenario, elapsed);
    if (value !== undefined) inputs[device.id][scenario.channel] = Math.min(control.maximum, Math.max(control.minimum, value));
  }
  private epochInputs() {
    const inputs = structuredClone(this.state.inputs);
    for (const scenario of this.state.scenarios) {
      if (this.state.scenarioRuns?.[scenarioKey(scenario)]?.status === 'active') this.applyScenario(inputs, scenario, 0);
    }
    return inputs;
  }
  private overrideScenarios(changed: (scenario: CircuitScenario) => boolean) {
    this.state.scenarios = this.state.scenarios.filter(scenario => {
      if (!changed(scenario)) return true;
      const run = this.state.scenarioRuns?.[scenarioKey(scenario)];
      if (!run) return false;
      run.status = 'overridden';
      return true;
    });
  }
  async poll() {
    if (this.closed || !this.bridgeReady || this.polling || this.queued) return false;
    this.polling = true;
    try { return await this.enqueue(async () => { if (!this.bridgeReady) return false; try {
      await this.status(); await this.readCircuit(); await this.readGpio(); await this.readWs2812(); await this.readMax7219(); await this.readCamera(); await this.readSpeaker(); this.state.metrics.qemuRssMb = await this.bridge!.rssMb();
      const text = await this.bridge!.command('qom-get', { path: '/machine/soc/i2c0', property: 'espemu-trace' });
      if (typeof text !== 'string' || text.length > 65536) throw new Error('Invalid I2C trace');
      for (const event of TraceSchema.parse(JSON.parse(text)).events) if (event.seq > this.traceSequence) { this.traceSequence = event.seq; this.event('i2c', `0x${event.address.toString(16)} ${event.read ? 'read' : 'write'} ${event.length} ${event.status}`, Math.max(0,event.virtualMs-this.baseline)); }
      if (this.state.phase === 'running') {
        const next = structuredClone(this.state.inputs);
        const completed: string[] = [];
        for (const scenario of this.state.scenarios) {
          const key = scenarioKey(scenario), run = this.state.scenarioRuns?.[key];
          if (run && run.status !== 'active') continue;
          const elapsed = this.state.virtualMs - (run?.originMs ?? 0);
          this.applyScenario(next, scenario, elapsed);
          if (run && scenario.kind === 'playback' && elapsed >= scenario.frames.at(-1)!.timeMs) completed.push(key);
        }
        if (JSON.stringify(next) !== JSON.stringify(this.state.inputs)) await this.setInputs(next);
        for (const key of completed) this.state.scenarioRuns![key].status = 'completed';
      }
      return true;
    } catch (error) { this.fail(error); await this.closeBridge(); return false; } }); } catch { return false; } finally { this.polling = false; }
  }
  private ack(id: string, ok: boolean, error?: string) { return { v: 1 as const, type: 'ack' as const, id: id.slice(0,100), sessionId: this.state.sessionId, epoch: this.state.epoch, ok, ...(error ? { error } : {}) }; }
  async command(value: unknown, source?: object) {
    const parsed = RuntimeCommandSchema.safeParse(value);
    if (!parsed.success) return this.ack(typeof (value as {id?:unknown})?.id === 'string' ? (value as {id:string}).id : '', false, parsed.error.issues.map(issue => issue.message).join('; ').slice(0,2000));
    try { return await this.enqueue(async () => {
      const command = parsed.data;
      if (source && this.disconnected.has(source)) return this.ack(command.id,false,'Connection closed before command execution');
      if (command.sessionId !== undefined && command.sessionId !== this.state.sessionId) return this.ack(command.id,false,'Stale runtime session');
      if (command.epoch !== this.state.epoch) return this.ack(command.id,false,'Stale reset epoch');
      if (this.state.phase === 'error' && !['run','stop','console-clear'].includes(command.action)) return this.ack(command.id,false,this.state.error ?? 'Emulator error');
      if (this.state.phase === 'stopped' && ['pause','reset'].includes(command.action)) return this.ack(command.id,false,'Guest is stopped');
      try {
        switch (command.action) {
        case 'input':
        case 'input-fields': {
          const device=this.state.manifest.devices.find(device=>device.id===command.deviceId);
          if(!device||!isSensor(device))throw new Error(`Unknown physical-input device: ${command.deviceId}`);
          const fields=command.action==='input'?{[command.channel]:command.value}:command.fields;
          for(const name of Object.keys(fields))if(!Object.hasOwn(controls(device.type),name)&&!['connected','invalid'].includes(name))throw new Error(`Unknown input channel: ${device.id}.${name}`);
          const next=structuredClone(this.state.inputs);Object.assign(next[device.id],fields);
          await this.setInputs(next);
          this.overrideScenarios(scenario=>scenario.deviceId===device.id&&Object.hasOwn(fields,scenario.channel));
          break;
        }
        case 'inputs': {
          const previous=this.state.inputs; await this.setInputs(command.inputs);
          this.overrideScenarios(scenario=>this.state.inputs[scenario.deviceId]?.[scenario.channel]!==previous[scenario.deviceId]?.[scenario.channel]); break;
        }
        case 'scenario':
        case 'scenario-start': {
          const key = scenarioKey(command.scenario);
          const scenarios = this.state.scenarios.filter(value => scenarioKey(value) !== key).concat(command.scenario);
          ProjectManifestSchema.parse({ ...this.state.manifest, inputs: this.state.inputs, scenarios });
          if (command.action === 'scenario-start') {
            if (this.state.phase !== 'stopped') await this.readCircuit();
            const originMs = this.state.phase === 'stopped' ? 0 : this.state.virtualMs;
            const next = structuredClone(this.state.inputs);
            this.applyScenario(next, command.scenario, 0);
            await this.setInputs(next);
            this.state.scenarioRuns![key] = { originMs, status: 'active' };
          } else delete this.state.scenarioRuns![key];
          this.state.scenarios = scenarios;
          break;
        }
        case 'scenario-stop': {
          const key = scenarioKey(command);
          if (!this.state.scenarios.some(scenario => scenarioKey(scenario) === key)) throw new Error('No scenario for this channel');
          this.state.scenarioRuns![key] = { originMs: this.state.scenarioRuns![key]?.originMs ?? 0, status: 'stopped' };
          break;
        }
        case 'gpio-inputs': await this.setGpio(command.pins); break;
        case 'gpio-pin': await this.setGpio(this.state.gpioInputs.filter(input => input.pin !== command.input.pin).concat(command.input)); break;
        case 'gpio-momentary': {
          if (!source) throw new Error('Momentary input requires an active connection');
          if (!this.bridgeReady) throw new Error('Guest is not available for momentary input');
          const device = this.state.manifest.devices.find(entry => entry.id === command.deviceId);
          if (!device || !isPeripheralInput(device) || peripheralFamily(device.type) !== 'button') throw new Error('Unknown momentary input');
          const held = this.momentary.get(device.pin);
          if (held && held.source !== source) throw new Error('Button held by another connection');
          if (command.pressed && !held) this.momentary.set(device.pin, { source, level: digitalInputLevel(device.type, device.activeLow, true, 'pullUp' in device && device.pullUp === true) });
          else if (!command.pressed && held) this.momentary.delete(device.pin);
          else break;
          await this.applyMomentary();
          break;
        }
        case 'restore-environment': {
          const before = this.exportFile(), declared = this.state.manifest;
          this.momentary.clear();
          try { await this.setInputs(declared.inputs); await this.setGpio(declared.gpioInputs); this.state.scenarios = structuredClone(declared.scenarios); this.state.scenarioRuns = {}; }
          catch (error) { this.state.inputs = before.inputs; this.state.gpioInputs = before.gpioInputs; this.fail(error); await this.closeBridge(); throw error; }
          break;
        }
        case 'peripherals': {
          const devices = this.state.manifest.devices.filter(device => isSensor(device) || isCamera(device) || isSpeaker(device)).concat(command.peripherals.map(device => { const {kind,...config}=device; return { ...config,type:kind }; }) as never[]);
          const gpioInputs = this.state.gpioInputs.filter(input => command.peripherals.some(device => {
            const family=peripheralFamily(device.kind as DeviceType);
            const pin=wiredPins(device)[0];
            return (family === 'button' || family === 'switch') && pin === input.pin;
          }));
          await this.replace(ProjectManifestSchema.parse({ ...this.state.manifest, devices, inputs: this.state.inputs, scenarios:this.state.scenarios, gpioInputs })); break;
        }
        case 'manifest': await this.replace(command.manifest); break;
        case 'camera-frame':
        case 'camera-clear': {
          const device = this.state.manifest.devices.find(entry => entry.id === command.deviceId);
          if (!device || !isCamera(device)) throw new Error(`Unknown camera: ${command.deviceId}`);
          if (!this.bridgeReady) throw new Error('Guest is not available for camera frames');
          const value = command.action === 'camera-clear' ? { v: 1, clear: true } : { v: 1, seq: ++this.cameraSequence, ...command.frame };
          await this.bridge!.command('qom-set', { path: '/machine/soc', property: 'espemu-camera-frame', value: JSON.stringify(value) });
          if (command.action === 'camera-clear') { await this.readCamera(); break; }
          await this.readCamera();
          // Frames arrive continuously; logging each one would flush every other control event.
          return this.ack(command.id, true);
        }
        case 'pause': await this.bridge!.command('stop'); await this.status(); await this.readCircuit(); await this.readGpio(); await this.readWs2812(); await this.readMax7219(); await this.readCamera(); break;
        case 'reset': await this.bridge!.command('stop'); this.epoch(); await this.bridge!.command('system_reset'); this.bridge!.resetOutput(); this.stdout.reset(); this.baseline = (await this.setInputs(this.epochInputs()))!.virtualMs; this.state.virtualMs = 0; await this.setGpio(this.state.gpioInputs); await this.readWs2812(); await this.readMax7219(); await this.readCamera(); await this.status(); break;
        case 'stop': this.state.phase = 'stopped'; this.state.error = null; await this.closeBridge(); break;
        case 'console-clear': this.state.console=[]; break;
        case 'run': if (this.state.phase === 'stopped' || this.state.phase === 'error') { await this.closeBridge(); this.epoch(); await this.launch(); } if (this.state.phase !== 'running') { await this.bridge!.command('cont'); await this.status(); } break;
        }
        this.event('control',command.action); return this.ack(command.id,true);
      } catch (error) {
        if (['run','pause','reset'].includes(command.action) && this.bridge) { this.fail(error); await this.closeBridge(); }
        return this.ack(command.id,false,message(error));
      }
    }); } catch (error) { return this.ack(parsed.data.id,false,message(error)); }
  }
  private epoch() { this.state.epoch++; this.state.virtualMs=0; this.state.latest=null; this.state.history=[]; this.state.deviceStates={}; this.state.gpio=null; this.state.gpioWallMs=0; this.state.ws2812=null; this.state.max7219=null; this.state.camera=null; this.state.speaker=null; this.appSequence=-1; this.traceSequence=-1; this.booted=false; this.momentary.clear(); for (const run of Object.values(this.state.scenarioRuns ?? {})) run.originMs = 0; }
  exportFile(): ProjectManifest { const { manifest, inputs, gpioInputs, scenarios } = this.confirmedDuringImport ?? this.state; return ProjectManifestSchema.parse({ ...manifest, inputs, gpioInputs, scenarios }); }
  private async replace(manifest: ProjectManifest) {
    const next = ProjectManifestSchema.parse(manifest);
    const previous = this.state;
    const hardware=(manifest:ProjectManifest)=>manifest.devices.filter(device=>isSensor(device)||isCamera(device)||isSpeaker(device)||device.type==='ws2812b'||device.type==='max7219');
    const restart = JSON.stringify(hardware(next)) !== JSON.stringify(hardware(previous.manifest)) || JSON.stringify(next.buses) !== JSON.stringify(previous.manifest.buses);
    this.momentary.clear();
    this.confirmedDuringImport = previous;
    this.state = { ...structuredClone(previous), manifest: next, inputs: structuredClone(next.inputs), scenarios: structuredClone(next.scenarios), scenarioRuns: {}, gpioInputs: structuredClone(next.gpioInputs), peripherals: wiring(next) };
    try {
      if (previous.phase === 'stopped') return;
      if (restart) {
        await this.closeBridge(); this.epoch(); await this.launch();
        if (previous.phase === 'running') { await this.bridge!.command('cont'); await this.status(); }
      } else { await this.setInputs(next.inputs); await this.setGpio(next.gpioInputs); }
    } catch (error) {
      const epoch = this.state.epoch;
      this.state = previous;
      this.state.epoch = epoch;
      this.fail(error); await this.closeBridge(); throw error;
    } finally { this.confirmedDuringImport = null; }
  }
  async importFile(value: unknown) {
    const request = value as {v?:number;id?:string;sessionId?:string;epoch?:number;file?:unknown};
    if (request?.v !== 1 || typeof request.id !== 'string' || request.epoch !== this.state.epoch) return this.ack(typeof request?.id === 'string' ? request.id : '',false,'Invalid import or stale reset epoch');
    return this.command({v:1,id:request.id,sessionId:request.sessionId,epoch:request.epoch,action:'manifest',manifest:request.file});
  }
  async close() { if(this.closed)return; this.closed=true; if(this.timer)clearInterval(this.timer); await this.queue; this.state.phase='stopped'; await this.closeBridge(); }
}

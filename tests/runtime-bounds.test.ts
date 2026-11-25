import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { EMPTY_MANIFEST, ProjectManifestSchema, DEMO_MANIFEST } from '../shared/manifest.ts';
import type { BridgeCallbacks } from '../server/qemu.ts';

test('commands from a different runtime lifetime reject even at the same epoch', async () => {
  const previous = new ProjectRuntime('.', EMPTY_MANIFEST).snapshot();
  const runtime = new ProjectRuntime('.', EMPTY_MANIFEST);
  const current = runtime.snapshot();
  assert.equal(current.epoch, previous.epoch);
  assert.notEqual(current.sessionId, previous.sessionId);
  const command = { v: 1, id: 'clear', epoch: current.epoch, action: 'console-clear' };
  const stale = await runtime.command({ ...command, sessionId: previous.sessionId });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'Stale runtime session');
  assert.equal(stale.sessionId, current.sessionId);
  assert.deepEqual(runtime.snapshot().events, []);
  assert.equal((await runtime.command({ ...command, sessionId: current.sessionId })).ok, true);
});

test('commands waiting in the runtime queue are retired with their connection', async () => {
  const runtime = new ProjectRuntime('.', DEMO_MANIFEST);
  let unblock!: () => void;
  const blocked = new Promise<void>(done => { unblock = done; });
  Object.assign(runtime, { queue: blocked, state: { ...runtime.snapshot(), phase: 'stopped' } });
  const source = {};
  const pending = runtime.command({ v: 1, id: 'queued', epoch: 0, action: 'input', deviceId: 'tmp105', channel: 'temperatureC', value: 31 }, source);
  await runtime.releaseControls(source);
  unblock();
  assert.equal((await pending).error, 'Connection closed before command execution');
  assert.equal(runtime.snapshot().inputs.tmp105.temperatureC, DEMO_MANIFEST.inputs.tmp105.temperatureC);
  await runtime.close();
});

test('failed polling allows Stop and Run and retires callbacks from the closed bridge', async () => {
  const callbacks: BridgeCallbacks[] = [];
  let closes = 0;
  const runtime = new ProjectRuntime('.', EMPTY_MANIFEST, (handlers) => {
    callbacks.push(handlers);
    let running = false;
    return {
      async start() {}, async rssMb() { return 0; }, resetOutput() {},
      async close() { closes++; handlers.exited('obsolete close event'); },
      async command(execute, args) {
        if (execute === 'cont') running = true;
        if (execute === 'query-status') return { running };
        if (execute === 'qom-get') {
          if (args?.property === 'espemu-circuit') return JSON.stringify({ v: 1, virtualMs: 0, devices: [] });
          if (args?.property === 'espemu-state') return JSON.stringify({ v: 1, virtualMs: 0, pins: [] });
          throw new Error('QMP poll failed');
        }
      },
    };
  });
  const command = (action: 'stop' | 'run') => runtime.command({ v: 1, id: action, epoch: runtime.snapshot().epoch, action });
  try {
    await runtime.start();
    assert.equal(await runtime.poll(), false);
    assert.equal(runtime.snapshot().error, 'QMP poll failed');
    assert.equal(closes, 1);
    assert.equal((await command('stop')).ok, true);
    assert.equal((await command('stop')).ok, true);
    assert.equal(closes, 1);
    assert.equal((await command('run')).ok, true);
    callbacks[0].stdout(Buffer.from('unexpected retired output\n'));
    callbacks[0].exited('unexpected retired exit');
    assert.equal(runtime.snapshot().phase, 'running');
    assert.equal(runtime.snapshot().epoch, 1);
    assert.equal(runtime.snapshot().error, null);
    assert.deepEqual(runtime.snapshot().console, []);
  } finally { await runtime.close(); }
});

test('protocol-only snapshot projection bounds large named-channel histories without inventing observations',()=>{
  const runtime=new ProjectRuntime('.',EMPTY_MANIFEST);
  const state=runtime.snapshot();
  const channels=Object.fromEntries(Array.from({length:64},(_,index)=>[`channel-${index}`,{value:index,unit:'long-unit-name'}]));
  state.history=Array.from({length:600},(_,seq)=>({v:1 as const,seq,guestUs:seq*1000,channels,epoch:0,virtualMs:seq,wallMs:seq}));
  state.latest=state.history.at(-1)!;
  Object.assign(runtime,{state});
  const projected=runtime.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(projected))<800*1024);
  assert.equal(projected.history.at(-1)!.seq,599);
  assert.equal(projected.latest!.channels['channel-63'].value,63);
});
test('stopped physical edits validate without a QMP connection', async () => {
  const runtime = new ProjectRuntime('.', DEMO_MANIFEST);
  const command = (payload: object) => runtime.command({ v: 1, id: 'staging', epoch: 0, ...payload });
  assert.equal((await command({ action: 'stop' })).ok, true);
  assert.equal((await command({ action: 'input', deviceId: 'tmp105', channel: 'temperatureC', value: -5 })).ok, true);
  assert.equal((await command({ action: 'input', deviceId: 'tmp105', channel: 'temperatureC', value: 500 })).ok, false);
  assert.equal(runtime.snapshot().inputs.tmp105.temperatureC, -5);
  assert.equal(runtime.snapshot().phase, 'stopped');
  assert.equal((await command({ action: 'reset' })).ok, false);
  assert.equal((await command({ action: 'restore-environment' })).ok, true);
  assert.equal(runtime.snapshot().inputs.tmp105.temperatureC, DEMO_MANIFEST.inputs.tmp105.temperatureC);
});
test('a rejected partial circuit import retains the last confirmed declaration', async () => {
  const runtime = new ProjectRuntime('.', EMPTY_MANIFEST);
  const next = ProjectManifestSchema.parse({ ...EMPTY_MANIFEST, devices: [{ id: 'alarm', type: 'led', pin: 4 }] });
  let closes = 0;
  Object.assign(runtime, {
    state: { ...runtime.snapshot(), phase: 'paused' }, bridgeReady: true,
    bridge: {
      command: async () => {
        assert.deepEqual(runtime.snapshot().manifest.devices, []);
        throw new Error('QMP write failed');
      },
      close: async () => { closes++; },
    },
  });
  const result = await runtime.command({ v: 1, id: 'import', epoch: 0, action: 'manifest', manifest: next });
  assert.equal(result.ok, false);
  assert.deepEqual(runtime.exportFile(), EMPTY_MANIFEST);
  assert.equal(runtime.snapshot().phase, 'error');
  assert.equal((await runtime.command({ v: 1, id: 'stop', epoch: 0, action: 'stop' })).ok, true);
  assert.equal(closes, 1);
});
test('oversized scenario manifests fail validation before simulation',()=>{
  const frames=Array.from({length:10000},(_,index)=>({timeMs:index,value:index}));
  const value={...DEMO_MANIFEST,scenarios:[{deviceId:'tmp105',channel:'temperatureC',kind:'playback',offset:0,amplitude:0,periodMs:10000,seed:0,frames},
    {deviceId:'bh1750',channel:'lux',kind:'playback',offset:0,amplitude:0,periodMs:10000,seed:0,frames}]};
  assert.equal(ProjectManifestSchema.safeParse(value).success,false);
});

test('explicit stopped playback stages frame zero and manual override retains its portable definition', async () => {
  const runtime = new ProjectRuntime('.', DEMO_MANIFEST);
  const command = (payload: object) => runtime.command({ v: 1, id: 'playback', epoch: 0, ...payload });
  const scenario = { deviceId: 'tmp105', channel: 'temperatureC', kind: 'playback', offset: 0, amplitude: 0, seed: 0, periodMs: 10000, frames: [{ timeMs: 0, value: 12 }, { timeMs: 6000, value: 40 }] };
  assert.equal((await command({ action: 'stop' })).ok, true);
  assert.equal((await command({ action: 'scenario-start', scenario })).ok, true);
  assert.equal(runtime.snapshot().inputs.tmp105.temperatureC, 12);
  assert.equal((await command({ action: 'input', deviceId: 'tmp105', channel: 'temperatureC', value: 19 })).ok, true);
  assert.equal(runtime.snapshot().scenarioRuns?.['tmp105:temperatureC'].status, 'overridden');
  assert.deepEqual(runtime.exportFile().scenarios.find(entry=>entry.deviceId==='tmp105'), scenario);
  assert.equal(Object.hasOwn(runtime.exportFile(), 'scenarioRuns'), false);
});

test('QEMU is launched with a parent-death signal on Linux so it cannot outlive a killed backend', async () => {
  const { qemuLauncher } = await import('../server/qemu.ts');
  assert.deepEqual(qemuLauncher('/q', 'linux', () => true), ['/usr/bin/setpriv', ['--pdeathsig', 'TERM', '--', '/q']]);
  assert.deepEqual(qemuLauncher('/q', 'linux', () => false), ['/q', []]);
  assert.deepEqual(qemuLauncher('/q', 'darwin', () => true), ['/q', []]);
});

test('camera frames are validated, forwarded to the QEMU sensor with a sequence number, and refresh camera state', async () => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'cam', type: 'ov2640' }, { id: 'lamp', type: 'led', pin: 2 }] });
  const frames: Record<string, unknown>[] = [];
  const camera = (source: unknown) => JSON.stringify({ v: 1, configured: true, id: 'cam', vsync: 25, sensor: { format: 'jpeg', width: 160, height: 120 }, source, status: source ? 'running' : 'no-source',
    framesStarted: 0, framesDelivered: 0, framesMissed: 0, dma: { bytes: 0, eofInterrupts: 0, descriptorErrors: 0, receiving: false }, error: '' });
  const runtime = new ProjectRuntime('.', manifest, () => {
    let running = false;
    return {
      async start() {}, async rssMb() { return 0; }, resetOutput() {}, async close() {},
      async command(execute, args) {
        if (execute === 'cont') running = true;
        if (execute === 'query-status') return { running };
        if (execute === 'qom-set' && args?.property === 'espemu-camera-frame') frames.push(JSON.parse(String(args.value)));
        if (execute === 'qom-get') {
          if (args?.property === 'espemu-circuit') return JSON.stringify({ v: 1, virtualMs: 0, devices: [] });
          if (args?.property === 'espemu-state') return JSON.stringify({ v: 1, virtualMs: 0, pins: [] });
          if (args?.property === 'espemu-camera-state') { const last = frames.at(-1); return camera(last ? { format: last.format, width: last.width, height: last.height, seq: last.seq, bytes: 4 } : null); }
        }
      },
    };
  });
  const send = (deviceId: string, frame: Record<string, unknown>) => runtime.command({ v: 1, id: 'frame', epoch: runtime.snapshot().epoch, action: 'camera-frame', deviceId, frame });
  const jpeg = { format: 'jpeg', width: 160, height: 120, data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') };
  try {
    await runtime.start();
    assert.deepEqual(runtime.snapshot().peripherals.map(device => device.id), ['lamp'], 'cameras are not GPIO peripherals');
    assert.equal((await send('cam', jpeg)).ok, true);
    assert.equal((await send('cam', jpeg)).ok, true);
    assert.deepEqual(frames.map(frame => frame.seq), [1, 2]);
    assert.deepEqual(frames[0], { v: 1, seq: 1, ...jpeg });
    assert.equal(runtime.snapshot().camera?.source?.seq, 2);
    assert.match((await send('lamp', jpeg)).error ?? '', /Unknown camera: lamp/);
    assert.equal((await send('cam', { ...jpeg, width: 161 })).ok, false, 'sizes follow the sensor multiples of four');
    assert.equal((await send('cam', { ...jpeg, data: 'A'.repeat(700_000) })).ok, false, 'frames stay under the WebSocket limit');
    assert.equal((await send('cam', { ...jpeg, data: 'not base64!' })).ok, false);
    assert.equal(frames.length, 2);
    assert.equal(runtime.snapshot().events.filter(event => event.message === 'camera-frame').length, 0, 'frames do not flood the event log');
  } finally { await runtime.close(); }
});

test('speaker polling reports state and emits drained PCM as audio events outside the state snapshot', async () => {
  const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'spk', type: 'max98357a', din: 27, bclk: 26, lrclk: 25 }] });
  const pcm = Buffer.from(new Int16Array([100, -100, 50]).buffer).toString('base64');
  let drained = false;
  const runtime = new ProjectRuntime('.', manifest, () => {
    let running = false;
    return {
      async start() {}, async rssMb() { return 0; }, resetOutput() {}, async close() {},
      async command(execute, args) {
        if (execute === 'cont') running = true;
        if (execute === 'query-status') return { running };
        if (execute === 'qom-get') {
          if (args?.property === 'espemu-circuit') return JSON.stringify({ v: 1, virtualMs: 0, devices: [] });
          if (args?.property === 'espemu-state') return JSON.stringify({ v: 1, virtualMs: 0, pins: [] });
          if (args?.property === 'espemu-speaker-state') return JSON.stringify({ v: 1, configured: true, id: 'spk', controller: 1, playing: true, rate: 16000, bits: 16, mono: false,
            samples: 3, underrunFrames: 0, eofInterrupts: 1, descriptorErrors: 0, dropped: 0, peak: 100, error: '' });
          if (args?.property === 'espemu-trace') return JSON.stringify({ v: 1, events: [] });
          if (args?.property === 'espemu-speaker-audio') { const data = drained ? '' : pcm; drained = true; return JSON.stringify({ v: 1, rate: 16000, start: 0, data }); }
        }
      },
    };
  });
  const events: unknown[] = [];
  runtime.on('audio', message => events.push(message));
  try {
    await runtime.start();
    assert.deepEqual(runtime.snapshot().peripherals, [], 'speakers are not GPIO peripherals');
    assert.equal(await runtime.poll(), true);
    assert.equal(await runtime.poll(), true);
    assert.deepEqual(events, [{ v: 1, type: 'audio', deviceId: 'spk', epoch: 0, rate: 16000, start: 0, data: pcm }], 'only non-empty drains are sent');
    assert.equal(runtime.snapshot().speaker?.controller, 1);
    assert.ok(!JSON.stringify(runtime.snapshot()).includes(pcm), 'PCM never enters state');
  } finally { await runtime.close(); }
});

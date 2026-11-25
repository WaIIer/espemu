import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INPUTS, ScenarioSchema } from '../shared/protocol.ts';
import { Backend } from '../server/backend.ts';
import { rawInputs } from '../server/telemetry.ts';
import type { Bridge, BridgeCallbacks, QmpCommand } from '../server/qemu.ts';

class ProtocolStub implements Bridge {
  absoluteMs = 1000;
  running = false;
  inputs = rawInputs(DEFAULT_INPUTS);
  calls: { execute: QmpCommand; args: Record<string, unknown> }[] = [];
  trace = [{ seq: 0, virtualMs: 1000, address: 72, read: true, length: 2, status: 'ok' }];
  closed = false;
  missingQom = false;
  block: Promise<void> | null = null;
  constructor(readonly callbacks: BridgeCallbacks) {}
  async start() {}
  async close() { this.closed = true; }
  async rssMb() { return 12.5; }
  resetOutput() {}
  async command(execute: QmpCommand, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ execute, args });
    if (this.block) await this.block;
    if (execute === 'qom-get') {
      if (this.missingQom) throw new Error('Property espemu-state not found');
      return JSON.stringify(args.property === 'espemu-state' ? { v: 1, virtualMs: this.absoluteMs, inputs: this.inputs } : { v: 1, events: this.trace });
    }
    if (execute === 'qom-set') { assert.equal(typeof args.value, 'string'); this.inputs = JSON.parse(args.value as string); }
    if (execute === 'query-status') return { running: this.running, status: this.running ? 'running' : 'paused' };
    if (execute === 'cont') this.running = true;
    if (execute === 'stop') this.running = false;
    if (execute === 'system_reset') this.trace = [{ ...this.trace[0], seq: 0, virtualMs: this.absoluteMs }];
    return {};
  }
  sample(seq: number, temperatureC = this.inputs.tmp105.temperatureMc / 1000, full = false) {
    this.callbacks.stdout(Buffer.from('ESP_EMU ' + JSON.stringify({ v: 1, seq, guestUs: this.absoluteMs * 1000,
      tmp105: { temperatureC, error: 0 }, ...(full ? {
        bh1750: { lux: this.inputs.bh1750.luxMilli / 1000, error: 0 },
        bme280: { temperatureC: this.inputs.bme280.temperatureMc / 1000, pressurePa: this.inputs.bme280.pressurePa, humidityPct: this.inputs.bme280.humidityMilli / 1000, error: 0 },
      } : {}),
    }) + '\n'));
  }
}

function fixture() {
  let stub!: ProtocolStub;
  let now = 0;
  const backend = new Backend(process.cwd(), callbacks => { stub = new ProtocolStub(callbacks); return stub; }, () => 5000 + now, () => now);
  return { backend, get stub() { return stub; }, advance: (value: number) => { now += value; } };
}
const command = (action: string, epoch = 0) => ({ v: 1, id: action, epoch, action });

test('protocol stub: QOM confirmed inputs are separate from real UART observations and readiness', async () => {
  const setup = fixture();
  await setup.backend.start(false);
  try {
    assert.equal(setup.backend.snapshot().latest, null);
    assert.equal(setup.backend.health().ready, false);
    setup.stub.sample(1);
    assert.equal(setup.backend.health().firmwareCatalog, false);
    setup.stub.callbacks.stdout(Buffer.from('ESP_EMU ' + JSON.stringify({ v: 1, seq: 2, guestUs: 1,
      tmp105: { temperatureC: 25, error: 0 }, bh1750: { lux: null, error: -1 },
      bme280: { temperatureC: null, pressurePa: null, humidityPct: null, error: -1 },
    }) + '\n'));
    assert.equal(setup.backend.health().ready, false);
    setup.stub.sample(3, 25, true);
    assert.equal(setup.backend.health().ready, true);
    setup.advance(2100);
    assert.equal(setup.backend.health().ready, false);
    const changed = structuredClone(DEFAULT_INPUTS);
    changed.tmp105.temperatureC = 37.6;
    assert.equal((await setup.backend.command({ ...command('inputs'), inputs: changed })).ok, true);
    assert.equal(setup.backend.snapshot().inputs.tmp105.temperatureC, 37.6);
    assert.equal(setup.backend.snapshot().latest?.tmp105?.temperatureC, 25);
    setup.advance(50);
    setup.stub.sample(4, 37.5);
    assert.equal(setup.backend.snapshot().metrics.latencyP95Ms, 50);
    assert.equal(setup.backend.snapshot().metrics.latencyCount, 1);
  } finally { await setup.backend.close(); }
});

test('protocol stub: reset uses absolute-clock baseline, freezes scenarios and rejects queued stale epochs', async () => {
  const setup = fixture();
  await setup.backend.start(false);
  try {
    const scenario = ScenarioSchema.parse({ deviceId: 'tmp105', channel: 'temperatureC', kind: 'ramp', offset: 0, amplitude: 100, periodMs: 1000, seed: 1 });
    await setup.backend.command({ ...command('scenario'), scenario });
    setup.stub.absoluteMs = 1500;
    await setup.backend.poll();
    assert.equal(setup.backend.snapshot().virtualMs, 500);
    assert.equal(setup.backend.snapshot().inputs.tmp105.temperatureC, 50);
    await setup.backend.command(command('pause'));
    const frozen = setup.backend.snapshot();
    await setup.backend.poll();
    assert.deepEqual(setup.backend.snapshot().inputs, frozen.inputs);
    assert.equal(setup.backend.snapshot().virtualMs, 500);
    const reset = setup.backend.command(command('reset'));
    const stale = setup.backend.command(command('run'));
    assert.equal((await reset).epoch, 1);
    assert.equal((await stale).ok, false);
    assert.equal(setup.backend.snapshot().phase, 'paused');
    assert.equal(setup.backend.snapshot().virtualMs, 0);
    assert.deepEqual(setup.backend.snapshot().inputs, frozen.inputs);
    setup.stub.sample(0);
    assert.equal(setup.backend.snapshot().latest?.epoch, 1);
    await setup.backend.command(command('run', 1));
    setup.stub.absoluteMs = 1600;
    await setup.backend.poll();
    assert.equal(setup.backend.snapshot().virtualMs, 100);
    assert.equal(setup.backend.snapshot().inputs.tmp105.temperatureC, 10);
    assert.equal(setup.backend.snapshot().events.filter(event => event.source === 'i2c').length, 2);
  } finally { await setup.backend.close(); }
});

test('protocol stub: overlapping polls skip, state rings are bounded, malformed commands do not mutate', async () => {
  const setup = fixture();
  await setup.backend.start(false);
  try {
    assert.equal((await setup.backend.command({ ...command('run'), v: 2 })).ok, false);
    assert.equal((await setup.backend.command({ ...command('run'), epoch: -1 })).ok, false);
    assert.equal((await setup.backend.command({ ...command('run'), id: 'x'.repeat(101) })).ok, false);
    let release!: () => void;
    setup.stub.block = new Promise<void>(resolveBlock => { release = resolveBlock; });
    const poll = setup.backend.poll();
    assert.equal(await setup.backend.poll(), false);
    release();
    await poll;
    setup.stub.block = null;
    for (let index = 0; index < 700; index++) {
      setup.stub.sample(index);
      setup.stub.callbacks.stderr(Buffer.from('plain log\n'));
    }
    const snapshot = setup.backend.snapshot();
    assert.equal(snapshot.history.length, 600);
    assert.equal(snapshot.console.length, 200);
    assert.equal(snapshot.metrics.qemuRssMb, 12.5);
    snapshot.inputs.tmp105.temperatureC = 100;
    assert.equal(setup.backend.snapshot().inputs.tmp105.temperatureC, 25);
    for (let index = 0; index < 260; index++) await setup.backend.command(command('pause'));
    assert.equal(setup.backend.snapshot().events.length, 256);
    await setup.backend.command(command('stop'));
    assert.equal(setup.stub.closed, true);
    assert.equal(setup.backend.health().ready, false);
    assert.equal((await setup.backend.command(command('run'))).epoch, 1);
  } finally { await setup.backend.close(); }
});

test('protocol stub: missing custom bridge fails honestly and import requires an epoch envelope', async () => {
  let stub!: ProtocolStub;
  const backend = new Backend(process.cwd(), callbacks => { stub = new ProtocolStub(callbacks); stub.missingQom = true; return stub; });
  await backend.start(false);
  try {
    assert.equal(backend.snapshot().phase, 'error');
    assert.equal(backend.health().bridgeReady, false);
    assert.equal(stub.closed, true);
    assert.match(backend.snapshot().error!, /not found/);
    assert.equal((await backend.importFile(backend.exportFile())).ok, false);
  } finally { await backend.close(); }
  const setup = fixture();
  await setup.backend.start(false);
  try {
    const file = setup.backend.exportFile();
    file.inputs.tmp105.temperatureC = 40;
    assert.equal((await setup.backend.importFile({ v: 1, id: 'import', epoch: 0, file })).ok, true);
    assert.equal(setup.backend.snapshot().inputs.tmp105.temperatureC, 40);
    assert.equal((await setup.backend.importFile({ v: 1, id: 'import', epoch: 9, file })).ok, false);
  } finally { await setup.backend.close(); }
});

test('protocol stub: fault-only updates preserve scenarios and scenario changes cancel superseded latency', async () => {
  const setup = fixture();
  await setup.backend.start(false);
  try {
    const scenario = ScenarioSchema.parse({ deviceId: 'tmp105', channel: 'temperatureC', kind: 'ramp', offset: 0, amplitude: 100, periodMs: 1000, seed: 1 });
    await setup.backend.command({ ...command('scenario'), scenario });
    const inputs = structuredClone(DEFAULT_INPUTS);
    inputs.tmp105.invalid = true;
    await setup.backend.command({ ...command('inputs'), inputs });
    assert.equal(setup.backend.snapshot().scenarios[0].kind, 'ramp');
    setup.stub.absoluteMs = 1100;
    await setup.backend.poll();
    assert.equal(setup.backend.snapshot().inputs.tmp105.temperatureC, 10);
    assert.equal(setup.backend.snapshot().inputs.tmp105.invalid, true);
    inputs.tmp105.temperatureC = 40;
    inputs.tmp105.invalid = false;
    await setup.backend.command({ ...command('inputs'), inputs });
    assert.equal(setup.backend.snapshot().scenarios[0].kind, 'manual');
    await setup.backend.command({ ...command('scenario'), scenario });
    setup.stub.absoluteMs = 1200;
    await setup.backend.poll();
    setup.advance(100);
    setup.stub.sample(1, 40);
    assert.equal(setup.backend.snapshot().metrics.latencyCount, 0);
  } finally { await setup.backend.close(); }
});

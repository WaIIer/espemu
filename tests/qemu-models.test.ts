import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { QmpConnection } from '../server/qemu.ts';
import { LineBuffer, rawInputs } from '../server/telemetry.ts';
import { DEFAULT_INPUTS, type InputSnapshot } from '../shared/protocol.ts';
import { Max7219StateSchema } from '../shared/dot-matrix.ts';

export class ModelFixture {
  private child!: ChildProcess;
  private qmp!: QmpConnection;
  private socket!: Socket;
  private directory!: string;
  private response: ((line: string) => void) | null = null;
  private diagnostics = '';
  private inputs: InputSnapshot = structuredClone(DEFAULT_INPUTS);
  i2cBase = 0x3ff53000;

  async start(devices: unknown[] = [
    { id: 'tmp105', type: 'tmp105', address: 0x48, inputs: { temperatureMc: 25000, connected: true, invalid: false } },
    { id: 'bh1750', type: 'bh1750', address: 0x23, inputs: { luxMilli: 320000, connected: true, invalid: false } },
    { id: 'bme280', type: 'bme280', address: 0x76, inputs: { temperatureMc: 23000, pressurePa: 101325, humidityMilli: 45000, connected: true, invalid: false } },
  ], extra: Record<string, unknown> = {}): Promise<void> {
    const root = resolve(import.meta.dirname, '..');
    this.directory = await mkdtemp(join(tmpdir(), 'espemu-qtest-'));
    await writeFile(`${this.directory}/circuit.json`, JSON.stringify({ v: 1, devices, ...extra }));
    this.child = spawn(resolve(root, process.env.ESPEMU_TOOLS ?? '.cache', 'qemu/build/qemu-system-xtensa'), [
      '-machine', 'esp32', '-accel', 'qtest', '-display', 'none', '-monitor', 'none', '-serial', 'null',
      '-qmp', `unix:${this.directory}/qmp,server=on,wait=off`,
      '-qtest', `unix:${this.directory}/qtest,server=on,wait=off`,
      '-qtest-log', '/dev/null', '-L', resolve(root, process.env.ESPEMU_TOOLS ?? '.cache', 'qemu/pc-bios'),
    ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ESPEMU_QEMU_CIRCUIT: `${this.directory}/circuit.json` } });
    this.child.stderr?.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-4096); });
    const connect = async (path: string): Promise<Socket> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (this.child.exitCode !== null) throw new Error(this.diagnostics);
        try {
          return await new Promise<Socket>((done, reject) => {
            const socket = createConnection(path);
            socket.once('error', reject);
            socket.once('connect', () => { socket.removeListener('error', reject); done(socket); });
          });
        } catch { await delay(10); }
      }
      throw new Error(`QTest startup timed out: ${this.diagnostics}`);
    };
    this.qmp = new QmpConnection(await connect(`${this.directory}/qmp`));
    await this.qmp.greeting;
    await this.qmp.command('qmp_capabilities');
    this.socket = await connect(`${this.directory}/qtest`);
    const framing = new LineBuffer(line => this.response?.(line), () => { throw new Error('QTest frame overflow'); });
    this.socket.on('data', chunk => framing.push(chunk));
  }

  async qtest(text: string): Promise<string> {
    assert.equal(this.response, null);
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => { this.response = null; reject(new Error(`QTest timeout: ${text}`)); }, 2000);
      this.response = line => {
        clearTimeout(timer);
        this.response = null;
        if (!line.startsWith('OK')) reject(new Error(line));
        else done(line);
      };
      this.socket.write(text + '\n');
    });
  }

  async clock(us: number): Promise<void> { await this.qtest(`clock_step ${us * 1000}`); }
  async write(offset: number, value: number): Promise<void> {
    await this.qtest(`writel 0x${(this.i2cBase + offset).toString(16)} 0x${(value >>> 0).toString(16)}`);
  }
  async read(offset: number): Promise<number> {
    return Number((await this.qtest(`readl 0x${(this.i2cBase + offset).toString(16)}`)).split(' ')[1]);
  }

  async transfer(address: number, outgoing: number[], count = 0): Promise<number[]> {
    await this.write(0x18, 0x3000);
    await this.write(0x18, 0);
    await this.write(0x24, 0xffff);
    const commands: number[] = [0];
    const data: number[] = [];
    if (outgoing.length || !count) {
      data.push(address << 1, ...outgoing);
      commands.push((1 << 11) | (1 << 8) | (outgoing.length + 1));
    }
    if (count) {
      if (outgoing.length) commands.push(0);
      data.push((address << 1) | 1);
      commands.push((1 << 11) | (1 << 8) | 1, (2 << 11) | (1 << 10) | count);
    }
    commands.push(3 << 11);
    for (const byte of data) await this.write(0x1c, byte);
    for (let index = 0; index < commands.length; index++) await this.write(0x58 + index * 4, commands[index]);
    await this.write(0x04, 0x30);
    assert.ok((await this.read(0x08)) & 0x10, 'Transaction must not complete synchronously');
    for (let step = 0; step < 100 && ((await this.read(0x08)) & 0x10); step++) await this.clock(100);
    assert.equal((await this.read(0x08)) & 0x10, 0, 'Transaction must complete');
    assert.equal((await this.read(0x20)) & ((1 << 10) | (1 << 8)), 0, `Bus fault at 0x${address.toString(16)}`);
    const result: number[] = [];
    for (let index = 0; index < count; index++) result.push(await this.read(0x1c));
    return result;
  }

  async configureBus(): Promise<void> {
    await this.write(0, 399);
    await this.write(0x38, 392);
    await this.write(0x04, 0x10);
    await this.write(0x28, (1 << 7) | (1 << 10) | (1 << 8));
  }

  async input(update: (inputs: InputSnapshot) => void): Promise<void> {
    update(this.inputs);
    await this.qmp.command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(rawInputs(this.inputs)) });
  }
  async circuitInputs(devices:Record<string,unknown>){await this.qmp.command('qom-set',{path:'/machine/soc',property:'espemu-circuit-inputs',value:JSON.stringify({v:1,devices})});}

  async trace(): Promise<{ events: { seq: number; address: number }[] }> {
    return JSON.parse(await this.qmp.command('qom-get', { path: '/machine/soc/i2c0', property: 'espemu-trace' }) as string);
  }

  async gpioState(): Promise<{ pins: { pin: number; level: number; outputEnabled: boolean; outputLatch: number }[] }> {
    return JSON.parse(await this.qmp.command('qom-get', { path: '/machine/soc/gpio', property: 'espemu-state' }) as string);
  }

  async reset(): Promise<void> { await this.qmp.command('system_reset'); }
  async matrixConfig(devices: unknown[]) {
    await this.qmp.command('qom-set', { path: '/machine/soc/gpio', property: 'max7219-config', value: JSON.stringify({ v: 1, devices }) });
  }
  async matrixState() {
    return Max7219StateSchema.parse(JSON.parse(await this.qmp.command('qom-get', { path: '/machine/soc/gpio', property: 'max7219-state' }) as string));
  }
  async matrixLevel(pin: number, high: boolean) {
    const bank = pin >= 32 ? 12 : 0;
    await this.qtest(`writel 0x${(0x3ff44000 + bank + (high ? 8 : 12)).toString(16)} 0x${(2 ** (pin % 32)).toString(16)}`);
  }
  async matrixEnable(pins: number[]) {
    for (const pin of pins) await this.qtest(`writel 0x${(0x3ff44000 + (pin >= 32 ? 0x30 : 0x24)).toString(16)} 0x${(2 ** (pin % 32)).toString(16)}`);
  }
  async matrixBits(bits: number[], din = 23, clk = 18) {
    for (const bit of bits) {
      await this.matrixLevel(clk, false);
      await this.matrixLevel(din, !!bit);
      await this.matrixLevel(clk, true);
      await this.matrixLevel(clk, false);
    }
  }
  async matrixWords(words: number[], load = 5, din = 23, clk = 18) {
    await this.matrixLevel(load, false);
    await this.matrixBits(words.flatMap(word => Array.from({ length: 16 }, (_, bit) => (word >> (15 - bit)) & 1)), din, clk);
    await this.matrixLevel(load, true);
  }
  async wsConfig(devices:{id:string;pin:number;length:number}[]){await this.qmp.command('qom-set',{path:'/machine/soc/rmt',property:'ws2812-config',value:JSON.stringify({v:1,devices})});}
  async wsState():Promise<{devices:{id:string;frames:number;pixels:number[][]}[];error:string}>{return JSON.parse(await this.qmp.command('qom-get',{path:'/machine/soc/rmt',property:'ws2812-state'}) as string);}
  async circuit(): Promise<{ devices: { id: string; type: string; address: number }[] }> {
    return JSON.parse(await this.qmp.command('qom-get', { path: '/machine/soc', property: 'espemu-circuit' }) as string);
  }
  async gpioInputs(pins: { pin: number; level: number | null }[]): Promise<void> {
    await this.qmp.command('qom-set', { path: '/machine/soc/gpio', property: 'espemu-inputs', value: JSON.stringify({ v: 1, pins }) });
  }

  async memory(address: number, value?: number): Promise<number> {
    if (value !== undefined) { await this.qtest(`writel 0x${address.toString(16)} 0x${(value >>> 0).toString(16)}`); return value; }
    return Number((await this.qtest(`readl 0x${address.toString(16)}`)).split(' ')[1]);
  }
  async camera(): Promise<{ status: string; sensor: { format: string; width: number; height: number }; framesStarted: number; framesDelivered: number; framesMissed: number; error: string; dma: { bytes: number; eofInterrupts: number; descriptorErrors: number; receiving: boolean } }> {
    return JSON.parse(await this.qmp.command('qom-get', { path: '/machine/soc', property: 'espemu-camera-state' }) as string);
  }
  async qomGet(property: string): Promise<string> { return await this.qmp.command('qom-get', { path: '/machine/soc', property }) as string; }
  async cameraFrame(frame: Record<string, unknown>): Promise<void> {
    await this.qmp.command('qom-set', { path: '/machine/soc', property: 'espemu-camera-frame', value: JSON.stringify(frame) });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    if (this.child && this.child.exitCode === null) {
      try { await this.qmp?.command('quit'); } catch { this.child.kill('SIGTERM'); }
      if (this.child.exitCode === null) await new Promise(done => this.child.once('exit', done));
    }
    this.qmp?.close();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

test('actual MAX7219 serial edges, register masks, display modes and RAM retention follow the datasheet', { timeout: 30000 }, async () => {
  const fixture = new ModelFixture();
  try {
    await fixture.start([]);
    await fixture.matrixConfig([{ id: 'matrix', din: 23, clk: 18, load: 5, length: 1 }]);
    await fixture.matrixEnable([23, 18, 5]);
    const module = async () => (await fixture.matrixState()).devices[0].modules[0];
    assert.equal((await module()).shutdown, true);
    assert.equal((await module()).scanLimit, 0);
    assert.deepEqual((await module()).rows, Array(8).fill(0));
    await fixture.matrixWords([0x0181]);
    assert.equal((await module()).digits[0], 0x81);
    assert.equal((await module()).rows[0], 0);
    await fixture.matrixWords([0x0c01]);
    assert.equal((await module()).rows[0], 0x81);
    await fixture.matrixWords([0x02ff]);
    assert.equal((await module()).rows[1], 0);
    await fixture.matrixWords([0x0bff]);
    assert.equal((await module()).scanLimit, 7);
    assert.equal((await module()).rows[1], 255);
    await fixture.matrixWords([0x0afe]);
    assert.equal((await module()).intensity, 14);
    assert.equal((await module()).duty32, 29);
    await fixture.matrixWords([0x0901]);
    await fixture.matrixWords([0x018b]);
    assert.equal((await module()).rows[0], 0xcf, 'Code B E + decimal point');
    const font = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70, 0x7f, 0x7b, 0x01, 0x4f, 0x37, 0x0e, 0x67, 0];
    for (const [digit, segments] of font.entries()) {
      await fixture.matrixWords([0x01f0 | digit]);
      assert.equal((await module()).rows[0], 0x80 | segments, 'All Code B glyphs ignore D6-D4 but retain decimal point');
    }
    await fixture.matrixWords([0x0c00]);
    const retained = (await module()).digits;
    assert.deepEqual((await module()).rows, Array(8).fill(0));
    await fixture.matrixWords([0x0f03]);
    assert.equal((await module()).displayTest, true);
    assert.deepEqual((await module()).rows, Array(8).fill(255));
    assert.equal((await module()).duty32, 31);
    await fixture.matrixWords([0x0f02]);
    assert.equal((await module()).displayTest, false);
    assert.deepEqual((await module()).digits, retained);
    await fixture.matrixWords([0xfcff]);
    assert.equal((await module()).shutdown, false, 'Upper address bits are ignored');
    await fixture.matrixWords([0x0000, 0x0dff, 0x0eff]);
    assert.deepEqual((await module()).digits, retained, 'Reserved addresses and NO-OP do not alter RAM');

    await fixture.matrixLevel(5, false);
    await fixture.matrixBits(Array.from({ length: 16 }, (_, bit) => (0x033c >> (15 - bit)) & 1));
    assert.equal((await module()).digits[2], 0, 'CLK only shifts, not latches');
    await fixture.matrixLevel(5, true);
    assert.equal((await module()).digits[2], 0x3c);
    await fixture.matrixBits(Array.from({ length: 16 }, (_, bit) => (0x045a >> (15 - bit)) & 1));
    assert.equal((await module()).digits[3], 0, 'LOAD high does not disable the shift register');
    await fixture.matrixLevel(5, false);
    await fixture.matrixLevel(5, true);
    assert.equal((await module()).digits[3], 0x5a, 'Falling LOAD must not discard shifted bits');
    await fixture.matrixWords([0xffff, 0x05a5]);
    assert.equal((await module()).digits[4], 0xa5, 'Long transfers retain the final 16 bits');
    await fixture.matrixWords([0]);
    await fixture.matrixBits([1, ...Array(14).fill(0)]);
    await fixture.matrixLevel(18, true);
    assert.equal((await module()).shift, 0x8000);
    assert.equal((await module()).dout, false, 'DIN is not visible at DOUT after only 16 rising edges');
    await fixture.matrixLevel(18, false);
    assert.equal((await module()).dout, true, 'DOUT changes after the 16.5th clock cycle');
    await fixture.matrixLevel(18, true);
    assert.equal((await module()).dout, true, 'DOUT holds its level across a rising clock');
    await fixture.matrixLevel(18, false);
    assert.equal((await module()).dout, false);
    await fixture.reset();
    assert.equal((await module()).shutdown, true);
    assert.deepEqual((await module()).digits, Array(8).fill(0));
  } finally { await fixture.close(); }
});

test('actual MAX7219 daisy chains shift via DOUT and target independent modules with NO-OP', { timeout: 30000 }, async () => {
  const fixture = new ModelFixture();
  try {
    await fixture.start([]);
    const config = { id: 'chain', din: 25, clk: 32, load: 33, length: 16 };
    await fixture.matrixConfig([config]);
    await fixture.matrixEnable([25, 32, 33]);
    await fixture.matrixWords(Array.from({ length: 16 }, (_, index) => 0x0100 | (16 - index)), 33, 25, 32);
    let observed = (await fixture.matrixState()).devices[0];
    assert.deepEqual(observed.modules.map(module => module.digits[0]), Array.from({ length: 16 }, (_, index) => index + 1));
    await fixture.matrixWords([0x015a, ...Array(15).fill(0)], 33, 25, 32);
    observed = (await fixture.matrixState()).devices[0];
    assert.equal(observed.modules[15].digits[0], 0x5a);
    assert.deepEqual(observed.modules.slice(0, 15).map(module => module.digits[0]), Array.from({ length: 15 }, (_, index) => index + 1));
    for (const devices of [[{ ...config, length: 17 }], [{ ...config, din: 34 }], [{ ...config, clk: 25 }], [config, { ...config, id: 'other' }]]) {
      await assert.rejects(fixture.matrixConfig(devices), /MAX7219/);
      assert.deepEqual((await fixture.matrixState()).devices[0], observed, 'Invalid configuration is atomic');
    }
    await fixture.matrixConfig([]);
    assert.deepEqual((await fixture.matrixState()).devices, []);
  } finally { await fixture.close(); }
});

test('actual QEMU models: TMP105/BH1750 conversions and BME280 registers use virtual time', { timeout: 30000 }, async () => {
  const fixture = new ModelFixture();
  try {
    await fixture.start();
    await fixture.configureBus();
    await fixture.input(inputs => { inputs.tmp105.temperatureC = 37.5; });
    assert.deepEqual(await fixture.transfer(0x48, [0], 2), [0, 0]);
    await fixture.clock(30000);
    assert.deepEqual(await fixture.transfer(0x48, [0], 2), [37, 128]);
    await fixture.transfer(0x48, [1, 1]);
    await fixture.input(inputs => { inputs.tmp105.temperatureC = 55; });
    await fixture.clock(100000);
    assert.deepEqual(await fixture.transfer(0x48, [0], 2), [37, 128]);
    await fixture.transfer(0x48, [1, 0x81]);
    await fixture.clock(30000);
    assert.deepEqual(await fixture.transfer(0x48, [0], 2), [55, 0]);
    assert.deepEqual(await fixture.transfer(0x48, [1], 1), [1]);

    await fixture.transfer(0x23, [0x10]);
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [0, 0]);
    await fixture.clock(125000);
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [1, 128]);
    await fixture.input(inputs => { inputs.bh1750.lux = 640; });
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [1, 128]);
    await fixture.clock(125000);
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [3, 0]);
    await fixture.transfer(0x23, [0]);
    await fixture.input(inputs => { inputs.bh1750.lux = 960; });
    await fixture.clock(125000);
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [3, 0]);
    await fixture.transfer(0x23, [0x20]);
    await fixture.clock(125000);
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [4, 128]);
    await fixture.input(inputs => { inputs.bh1750.lux = 640; });
    await fixture.clock(125000);
    assert.deepEqual(await fixture.transfer(0x23, [], 2), [4, 128]);

    assert.deepEqual(await fixture.transfer(0x76, [0xd0], 1), [0x60]);
    assert.deepEqual(await fixture.transfer(0x76, [0x88], 2), [0x70, 0x6b]);
    await fixture.transfer(0x76, [0xd0, 0]);
    assert.deepEqual(await fixture.transfer(0x76, [0xd0], 1), [0x60]);
    await fixture.transfer(0x76, [0xf2, 1]);
    await fixture.transfer(0x76, [0xf4, 0x25]);
    assert.ok((await fixture.transfer(0x76, [0xf3], 1))[0] & 8);
    assert.deepEqual(await fixture.transfer(0x76, [0xfa], 3), [0x80, 0, 0]);
    await fixture.clock(12000);
    assert.equal((await fixture.transfer(0x76, [0xf3], 1))[0] & 8, 0);
    assert.equal((await fixture.transfer(0x76, [0xf4], 1))[0] & 3, 0);
    assert.notDeepEqual(await fixture.transfer(0x76, [0xfa], 3), [0x80, 0, 0]);
    await fixture.input(inputs => { inputs.bme280.invalid = true; });
    await fixture.transfer(0x76, [0xf4, 0x25]);
    await fixture.clock(12000);
    assert.deepEqual(await fixture.transfer(0x76, [0xf7], 8), [0x80, 0, 0, 0x80, 0, 0, 0x80, 0]);
    await fixture.transfer(0x76, [0xe0, 0xb6]);
    await fixture.clock(3000);
    assert.deepEqual(await fixture.transfer(0x76, [0xf4], 1), [0]);

    for (let index = 0; index < 140; index++) await fixture.transfer(0x76, [0xd0], 1);
    const trace = await fixture.trace();
    assert.equal(trace.events.length, 128);
    assert.ok(trace.events[0].seq > 1);
    await fixture.write(0x24, 0xffff);
    await fixture.write(0x58, (1 << 11));
    await fixture.write(0x5c, (3 << 11));
    await fixture.write(0x04, 0x30);
    await fixture.clock(1000);
    assert.ok((await fixture.read(0x20)) & (1 << 8), 'Malformed zero-length FIFO commands report timeout without crashing');
  } finally {
    await fixture.close();
  }
});

test('actual RMT memory symbols latch a WS2812 GRB pixel and raise TX completion', {timeout:10000},async()=>{
  const fixture=new ModelFixture();
  try{
    await fixture.start([]);await fixture.wsConfig([{id:'pixel',pin:18,length:1}]);
    await fixture.qtest('writel 0x3ff44578 87');
    await fixture.qtest('writel 0x3ff56020 0x01000008');await fixture.qtest('writel 0x3ff560f0 1');await fixture.qtest('writel 0x3ff560d0 32');
    const symbols:number[]=[];for(const byte of [0,255,0])for(let bit=7;bit>=0;bit--)symbols.push(byte&(1<<bit)?(3<<16)|(1<<15)|9:(9<<16)|(1<<15)|3);
    symbols.push(800);
    for(const [index,symbol] of symbols.entries())await fixture.qtest(`writel 0x${(0x3ff56800+index*4).toString(16)} ${symbol}`);
    await fixture.qtest('writel 0x3ff56024 0xa0001');await fixture.clock(1000);
    assert.deepEqual((await fixture.wsState()).devices[0].pixels,[[255,0,0]]);
    assert.equal((await fixture.wsState()).devices[0].frames,1);
    assert.equal(Number((await fixture.qtest('readl 0x3ff560a0')).split(' ')[1])&1,1);
  }finally{await fixture.close();}
});

test('MPU6050 ordinary I2C bursts reflect signed motion, selected ranges, sleep and reset', {timeout:10000},async()=>{
  const fixture=new ModelFixture();
  const motion={temperatureMc:25000,gyroXmilliDps:90000,gyroYmilliDps:-45000,gyroZmilliDps:15000,accelXmilliG:0,accelYmilliG:0,accelZmilliG:1000,connected:true,invalid:false};
  try{
    await fixture.start([{id:'gyro',type:'mpu6050',address:0x68,inputs:motion}]);await fixture.configureBus();
    assert.deepEqual(await fixture.transfer(0x68,[0x75],1),[0x68]);
    assert.deepEqual(await fixture.transfer(0x68,[0x6b],1),[0x40]);
    assert.deepEqual(await fixture.transfer(0x68,[0x3b],14),Array(14).fill(0));
    await fixture.transfer(0x68,[0x1a,3]);await fixture.transfer(0x68,[0x19,9]);await fixture.transfer(0x68,[0x6b,1]);await fixture.clock(12000);
    const first=Buffer.from(await fixture.transfer(0x68,[0x3b],14));
    assert.equal(first.readInt16BE(4),16384);assert.equal(first.readInt16BE(6),-3920);
    assert.equal(first.readInt16BE(8),11790);assert.equal(first.readInt16BE(10),-5895);
    assert.equal((await fixture.transfer(0x68,[0x3a],1))[0]&1,1);
    await fixture.transfer(0x68,[0x1b,24]);await fixture.transfer(0x68,[0x1c,24]);await fixture.clock(12000);
    const scaled=Buffer.from(await fixture.transfer(0x68,[0x3b],14));
    assert.equal(scaled.readInt16BE(4),2048);assert.equal(scaled.readInt16BE(8),1476);
    await fixture.transfer(0x68,[0x6b,0x40]);await fixture.circuitInputs({gyro:{...motion,gyroXmilliDps:-180000,accelXmilliG:1000,accelZmilliG:0}});await fixture.clock(100000);
    assert.deepEqual(await fixture.transfer(0x68,[0x3b],14),[...scaled]);
    await fixture.transfer(0x68,[0x6b,1]);await fixture.clock(12000);
    const changed=Buffer.from(await fixture.transfer(0x68,[0x3b],14));
    assert.equal(changed.readInt16BE(0),2048);assert.equal(changed.readInt16BE(4),0);assert.equal(changed.readInt16BE(8),-2952);
    await assert.rejects(fixture.circuitInputs({gyro:{...motion,gyroXmilliDps:2000001}}));
    await fixture.transfer(0x68,[0x6b,0x80]);
    assert.deepEqual(await fixture.transfer(0x68,[0x6b],1),[0x40]);assert.deepEqual(await fixture.transfer(0x68,[0x1b],2),[0,0]);
    await fixture.circuitInputs({gyro:{...motion,connected:false}});await assert.rejects(fixture.transfer(0x68,[0x75],1),/Bus fault/);
  }finally{await fixture.close();}
});

test('actual QEMU circuit has no implicit devices and supports independently addressed TMP105s', { timeout: 10000 }, async () => {
  const empty = new ModelFixture();
  try { await empty.start([]); assert.deepEqual((await empty.circuit()).devices, []); await empty.configureBus(); await assert.rejects(empty.transfer(0x48,[0],2), /Bus fault/); }
  finally { await empty.close(); }
  const dual = new ModelFixture();
  try {
    await dual.start([{ id: 'room', type: 'tmp105', address: 0x48, inputs: { temperatureMc: 20000, connected: true, invalid: false } },
      { id: 'outside', type: 'tmp105', address: 0x49, inputs: { temperatureMc: 35000, connected: true, invalid: false } }]);
    await dual.configureBus(); await dual.clock(30000);
    assert.deepEqual(await dual.transfer(0x48, [0], 2), [20,0]);
    assert.deepEqual(await dual.transfer(0x49, [0], 2), [35,0]);
    assert.equal((await dual.circuit()).devices.length, 2);
  } finally { await dual.close(); }
});

test('actual ESP32 GPIO output registers drive QMP pin state and reset both banks', { timeout: 10000 }, async () => {
  const fixture = new ModelFixture();
  try {
    await fixture.start();
    const pin = async (number: number) => (await fixture.gpioState()).pins.find(entry => entry.pin === number)!;
    assert.equal((await pin(2)).outputEnabled, false);
    await fixture.qtest('writel 0x3ff44024 0x4');
    await fixture.qtest('writel 0x3ff44008 0x4');
    assert.equal((await pin(2)).outputEnabled, true);
    assert.equal((await pin(2)).level, 1);
    assert.equal(Number((await fixture.qtest('readl 0x6000403c')).split(' ')[1]) & 4, 4);
    await fixture.qtest('writel 0x3ff4400c 0x4');
    assert.equal((await pin(2)).level, 0);
    await fixture.qtest('writel 0x3ff44030 0xff');
    await fixture.qtest('writel 0x3ff44014 0xff');
    assert.equal((await pin(33)).level, 1);
    assert.equal((await pin(34)).outputEnabled, false);
    await fixture.reset();
    assert.equal((await pin(2)).outputEnabled, false);
    assert.equal((await pin(33)).level, 0);
  } finally { await fixture.close(); }
});

test('actual GPIO inputs, SDK-mapped pulls and atomic invalid-snapshot rejection', { timeout: 10000 }, async () => {
  const fixture = new ModelFixture();
  try {
    await fixture.start();
    const pin = async () => (await fixture.gpioState()).pins.find(entry => entry.pin === 27)!;
    await fixture.qtest('writel 0x3ff484b0 0x8000000');
    assert.equal((await pin()).level, 1);
    await fixture.gpioInputs([{ pin: 27, level: 0 }]);
    assert.equal((await pin()).level, 0);
    await fixture.qtest('writel 0x3ff440f4 0x8180');
    await fixture.gpioInputs([{ pin: 27, level: 1 }]);
    assert.equal(Number((await fixture.qtest('readl 0x3ff44068')).split(' ')[1]) & (1 << 27), 1 << 27);
    await fixture.qtest('writel 0x3ff4404c 0x8000000');
    assert.equal(Number((await fixture.qtest('readl 0x3ff44044')).split(' ')[1]) & (1 << 27), 0);
    await fixture.gpioInputs([{ pin: 27, level: 0 }]);
    await assert.rejects(fixture.gpioInputs([{ pin: 27, level: 1 }, { pin: 6, level: 0 }]));
    assert.equal((await pin()).level, 0);
    await assert.rejects(fixture.gpioInputs([{ pin: 27, level: null }, { pin: 27, level: 1 }]));
    await fixture.gpioInputs([{ pin: 27, level: null }]);
    assert.equal((await pin()).level, 1);
    await fixture.qtest('writel 0x3ff484b0 0x10000000');
    assert.equal((await pin()).level, 0);
    await fixture.qtest('writel 0x3ff49074 0x100');
    assert.equal((await fixture.gpioState()).pins.find(entry => entry.pin === 19)!.level, 1);
  } finally { await fixture.close(); }
});

const sht3xCrc = (bytes: number[]) => {
  let crc = 0xff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff; }
  return crc;
};
const sht3xWord = (word: number, corrupt = false) => [word >> 8, word & 0xff, sht3xCrc([word >> 8, word & 0xff]) ^ (corrupt ? 0xff : 0)];

test('SHT3x single-shot commands NACK until ready, return CRC-protected words and keep instances independent', { timeout: 15000 }, async () => {
  assert.equal(sht3xCrc([0xbe, 0xef]), 0x92, 'datasheet Table 20 CRC example');
  const fixture = new ModelFixture();
  const room = { temperatureMc: 25000, humidityMilli: 45000, connected: true, invalid: false };
  const outside = { temperatureMc: -10500, humidityMilli: 80000, connected: true, invalid: false };
  try {
    await fixture.start([{ id: 'room', type: 'sht3x', address: 0x44, inputs: room }, { id: 'outside', type: 'sht3x', address: 0x45, inputs: outside }]);
    await fixture.configureBus();
    assert.deepEqual(await fixture.transfer(0x44, [0xf3, 0x2d], 3), sht3xWord(0x8010), 'status after power-up: alert pending and reset detected');
    await fixture.transfer(0x44, [0x24, 0x00]);
    await assert.rejects(fixture.transfer(0x44, [], 6), /Bus fault/, 'no clock stretching: read header NACKs while measuring');
    await fixture.clock(13500);
    await assert.rejects(fixture.transfer(0x44, [], 6), /Bus fault/, 'still converting before the 15 ms maximum duration');
    await fixture.clock(1600);
    assert.deepEqual(await fixture.transfer(0x44, [], 6), [...sht3xWord(0x6666), ...sht3xWord(0x7333)]);
    await assert.rejects(fixture.transfer(0x44, [], 6), /Bus fault/, 'results are cleared after readout');

    await fixture.transfer(0x45, [0x2c, 0x06]);
    const raw = Buffer.from(await fixture.transfer(0x45, [], 6));
    assert.equal(raw.readUInt16BE(0), Math.round((-10.5 + 45) * 65535 / 175));
    assert.equal(raw.readUInt16BE(3), Math.round(80 * 65535 / 100));

    await fixture.circuitInputs({ room: { ...room, temperatureMc: 85000, humidityMilli: 100000 }, outside });
    await fixture.transfer(0x44, [0x24, 0x16]);
    await fixture.clock(4100);
    assert.deepEqual(await fixture.transfer(0x44, [], 6), [...sht3xWord(48683), ...sht3xWord(65535)]);
    await fixture.circuitInputs({ room: { ...room, invalid: true }, outside });
    await fixture.transfer(0x44, [0x24, 0x0b]);
    await fixture.clock(6100);
    assert.deepEqual(await fixture.transfer(0x44, [], 6), [...sht3xWord(0x6666, true), ...sht3xWord(0x7333, true)], 'invalid injection corrupts both CRCs');
    assert.deepEqual(await fixture.transfer(0x44, [0xf3, 0x2d], 3), sht3xWord(0x8010), 'status reads stay valid so drivers still initialize');

    await fixture.transfer(0x44, [0x30, 0x6d]);
    assert.equal((await fixture.transfer(0x44, [0xf3, 0x2d], 3))[0] & 0x20, 0x20, 'heater status bit');
    await fixture.transfer(0x44, [0x30, 0x41]);
    assert.deepEqual((await fixture.transfer(0x44, [0xf3, 0x2d], 3)).slice(0, 2), [0x20, 0x00], 'clear status keeps heater');
    await fixture.transfer(0x44, [0x30, 0xa2]);
    assert.deepEqual((await fixture.transfer(0x44, [0xf3, 0x2d], 3)).slice(0, 2), [0x80, 0x10], 'soft reset disables heater and flags reset');
    await assert.rejects(fixture.transfer(0x44, [0x21, 0x30]), /Bus fault/, 'periodic mode is outside the emulated subset');
    assert.equal((await fixture.transfer(0x44, [0xf3, 0x2d], 3))[1] & 0x02, 0x02, 'command status reports the rejected command');
    await fixture.transfer(0x44, [0x30, 0x66]);
    assert.equal((await fixture.transfer(0x44, [0xf3, 0x2d], 3))[1] & 0x02, 0, 'command status describes the last command only');

    await fixture.circuitInputs({ room, outside });
    await fixture.transfer(0x44, [0x24, 0x00]);
    await fixture.clock(15100);
    assert.deepEqual(await fixture.transfer(0x44, [], 3), sht3xWord(0x6666), 'a partial read may stop after the temperature word');
    await assert.rejects(fixture.transfer(0x44, [], 6), /Bus fault/, 'the rest of an aborted readout is discarded');
    await fixture.transfer(0x44, [0x24, 0x00]);
    await fixture.transfer(0x44, [0x30, 0x93]);
    await fixture.clock(15100);
    await assert.rejects(fixture.transfer(0x44, [], 6), /Bus fault/, 'break aborts the measurement');
    await fixture.transfer(0x44, [0x2c, 0x10]);
    assert.equal((await fixture.transfer(0x44, [], 6)).length, 6);
    await assert.rejects(fixture.transfer(0x44, [], 6), /Bus fault/, 'a clock-stretching result is also read once');

    await assert.rejects(fixture.circuitInputs({ room: { ...room, humidityMilli: 100001 }, outside }));
    await fixture.circuitInputs({ room: { ...room, connected: false }, outside });
    await assert.rejects(fixture.transfer(0x44, [0x24, 0x00]), /Bus fault/);
    await fixture.transfer(0x45, [0x24, 0x00]);
    await fixture.clock(15100);
    assert.equal(Buffer.from(await fixture.transfer(0x45, [], 6)).readUInt16BE(0), raw.readUInt16BE(0), 'the other address is unaffected');
    const state = (await fixture.circuit() as unknown as { devices: { id: string; state: { status: string; channels: Record<string, number | null> } }[] }).devices;
    assert.equal(state[0].state.status, 'disconnected'); assert.equal(state[0].state.channels.temperatureC, null);
    assert.ok(Math.abs(state[1].state.channels.temperatureC! + 10.5) < 0.01); assert.ok(Math.abs(state[1].state.channels.humidityPct! - 80) < 0.01);
  } finally { await fixture.close(); }
});

test('OV2640 identifies over SCCB, derives output from DSP registers and streams frames through I2S0 descriptor DMA', { timeout: 20000 }, async () => {
  const fixture = new ModelFixture();
  const I2S = 0x3ff4f000, GPIO_IN = 0x3ff4403c, DESC = 0x3ffb0000, BUFFER = 0x3ffb1000;
  try {
    await fixture.start([], { camera: { id: 'cam', vsync: 25 } });
    fixture.i2cBase = 0x3ff67000;
    await fixture.configureBus();
    await fixture.transfer(0x30, [0xff, 0x01]);
    assert.deepEqual(await fixture.transfer(0x30, [0x0a], 2), [0x26, 0x42], 'PID/VER');
    assert.deepEqual([...await fixture.transfer(0x30, [0x1c], 1), ...await fixture.transfer(0x30, [0x1d], 1)], [0x7f, 0xa2], 'MIDH/MIDL');
    await fixture.transfer(0x30, [0x0a, 0x00]);
    assert.deepEqual(await fixture.transfer(0x30, [0x0a], 1), [0x26], 'ID registers are read-only');
    for (const [register, value] of [[0xff, 0], [0xda, 0x10], [0x5a, 40], [0x5b, 30], [0x5c, 0]]) await fixture.transfer(0x30, [register, value]);
    assert.deepEqual((await fixture.camera()).sensor, { format: 'jpeg', width: 160, height: 120 });
    assert.equal((await fixture.camera()).status, 'no-source');

    const jpeg = [0xff, 0xd8, ...Array.from({ length: 96 }, (_, index) => (index * 7) & 0xff), 0xff, 0xd9];
    const frame = (format: string, width: number, height: number, bytes: number[], seq = 1) => ({ v: 1, seq, format, width, height, data: Buffer.from(bytes).toString('base64') });
    await assert.rejects(fixture.cameraFrame(frame('jpeg', 160, 120, [1, 2, 3, 4])), /SOI/);
    await assert.rejects(fixture.cameraFrame(frame('rgb565', 160, 120, [1, 2])), /width x height x 2/);
    await fixture.cameraFrame(frame('rgb565', 8, 4, Array(64).fill(0)));
    assert.equal((await fixture.camera()).status, 'mismatch');
    assert.match((await fixture.camera()).error, /does not match sensor output jpeg 160x120/);
    await fixture.cameraFrame(frame('jpeg', 160, 120, jpeg));

    for (let index = 0; index < 2; index++) {
      await fixture.memory(DESC + index * 12, 512 | (1 << 31));
      await fixture.memory(DESC + index * 12 + 4, BUFFER + index * 512);
      await fixture.memory(DESC + index * 12 + 8, DESC + ((index + 1) % 2) * 12);
    }
    await fixture.memory(I2S + 0x20, (1 << 12) | (3 << 16));
    await fixture.memory(I2S + 0xa8, 1);
    await fixture.memory(I2S + 0x24, 64);
    await fixture.memory(I2S + 0x14, 1 << 9);
    await fixture.memory(I2S + 0x34, (1 << 29) | (DESC & 0xfffff));
    await fixture.memory(I2S + 0x08, 1 << 5);
    assert.equal((await fixture.memory(I2S + 0x34)) & (1 << 31), 0, 'link running');

    const vsync = async () => (await fixture.memory(GPIO_IN)) >> 25 & 1;
    const until = async (level: number, limitUs: number) => {
      for (let elapsed = 0; elapsed < limitUs; elapsed += 250) { if (await vsync() === level) return; await fixture.clock(250); }
      assert.fail(`VSYNC did not reach ${level}`);
    };
    await until(1, 210000);
    assert.equal((await fixture.camera()).framesStarted, 0, 'VSYNC high is the blanking pulse before the frame');
    await until(0, 2000);
    await fixture.clock(3000);
    let state = await fixture.camera();
    assert.equal(state.dma.bytes, 64, 'streaming pauses at rx_eof_num until the guest services the EOF');
    assert.equal(state.framesDelivered, 0);
    assert.equal(state.dma.eofInterrupts, 1);
    assert.equal((await fixture.memory(I2S + 0x10)) & (1 << 9), 1 << 9, 'in_suc_eof pending');
    assert.equal(await fixture.memory(I2S + 0x3c), DESC, 'EOF descriptor address');
    const first = await fixture.memory(DESC);
    assert.equal(first >>> 31, 0, 'hardware returned descriptor ownership');
    assert.equal((first >> 12) & 0xfff, 256, 'descriptor length at rx_eof_num words');
    assert.equal((first >> 30) & 1, 1, 'descriptor EOF flag');
    for (let index = 0; index < 4; index++) assert.equal(await fixture.memory(BUFFER + index * 4), jpeg[index] << 16, 'SM_0A00_0B00 places each byte in sample1');
    await fixture.memory(I2S + 0x18, 1 << 9);
    assert.equal((await fixture.memory(I2S + 0x10)) & (1 << 9), 0, 'interrupt clear');
    await fixture.clock(2000);
    state = await fixture.camera();
    assert.equal(state.framesDelivered, 1, 'clearing the EOF lets the rest of the frame arrive');
    assert.equal(state.dma.bytes, jpeg.length);
    assert.equal(await fixture.memory(BUFFER + 512), jpeg[64] << 16, 'DMA continued in the next descriptor');

    await fixture.memory(I2S + 0x08, 0);
    await fixture.clock(200000);
    assert.ok((await fixture.camera()).framesMissed >= 1, 'frames are lost while firmware has not started DMA');

    await fixture.memory(I2S + 0x60, 1);
    await fixture.memory(I2S + 0x60, 0);
    await fixture.memory(I2S + 0x20, (1 << 12) | (1 << 16));
    await fixture.memory(DESC, 512 | (1 << 31));
    await fixture.memory(I2S + 0x34, (1 << 29) | (DESC & 0xfffff));
    await fixture.memory(I2S + 0x08, 1 << 5);
    await fixture.clock(110000);
    assert.equal(await fixture.memory(BUFFER), (jpeg[0] << 16) | jpeg[1], 'SM_0A0B_0C0D packs two bytes per word');

    await fixture.transfer(0x30, [0xff, 0x01]);
    await fixture.transfer(0x30, [0x12, 0x80]);
    assert.deepEqual(await fixture.transfer(0x30, [0x0a], 1), [0x26], 'COM7 soft reset keeps identification');
  } finally { await fixture.close(); }
  const absent = new ModelFixture();
  try {
    await absent.start([]); absent.i2cBase = 0x3ff67000; await absent.configureBus();
    await assert.rejects(absent.transfer(0x30, [0xff, 0x01]), /Bus fault/, 'no camera in the circuit means no SCCB device');
    await assert.rejects(absent.cameraFrame({ v: 1, seq: 0, format: 'jpeg', width: 4, height: 4, data: 'AA==' }), /no camera/);
  } finally { await absent.close(); }
});

test('OV2640 streams a private copy latched at VSYNC, clears its source, resets counters and rejects descriptors outside DRAM', { timeout: 30000 }, async () => {
  const fixture = new ModelFixture();
  const I2S = 0x3ff4f000, GPIO_IN = 0x3ff4403c, DESC = 0x3ffb0000, BUFFER = 0x3ffb1000;
  const jpeg = (length: number, fill: number) => [0xff, 0xd8, ...Array.from({ length: length - 4 }, (_, index) => (index * fill) % 251), 0xff, 0xd9];
  const frame = (bytes: number[], seq: number) => ({ v: 1, seq, format: 'jpeg', width: 160, height: 120, data: Buffer.from(bytes).toString('base64') });
  try {
    await fixture.start([], { camera: { id: 'cam', vsync: 25 } });
    fixture.i2cBase = 0x3ff67000;
    await fixture.configureBus();
    for (const [register, value] of [[0xff, 0], [0xda, 0x10], [0x5a, 40], [0x5b, 30], [0x5c, 0]]) await fixture.transfer(0x30, [register, value]);
    // Six 4092-byte descriptors hold 6000 one-byte-per-word samples; rx_eof_num 0 means no EOF pause.
    const start = async (buffer = BUFFER) => {
      for (let index = 0; index < 6; index++) {
        await fixture.memory(DESC + index * 12, 4092 | (1 << 31));
        await fixture.memory(DESC + index * 12 + 4, buffer + index * 4096);
        await fixture.memory(DESC + index * 12 + 8, index === 5 ? 0 : DESC + (index + 1) * 12);
      }
      await fixture.memory(I2S + 0x60, 1); await fixture.memory(I2S + 0x60, 0);
      await fixture.memory(I2S + 0x20, (1 << 12) | (3 << 16)); await fixture.memory(I2S + 0xa8, 1); await fixture.memory(I2S + 0x24, 0);
      await fixture.memory(I2S + 0x34, (1 << 29) | (DESC & 0xfffff)); await fixture.memory(I2S + 0x08, 1 << 5);
    };
    const vsync = async () => (await fixture.memory(GPIO_IN)) >> 25 & 1;
    const fall = async () => {
      for (let elapsed = 0; elapsed < 220000 && await vsync() === 0; elapsed += 250) await fixture.clock(250);
      for (let elapsed = 0; elapsed < 3000 && await vsync() === 1; elapsed += 250) await fixture.clock(250);
    };
    const first = jpeg(6000, 7), second = jpeg(100, 3);
    await fixture.cameraFrame(frame(first, 1));
    await start();
    await fall();
    await fixture.clock(2500);
    const partial = (await fixture.camera()).dma.bytes;
    assert.ok(partial > 0 && partial < first.length, `frame is mid-stream (${partial} bytes)`);
    await fixture.cameraFrame(frame(second, 2));
    await fixture.clock(5000);
    let state = await fixture.camera();
    assert.equal(state.framesDelivered, 1); assert.equal(state.dma.bytes, first.length, 'the latched frame completes at its own length');
    const word = (index: number) => fixture.memory(BUFFER + Math.floor(index / 1023) * 4096 + (index % 1023) * 4);
    for (const index of [3000, 5998, 5999]) assert.equal(await word(index), first[index] << 16, `sample ${index} comes from the first picture`);

    await fixture.cameraFrame({ v: 1, clear: true });
    state = await fixture.camera();
    assert.equal(state.status, 'no-source'); assert.equal(state.dma.bytes, first.length);

    await fixture.reset();
    await fixture.configureBus();
    for (const [register, value] of [[0xff, 0], [0xda, 0x10], [0x5a, 40], [0x5b, 30], [0x5c, 0]]) await fixture.transfer(0x30, [register, value]);
    state = await fixture.camera();
    assert.deepEqual([state.framesStarted, state.framesDelivered, state.dma.bytes, state.dma.eofInterrupts], [0, 0, 0, 0], 'counters restart with the reset epoch');

    await fixture.cameraFrame(frame(second, 3));
    await start(0x50000000);
    await fall();
    await fixture.clock(3000);
    state = await fixture.camera();
    assert.ok(state.dma.descriptorErrors >= 1, 'a buffer outside internal DRAM is a descriptor error');
    assert.equal(state.dma.bytes, 0);
    assert.equal((await fixture.memory(I2S + 0x0c)) & (1 << 13), 1 << 13, 'in_dscr_err raised');
  } finally { await fixture.close(); }
});

test('HD44780 behind a PCF8574 latches nibbles on E falling, honors the busy flag, CGRAM, shift and readback', { timeout: 30000 }, async () => {
  const fixture = new ModelFixture();
  const RS = 1, RW = 2, E = 4, BL = 8;
  try {
    await fixture.start([{ id: 'lcd', type: 'hd44780', address: 0x27, inputs: { connected: true, invalid: false } }]);
    await fixture.configureBus();
    const lcd = async () => (await fixture.circuit() as unknown as { devices: { state: Record<string, unknown> }[] }).devices[0].state as Record<string, number | string | boolean>;
    const nibble = (value: number, rs = 0) => [((value & 15) << 4) | rs | BL | E, ((value & 15) << 4) | rs | BL];
    const send = async (value: number, rs = 0) => { await fixture.transfer(0x27, [...nibble(value >> 4, rs), ...nibble(value, rs)]); };
    assert.equal((await lcd()).eightBit, true, 'power-on interface is 8-bit');
    assert.equal((await lcd()).backlight, true, 'PCF8574 outputs start high');
    // Initialization by instruction: 0x3 three times in 8-bit mode, then 0x2 selects 4-bit.
    for (const value of [3, 3, 3, 2]) { await fixture.transfer(0x27, nibble(value)); await fixture.clock(5000); }
    assert.equal((await lcd()).eightBit, false);
    await send(0x28); await send(0x0f); await send(0x06);
    let state = await lcd();
    assert.deepEqual([state.twoLines, state.displayOn, state.cursor, state.blink], [true, true, true, true]);
    await send(0x01);
    await send(0x80 | 0x05);
    assert.equal((await lcd()).ignoredWhileBusy, 1, 'an instruction within 1.52 ms of clear is ignored');
    await fixture.clock(2000);
    await send(0x80 | 0x40 | 0x02);
    for (const character of 'Hi') await send(character.charCodeAt(0), RS);
    state = await lcd();
    assert.equal(String(state.ddram).slice(80 + 4, 80 + 8), '4869', 'line 2 starts at DDRAM 0x40, stored after the 40 bytes of line 1');
    assert.equal(state.addressCounter, 0x44);
    assert.equal(state.dataWrites, 2);

    await send(0x40 | 8);
    for (const row of [0x1f, 0x11]) await send(row, RS);
    assert.equal(String((await lcd()).cgram).slice(16, 20), '1f11', 'CGRAM slot 1 rows');
    await send(0x18);
    assert.equal((await lcd()).shift, 1, 'display shift left');

    // Busy-flag/address read: RW high, E high exposes D7-D4 on the expander inputs.
    await send(0x80 | 0x43);
    await fixture.transfer(0x27, [0xf0 | RW | BL, 0xf0 | RW | BL | E]);
    const [high] = await fixture.transfer(0x27, [], 1);
    await fixture.transfer(0x27, [0xf0 | RW | BL, 0xf0 | RW | BL | E]);
    const [low] = await fixture.transfer(0x27, [], 1);
    await fixture.transfer(0x27, [0xf0 | RW | BL]);
    assert.equal(((high & 0xf0) | (low >> 4)) & 0x7f, 0x43, 'address counter read back through quasi-bidirectional pins');

    await fixture.transfer(0x27, [0]);
    assert.equal((await lcd()).backlight, false);
    await fixture.circuitInputs({ lcd: { connected: false, invalid: false } });
    await assert.rejects(fixture.transfer(0x27, [BL]), /Bus fault/, 'a disconnected backpack NACKs');
  } finally { await fixture.close(); }
});

test('I2S TX DMA plays at the divider-derived rate and the MAX98357A hears it only when the GPIO matrix routes it', { timeout: 30000 }, async () => {
  const fixture = new ModelFixture();
  const I2S1 = 0x3ff6d000, DESC = 0x3ffb0000, BUFFER = 0x3ffb1000, MATRIX_OUT = 0x3ff44530;
  const speaker = async () => JSON.parse(await fixture.qomGet('espemu-speaker-state'));
  const audio = async (): Promise<{ rate: number; start: number; samples: number[] }> => {
    const value = JSON.parse(await fixture.qomGet('espemu-speaker-audio')); const bytes = Buffer.from(value.data, 'base64');
    return { rate: value.rate, start: value.start, samples: Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readInt16LE(index * 2)) };
  };
  try {
    await fixture.start([], { speaker: { id: 'spk', din: 27, bclk: 26, lrclk: 25 } });
    // 100 stereo frames per descriptor: left = index, right = index + 100, so the mono mix is index + 50.
    for (let index = 0; index < 2; index++) {
      await fixture.memory(DESC + index * 12, 400 | (400 << 12) | (1 << 30) | (1 << 31));
      await fixture.memory(DESC + index * 12 + 4, BUFFER + index * 512);
      await fixture.memory(DESC + index * 12 + 8, DESC + ((index + 1) % 2) * 12);
      for (let frame = 0; frame < 100; frame++) await fixture.memory(BUFFER + index * 512 + frame * 4, ((frame + 100 * index + 100) << 16) | (frame + 100 * index));
    }
    await fixture.memory(I2S1 + 0xac, 125 | (1 << 20));           // 160 MHz / 125
    await fixture.memory(I2S1 + 0xb0, 4 | (16 << 12));             // BCK /4, 16-bit: 10 kHz
    await fixture.memory(I2S1 + 0x14, 1 << 12);                     // out_eof interrupt
    await fixture.memory(I2S1 + 0x30, (1 << 29) | (DESC & 0xfffff));
    await fixture.memory(I2S1 + 0x08, 1 << 4);                      // tx_start
    await fixture.clock(40000);
    let state = await speaker();
    assert.equal(state.controller, null, 'DOUT is not routed to the speaker pins yet');
    assert.equal(state.samples, 0);
    assert.equal((await fixture.memory(I2S1 + 0x0c)) & (1 << 12), 1 << 12, 'TX DMA runs and raises out_eof without a listener');
    assert.ok([DESC, DESC + 12].includes(await fixture.memory(I2S1 + 0x38)), 'out_eof_des_addr names a finished descriptor');

    await fixture.memory(MATRIX_OUT + 27 * 4, 189);
    await fixture.memory(MATRIX_OUT + 26 * 4, 24);
    state = await speaker();
    assert.match(state.error, /BCLK\/LRCLK are not/);
    await fixture.memory(MATRIX_OUT + 25 * 4, 26);
    await audio();
    await fixture.clock(50000);
    state = await speaker();
    assert.deepEqual([state.controller, state.rate, state.bits, state.mono, state.playing, state.error], [1, 10000, 16, false, true, '']);
    const heard = await audio();
    assert.equal(heard.rate, 10000);
    assert.ok(Math.abs(heard.samples.length - 500) <= 60, `about 50 ms at 10 kHz, got ${heard.samples.length}`);
    for (let index = 1; index < heard.samples.length; index++) {
      const previous = heard.samples[index - 1], value = heard.samples[index];
      assert.ok(value === previous + 1 || (previous === 249 && value === 50), `mono mix (L+R)/2 continues the descriptor ring at ${index}: ${previous} -> ${value}`);
    }

    await fixture.memory(I2S1 + 0x20, 1 << 13);                     // 16-bit mono: two samples per FIFO word
    await audio();
    await fixture.clock(20000);
    const mono = (await audio()).samples;
    assert.ok(mono.slice(0, 40).some((value, index) => index > 0 && value === mono[index - 1] + 100), 'low then high half of each word');

    // About 5.5 kHz gives odd frame counts per 5 ms step; a held half-word must carry over between steps.
    for (let index = 0; index < 2; index++) for (let word = 0; word < 100; word++) {
      const sample = index * 200 + word * 2;
      await fixture.memory(BUFFER + index * 512 + word * 4, ((sample + 1) << 16) | sample);
    }
    await fixture.memory(I2S1 + 0xac, 227 | (1 << 20));
    await fixture.memory(I2S1 + 0x30, (1 << 29) | (DESC & 0xfffff));
    await audio();
    await fixture.clock(60000);
    const contiguous = (await audio()).samples;
    assert.ok(contiguous.length > 300, `${contiguous.length} samples`);
    for (let index = 1; index < contiguous.length; index++)
      assert.ok(contiguous[index] === (contiguous[index - 1] + 1) % 400, `16-bit mono stays contiguous across steps at ${index}: ${contiguous[index - 1]} -> ${contiguous[index]}`);
    // 32-bit slots with 16-bit data (tx_fifo_mod 2) clock 64 bits per frame: half the 16-bit-slot rate.
    await fixture.memory(I2S1 + 0x20, 2 << 13);
    await fixture.memory(I2S1 + 0xac, 125 | (1 << 20));
    assert.equal((await speaker()).rate, 5000);

    await fixture.memory(I2S1 + 0x30, 1 << 28);                     // stop the link: the FIFO underruns
    const underrun = (await speaker()).underrunFrames;
    await fixture.clock(20000);
    assert.ok((await speaker()).underrunFrames > underrun);
    assert.ok((await audio()).samples.slice(-50).every(value => value === 0), 'silence while starved');

    await fixture.memory(I2S1 + 0xac, 125 | (1 << 20) | (1 << 21));
    assert.match((await speaker()).error, /APLL/);
  } finally { await fixture.close(); }
});

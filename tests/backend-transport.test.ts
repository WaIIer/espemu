import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_INPUTS } from '../shared/protocol.ts';
import { LineBuffer, parseFirmwareLine, rawInputs, physicalInputs, matchesObservation } from '../server/telemetry.ts';
import { QmpConnection, QemuProcess } from '../server/qemu.ts';

test('bounded UART framing reassembles chunks and discards oversized/malformed records', () => {
  const lines: string[] = [];
  let drops = 0;
  const buffer = new LineBuffer(line => lines.push(line), () => drops++, 10);
  buffer.push(Buffer.from('he'));
  buffer.push(Buffer.from('llo\r\n' + 'x'.repeat(20)));
  buffer.push(Buffer.from('discard\nok\n'));
  assert.deepEqual(lines, ['hello', 'ok']);
  assert.equal(drops, 1);
  assert.equal(parseFirmwareLine('ESP_EMU {invalid}'), null);
  assert.equal(parseFirmwareLine('log ESP_EMU {}'), null);
  assert.equal(parseFirmwareLine('ESP_EMU {"v":2}'), null);
  buffer.push(Buffer.from('partial'));
  buffer.reset();
  buffer.push(Buffer.from('fresh\n'));
  assert.equal(lines.at(-1), 'fresh');
  assert.equal(drops, 2);
});

test('raw QOM inputs use integers and observation matching allows sensor quantization only for valid readings', () => {
  const inputs = structuredClone(DEFAULT_INPUTS);
  inputs.tmp105.temperatureC = 25.1234;
  const raw = rawInputs(inputs);
  assert.equal(raw.tmp105.temperatureMc, 25123);
  assert.equal(physicalInputs(raw).tmp105.temperatureC, 25.123);
  const sample = { v: 1 as const, seq: 1, guestUs: 1, tmp105: { temperatureC: 25, error: 0 } };
  assert.equal(matchesObservation(inputs, sample, ['tmp105']), true);
  assert.equal(matchesObservation(inputs, sample, ['bh1750']), false);
  assert.equal(matchesObservation(inputs, { ...sample, tmp105: { temperatureC: 25, error: 1 } }, ['tmp105']), false);
  assert.equal(matchesObservation({ ...inputs, tmp105: { ...inputs.tmp105, connected: false } }, sample, ['tmp105']), false);
});

test('QMP protocol stub correlates responses, reports errors and bounds request timeouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'espemu-test-'));
  const path = join(directory, 'qmp');
  let peer: Socket | undefined;
  const server = createServer(socket => {
    peer = socket;
    socket.write('{"QMP":{"version":{}}}\n');
    const lines = new LineBuffer(line => {
      const message = JSON.parse(line);
      if (message.execute === 'stop') socket.write(JSON.stringify({ id: message.id, error: { desc: 'stub rejection' } }) + '\n');
      else if (message.execute !== 'cont') socket.write(JSON.stringify({ id: message.id, return: {} }) + '\n');
    }, () => {});
    socket.on('data', chunk => lines.push(chunk));
  });
  await new Promise<void>(resolveListen => server.listen(path, resolveListen));
  const socket = createConnection(path);
  const qmp = new QmpConnection(socket, 100);
  try {
    await qmp.greeting;
    assert.deepEqual(await qmp.command('qmp_capabilities'), {});
    await assert.rejects(qmp.command('stop'), /stub rejection/);
    await assert.rejects(qmp.command('cont'), /timed out/);
  } finally {
    qmp.close();
    peer?.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('owned QEMU lifecycle cleans up failed launch and supports idempotent close', async () => {
  const bridge = new QemuProcess(process.cwd(), { stdout() {}, stderr() {}, exited() {} }, { ...process.env, ESPEMU_QEMU: '/nonexistent/espemu-qemu' });
  await assert.rejects(bridge.start(), /ENOENT/);
  await bridge.close();
  await bridge.close();
  assert.equal(await bridge.rssMb(), 0);
});

test('owned protocol-stub child uses a private socket, reports actual RSS and is killed on shutdown', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'espemu-child-test-'));
  const executable = join(directory, 'qmp-stub.mjs');
  await writeFile(executable, `#!${process.execPath}
import { createServer } from 'node:net';
const option = process.argv[process.argv.indexOf('-qmp') + 1];
const socketPath = option.slice(5).split(',')[0];
process.on('SIGTERM', () => {});
const server = createServer(socket => {
  socket.write(JSON.stringify({ QMP: { version: {} } }) + '\\n');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      socket.write(JSON.stringify({ id: request.id, return: {} }) + '\\n');
    }
  });
});
server.listen(socketPath, () => process.stderr.write(JSON.stringify({ pid: process.pid, socketPath }) + '\\n'));
`);
  await chmod(executable, 0o700);
  let information: { pid: number; socketPath: string } | undefined;
  const lines = new LineBuffer(line => { information = JSON.parse(line); }, () => {});
  const bridge = new QemuProcess(process.cwd(), { stdout() {}, stderr: chunk => lines.push(chunk), exited() {} }, { ...process.env, ESPEMU_QEMU: executable });
  try {
    await bridge.start();
    assert.ok(information);
    assert.equal((await stat(join(information.socketPath, '..'))).mode & 0o777, 0o700);
    assert.ok(await bridge.rssMb() > 0);
    await bridge.close();
    await assert.rejects(stat(`/proc/${information.pid}`), /ENOENT/);
    await assert.rejects(stat(join(information.socketPath, '..')), /ENOENT/);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

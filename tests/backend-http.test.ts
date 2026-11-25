import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Backend } from '../server/backend.ts';
import { createBackendServer, MAX_FRAME_BYTES, sendToClient } from '../server/http.ts';

test('HTTP exposes state, topology, export and honest readiness but no raw QMP endpoint', async () => {
  const backend = new Backend(process.cwd());
  const app = createBackendServer(backend, process.cwd());
  await new Promise<void>(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).ready, false);
    assert.deepEqual(await (await fetch(`${base}/live`)).json(), { v: 1, live: true });
    assert.equal((await fetch(`${base}/live`, { headers: { Host: 'foreign.invalid', Origin: 'http://foreign.invalid' } })).status, 403);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.v, 1);
    assert.equal(state.latest, null);
    assert.equal((await (await fetch(`${base}/api/topology`)).json()).devices.length, 3);
    const file = await (await fetch(`${base}/api/export`)).json();
    assert.deepEqual(Object.keys(file).sort(), ['inputs', 'scenarios', 'v']);
    assert.equal((await fetch(`${base}/api/qmp`)).status, 404);
    assert.equal((await fetch(`${base}/qmp`)).status, 404);
    assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file) })).status, 400);
    assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://attacker.invalid' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(MAX_FRAME_BYTES + 1) })).status, 413);
  } finally { await app.close(); await backend.close(); }
});

test('WebSocket delivers state and validation acks, denies cross-origin and oversized frames', async () => {
  const backend = new Backend(process.cwd());
  const app = createBackendServer(backend, process.cwd());
  await new Promise<void>(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const client = new WebSocket(url);
  try {
    const messages: unknown[] = [];
    client.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(client, 'open');
    const response = once(client, 'message');
    client.send(JSON.stringify({ v: 2, id: 'bad', epoch: 0, action: 'run' }));
    const [data] = await response;
    const ack = JSON.parse(data.toString());
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, false);
    assert.equal(ack.id, 'bad');
    assert.ok(messages.some(message => (message as { type: string }).type === 'state'));
    const closed = once(client, 'close');
    client.send('x'.repeat(MAX_FRAME_BYTES + 1));
    assert.equal((await closed)[0], 1009);
    const denied = new WebSocket(url, { origin: 'http://attacker.invalid' });
    const denial = await once(denied, 'error');
    assert.match(denial[0].message, /403/);
    denied.terminate();
  } finally { client.terminate(); await app.close(); await backend.close(); }
});

test('slow-consumer guard closes and accounts dropped frames before exceeding 1MiB', () => {
  let drops = 0;
  let closed = 0;
  let sent = 0;
  const stub = { readyState: WebSocket.OPEN, bufferedAmount: MAX_FRAME_BYTES, send() { sent++; }, close(code: number) { closed = code; } };
  assert.equal(sendToClient(stub, '{}', () => drops++), false);
  assert.equal(closed, 1013);
  assert.equal(drops, 1);
  assert.equal(sent, 0);
});

test('asset serving stays in dist, including symlinks, and supports SPA and HEAD requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'espemu-assets-'));
  const backend = new Backend(root);
  const app = createBackendServer(backend, root);
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'index.html'), '<main>asset fixture</main>');
    await writeFile(join(root, 'outside.txt'), 'private fixture');
    await symlink(join(root, 'outside.txt'), join(root, 'dist', 'escape.txt'));
    await new Promise<void>(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal(await (await fetch(`${base}/`)).text(), '<main>asset fixture</main>');
    assert.equal(await (await fetch(`${base}/dashboard`, { headers: { Accept: 'text/html' } })).text(), '<main>asset fixture</main>');
    assert.equal((await fetch(`${base}/escape.txt`)).status, 403);
    assert.equal((await fetch(`${base}/%2e%2e%2foutside.txt`)).status, 400);
    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { await app.close(); await backend.close(); await rm(root, { recursive: true, force: true }); }
});

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { EventEmitter } from 'node:events';

type Ack = { v: 1; type: 'ack'; id: string; epoch: number; sessionId?: string; ok: boolean; error?: string };
type ServerMessage = { v: 1; type: 'state'; state: unknown } | Ack | { v: 1; type: 'audio'; deviceId: string; epoch: number; rate: number; start: number; data: string };
export interface ControlRuntime extends Pick<EventEmitter, 'on' | 'off'> {
  snapshot(): { epoch: number; sessionId?: string }; health(): Record<string, unknown>; topology(): unknown; drop(): void;
  command(value: unknown, source?: object): Promise<Ack>; importFile(value: unknown): Promise<Ack>; exportFile(): unknown;
  releaseControls?(source: object): Promise<void>;
}

export const MAX_FRAME_BYTES = 1024 * 1024;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export function sendToClient(client: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>, data: string, dropped: () => void): boolean {
  if (client.readyState !== WebSocket.OPEN) return false;
  if (client.bufferedAmount + Buffer.byteLength(data) > MAX_FRAME_BYTES) {
    dropped();
    client.close(1013, 'Slow consumer');
    return false;
  }
  client.send(data, error => { if (error) dropped(); });
  return true;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

export function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) return false;
  if (!request.headers.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    return origin.protocol === 'http:' && origin.origin === new URL(`http://${host}`).origin && request.headers.origin === origin.origin;
  } catch { return false; }
}

export async function requestBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers['content-length'];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_FRAME_BYTES)) throw new Error('Body exceeds limit');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_FRAME_BYTES) throw new Error('Body exceeds limit');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}

function within(directory: string, candidate: string): boolean {
  const difference = relative(directory, candidate);
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

export async function asset(request: IncomingMessage, response: ServerResponse, root: string, pathname: string): Promise<void> {
  const directory = await realpath(resolve(root, 'dist'));
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) { json(response, 400, { error: 'Invalid asset path' }); return; }
  let candidate = resolve(directory, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!within(directory, candidate)) { json(response, 403, { error: 'Forbidden' }); return; }
  try {
    candidate = await realpath(candidate);
  } catch {
    if (!extname(decoded) && request.headers.accept?.includes('text/html')) candidate = await realpath(resolve(directory, 'index.html'));
    else { json(response, 404, { error: 'Not found' }); return; }
  }
  if (!within(directory, candidate)) { json(response, 403, { error: 'Forbidden' }); return; }
  const info = await stat(candidate);
  if (!info.isFile()) { json(response, 404, { error: 'Not found' }); return; }
  response.writeHead(200, { 'Content-Type': contentTypes[extname(candidate)] ?? 'application/octet-stream', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(candidate);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export function createBackendServer(backend: ControlRuntime, root: string) {
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: 'Request failed' });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 64;
  server.maxConnections = 64;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  let closing = false;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) { json(response, 503, { error: 'Server closing' }); return; }
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { json(response, 400, { error: 'Invalid URL' }); return; }
    if (!sameOrigin(request)) { json(response, 403, { error: 'Cross-origin request denied' }); return; }
    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/live': json(response, 200, { v: 1, live: true }); return;
        case '/health': {
          const health = backend.health();
          json(response, health.ready ? 200 : 503, health);
          return;
        }
        case '/api/state': json(response, 200, backend.snapshot()); return;
        case '/api/topology': json(response, 200, backend.topology()); return;
        case '/api/export': json(response, 200, backend.exportFile()); return;
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/import') {
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') { json(response, 415, { error: 'Expected application/json' }); return; }
      let body: unknown;
      try { body = await requestBody(request); }
      catch (error) {
        if (!response.destroyed) {
          json(response, error instanceof Error && error.message === 'Body exceeds limit' ? 413 : 400, { error: 'Invalid or oversized JSON body' });
          request.resume();
        }
        return;
      }
      const ack = await backend.importFile(body);
      json(response, ack.ok ? 200 : 400, ack);
      if (ack.ok) broadcastState();
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/health' || url.pathname === '/live' || url.pathname.toLowerCase().includes('qmp')) {
      json(response, 404, { error: 'Not found' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: 'Method not allowed' }); return; }
    try { await asset(request, response, root, url.pathname); }
    catch { if (!response.headersSent) json(response, 404, { error: 'Assets not built or not found' }); }
  }

  server.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== '/ws' || !sameOrigin(request) || sockets.clients.size >= 32) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request));
  });

  const send = (client: WebSocket, message: ServerMessage) => sendToClient(client, JSON.stringify(message), () => backend.drop());
  sockets.on('connection', client => {
    let inFlight = 0;
    let alive = true;
    client.on('error', () => backend.drop());
    client.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { backend.drop(); client.terminate(); return; }
      alive = false;
      client.ping();
    }, 15000);
    client.on('close', () => {
      clearInterval(heartbeat);
      void backend.releaseControls?.(client).then(broadcastState).catch(() => backend.drop());
    });
  send(client, { v: 1, type: 'state', state: backend.snapshot() });
    client.on('message', (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) { backend.drop(); return; }
      if (binary || inFlight >= 8) { backend.drop(); client.close(1008, 'Invalid frame or command backlog'); return; }
      let value: unknown;
      try { value = JSON.parse(data.toString()); }
      catch { backend.drop(); const { epoch, sessionId } = backend.snapshot(); send(client, { v: 1, type: 'ack', id: '', epoch, sessionId, ok: false, error: 'Invalid JSON frame' }); return; }
      inFlight++;
      // Camera frames stream continuously; the periodic broadcast already reports their effect.
      const streaming = (value as { action?: unknown } | null)?.action === 'camera-frame';
      void backend.command(value, client).then(ack => { if (client.readyState === WebSocket.OPEN) send(client, ack); if (ack.ok && !streaming) broadcastState(); }).catch(() => backend.drop()).finally(() => { inFlight--; });
    });
  });

  let lastBroadcastAt = 0;
  const broadcastState = () => {
    if (!sockets.clients.size) return;
    const message = JSON.stringify({ v: 1, type: 'state', state: backend.snapshot() } satisfies ServerMessage);
    for (const client of sockets.clients) sendToClient(client, message, () => backend.drop());
    lastBroadcastAt = Date.now();
  };
  backend.on('sample', broadcastState);
  // PCM goes out as its own message so state snapshots never carry audio.
  const broadcastAudio = (message: ServerMessage) => { const text = JSON.stringify(message); for (const client of sockets.clients) sendToClient(client, text, () => backend.drop()); };
  backend.on('audio', broadcastAudio);
  const broadcast = setInterval(() => {
    if (Date.now() - lastBroadcastAt >= 90) broadcastState();
  }, 100);
  let closePromise: Promise<void> | null = null;
  return {
    server,
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(broadcast);
        backend.off('sample', broadcastState);
        backend.off('audio', broadcastAudio);
        for (const client of sockets.clients) client.terminate();
        await new Promise<void>(resolveSockets => sockets.close(() => resolveSockets()));
        await new Promise<void>((resolveServer, rejectServer) => {
          server.close(error => { if (error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectServer(error); else resolveServer(); });
          server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { asset, requestBody, sameOrigin } from '../server/http.ts';
import { ProjectCreatorConfigSchema, type ProjectCreatorConfig } from '../shared/project-creator.ts';

export type CreatorSession = { url: string; done: Promise<{ config: ProjectCreatorConfig; directory: string }>; close(): Promise<void> };
type Mode = 'create' | 'build' | 'run';
/** Checks a destination and returns its absolute path, or throws a user-facing reason. */
type Destination = (directory: string) => string;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FOLDERS = 500;

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function expand(path: string) {
  const text = path.trim();
  return text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
}

/** Project folder from a location and a name, as the page sends them. */
function projectPath(location: unknown, name: unknown) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Use letters, digits, dot, dash or underscore for the project name (start with a letter or digit).');
  if (typeof location !== 'string' || !isAbsolute(expand(location))) throw new Error('Choose an absolute location, for example ~/projects.');
  return join(resolve(expand(location)), name);
}

/** Subfolders of an existing directory for the page's folder picker; hidden folders are omitted. */
function listFolders(path: string) {
  const directory = realpathSync(resolve(expand(path) || homedir()));
  if (!statSync(directory).isDirectory()) throw new Error('Not a folder');
  const folders = readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return statSync(join(directory, entry.name)).isDirectory(); } catch { return false; } })())))
    .map(entry => entry.name).sort((left, right) => left.localeCompare(right));
  return { path: directory, parent: dirname(directory) === directory ? null : dirname(directory), folders: folders.slice(0, MAX_FOLDERS), truncated: folders.length > MAX_FOLDERS };
}

/**
 * Serves the web project creator on loopback. The token travels in the URL fragment, so only the
 * opened page can browse folders, check destinations or submit; a rejected submission leaves the
 * session open for corrections.
 */
export async function serveCreator(root: string, initial: { location: string; name: string }, mode: Mode, destination: Destination,
  accept: (config: ProjectCreatorConfig, directory: string) => void, port = 0): Promise<CreatorSession> {
  const token = randomBytes(24).toString('hex');
  const authorized = (request: IncomingMessage) => {
    const value = request.headers['x-espemu-creator'];
    if (typeof value !== 'string') return false;
    const given = Buffer.from(value, 'latin1'), expected = Buffer.from(token, 'latin1');
    return given.length === expected.length && timingSafeEqual(given, expected) && sameOrigin(request);
  };
  let finish!: (result: { config: ProjectCreatorConfig; directory: string }) => void, completed = '', claimed = false;
  const done = new Promise<{ config: ProjectCreatorConfig; directory: string }>(resolve => { finish = resolve; });
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/creator-')) {
        if (!authorized(request)) return reply(response, 403, { error: 'Invalid creator session' });
        if (url.pathname === '/api/creator-session' && request.method === 'GET')
          return reply(response, 200, { v: 1, mode, location: initial.location, name: initial.name, home: homedir() });
        if (url.pathname === '/api/creator-folders' && request.method === 'GET') {
          try { return reply(response, 200, listFolders(url.searchParams.get('path') ?? '')); }
          catch { return reply(response, 400, { error: 'That folder cannot be opened.' }); }
        }
        if (url.pathname === '/api/creator-check' && request.method === 'GET') {
          try { return reply(response, 200, { ok: true, directory: destination(projectPath(url.searchParams.get('location'), url.searchParams.get('name'))) }); }
          catch (error) { return reply(response, 200, { ok: false, error: error instanceof Error ? error.message : 'Invalid destination' }); }
        }
        if (url.pathname === '/api/creator-submit' && request.method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/json')) return reply(response, 415, { error: 'Expected JSON' });
          if (completed || claimed) return reply(response, 409, { error: completed ? 'This project was already created.' : 'A project is already being created.' });
          claimed = true;
          try {
            const body = z.object({ location: z.string(), name: z.string(), config: z.unknown() }).strict().parse(await requestBody(request));
            const config = ProjectCreatorConfigSchema.parse(body.config);
            const directory = destination(projectPath(body.location, body.name));
            accept(config, directory);
            completed = directory;
            // Close this connection after the reply so shutting the server down cannot cut it off.
            response.setHeader('Connection', 'close');
            response.on('finish', () => finish({ config, directory }));
            reply(response, 200, { v: 1, directory, mode });
          } catch (error) {
            claimed = false;
            reply(response, 400, { error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('; ') : error instanceof Error ? error.message : 'Invalid project configuration' });
          }
          return;
        }
        return reply(response, 404, { error: 'Not found' });
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return reply(response, 404, { error: 'Not found' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405, { error: 'Method not allowed' });
      if (!existsSync(join(root, 'dist/index.html'))) return reply(response, 503, { error: 'The web interface is not built. Run npm run build in the ESPEmu checkout.' });
      await asset(request, response, root, url.pathname);
    })().catch(() => { if (!response.headersSent) reply(response, 500, { error: 'Request failed' }); else response.destroy(); });
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Creator did not bind a loopback port');
  return {
    url: `http://127.0.0.1:${address.port}/create#session=${token}`,
    done,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Best-effort browser launch; the URL is always printed as well. */
export function openBrowser(url: string) {
  if (process.env.ESPEMU_NO_BROWSER === '1') return;
  const wsl = process.platform === 'linux' && /microsoft/i.test(existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : '');
  const [command, args] = process.env.BROWSER ? [process.env.BROWSER, [url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['explorer.exe', [url]]
    : wsl ? ['explorer.exe', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* the printed URL still works */ }
}

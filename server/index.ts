import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRuntime } from './project-runtime.ts';
import { loadProject } from './project.ts';
import { createBackendServer } from './http.ts';

export async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!process.env.ESPEMU_PROJECT && !process.env.ESPEMU_MANIFEST && !process.env.ESPEMU_FLASH)
    throw new Error('No project selected. Set ESPEMU_PROJECT to a built ESP-IDF project, or run espemu demo for the bundled demo.');
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const project = loadProject(root);
  const backend = new ProjectRuntime(root, project.manifest, undefined, project.directory);
  const application = createBackendServer(backend, root);
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= Promise.allSettled([application.close(), backend.close()]).then(results => {
      for (const result of results) if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
    });
    return shutdownPromise;
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGHUP', () => { void shutdown(); });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      application.server.once('error', rejectListen);
      application.server.listen(port, host, () => { application.server.removeListener('error', rejectListen); resolveListen(); });
    });
    application.server.on('error', error => { console.error(error); process.exitCode = 1; void shutdown(); });
    console.log(`ESPEmu control backend: http://${host}:${port}`);
    await backend.start().catch(() => {});
    const health = backend.health();
    if (!health.bridgeReady) console.error(`QEMU bridge unavailable: ${health.error}`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error); process.exitCode = 1; });
}

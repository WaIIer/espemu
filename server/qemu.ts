import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, constants, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LineBuffer } from './telemetry.ts';
import { loadProject } from './project.ts';
import { ProjectManifestSchema, qemuCircuit, type ProjectManifest } from '../shared/manifest.ts';

export type QmpCommand = 'qmp_capabilities' | 'query-status' | 'stop' | 'cont' | 'system_reset' | 'quit' | 'qom-get' | 'qom-set';
export interface Bridge {
  start(): Promise<void>;
  command(execute: QmpCommand, argumentsValue?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  rssMb(): Promise<number>;
  resetOutput(): void;
}
export interface BridgeCallbacks {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  exited: (message: string) => void;
}

export class QmpConnection {
  private counter = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private greetingResolve!: () => void;
  private greetingReject!: (error: Error) => void;
  private greetingTimer: NodeJS.Timeout;
  readonly greeting: Promise<void>;

  constructor(private readonly socket: Socket, private readonly timeoutMs = 2000) {
    this.greeting = new Promise((resolveGreeting, rejectGreeting) => {
      this.greetingResolve = resolveGreeting;
      this.greetingReject = rejectGreeting;
    });
    this.greetingTimer = setTimeout(() => this.fail(new Error('QMP greeting timed out')), timeoutMs);
    const lines = new LineBuffer(line => this.receive(line), () => this.fail(new Error('QMP frame exceeds limit')), 1024 * 1024);
    socket.on('data', chunk => lines.push(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('QMP disconnected')));
  }

  private receive(line: string): void {
    let message: { QMP?: unknown; id?: number; return?: unknown; error?: { desc?: string } };
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid QMP envelope');
    } catch {
      this.fail(new Error('Malformed QMP frame'));
      return;
    }
    if (message.QMP) {
      clearTimeout(this.greetingTimer);
      this.greetingResolve();
      return;
    }
    const request = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!request) return;
    this.pending.delete(message.id!);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(String(message.error.desc ?? 'QMP command failed').slice(0, 2000)));
    else if (Object.hasOwn(message, 'return')) request.resolve(message.return);
    else request.reject(new Error('QMP response has no result'));
  }

  command(execute: QmpCommand, argumentsValue: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('QMP is closed'));
    if (this.pending.size >= 32 || this.socket.writableLength > 1024 * 1024) return Promise.reject(new Error('QMP backpressure limit'));
    const id = ++this.counter;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`QMP ${execute} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.socket.write(JSON.stringify({ execute, arguments: argumentsValue, id }) + '\n', error => {
        if (error) this.fail(error);
      });
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.greetingTimer);
    this.greetingReject(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }

  close(): void { this.fail(new Error('QMP closed')); }
}

// The kernel stops QEMU if the backend dies without cleanup (SIGKILL, crash), so emulators are never orphaned.
export function qemuLauncher(qemu: string, platform = process.platform, available = existsSync): [string, string[]] {
  return platform === 'linux' && available('/usr/bin/setpriv') ? ['/usr/bin/setpriv', ['--pdeathsig', 'TERM', '--', qemu]] : [qemu, []];
}

export class QemuProcess implements Bridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private qmp: QmpConnection | null = null;
  private directory: string | null = null;
  private exit: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private expectedExit = false;
  private finished = false;
  private launchError: Error | null = null;

  constructor(private readonly root: string, private readonly callbacks: BridgeCallbacks, private readonly env: NodeJS.ProcessEnv = process.env, private readonly manifest?: ProjectManifest) {}

  async start(): Promise<void> {
    if (this.child || this.directory || this.closing) throw new Error('QEMU lifecycle already used');
    try {
      const manifest = ProjectManifestSchema.parse(this.manifest ?? loadProject(this.root, this.env).manifest);
      const strips=manifest.devices.filter(device=>device.type==='ws2812b');
      const matrices = manifest.devices.filter(device => device.type === 'max7219');
      const project = loadProject(this.root, this.env);
      const flash = this.env.ESPEMU_FLASH ?? (this.env.ESPEMU_PROJECT || this.env.ESPEMU_MANIFEST ? join(project.directory, 'build/qemu_flash.bin') : 'firmware/build/qemu_flash.bin');
      this.directory = await mkdtemp(join(tmpdir(), 'espemu-'));
      await chmod(this.directory, 0o700);
      const socketPath = join(this.directory, 'qmp.sock');
      const circuitPath = join(this.directory, 'circuit.json');
      await writeFile(circuitPath, JSON.stringify(qemuCircuit(manifest)), { mode: 0o600 });
      const qemu = resolve(this.root, this.env.ESPEMU_QEMU ?? join(this.env.ESPEMU_TOOLS ?? '.cache', 'qemu/build/qemu-system-xtensa'));
      // Checked here because setpriv would otherwise turn a missing emulator into an anonymous exit 127.
      await access(qemu, constants.X_OK);
      const [command, prefix] = qemuLauncher(qemu);
      this.child = spawn(command, [...prefix,
        '-machine', 'esp32', '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-S', '-snapshot',
        ...(strips.length?['-icount','shift=3,align=off,sleep=off']:[]),
        '-qmp', `unix:${socketPath},server=on,wait=off`,
        '-drive', `file=${resolve(this.root, flash)},if=mtd,format=raw`,
        '-L', resolve(this.root, this.env.ESPEMU_BIOS ?? join(this.env.ESPEMU_TOOLS ?? '.cache', 'qemu/pc-bios')),
      ], { env: { ...this.env, ESPEMU_QEMU_CIRCUIT: circuitPath }, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stdout.on('data', this.callbacks.stdout);
      this.child.stderr.on('data', this.callbacks.stderr);
      this.exit = new Promise(resolveExit => {
        this.child!.once('error', error => { this.launchError = error; });
        this.child!.once('close', (code, signal) => {
          this.finished = true;
          this.qmp?.close();
          if (!this.expectedExit) this.callbacks.exited(this.launchError?.message ?? `QEMU exited (${code ?? signal})`);
          resolveExit();
        });
      });
      const deadline = Date.now() + 8000;
      while (!this.qmp) {
        if (this.launchError) throw this.launchError;
        if (this.finished) throw new Error('QEMU exited during startup');
        if (Date.now() >= deadline) throw new Error('QEMU startup timed out');
        try {
          const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
            const connection = createConnection(socketPath);
            connection.setTimeout(500, () => connection.destroy(new Error('QMP connect timed out')));
            connection.once('error', rejectSocket);
            connection.once('connect', () => {
              connection.setTimeout(0);
              connection.removeListener('error', rejectSocket);
              resolveSocket(connection);
            });
          });
          this.qmp = new QmpConnection(socket);
        } catch {
          await delay(25);
        }
      }
      await this.qmp.greeting;
      await this.qmp.command('qmp_capabilities');
      if(strips.length)await this.qmp.command('qom-set',{path:'/machine/soc/rmt',property:'ws2812-config',value:JSON.stringify({v:1,devices:strips.map(device=>({id:device.id,pin:device.pin,length:device.length}))})});
      if (matrices.length) await this.qmp.command('qom-set', { path: '/machine/soc/gpio', property: 'max7219-config',
        value: JSON.stringify({ v: 1, devices: matrices.map(({ id, din, clk, load, length }) => ({ id, din, clk, load, length })) }) });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  command(execute: QmpCommand, argumentsValue?: Record<string, unknown>): Promise<unknown> {
    if (!this.qmp) return Promise.reject(new Error('QEMU is not connected'));
    return this.qmp.command(execute, argumentsValue);
  }

  resetOutput(): void { this.child?.stdout.read(); }

  async rssMb(): Promise<number> {
    if (!this.child?.pid || this.finished) return 0;
    try {
      const status = await readFile(`/proc/${this.child.pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return match ? Number(match[1]) / 1024 : 0;
    } catch { return 0; }
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); });
    try { return await Promise.race([this.exit.then(() => true), timedOut]); }
    finally { clearTimeout(timer); }
  }

  private async shutdown(): Promise<void> {
    this.expectedExit = true;
    if (this.child && !this.finished) {
      try { await this.qmp?.command('quit'); } catch {}
      if (!await this.waitForExit(500)) {
        this.child.kill('SIGTERM');
        if (!await this.waitForExit(1000)) {
          this.child.kill('SIGKILL');
          if (!await this.waitForExit(2000)) throw new Error('QEMU did not exit after SIGKILL');
        }
      }
    }
    this.qmp?.close();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = null;
  }
}

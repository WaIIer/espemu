import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bash = (script: string, cwd: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } });

// A miniature install tree: the real scripts plus install.env rendered from the packaging template.
function installedTree(version = '0.1.7') {
  const prefix = mkdtempSync(join(tmpdir(), 'espemu-installed-'));
  mkdirSync(join(prefix, 'tools'));
  for (const file of ['env.sh', 'bootstrap.sh', 'espemu.sh', 'project-command.sh']) cpSync(join(root, 'tools', file), join(prefix, 'tools', file));
  cpSync(join(root, 'versions.env'), join(prefix, 'versions.env'));
  writeFileSync(join(prefix, 'install.env'), readFileSync(join(root, 'packaging/install.env.in'), 'utf8').replaceAll('@VERSION@', version));
  return prefix;
}

test('a packaged install locates its bundled toolchain and emulator without .cache', () => {
  const prefix = installedTree();
  try {
    const result = bash('source tools/env.sh; printf "%s\\n" "$ESPEMU_INSTALLED" "$ESPEMU_TOOLS" "$IDF_PATH" "$IDF_TOOLS_PATH" "$ESPEMU_QEMU" "$ESPEMU_BIOS" "$PATH"', prefix);
    assert.equal(result.status, 0, result.stderr);
    const [installed, tools, idf, idfTools, qemu, bios, path] = result.stdout.trim().split('\n');
    assert.equal(installed, '1');
    assert.equal(tools, join(prefix, 'toolchain'));
    assert.deepEqual([idf, idfTools, qemu, bios], [join(tools, 'esp-idf'), join(tools, 'idf-tools'), join(tools, 'qemu/qemu-system-xtensa'), join(tools, 'qemu/pc-bios')]);
    assert.ok(path.startsWith(`${tools}/node/bin:${tools}/bin:${tools}/build-env/bin:`));
    assert.equal(bash('bash tools/espemu.sh version', prefix).stdout, 'ESPEmu 0.1.7\n');
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});

test('a packaged install refuses to download tools into its read-only tree', () => {
  const prefix = installedTree();
  try {
    const result = bash('bash tools/bootstrap.sh', prefix);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packaged ESPEmu tools in .*\/toolchain are incomplete\. Reinstall the espemu package/);
    assert.equal(existsSync(join(prefix, 'toolchain')), false, 'nothing was downloaded or created');
    const foreign = bash('bash tools/bootstrap.sh', prefix, { IDF_PATH: '/opt/other-idf' });
    assert.match(foreign.stderr, /IDF_PATH is \/opt\/other-idf; unset it to use the packaged ESP-IDF/);
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});

test('a packaged ESP-IDF without git metadata is recognized by its recorded commit', () => {
  const prefix = installedTree();
  try {
    const tools = join(prefix, 'toolchain');
    mkdirSync(join(tools, 'esp-idf'), { recursive: true });
    mkdirSync(join(tools, 'idf-tools/python_env'), { recursive: true });
    mkdirSync(join(tools, 'idf-tools/tools/xtensa-esp-elf'), { recursive: true });
    writeFileSync(join(tools, 'esp-idf/export.sh'), '');
    const commit = /^IDF_COMMIT=(\S+)$/m.exec(readFileSync(join(root, 'versions.env'), 'utf8'))![1];
    writeFileSync(join(tools, 'esp-idf/.espemu-idf-commit'), 'something-else\n');
    assert.notEqual(bash('source tools/env.sh; espemu_have_idf', prefix).status, 0);
    writeFileSync(join(tools, 'esp-idf/.espemu-idf-commit'), `${commit}\n`);
    assert.equal(bash('source tools/env.sh; espemu_have_idf', prefix).status, 0);
  } finally { rmSync(prefix, { recursive: true, force: true }); }
});

test('a source checkout keeps its own tools in .cache, even after another checkout was sourced', () => {
  const show = (env: Record<string, string> = {}) => bash('source tools/env.sh; printf "%s|%s|%s" "${ESPEMU_INSTALLED:-}" "$ESPEMU_TOOLS" "$IDF_PATH"', root, env).stdout;
  assert.equal(show(), `|${root}/.cache|${root}/.cache/esp-idf`);
  assert.equal(show({ ESPEMU_TOOLS: '/srv/other/.cache', ESPEMU_TOOLS_ROOT: '/srv/other' }), `|${root}/.cache|${root}/.cache/esp-idf`);
  assert.equal(show({ ESPEMU_TOOLS: '/usr/lib/espemu/toolchain' }), `|${root}/.cache|${root}/.cache/esp-idf`);
  assert.equal(show({ ESPEMU_TOOLS: '/srv/tools', ESPEMU_TOOLS_ROOT: root }), '|/srv/tools|/srv/tools/esp-idf');
});

test('the espemu command forwards project commands and rejects unknown ones', () => {
  const unknown = bash('bash tools/espemu.sh frobnicate', root);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);
  assert.equal(bash('bash tools/espemu.sh build a b', root).status, 2);
  const missing = bash(`bash tools/espemu.sh build ${JSON.stringify(tmpdir())}`, root);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Not an ESP-IDF project/);
  assert.match(bash('bash tools/espemu.sh version', root).stdout, /^ESPEmu source checkout at /);
});

// Runs publish.sh against a fake gh that records calls and answers tag/main lookups from its environment.
function publish(tags: Record<string, string>, main: string, extra: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-publish-'));
  try {
    const bin = join(directory, 'bin'), packages = join(directory, 'packages'), log = join(directory, 'gh.log');
    mkdirSync(bin); mkdirSync(packages);
    for (const file of ['espemu_0.1.9_amd64.deb', 'espemu-0.1.9-1-x86_64.pkg.tar.zst', 'espemu-qemu-source-0.1.9.tar.xz', 'SHA256SUMS']) writeFileSync(join(packages, file), file);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
args="$*"; printf '%s\\n' "\${args//$'\\n'/ }" >> ${JSON.stringify(log)}
missing() { printf '%s\\n' '{"message":"Not Found","status":"404"}'; exit 1; }
case "$1 $2" in
  "api repos/o/r/git/ref/tags/v0.1.9") [[ -n \${TAG_VERSION:-} ]] && printf '%s\\n' "$TAG_VERSION" || missing ;;
  "api repos/o/r/git/ref/tags/latest") [[ -n \${TAG_LATEST:-} ]] && printf '%s\\n' "$TAG_LATEST" || missing ;;
  "api repos/o/r/commits/main") printf '%s\\n' "$MAIN_SHA" ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', [join(root, 'packaging/publish.sh'), '0.1.9', packages], { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc', MAIN_SHA: main, TAG_VERSION: tags.version ?? '', TAG_LATEST: tags.latest ?? '', ...extra } });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(line => !line.startsWith('api repos/o/r/git/ref/tags/') && !line.startsWith('api repos/o/r/commits/')) : [];
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('publish creates the version and latest for main head, and never deletes latest', () => {
  const first = publish({}, 'abc');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.calls[0], /^release create v0\.1\.9 espemu_0\.1\.9_amd64\.deb .* --target abc --prerelease/);
  assert.match(first.calls[1], /^release create latest .*espemu_amd64\.deb --target abc --prerelease/);
  const moved = publish({ latest: 'old' }, 'abc');
  assert.equal(moved.status, 0, moved.stderr);
  assert.deepEqual(moved.calls.slice(1).map(call => call.split(' ').slice(0, 3).join(' ')), ['release upload latest', 'api -X PATCH', 'release edit latest']);
  assert.match(moved.calls[2], /git\/refs\/tags\/latest -f sha=abc -F force=true/);
  assert.ok(!moved.calls.some(call => call.includes('delete')));
});

test('publish re-runs are idempotent, never move latest backwards, and never replace another commit\'s version', () => {
  const rerun = publish({ version: 'abc', latest: 'newer' }, 'newer');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(rerun.calls, ['release upload v0.1.9 espemu_0.1.9_amd64.deb espemu-0.1.9-1-x86_64.pkg.tar.zst espemu-qemu-source-0.1.9.tar.xz SHA256SUMS --clobber']);
  assert.match(rerun.stdout, /main has moved on to newer; latest stays/);
  const conflict = publish({ version: 'other' }, 'abc');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /v0\.1\.9 already belongs to other, not abc/);
  assert.deepEqual(conflict.calls, []);
});

test('publish releases the merged commit even after main has moved on', () => {
  const result = publish({}, 'later', { RELEASE_SHA: 'merged' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls[0], /^release create v0\.1\.9 .* --target merged --prerelease/);
  assert.equal(result.calls.length, 1, 'latest stays with the newer main commit');
});

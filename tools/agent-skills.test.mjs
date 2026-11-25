import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillsDirectory = join(root, '.github/skills');

function metadata(text) {
  const header = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(header, 'Expected LF-delimited YAML frontmatter at the start');
  const fields = {};
  for (const line of header[1].split('\n')) {
    const field = line.match(/^([a-z][a-z0-9-]*): (.+)$/);
    assert.ok(field, `Use a flat field with a JSON-compatible YAML value: ${line}`);
    assert.ok(!Object.hasOwn(fields, field[1]), `Duplicate field: ${field[1]}`);
    fields[field[1]] = JSON.parse(field[2]);
  }
  return { fields, body: text.slice(header[0].length) };
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Customization must not be a symlink: ${filename}`);
    return entry.isDirectory() ? filesBelow(filename) : [filename];
  });
}

function checkLinks(filename, text) {
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^https?:\/\//.test(target) || target.startsWith('#')) continue;
    assert.ok(!/^[a-z]+:/i.test(target), `Unsupported local link: ${target}`);
    const pathname = decodeURIComponent(target.split('#')[0]);
    assert.ok(!isAbsolute(pathname), `Local links must be relative: ${target}`);
    const destination = resolve(dirname(filename), pathname);
    const fromRoot = relative(root, destination);
    assert.ok(fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`), `Link leaves repository: ${target}`);
    assert.ok(existsSync(destination), `${relative(root, filename)} links to missing ${target}`);
  }
}

test('customization metadata accepts explicit JSON-compatible YAML and rejects ambiguous fields', () => {
  assert.deepEqual(metadata('---\nname: "example"\ndescription: "Use when: testing"\nuser-invocable: true\n---\nBody').fields,
    { name: 'example', description: 'Use when: testing', 'user-invocable': true });
  for (const invalid of [
    'name: unquoted',
    'name: "first"\nname: "second"',
    'description: |\n  multiline',
    ' name: "indented"',
  ]) assert.throws(() => metadata(`---\n${invalid}\n---\nBody`));
});

const skillFolders = readdirSync(skillsDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory());
test('repository contains the complete discoverable workflow suite', () => {
  const names = new Set(skillFolders.map(folder => folder.name));
  for (const name of ['espemu-cloud-pr-intake', 'espemu-completion-gate', 'espemu-datasheet-sensor',
    'espemu-device-contracts', 'espemu-environment', 'espemu-firmware-sdk', 'espemu-pr-review',
    'espemu-pr-review-delivery', 'espemu-pre-pr', 'espemu-project-tooling', 'espemu-qemu-model',
    'espemu-validation']) assert.ok(names.has(name), `Missing workflow skill: ${name}`);
});

for (const folder of skillFolders) {
  test(`skill ${folder.name}: metadata, discovery, body size, and resource links`, () => {
    const filename = join(skillsDirectory, folder.name, 'SKILL.md');
    assert.ok(existsSync(filename), 'Each skill directory needs SKILL.md');
    const text = readFileSync(filename, 'utf8');
    const { fields, body } = metadata(text);
    assert.equal(fields.name, folder.name);
    assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(fields.name.length <= 64);
    assert.equal(typeof fields.description, 'string');
    assert.ok(fields.description.length > 20 && fields.description.length <= 1024);
    assert.match(fields.description, /use when/i, 'Description must explain discovery triggers');
    for (const field of ['user-invocable', 'disable-model-invocation']) {
      if (Object.hasOwn(fields, field)) assert.equal(typeof fields[field], 'boolean');
    }
    assert.ok(!(fields['user-invocable'] === false && fields['disable-model-invocation'] === true));
    assert.ok(body.trim().length > 100);
    assert.ok(text.split('\n').length < 500, 'Move long procedures into referenced resources');
    checkLinks(filename, text);
  });
}

const customizations = filesBelow(skillsDirectory).concat(filesBelow(join(root, '.github/agents')),
  join(root, '.github/copilot-instructions.md'));

test('customization resources have valid local links and no machine-specific private paths', () => {
  for (const filename of customizations.filter(value => value.endsWith('.md'))) {
    const text = readFileSync(filename, 'utf8');
    checkLinks(filename, text);
    assert.doesNotMatch(text, /\/home\/[^/\s]+\//, 'Use repository-relative paths, not a developer home');
    assert.ok(!text.includes('file://'), 'Do not use editor-specific file URLs');
  }
});

test('customizations are permitted by the repository Git allowlist', context => {
  const repository = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (repository.status !== 0) return context.skip('Source archive has no Git metadata');
  for (const filename of customizations) {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--', relative(root, filename)], { cwd: root, encoding: 'utf8' });
    assert.equal(ignored.status, 1, `${relative(root, filename)} is ignored: ${ignored.stdout || ignored.stderr}`);
  }
});

test('bundled shell helpers pass bash syntax checks', () => {
  for (const filename of customizations.filter(value => value.endsWith('.sh'))) {
    execFileSync('bash', ['-n', filename], { cwd: root, stdio: 'pipe' });
  }
});

test('custom agent profiles use cross-platform supported metadata', () => {
  const allowed = new Set(['name', 'description', 'tools', 'target', 'model', 'user-invocable', 'disable-model-invocation']);
  for (const filename of filesBelow(join(root, '.github/agents')).filter(value => value.endsWith('.agent.md'))) {
    const { fields, body } = metadata(readFileSync(filename, 'utf8'));
    assert.equal(typeof fields.description, 'string');
    assert.ok(fields.description.length > 20);
    for (const field of Object.keys(fields)) assert.ok(allowed.has(field), `Unexpected profile field: ${field}`);
    if (Object.hasOwn(fields, 'tools')) assert.ok(Array.isArray(fields.tools) && fields.tools.every(value => typeof value === 'string'));
    if (Object.hasOwn(fields, 'target')) assert.ok(['vscode', 'github-copilot'].includes(fields.target));
    assert.ok(body.length < 30000, 'GitHub custom agent body exceeds 30,000 characters');
  }
});

const setupWorkflow = join(root, '.github/workflows/copilot-setup-steps.yml');
if (existsSync(setupWorkflow)) {
  test('Copilot setup workflow uses the supported single job and least-privilege setup', () => {
    const workflow = JSON.parse(readFileSync(setupWorkflow, 'utf8'));
    assert.deepEqual(Object.keys(workflow.jobs), ['copilot-setup-steps']);
    const job = workflow.jobs['copilot-setup-steps'];
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 59);
    assert.deepEqual(job.permissions, { contents: 'read' });
    const supported = new Set(['steps', 'permissions', 'runs-on', 'services', 'snapshot', 'timeout-minutes']);
    for (const field of Object.keys(job)) assert.ok(supported.has(field), `Unsupported setup-job setting: ${field}`);
    assert.ok(job.steps.some(step => /^actions\/checkout@[a-f0-9]{40}$/.test(step.uses ?? '')));
    const setup = job.steps.find(step => step.run?.includes('/scripts/setup.sh'));
    assert.ok(setup && setup.run.includes('--web') && setup.run.includes('--browser'));
    assert.ok(!/--native|--models|--fixtures|sudo|secrets\./.test(setup.run));
  });
}

const setupScript = join(skillsDirectory, 'espemu-environment/scripts/setup.sh');
if (existsSync(setupScript)) {
  test('setup helper help and invalid arguments do not start installation', () => {
    const help = execFileSync('bash', [setupScript, '--help'], { cwd: root, encoding: 'utf8' });
    assert.match(help, /--web/);
    assert.match(help, /--check/);
    assert.match(help, /--native/);
    const invalid = spawnSync('bash', [setupScript, '--not-an-option'], { cwd: root, encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Unknown option/);
    assert.ok(!/Downloading|Installing/.test(invalid.stdout));
  });
}

function setupFixture(context, nodeVersion = '22.16.0') {
  const directory = mkdtempSync(join(tmpdir(), 'espemu agent-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const helperDirectory = join(directory, '.github/skills/espemu-environment/scripts');
  mkdirSync(helperDirectory, { recursive: true });
  for (const name of ['setup.sh', 'doctor.sh']) copyFileSync(join(dirname(setupScript), name), join(helperDirectory, name));
  mkdirSync(join(directory, 'tools'));
  mkdirSync(join(directory, '.cache/bin'), { recursive: true });
  mkdirSync(join(directory, 'node_modules/tsx'), { recursive: true });
  writeFileSync(join(directory, 'versions.env'), 'NODE_VERSION=22.16.0\nQEMU_COMMIT=fixture\nIDF_COMMIT=fixture\n');
  writeFileSync(join(directory, 'tools/env.sh'), 'ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)\nexport PATH="$ROOT/.cache/node/bin:$ROOT/.cache/bin:$PATH"\nexport IDF_PATH="$ROOT/.cache/esp-idf"\nexport IDF_TOOLS_PATH="$ROOT/.cache/idf-tools"\n');
  const calls = join(directory, 'calls');
  writeFileSync(join(directory, '.cache/bin/npm'), '#!/usr/bin/env bash\nprintf "npm %s\\n" "$*" >> "$ESPEMU_TEST_CALLS"\n', { mode: 0o755 });
  for (const name of ['bootstrap', 'build-qemu', 'build-firmware', 'build-gpio-fixture', 'build-framework-fixtures', 'build-ws2812-fixture']) {
    writeFileSync(join(directory, `tools/${name}.sh`), `#!/usr/bin/env bash\nprintf '${name}\\n' >> "$ESPEMU_TEST_CALLS"\n`, { mode: 0o755 });
  }
  if (nodeVersion !== null) {
    mkdirSync(join(directory, '.cache/node/bin'), { recursive: true });
    writeFileSync(join(directory, '.cache/node/bin/node'), `#!/usr/bin/env bash\nprintf 'v${nodeVersion}\\n'\n`, { mode: 0o755 });
  }
  const environment = { ...process.env, PATH: `${join(directory, '.cache/bin')}${sep === '/' ? ':' : ';'}${process.env.PATH}`,
    ESPEMU_TEST_CALLS: calls, GITHUB_PATH: '', GITHUB_ENV: '', PLAYWRIGHT_BROWSERS_PATH: join(directory, '.cache/playwright') };
  return {
    directory,
    environment,
    run: (args, env = {}) => spawnSync('bash', [join(helperDirectory, 'setup.sh'), ...args], {
      cwd: directory, encoding: 'utf8', env: { ...environment, ...env },
    }),
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
  };
}

test('default setup and read-only check never bootstrap, build, or launch a simulator', context => {
  const fixture = setupFixture(context);
  const result = fixture.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls(), ['npm ci --no-audit --no-fund']);
  const check = fixture.run(['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(fixture.calls(), ['npm ci --no-audit --no-fund']);
  assert.ok(!existsSync(join(fixture.directory, '.cache/qemu')));
  const incompatible = fixture.run(['--check', '--browser']);
  assert.equal(incompatible.status, 2);
  assert.deepEqual(fixture.calls(), ['npm ci --no-audit --no-fund']);
});

test('explicit native, model, fixture and browser flags execute only selected setup operations', context => {
  const fixture = setupFixture(context);
  const result = fixture.run(['--fixtures', '--browser']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls(), ['bootstrap', 'npm ci --no-audit --no-fund', 'npm exec -- playwright install chromium',
    'build-qemu', 'build-firmware', 'build-gpio-fixture', 'build-framework-fixtures', 'build-ws2812-fixture']);
  assert.ok(!/server\/index|demo\.sh|sudo/.test(fixture.calls().join('\n')));
});

test('a mismatched or incomplete Node cache is preserved and prevents dependency installation', context => {
  const mismatched = setupFixture(context, '0.0.0');
  const nodeFile = join(mismatched.directory, '.cache/node/bin/node');
  const before = readFileSync(nodeFile, 'utf8');
  assert.equal(mismatched.run(['--web']).status, 1);
  assert.deepEqual(mismatched.calls(), []);
  assert.equal(readFileSync(nodeFile, 'utf8'), before);
  const incomplete = setupFixture(context, null);
  mkdirSync(join(incomplete.directory, '.cache/node'));
  writeFileSync(join(incomplete.directory, '.cache/node/keep'), 'existing partial state');
  assert.equal(incomplete.run(['--web']).status, 1);
  assert.deepEqual(incomplete.calls(), []);
  assert.equal(readFileSync(join(incomplete.directory, '.cache/node/keep'), 'utf8'), 'existing partial state');
});

function mockNodeDownload(fixture, checksumValid = true) {
  const assets = join(fixture.directory, 'assets');
  const archiveName = 'node-v22.16.0-linux-x64.tar.xz';
  const source = join(assets, 'node-v22.16.0-linux-x64/bin');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'node'), '#!/usr/bin/env bash\nprintf "v22.16.0\\n"\n', { mode: 0o755 });
  execFileSync('tar', ['-cJf', join(assets, archiveName), '-C', assets, 'node-v22.16.0-linux-x64']);
  const hash = checksumValid ? createHash('sha256').update(readFileSync(join(assets, archiveName))).digest('hex') : '0'.repeat(64);
  writeFileSync(join(assets, 'SHASUMS256.txt'), `${hash}  ${archiveName}\n`);
  writeFileSync(join(fixture.directory, '.cache/bin/curl'), '#!/usr/bin/env bash\nset -euo pipefail\nsource_file=""\ndestination=""\nwhile [[ "$#" -gt 0 ]]; do\n  case "$1" in\n    https://nodejs.org/dist/v22.16.0/*) source_file="$ESPEMU_TEST_ASSETS/${1##*/}" ;;\n    -o) shift; destination="$1" ;;\n  esac\n  shift\ndone\n[[ -n "$source_file" && -n "$destination" ]]\ncp -- "$source_file" "$destination"\n', { mode: 0o755 });
  return { ESPEMU_TEST_ASSETS: assets };
}

test('Node download checksum/extraction succeeds offline and cleans agent-owned staging', context => {
  const fixture = setupFixture(context, null);
  const result = fixture.run(['--web'], mockNodeDownload(fixture));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(fixture.directory, '.cache/node/bin/node')));
  assert.deepEqual(fixture.calls(), ['npm ci --no-audit --no-fund']);
  assert.deepEqual(readdirSync(join(fixture.directory, '.cache/downloads')), []);
});

test('an incorrect Node checksum fails before extraction/npm and cleans only staging', context => {
  const fixture = setupFixture(context, null);
  const result = fixture.run(['--web'], mockNodeDownload(fixture, false));
  assert.equal(result.status, 1);
  assert.ok(!existsSync(join(fixture.directory, '.cache/node')));
  assert.deepEqual(fixture.calls(), []);
  assert.deepEqual(readdirSync(join(fixture.directory, '.cache/downloads')), []);
});

test('GitHub setup exposes nonsecret tool paths without writing product source', context => {
  const fixture = setupFixture(context);
  const pathFile = join(fixture.directory, 'github-path');
  const envFile = join(fixture.directory, 'github-env');
  const result = fixture.run(['--web'], { GITHUB_PATH: pathFile, GITHUB_ENV: envFile });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(pathFile, 'utf8').includes(join(fixture.directory, '.cache/node/bin')));
  assert.match(readFileSync(envFile, 'utf8'), /PLAYWRIGHT_BROWSERS_PATH=/);
  assert.match(readFileSync(envFile, 'utf8'), /IDF_PYTHON_CHECK_CONSTRAINTS=no/);
  assert.deepEqual(fixture.calls(), ['npm ci --no-audit --no-fund']);
});

test('native diagnostics require source pins and recognize worktree Git files without installing', context => {
  const fixture = setupFixture(context);
  for (const name of ['curl', 'tar', 'xz', 'sha256sum', 'apt-get', 'dpkg-deb', 'gcc', 'make', 'cmake', 'ninja', 'meson']) {
    writeFileSync(join(fixture.directory, `.cache/bin/${name}`), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  }
  writeFileSync(join(fixture.directory, '.cache/bin/git'), '#!/usr/bin/env bash\nif [[ "$1" == -C && -e "$2/.git" ]]; then\n  printf "fixture\\n"\nelse\n  exit 1\nfi\n', { mode: 0o755 });
  for (const filename of ['.cache/build-env/bin/python', '.cache/idf-tools/python_env/idf5.4_py3.11_env/bin/python',
    '.cache/qemu/build/qemu-system-xtensa', '.cache/esp-idf/export.sh', 'qemu/espemu.patch']) {
    mkdirSync(dirname(join(fixture.directory, filename)), { recursive: true });
    writeFileSync(join(fixture.directory, filename), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  }
  const missingSources = fixture.run(['--check', '--native']);
  assert.equal(missingSources.status, 1);
  assert.match(missingSources.stdout, /MISSING  QEMU source checkout/);
  assert.match(missingSources.stdout, /MISSING  ESP-IDF source checkout/);
  writeFileSync(join(fixture.directory, '.cache/qemu/.git'), 'worktree Git file');
  writeFileSync(join(fixture.directory, '.cache/esp-idf/.git'), 'worktree Git file');
  const worktrees = fixture.run(['--check', '--native']);
  assert.equal(worktrees.status, 0, worktrees.stdout + worktrees.stderr);
  assert.match(worktrees.stdout, /OK       QEMU upstream pin/);
  assert.match(worktrees.stdout, /OK       ESP-IDF upstream pin/);
  writeFileSync(join(fixture.directory, 'versions.env'), 'NODE_VERSION=22.16.0\nQEMU_COMMIT=wrong\nIDF_COMMIT=fixture\n');
  const mismatch = fixture.run(['--check', '--native']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /MISSING  QEMU upstream pin mismatch/);
  assert.deepEqual(fixture.calls(), []);
});

test('PR queue reference is valid JSON with consistent dependencies and conservative authorization', () => {
  const queue = JSON.parse(readFileSync(join(skillsDirectory, 'espemu-cloud-pr-intake/references/pr-queue.json'), 'utf8'));
  assert.equal(queue.v, 1);
  const numbers = new Set(queue.pullRequests.map(pr => pr.number));
  assert.equal(numbers.size, queue.pullRequests.length);
  for (const pr of queue.pullRequests) {
    assert.ok(Number.isInteger(pr.number) && pr.number > 0);
    assert.ok(pr.dependsOn.every(number => numbers.has(number) && number !== pr.number));
    assert.equal(pr.status, 'pending');
  }
  assert.equal(queue.authorization.forcePush, false);
  assert.equal(queue.authorization.deleteBranches, false);
  assert.equal(queue.authorization.mergeRemotePrs, false);
});

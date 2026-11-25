import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function stage(name) {
  const value = dockerfile.split(/(?=^FROM )/m).find(part => new RegExp(`^FROM \\S+ AS ${name}$`, 'm').test(part));
  assert.ok(value, `Missing Docker stage ${name}`);
  return value;
}

test('ESP-IDF exporters run under Bash in both pinned build stages', () => {
  for (const name of ['emulator-build', 'firmware-build']) {
    const value = stage(name);
    const shell = value.match(/^SHELL (.+)$/m);
    assert.ok(shell, `${name} must declare its exporter shell`);
    assert.deepEqual(JSON.parse(shell[1]), ['/bin/bash', '-o', 'pipefail', '-c']);
    assert.ok(value.indexOf('SHELL ') < value.indexOf('RUN '));
    assert.ok(value.includes('. /opt/esp/idf/export.sh'));
  }
});

test('verification reuses preinstalled pinned tools through the framework readiness paths', () => {
  const value = stage('verification');
  for (const [source, destination] of [
    ['/usr/local', '/app/.cache/node'],
    ['/opt/esp/idf', '/app/.cache/esp-idf'],
    ['/opt/esp', '/app/.cache/idf-tools'],
  ]) assert.ok(value.includes(`ln -s ${source} ${destination}`), `Missing tool mapping ${destination}`);
  assert.match(value, /\bIDF_PATH=\/app\/\.cache\/esp-idf\b/);
  assert.match(value, /\bIDF_TOOLS_PATH=\/app\/\.cache\/idf-tools\b/);
  const install=value.indexOf('RUN npm exec -- playwright install --with-deps chromium');
  assert.ok(install>=0,'Playwright dependency flags must be forwarded through npm');
  assert.ok(value.indexOf('ln -s') < install);
  assert.match(value, /^COPY Dockerfile \/app\/Dockerfile$/m, 'Verification must include the Dockerfile read by its regression tests');
  assert.match(value, /COPY --from=emulator-build \/src\/qemu \/app\/\.cache\/qemu/);
  assert.match(value, /COPY --from=firmware-build \/project\/firmware\/build \/app\/firmware\/build/);
});

test('Playwright dependency flags reach its CLI and the image proves Chromium can launch', () => {
  const value = stage('verification');
  const install = value.match(/^RUN npm exec -- playwright install --with-deps chromium && (.+)$/m);
  assert.ok(install, 'Forward --with-deps after npm exec -- and smoke-test the installed browser');
  assert.match(install[1], /chromium\.launch\(\)/);
  assert.match(install[1], /browser\.close\(\)/);
});

test('CI runs only on merged pull requests or by hand, and full verification is opt-in', () => {
  assert.match(workflow, /^on:\n  # [^\n]+\n  pull_request_target:\n    types: \[closed\]\n    branches: \["main"\]\n  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request):/m, 'unmerged or unapproved code never starts CI');
  assert.match(workflow, /^  agent-customizations:\n    if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.merged \}\}$/m);
  assert.equal(workflow.match(/uses: actions\/checkout@/g).length, workflow.match(/persist-credentials: false/g).length);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^      full_verification:\n        description: [^\n]+\n        type: boolean\n        required: false\n        default: false$/m);
  assert.match(workflow, /^  actual-emulator:\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 60\n    if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.full_verification \}\}$/m);
  assert.doesNotMatch(workflow, /^\s+(?:schedule|workflow_run):/m);
  const setup = JSON.parse(readFileSync(new URL('../.github/workflows/copilot-setup-steps.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(setup.on), ['workflow_dispatch']);
  assert.match(workflow, /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n  cancel-in-progress: true$/m);
});

test('CI retains real container verification, dropped capabilities and the endurance gate', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  const budget = workflow.match(/^  actual-emulator:\n    runs-on: [^\n]+\n    timeout-minutes: (\d+)$/m);
  assert.ok(budget && Number(budget[1]) >= 60, 'Allow the measured cold build/firmware time plus complete ten-minute verification');
  assert.match(workflow, /docker build --target verification -t espemu-verification \./);
  assert.match(workflow, /docker run --rm --init --cap-drop=ALL --security-opt=no-new-privileges -e CI=true -e SOAK=1 espemu-verification/);
  assert.doesNotMatch(workflow, /--privileged|--cap-add|SOAK=0|continue-on-error: true/);
});

test('RMT sessions retain deterministic instruction timing without host idle sleeps', () => {
  const runtime = readFileSync(new URL('../server/qemu.ts', import.meta.url), 'utf8');
  assert.ok(runtime.includes("['-icount','shift=3,align=off,sleep=off']"));
  assert.doesNotMatch(runtime, /shift=auto/);
});

test('the automatic CI job is capped at three minutes and runs only the explicit fast suite', () => {
  assert.match(workflow, /^  agent-customizations:\n    if: [^\n]+\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 3$/m);
  assert.match(workflow, /npm run typecheck\n\s+npm run test:fast/);
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(scripts['test:ci'], 'node --test tools/ci.test.mjs');
  assert.deepEqual(scripts['test:fast'].split(' '), [
    'node', '--import', 'tsx', '--test', '--test-concurrency=2',
    'tools/ci.test.mjs', 'tools/agent-skills.test.mjs', 'tests/application.test.ts',
    'tests/gpio-protocol.test.ts', 'tests/kicad-export.test.ts', 'tests/manifest.test.ts', 'tests/packaging.test.ts', 'tests/project-artifacts.test.ts',
    'tests/project-creator.test.ts', 'tests/protocol.test.ts', 'tests/runtime-bounds.test.ts',
  ]);
});
test('releases build only from merged pull requests and publish only after the owner approves', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(release, /^on:\n  # [^\n]+\n  pull_request_target:\n    types: \[closed\]\n    branches: \["main"\]\n  workflow_dispatch:\npermissions:\n  contents: read$/m);
  assert.doesNotMatch(release, /^  (?:push|pull_request|schedule|workflow_run):/m, 'unmerged code never starts a release');
  assert.match(release, /^concurrency:\n  group: release-packages-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m, 'a running release is never cancelled');
  for (const [, reference] of release.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(reference, /^[0-9a-f]{40}$/, 'actions are pinned to commits');
  assert.equal(release.match(/uses: actions\/checkout@/g).length, release.match(/persist-credentials: false/g).length, 'no checkout keeps a token');
  const build = release.slice(release.indexOf('\n  build:'), release.indexOf('\n  publish:'));
  const publish = release.slice(release.indexOf('\n  publish:'));
  assert.match(build, /^    if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.merged \}\}$/m);
  assert.match(build, /^          ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}$/m, 'the merged commit is what gets built');
  assert.match(build, /^    permissions:\n      contents: read$/m, 'dependency installs and builds never see a write token');
  assert.doesNotMatch(build, /contents: write|GH_TOKEN|github\.token|secrets\./);
  let position = 0;
  for (const step of ['build-in-container.sh', 'build-deb.sh', 'build-arch.sh', 'test-install.sh ubuntu', 'test-install.sh arch', 'actions/upload-artifact']) {
    const next = build.indexOf(step, position);
    assert.ok(next > position, `${step} must follow the previous build step`);
    position = next;
  }
  assert.match(publish, /^    needs: build\n    if: \$\{\{ github\.event_name == 'pull_request_target' && github\.event\.pull_request\.merged \}\}$/m, 'manual runs never publish');
  assert.match(publish, /^    environment: release$/m, 'the owner approves each release in the protected environment');
  assert.match(publish, /^    permissions:\n      contents: write$/m);
  assert.match(publish, /^      RELEASE_SHA: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}$/m);
  assert.match(publish, /run: bash packaging\/publish\.sh "\$VERSION" packages$/m);
  assert.doesNotMatch(publish, /npm|build-tree|docker/, 'the write-token job only publishes downloaded artifacts');
  assert.match(release, /^      VERSION: 0\.1\.\$\{\{ github\.run_number \}\}$/m);
  assert.doesNotMatch(release, /continue-on-error: true/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectCreatorConfigSchema } from '../shared/project-creator.ts';

const root = resolve(import.meta.dirname, '..');
function setup(directory: string, ...options: string[]) {
  return spawnSync('bash', [join(root, 'tools/setup-project.sh'), directory, ...options], { cwd: root, encoding: 'utf8', timeout: 10000 });
}

test('plain project setup returns without building or running and creates only an empty app', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-project-'));
  try {
    const directory = join(temporary, 'my empty project');
    const result = setup(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout,/make build or make run/);
    assert.doesNotMatch(result.stdout,/ESPEmu control backend|QEMU emulator version|Building .*firmware|vite v/);
    assert.equal(readFileSync(join(directory, 'main/main.c'), 'utf8').trim(), 'void app_main(void)\n{\n}');
    assert.equal(readFileSync(join(directory, 'main/CMakeLists.txt'), 'utf8').trim(), 'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")');
    for (const file of ['CMakeLists.txt', 'sdkconfig.defaults', '.gitignore', '.espemu-project']) assert.ok(existsSync(join(directory, file)));
    assert.equal(existsSync(join(directory, 'components')), false);
    assert.equal(existsSync(join(directory, 'build')), false);
    assert.equal(existsSync(join(directory, 'sdkconfig')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('the explicit demo template includes the all-device firmware and Bosch drivers', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-project-'));
  try {
    const directory = join(temporary, 'my sensor project');
    const result = setup(directory, '--template', 'demo', '--init-only');
    assert.equal(result.status, 0, result.stderr);
    for (const path of ['CMakeLists.txt', 'sdkconfig.defaults', 'main/main.c', 'main/CMakeLists.txt', 'components/bme280/CMakeLists.txt', 'components/bme280/vendor/bme280.c', 'components/bme280/vendor/LICENSE', '.gitignore']) {
      assert.equal(readFileSync(join(directory, path), 'utf8'), readFileSync(path === '.gitignore' ? join(root, 'templates/project.gitignore') : join(root, 'firmware', path), 'utf8'));
    }
    assert.equal(readFileSync(join(directory, '.espemu-project'), 'utf8'), 'espemu-project-v1\n');
    assert.match(readFileSync(join(directory,'main/device_pins.h'),'utf8'),/#include "espemu_devices.h"/);
    assert.ok(existsSync(join(directory,'components/espemu_devices/include/espemu_devices.h')));
    assert.equal(existsSync(join(directory, 'build')), false);
    assert.equal(existsSync(join(directory, 'sdkconfig')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('repeated setup preserves user firmware changes and does not recopy deleted components', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-project-'));
  try {
    assert.equal(setup(temporary, '--template', 'demo', '--init-only').status, 0);
    const entry = join(temporary, 'main/main.c');
    writeFileSync(entry, 'user-owned firmware\n');
    rmSync(join(temporary, 'components'), { recursive: true });
    const repeated = setup(temporary);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(readFileSync(entry, 'utf8'), 'user-owned firmware\n');
    assert.equal(existsSync(join(temporary, 'components')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('setup refuses nonempty unrecognized directories and symlinks without changing their files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-project-'));
  try {
    const directory = join(temporary, 'existing');
    mkdirSync(directory);
    writeFileSync(join(directory, 'mine.txt'), 'keep me');
    assert.equal(setup(directory).status, 2);
    assert.deepEqual(readdirSync(directory), ['mine.txt']);
    assert.equal(readFileSync(join(directory, 'mine.txt'), 'utf8'), 'keep me');
    const link = join(temporary, 'alias');
    symlinkSync(directory, link);
    assert.equal(setup(link).status, 2);
    assert.deepEqual(readdirSync(directory), ['mine.txt']);
    assert.equal(setup(join(root, 'firmware')).status, 2);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('invalid setup options do not create a project directory', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-project-'));
  try {
    const directory = join(temporary, 'new');
    assert.equal(setup(directory, '--overwrite').status, 2);
    assert.equal(setup(directory, '--template', 'unknown').status, 2);
    assert.equal(setup(directory, '--run', '--init-only').status, 2);
    assert.equal(setup(directory, '--no-run', '--run').status, 2);
    assert.equal(existsSync(directory), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('generated project Git ignores build output without hiding application source',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-project-git-'));
  try{
    const result=setup(directory);assert.equal(result.status,0,result.stderr);
    assert.equal(spawnSync('git',['init','--quiet',directory]).status,0);
    for(const path of ['main/main.c','main/device_pins.h','CMakeLists.txt','espemu.json','.devcontainer/devcontainer.json','.vscode/c_cpp_properties.json','.vscode/settings.json','.vscode/tasks.json'])assert.equal(spawnSync('git',['-C',directory,'check-ignore','--no-index',path]).status,1,path);
    for(const path of ['build/app.elf','managed_components/library/source.c','.env','.espemu-framework','.vscode/launch.json'])assert.equal(spawnSync('git',['-C',directory,'check-ignore','--no-index',path]).status,0,path);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('setup imports portable creator JSON from a file, string or stdin without prompting or launching', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-config-'));
  try {
    const config = ProjectCreatorConfigSchema.parse({
      v: 1, starter: 'blinky', language: 'cpp',
      blink: { deviceId: 'front_led', intervalMs: 250 },
      manifest: { v: 1, target: 'esp32', devices: [{ id: 'front_led', type: 'led', pin: 4, activeLow: true }] },
    });
    const text = JSON.stringify(config);
    const filename = join(temporary, 'project config.json');
    writeFileSync(filename, text);
    const variants = [['--config', filename], ['--config-json', text], ['--config', '-']];
    for (const [index, options] of variants.entries()) {
      const directory = join(temporary, `project ${index}`);
      const result = spawnSync('bash', [join(root, 'tools/setup-project.sh'), directory, ...options], {
        cwd: root, encoding: 'utf8', input: text, timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8')), config.manifest);
      assert.match(readFileSync(join(directory, 'main/main.cpp'), 'utf8'), /BLINK_INTERVAL_MS 250/);
      assert.match(readFileSync(join(directory, 'main/device_pins.h'), 'utf8'), /FRONT_LED_PIN GPIO_NUM_4/);
      assert.equal(existsSync(join(directory, 'main/main.c')), false);
      assert.equal(existsSync(join(directory, 'build')), false);
      assert.doesNotMatch(result.stdout, /Project directory|Create project\?|ESPEmu control backend/);
      const repeated = setup(directory, '--config-json', text);
      assert.notEqual(repeated.status, 0);
      assert.match(repeated.stderr, /not empty/);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('invalid creator configurations and conflicting setup options fail before creating files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-invalid-config-'));
  try {
    const directory = join(temporary, 'new');
    const base = { v: 1, starter: 'empty', manifest: { v: 1, target: 'esp32' } };
    const invalid = [
      '{',
      JSON.stringify({ ...base, starter: 'unknown' }),
      JSON.stringify({ ...base, starter: 'blinky', blink: { deviceId: 'missing', intervalMs: 500 } }),
      JSON.stringify({ ...base, language: 'rust' }),
      JSON.stringify({ ...base, mode: 'run' }),
      JSON.stringify({ ...base, manifest: { ...base.manifest, devices: [{ id: 'led', type: 'led', pin: 34 }] } }),
      JSON.stringify({ ...base, manifest: { ...base.manifest, devices: [{ id: 'front-led', type: 'led', pin: 2 }, { id: 'front_led', type: 'led', pin: 4 }] } }),
    ];
    for (const text of invalid) {
      const result = setup(directory, '--config-json', text);
      assert.notEqual(result.status, 0, text);
      assert.equal(existsSync(directory), false, text);
    }
    for (const options of [
      ['--config-json', JSON.stringify(base), '--template', 'demo'],
      ['--config-json', JSON.stringify(base), '--makefile-only'],
      ['--config', 'missing.json', '--config-json', JSON.stringify(base)],
      ['--config'],
    ]) {
      assert.equal(setup(directory, ...options).status, 2);
      assert.equal(existsSync(directory), false);
    }
    const missing = setup(directory, '--config', join(temporary, 'missing.json'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT/);
    assert.equal(existsSync(directory), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('demo creator rejects edits that would remove required firmware pin definitions',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-demo-contract-'));
  try{
    const manifest=JSON.parse(readFileSync(join(root,'firmware/espemu.json'),'utf8'));
    const config={v:1,starter:'demo',language:'c',manifest};
    assert.equal(ProjectCreatorConfigSchema.safeParse(config).success,true);
    const invalid=[
      {...manifest,devices:manifest.devices.filter((device:{id:string})=>device.id!=='status_led')},
      {...manifest,devices:manifest.devices.map((device:{id:string})=>device.id==='status_led'?{id:'status_led',type:'button',pin:2}:device)},
      {...manifest,buses:manifest.buses.map((bus:Record<string,unknown>)=>({...bus,id:'sensors'})),devices:manifest.devices.map((device:Record<string,unknown>)=>'bus' in device?{...device,bus:'sensors'}:device)},
      {...manifest,devices:manifest.devices.map((device:Record<string,unknown>)=>device.id==='button'?{...device,pin:34}:device)},
    ];
    for(const changed of invalid){
      const text=JSON.stringify({...config,manifest:changed});
      assert.equal(ProjectCreatorConfigSchema.safeParse(JSON.parse(text)).success,false);
      const target=join(directory,'new');const result=setup(target,'--config-json',text);
      assert.notEqual(result.status,0);assert.equal(existsSync(target),false);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, rmSync, mkdirSync, symlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateProjectArtifacts, devicePinsHeader, projectReadme } from '../tools/project-artifacts.ts';
import { ProjectManifestSchema, DEMO_MANIFEST, EMPTY_MANIFEST } from '../shared/manifest.ts';
import { frameworkRoot } from '../tools/project-creator.ts';

test('firmware provenance distinguishes missing, reused, recorded and stale images', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-provenance-'));
  const check = (action = 'check') => spawnSync('bash', [join(frameworkRoot, 'tools/artifact-provenance.sh'), action, 'firmware', directory], { encoding: 'utf8' });
  try {
    mkdirSync(join(directory, 'build'));
    mkdirSync(join(directory, 'main'));
    const artifact = join(directory, 'build/qemu_flash.bin');
    const source = join(directory, 'main/main.c');
    assert.equal(check().status, 1);
    writeFileSync(artifact, 'known binary');
    assert.match(check().stdout, /Unrecorded firmware SHA256.*freshness unknown/);
    writeFileSync(source, 'original source');
    assert.equal(check('record').status, 0);
    assert.equal(check().status, 0);
    writeFileSync(join(directory, 'README.md'), 'custom notes');
    assert.equal(check().status, 0);
    writeFileSync(join(directory, 'espemu.json'), '{"v":1,"target":"esp32","scenarios":[]}');
    assert.equal(check().status, 0, 'scenario/input edits in the manifest do not require a firmware rebuild');
    writeFileSync(join(directory, 'main/device_pins.h'), '#define WIRING 1');
    assert.equal(check().status, 3);
    rmSync(join(directory, 'main/device_pins.h'));
    writeFileSync(source, 'changed source');
    assert.equal(check().status, 3);
    assert.match(check().stdout, /run make build/);
    writeFileSync(source, 'original source');
    writeFileSync(artifact, 'changed binary');
    assert.equal(check().status, 3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed QEMU diff export cannot replace the published patch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-patch-export-'));
  try {
    for (const folder of ['tools', 'qemu', 'bin', '.cache/qemu']) mkdirSync(join(directory, folder), { recursive: true });
    copyFileSync(join(frameworkRoot, 'tools/save-qemu-patch.sh'), join(directory, 'tools/save-qemu-patch.sh'));
    writeFileSync(join(directory, 'versions.env'), 'QEMU_COMMIT=pinned\n');
    const patch = join(directory, 'qemu/espemu.patch');
    writeFileSync(patch, 'authoritative previous patch\n');
    writeFileSync(join(directory, 'bin/git'), `#!/usr/bin/env bash\ncase "$3" in\n  rev-parse) printf 'pinned\\n';;\n  diff) if [[ "$5" == --binary ]]; then printf 'partial patch\\n'; exit 7; fi;;\nesac\n`, { mode: 0o755 });
    const result = spawnSync('bash', [join(directory, 'tools/save-qemu-patch.sh')], { env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}` } });
    assert.equal(result.status, 7);
    assert.equal(readFileSync(patch, 'utf8'), 'authoritative previous patch\n');
    assert.deepEqual(readdirSync(join(directory, 'qemu')), ['espemu.patch']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('configuration generates device-specific README, logical diagram and project-local VS Code metadata',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-artifacts-'));
  try{
    writeFileSync(join(directory,'CMakeLists.txt'),'project(example)');
    writeFileSync(join(directory,'espemu.json'),JSON.stringify({v:1,target:'esp32',buses:[{id:'bus',type:'i2c',controller:0,sda:21,scl:22}],devices:[{id:'rgb',type:'rgb',pins:[16,17,18]},{id:'button',type:'button',pin:27},{id:'temp',type:'tmp105',bus:'bus',address:73}]}));
    const result=generateProjectArtifacts(directory);
    for(const path of ['README.md','main/device_pins.h','components/espemu_devices/include/espemu_devices.h','.espemu-device-sdk.cmake'])assert.ok(result.written.includes(path));
    assert.ok(!result.written.includes('components/bme280/vendor/LICENSE'));
    assert.match(readFileSync(join(directory,'README.md'),'utf8'),/ESPEMU-DEVICES\.md/);
    const readme=readFileSync(join(directory,'ESPEMU-DEVICES.md'),'utf8');
    assert.match(readme,/flowchart LR/);assert.match(readme,/GPIO16 \/ R/);assert.match(readme,/0x49/);
    assert.match(readme,/gpio_get_level\(BUTTON_PIN\)/);assert.match(readme,/espemu_tmp105_read/);
    assert.match(readme,/#include "device_pins\.h"/);
    assert.match(readFileSync(join(directory,'main/device_pins.h'),'utf8'),/#include "esp_log\.h"/);
    assert.doesNotMatch(readme,/gpio_config_t|pin_bit_mask/);
    assert.doesNotMatch(readme,/## .*BH1750/);
    const propertiesPath='.vscode/c_cpp_properties.json';
    const propertiesFile=join(directory,propertiesPath);
    const properties=JSON.parse(readFileSync(propertiesFile,'utf8'));
    const config=properties.configurations[0];
    assert.equal(config.compileCommands,'${workspaceFolder}/build/compile_commands.json');
    assert.equal(config.compilerPath,'');
    assert.equal(config.intelliSenseMode,'linux-gcc-x86');
    assert.deepEqual(config.includePath,['${workspaceFolder}/main','${workspaceFolder}/build/config']);
    assert.deepEqual(config.browse,{path:['${workspaceFolder}/main'],limitSymbolsToIncludedHeaders:true});
    assert.equal(config.forcedInclude,undefined);
    assert.equal(config.defines,undefined);
    const tasks=JSON.parse(readFileSync(join(directory,'.vscode/tasks.json'),'utf8'));assert.ok(tasks.tasks.some((task:{args:string[]})=>task.args[0]==='build'));
    const container=JSON.parse(readFileSync(join(directory,'.devcontainer/devcontainer.json'),'utf8'));
    const pinnedImage=readFileSync(join(frameworkRoot,'versions.env'),'utf8').match(/^IDF_IMAGE=(.+)$/m)?.[1];
    assert.equal(container.image,pinnedImage);
    assert.notEqual(container.remoteUser,'root');
    assert.deepEqual(container.customizations.vscode.extensions,['ms-vscode.cpptools']);
    assert.equal(container.postCreateCommand,undefined);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('generated ESP-IDF tasks configure without a build and build without ESPEmu',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-editor-'));
  try{
    writeFileSync(join(directory,'CMakeLists.txt'),'project(example)');
    generateProjectArtifacts(directory);
    const sdk=join(directory,'standalone SDK');
    mkdirSync(sdk);
    writeFileSync(join(sdk,'export.sh'),'export PATH="$IDF_PATH:$PATH"\n');
    for(const command of ['idf.py','cmake','esptool.py'])writeFileSync(join(sdk,command),'#!/bin/bash\nprintf "%s: %s\\n" "${0##*/}" "$*"\n',{mode:0o755});
    const {tasks}=JSON.parse(readFileSync(join(directory,'.vscode/tasks.json'),'utf8'));
    const run=(label:string,idfPath=sdk)=>{
      const task=tasks.find((candidate:{label:string})=>candidate.label===label);
      assert.equal(task.options.cwd,'${workspaceFolder}');
      return spawnSync(task.command,task.args,{cwd:directory,env:{...process.env,IDF_PATH:idfPath},encoding:'utf8'});
    };
    const configure=run('ESP-IDF: Prepare IntelliSense');
    assert.equal(configure.status,0,configure.stderr);
    assert.equal(configure.stdout,'idf.py: reconfigure\n');
    mkdirSync(join(directory,'build'));
    const build=run('ESP-IDF: Build Firmware');
    assert.equal(build.status,0,build.stderr);
    assert.match(build.stdout,/^idf\.py: reconfigure\ncmake: --build build --parallel 2\nesptool\.py: --chip esp32 merge_bin --fill-flash-size 4MB -o qemu_flash\.[\w]{8} @flash_args\n$/);
    assert.deepEqual(readdirSync(join(directory,'build')),['qemu_flash.bin']);
    writeFileSync(join(directory,'build/qemu_flash.bin'),'previous image');
    writeFileSync(join(sdk,'esptool.py'),'#!/bin/bash\nexit 9\n');
    assert.equal(run('ESP-IDF: Build Firmware').status,9);
    assert.deepEqual(readdirSync(join(directory,'build')),['qemu_flash.bin']);
    assert.equal(readFileSync(join(directory,'build/qemu_flash.bin'),'utf8'),'previous image');
    const missing=run('ESP-IDF: Prepare IntelliSense','');
    assert.equal(missing.status,1);
    assert.match(missing.stderr,/Dev Container or start VS Code from an activated ESP-IDF environment/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('GPIO README examples use simple named-pin calls with the correct pulls',()=>{
  const devices=[{id:'status',type:'led',pin:2},{id:'rgb',type:'rgb',pins:[16,17,18]},{id:'Button2',type:'button',pin:27},{id:'toggle',type:'switch',pin:26},{id:'probe',type:'probe',pin:2},{id:'external',type:'button',pin:34}];
  const readme=projectReadme('example',ProjectManifestSchema.parse({v:1,target:'esp32',devices}));
  assert.match(readme,/gpio_set_direction\(STATUS_PIN, GPIO_MODE_OUTPUT\)/);
  assert.match(readme,/gpio_set_level\(STATUS_PIN, STATUS_ACTIVE_LEVEL\)/);
  assert.match(readme,/gpio_set_direction\(RGB_RED_PIN, GPIO_MODE_OUTPUT\)/);
  assert.match(readme,/gpio_set_pull_mode\(BUTTON2_PIN, GPIO_PULLUP_ONLY\)/);
  assert.match(readme,/gpio_set_pull_mode\(TOGGLE_PIN, GPIO_PULLDOWN_ONLY\)/);
  assert.match(readme,/gpio_get_level\(BUTTON2_PIN\) == BUTTON2_ACTIVE_LEVEL/);
  assert.match(readme,/gpio_get_level\(PROBE_PIN\)/);
  assert.match(readme,/gpio_set_direction\(EXTERNAL_PIN, GPIO_MODE_INPUT\)/);
  assert.doesNotMatch(readme,/gpio_set_pull_mode\(EXTERNAL_PIN|gpio_config_t|pin_bit_mask/);
});

test('named-module documentation distinguishes driven outputs and open-collector pull-ups',()=>{
  const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'pir',type:'hc_sr501',pin:27},{id:'sound',type:'ky_038',pin:26},{id:'hall',type:'a3144',pin:34}]});
  const readme=projectReadme('modules',manifest);
  assert.doesNotMatch(readme,/gpio_set_pull_mode\(PIR_PIN/);
  assert.match(readme,/gpio_set_pull_mode\(SOUND_PIN, GPIO_PULLUP_ONLY\)/);
  assert.doesNotMatch(readme,/gpio_set_pull_mode\(HALL_PIN/);
  assert.match(readme,/external pull-up resistor/);
});

test('device_pins.h supplies shared and configured library headers without unrelated dependencies',()=>{
  const shared=devicePinsHeader(EMPTY_MANIFEST),all=devicePinsHeader(DEMO_MANIFEST);
  for(const name of ['esp_err.h','esp_log.h','freertos/FreeRTOS.h','freertos/task.h','driver/gpio.h'])assert.ok(shared.includes(`#include "${name}"`));
  assert.match(shared,/#include <stdbool.h>/);assert.match(shared,/#include <stdint.h>/);
  assert.doesNotMatch(shared,/#include "(?:driver\/i2c|bme280|led_strip)\.h"/);
  for(const name of ['driver/i2c.h','bme280.h','led_strip.h'])assert.ok(all.includes(`#include "${name}"`));
});

test('MPU6050 documentation uses the installed short API instead of register/callback boilerplate',()=>{
  const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',buses:[{id:'motion_bus',type:'i2c',controller:0,sda:21,scl:22}],devices:[{id:'gyro',type:'mpu6050',bus:'motion_bus',address:104}]});
  const readme=projectReadme('motion',manifest),header=devicePinsHeader(manifest);
  assert.match(readme,/espemu_mpu6050_init/);assert.match(readme,/espemu_mpu6050_read/);
  assert.match(readme,/GYRO_I2C_PORT, GYRO_I2C_ADDRESS/);assert.match(readme,/device_gyro_reading.gyro_x_dps/);
  assert.doesNotMatch(readme,/bme280_init|bme280_get_sensor_data|Bosch SensorAPI|static int8_t/);
  assert.match(header,/#define GYRO_I2C_PORT MOTION_BUS_I2C_PORT/);
});
test('matrix projects install the real GPIO driver and generate three signal pins and chain examples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-matrix-artifacts-'));
  try {
    writeFileSync(join(directory, 'CMakeLists.txt'), 'project(matrix)');
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify({
      v: 1, target: 'esp32', devices: [{ id: 'screen', type: 'max7219', din: 23, clk: 18, load: 5, length: 4 }],
    }));
    generateProjectArtifacts(directory);
    const header = readFileSync(join(directory, 'main/device_pins.h'), 'utf8');
    assert.match(header, /SCREEN_DIN_PIN GPIO_NUM_23/);
    assert.match(header, /SCREEN_CLK_PIN GPIO_NUM_18/);
    assert.match(header, /SCREEN_LOAD_PIN GPIO_NUM_5/);
    assert.match(header, /SCREEN_MODULE_COUNT 4/);
    assert.doesNotMatch(header, /SCREEN_(?:PIN|ACTIVE_LEVEL|LED_COUNT)\b/);
    assert.match(readFileSync(join(directory, 'ESPEMU-DEVICES.md'), 'utf8'), /espemu_max7219_set_rows/);
    assert.match(readFileSync(join(directory, 'components/espemu_devices/espemu_devices.c'), 'utf8'), /gpio_set_level\(display->clk, 1\)/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('pin header uses uppercase device names and rejects normalized macro collisions',()=>{
  const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'status-led',type:'led',pin:2},{id:'colors',type:'rgb',pins:[16,17,18]}]});
  const header=devicePinsHeader(manifest);
  assert.match(header,/#define STATUS_LED_PIN GPIO_NUM_2/);assert.match(header,/#define COLORS_RED_PIN GPIO_NUM_16/);
  assert.match(header,/#define COLORS_GREEN_PIN GPIO_NUM_17/);assert.match(header,/#define COLORS_BLUE_PIN GPIO_NUM_18/);
  const collision=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'status-led',type:'led',pin:2},{id:'status_led',type:'led',pin:4}]});
  assert.throws(()=>devicePinsHeader(collision),/duplicate pin define STATUS_LED_PIN/);
});
test('regeneration preserves edited README/settings and refreshes untouched generated files',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-artifacts-'));
  try{
    writeFileSync(join(directory,'CMakeLists.txt'),'project(example)');writeFileSync(join(directory,'espemu.json'),'{"v":1,"target":"esp32","devices":[]}');
    generateProjectArtifacts(directory);writeFileSync(join(directory,'README.md'),'my documentation');writeFileSync(join(directory,'.vscode/settings.json'),'{"mine":true}');
    const configPath='.vscode/c_cpp_properties.json';
    const properties=JSON.parse(readFileSync(join(directory,configPath),'utf8'));
    properties.configurations[0].browse.path.push('${workspaceFolder}/custom');
    const editedConfig=JSON.stringify(properties,null,4)+'\n';
    writeFileSync(join(directory,configPath),editedConfig);
    writeFileSync(join(directory,'espemu.json'),JSON.stringify({v:1,target:'esp32',buses:[{id:'bus',type:'i2c',controller:0,sda:21,scl:22}],devices:[{id:'outside',type:'tmp105',bus:'bus',address:72}]}));
    const result=generateProjectArtifacts(directory);assert.ok(result.preserved.includes('README.md'));assert.ok(result.preserved.includes('.vscode/settings.json'));
    assert.equal(readFileSync(join(directory,'README.md'),'utf8'),'my documentation');assert.equal(readFileSync(join(directory,'.vscode/settings.json'),'utf8'),'{"mine":true}');
    assert.ok(result.preserved.includes(configPath));
    assert.equal(readFileSync(join(directory,configPath),'utf8'),editedConfig);
    assert.match(readFileSync(join(directory,'ESPEMU-DEVICES.md'),'utf8'),/outside \/ TMP105/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('artifact generation does not write through a user VS Code directory symlink',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-artifacts-')),outside=mkdtempSync(join(tmpdir(),'espemu-editor-'));
  try{
    writeFileSync(join(directory,'CMakeLists.txt'),'project(example)');symlinkSync(outside,join(directory,'.vscode'));
    const result=generateProjectArtifacts(directory);assert.equal(result.preserved.length,3);
  }finally{rmSync(directory,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('generated documentation includes every supported configured device and preserves dangling symlinks',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-artifacts-')),outside=mkdtempSync(join(tmpdir(),'espemu-artifacts-outside-'));
  try{
    writeFileSync(join(directory,'CMakeLists.txt'),'project(example)');
    writeFileSync(join(directory,'espemu.json'),JSON.stringify({v:1,target:'esp32',buses:[{id:'bus',type:'i2c',controller:0,sda:21,scl:22}],devices:[{id:'light',type:'bh1750',bus:'bus',address:35},{id:'env',type:'bme280',bus:'bus',address:118}]}));
    generateProjectArtifacts(directory);
    const readme=readFileSync(join(directory,'ESPEMU-DEVICES.md'),'utf8');assert.match(readme,/espemu_bme280_read/);assert.match(readme,/espemu_bh1750_read/);
    assert.doesNotMatch(readme,/REQUIRES|include bme280.h|static int8_t|unmodified Bosch|\/home\//);
    rmSync(join(directory,'README.md'));symlinkSync(join(outside,'missing-readme'),join(directory,'README.md'));
    assert.ok(generateProjectArtifacts(directory).preserved.includes('README.md'));
  }finally{rmSync(directory,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('packaged driver edits are preserved and component ancestor symlinks are not written through',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-sdk-files-')),outside=mkdtempSync(join(tmpdir(),'espemu-sdk-outside-'));
  try{
    writeFileSync(join(directory,'CMakeLists.txt'),'project(example)');
    writeFileSync(join(directory,'espemu.json'),JSON.stringify(DEMO_MANIFEST));
    generateProjectArtifacts(directory);
    const driver=join(directory,'components/espemu_devices/espemu_devices.c');
    writeFileSync(driver,'User driver\n');
    const refreshed=generateProjectArtifacts(directory);assert.ok(refreshed.preserved.includes('components/espemu_devices/espemu_devices.c'));assert.equal(readFileSync(driver,'utf8'),'User driver\n');
    rmSync(join(directory,'components'),{recursive:true});symlinkSync(outside,join(directory,'components'));
    const protectedResult=generateProjectArtifacts(directory);
    assert.ok(protectedResult.preserved.includes('components/espemu_devices/include/espemu_devices.h'));
    assert.equal(lstatSync(join(outside,'espemu_devices'),{throwIfNoEntry:false}),undefined);
  }finally{rmSync(directory,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('device SDK packages only the drivers and managed dependencies the circuit uses', () => {
  const cases = [
    { devices: [{ id: 'outside', type: 'tmp105', bus: 'i2c0', address: 72 }], bme280: false, ws2812: false },
    { devices: [{ id: 'climate', type: 'bme280', bus: 'i2c0', address: 118 }], bme280: true, ws2812: false },
    { devices: [{ id: 'climate', type: 'bme280', bus: 'i2c0', address: 118 }, { id: 'status', type: 'ws2812b', pin: 18, length: 3 }], bme280: true, ws2812: true },
  ];
  for (const { devices, bme280, ws2812 } of cases) {
    const directory = mkdtempSync(join(tmpdir(), 'espemu-selective-sdk-'));
    try {
      writeFileSync(join(directory, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\n');
      mkdirSync(join(directory, 'main'));
      writeFileSync(join(directory, 'espemu.json'), JSON.stringify({ v: 1, target: 'esp32', buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }], devices }));
      generateProjectArtifacts(directory, frameworkRoot);
      const cmake = readFileSync(join(directory, 'components/espemu_devices/CMakeLists.txt'), 'utf8');
      const dependencies = readFileSync(join(directory, 'components/espemu_devices/idf_component.yml'), 'utf8');
      const header = readFileSync(join(directory, 'main/device_pins.h'), 'utf8');
      assert.equal(readdirSync(join(directory, 'components')).includes('bme280'), bme280);
      assert.equal(/ bme280\b/.test(cmake), bme280); assert.equal(cmake.includes('ESPEMU_DEVICES_NO_BME280'), !bme280);
      assert.equal(/ led_strip\b/.test(cmake), ws2812); assert.equal(cmake.includes('ESPEMU_DEVICES_NO_WS2812'), !ws2812);
      assert.equal(dependencies.includes('espressif/led_strip'), ws2812);
      assert.equal(header.includes('"bme280.h"'), bme280); assert.equal(header.includes('"led_strip.h"'), ws2812);
      assert.match(projectReadme(directory, ProjectManifestSchema.parse(JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8')))), /espemu_telemetry_send[\s\S]*make test[\s\S]*startProject/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('project tests can import the public regression client as espemu/regression', () => {
  const result = spawnSync(process.execPath, ['--import', join(frameworkRoot, 'node_modules/tsx/dist/loader.mjs'), '--import', join(frameworkRoot, 'tools/regression-loader.mjs'), '--input-type=module', '-e',
    "const api = await import('espemu/regression'); console.log(typeof api.startProject, typeof api.connectProject);"], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'function function');
  const directory = mkdtempSync(join(tmpdir(), 'espemu-project-test-'));
  try {
    for (const name of ['smoke.test.mjs', 'smoke.test.mts']) writeFileSync(join(directory, name), "import { test } from 'node:test';\nimport { startProject } from 'espemu/regression';\ntest('import', () => { if (typeof startProject !== 'function') throw new Error('missing'); });\n");
    const run = spawnSync(process.execPath, ['--import', join(frameworkRoot, 'node_modules/tsx/dist/loader.mjs'), '--import', join(frameworkRoot, 'tools/regression-loader.mjs'), '--test', join(directory, 'smoke.test.mjs'), join(directory, 'smoke.test.mts')], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    assert.equal(run.status, 0, run.stdout + run.stderr); assert.match(run.stdout, /# pass 2/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('build-qemu upgrades only an unmodified checkout of an earlier published patch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-qemu-upgrade-'));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const framework = join(directory, 'framework'), qemu = join(directory, 'qemu'), current = join(framework, 'qemu/espemu.patch');
  const helper = `source <(sed -n '/^espemu_previous_patch()/,/^}/p' ${JSON.stringify(join(frameworkRoot, 'tools/build-qemu.sh'))})`;
  const previous = () => spawnSync('bash', ['-c', `${helper}; espemu_previous_patch`], { cwd: qemu, encoding: 'utf8', env: { ...process.env, ROOT: framework } });
  try {
    for (const folder of [join(framework, 'qemu'), qemu]) mkdirSync(folder, { recursive: true });
    git(framework, 'init', '-q'); git(qemu, 'init', '-q');
    writeFileSync(join(qemu, 'board.c'), 'board\n'); git(qemu, 'add', '.'); git(qemu, 'commit', '-qm', 'pinned');
    const patch = (files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(qemu, name), text);
      git(qemu, 'add', '-N', '.');
      const text = git(qemu, 'diff', 'HEAD', '--binary');
      git(qemu, 'reset', '-q'); git(qemu, 'checkout', '--', '.'); git(qemu, 'clean', '-fdq');
      return text;
    };
    const first = patch({ 'board.c': 'board\nattach\n', 'model.c': 'model one\n' });
    const second = patch({ 'board.c': 'board\nattach\n', 'model.c': 'model two\n', 'sht3x.c': 'new model\n' });
    writeFileSync(current, first); git(framework, 'add', '.'); git(framework, 'commit', '-qm', 'first');
    writeFileSync(current, second); git(framework, 'commit', '-qam', 'second');
    writeFileSync(join(directory, 'first.patch'), first); git(qemu, 'apply', join(directory, 'first.patch'));
    const found = previous();
    assert.equal(found.status, 0, found.stderr);
    git(qemu, 'apply', '--reverse', found.stdout.trim()); git(qemu, 'apply', current);
    assert.equal(readFileSync(join(qemu, 'sht3x.c'), 'utf8'), 'new model\n');
    rmSync(found.stdout.trim(), { force: true });
    writeFileSync(join(qemu, 'model.c'), 'user edit\n');
    git(qemu, 'apply', '--reverse', current, '--exclude', 'model.c');
    assert.notEqual(previous().status, 0, 'an edited checkout is never reverted automatically');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('generated SHT3x documentation shows short CRC-checked SDK calls and device macros', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-sht3x-docs-'));
  try {
    writeFileSync(join(directory, 'CMakeLists.txt'), 'project(example)');
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify({ v: 1, target: 'esp32', buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }], devices: [{ id: 'cabinet', type: 'sht3x', bus: 'i2c0', address: 69 }] }));
    generateProjectArtifacts(directory, frameworkRoot);
    const readme = readFileSync(join(directory, 'ESPEMU-DEVICES.md'), 'utf8');
    assert.match(readme, /espemu_sht3x_init\(&device_cabinet, CABINET_I2C_PORT, CABINET_I2C_ADDRESS\)/);
    assert.match(readme, /espemu_sht3x_read\(&device_cabinet, &device_cabinet_reading\)/);
    assert.match(readme, /Values: temperature_c, humidity_pct\. .*ESP_ERR_INVALID_CRC/);
    assert.match(readFileSync(join(directory, 'main/device_pins.h'), 'utf8'), /#define CABINET_I2C_ADDRESS 0x45/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('generated camera projects package pinned esp32-camera beside other drivers and a camera_config_t macro', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-camera-docs-'));
  try {
    writeFileSync(join(directory, 'CMakeLists.txt'), 'project(example)');
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify({ v: 1, target: 'esp32', devices: [{ id: 'cam', type: 'ov2640' }, { id: 'strip', type: 'ws2812b', pin: 4, length: 2 }] }));
    generateProjectArtifacts(directory, frameworkRoot);
    const header = readFileSync(join(directory, 'main/device_pins.h'), 'utf8');
    assert.match(header, /#include "esp_camera\.h"/);
    for (const line of ['CAM_VSYNC_PIN GPIO_NUM_25', 'CAM_RESET_PIN -1', 'CAM_D7_PIN GPIO_NUM_35', 'CAM_SCCB_PORT 1']) assert.match(header, new RegExp(`#define ${line}\n`));
    assert.match(header, /#define CAM_CAMERA_CONFIG\(pixel_format_, frame_size_\) \(\(camera_config_t\)\{ \.pin_pwdn = CAM_PWDN_PIN,.*\.pixel_format = \(pixel_format_\), \.frame_size = \(frame_size_\),.*\.fb_location = CAMERA_FB_IN_DRAM,.*\.sccb_i2c_port = CAM_SCCB_PORT \}\)/);
    assert.equal(readFileSync(join(directory, 'components/espemu_devices/idf_component.yml'), 'utf8'), 'dependencies:\n  espressif/led_strip: "2.5.5"\n  espressif/esp32-camera: "2.1.7"\n');
    assert.match(readFileSync(join(directory, 'components/espemu_devices/CMakeLists.txt'), 'utf8'), /REQUIRES driver esp_rom esp_timer led_strip esp32-camera\)/);
    const readme = readFileSync(join(directory, 'ESPEMU-DEVICES.md'), 'utf8');
    assert.match(readme, /camera_config_t device_cam_config = CAM_CAMERA_CONFIG\(PIXFORMAT_JPEG, FRAMESIZE_QVGA\);\nESP_ERROR_CHECK\(esp_camera_init\(&device_cam_config\)\);/);
    assert.match(readme, /camera_fb_t \*frame = esp_camera_fb_get\(\);/);
    assert.match(readme, /\| cam \| ov2640 \| PWDN: GPIO32, XCLK: GPIO0, SDA: GPIO26/);
    assert.match(readme, /esp <-->\|"SCCB GPIO26\/27"\| device0/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('generated LCD and speaker projects get size/pin macros, SDK usage and wiring rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-lcd-speaker-docs-'));
  try {
    writeFileSync(join(directory, 'CMakeLists.txt'), 'project(example)');
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify({ v: 1, target: 'esp32', buses: [{ id: 'i2c0', type: 'i2c', controller: 0, sda: 21, scl: 22 }],
      devices: [{ id: 'panel', type: 'hd44780', bus: 'i2c0', address: 0x3f, size: '20x4' }, { id: 'buzzer', type: 'max98357a', din: 27, bclk: 26, lrclk: 25 }] }));
    generateProjectArtifacts(directory, frameworkRoot);
    const header = readFileSync(join(directory, 'main/device_pins.h'), 'utf8');
    for (const line of ['PANEL_I2C_ADDRESS 0x3f', 'PANEL_COLUMNS 20', 'PANEL_ROWS 4', 'BUZZER_DIN_PIN GPIO_NUM_27', 'BUZZER_BCLK_PIN GPIO_NUM_26', 'BUZZER_LRCLK_PIN GPIO_NUM_25']) assert.match(header, new RegExp(`#define ${line}\\n`));
    assert.match(header, /#include "espemu_devices\.h"/);
    const readme = readFileSync(join(directory, 'ESPEMU-DEVICES.md'), 'utf8');
    assert.match(readme, /espemu_hd44780_init\(&device_panel, PANEL_I2C_PORT, PANEL_I2C_ADDRESS, PANEL_COLUMNS, PANEL_ROWS\)/);
    assert.match(readme, /espemu_max98357a_init\(&device_buzzer, BUZZER_BCLK_PIN, BUZZER_LRCLK_PIN, BUZZER_DIN_PIN, 16000\)/);
    assert.match(readme, /\| buzzer \| max98357a \| DIN: GPIO27, BCLK: GPIO26, LRCLK: GPIO25 \|/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

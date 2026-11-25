import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createProject, blinkySource, interview, interviewComponent, addComponent, componentFromSpec, checkDestination, frameworkRoot } from '../tools/project-creator.ts';
import { EMPTY_MANIFEST, DEMO_MANIFEST, ProjectManifestSchema } from '../shared/manifest.ts';
import { PERIPHERAL_REGISTRY } from '../shared/registry.ts';

test('creator generates an explicit blinky circuit, matching ordinary GPIO firmware and build dependency', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-creator-'));
  try {
    const directory = join(temporary, 'my blinky');
    const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'status', type: 'led', pin: 2, color: 'green', activeLow: true }] });
    createProject({ directory, starter: 'blinky', manifest, blink: { deviceId: 'status', intervalMs: 250 }, mode: 'create' });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8')), manifest);
    const source = readFileSync(join(directory, 'main/main.c'), 'utf8');
    assert.match(source, /LED_PIN STATUS_PIN/);
    assert.match(source, /BLINK_INTERVAL_MS 250/);
    assert.match(source, /gpio_set_level\(LED_PIN, STATUS_ACTIVE_LEVEL\)/);
    assert.doesNotMatch(source, /ESP_EMU|bme280|i2c/);
    assert.match(readFileSync(join(directory, 'main/CMakeLists.txt'), 'utf8'), /esp_driver_gpio/);
    assert.match(readFileSync(join(directory, 'CMakeLists.txt'), 'utf8'), /project\(my_blinky\)/);
    assert.equal(existsSync(join(directory, 'components')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('guided creator asks one question at a time and produces a matching blinky plan', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-interview-'));
  const directory = join(temporary, 'blink');
  const answers = [directory, '1', '2', '', '34', '2', 'n', '2', '200', 'n', '1', 'y'];
  const questions: string[] = [], output: string[] = [];
  try {
    const plan = await interview(async question => { questions.push(question); const answer = answers.shift(); assert.notEqual(answer, undefined, question); return answer!; }, text => output.push(text));
    assert.ok(plan);
    assert.equal(plan.starter, 'blinky');
    assert.equal(plan.blink!.intervalMs, 200);
    assert.equal(plan.manifest.devices[0].type, 'led');
    assert.equal((plan.manifest.devices[0] as { pin: number }).pin, 2);
    assert.equal(answers.length, 0);
    assert.equal(existsSync(directory), false, 'Interview must not write before generation');
    assert.ok(output.some(line => line.includes('GPIO34: input-only')));
    assert.doesNotMatch(output.join('\n'),/Available output pins|Unavailable pins|Real-board caution/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('declining the walkthrough confirmation leaves the destination untouched', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-interview-'));
  const directory = join(temporary, 'cancelled');
  const answers = [directory, '1', '1', 'n', '1', 'n'];
  try {
    assert.equal(await interview(async () => answers.shift()!, () => {}), null);
    assert.equal(existsSync(directory), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('wizard recommends distinct switch pins and defaults to creating without launching', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-wizard-defaults-'));
  const answers = [join(temporary,'switches'),'1','1','y','8','','','n','y','8','','?','','n','n','','y'];
  const questions: string[] = [], output: string[] = [];
  try {
    const plan = await interview(async question => { questions.push(question); const value = answers.shift(); assert.notEqual(value,undefined,question); return value!; }, text => output.push(text));
    assert.ok(plan); assert.equal(plan.mode,'create');
    assert.deepEqual(plan.manifest.devices.map(device=>(device as {pin:number}).pin),[27,16]);
    assert.match(questions.filter(question=>question.startsWith('? GPIO pin'))[1],/\(16\)/);
    assert.match(questions.find(question=>question.startsWith('? After generating files'))!,/\(1\)/);
    assert.ok(output.some(text=>text.includes('GPIO27: already wired to switch_1')));
    assert.ok(output.some(text=>text.includes('Create, build and run')));
  } finally { rmSync(temporary,{recursive:true,force:true}); }
});

test('guided creator uses registry input channels and scenarios for an added sensor', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-interview-'));
  const answers = [join(temporary, 'sensor'), '1', '1', 'y', '1', '', '', '22', 'n', 'y', '1', '2', '20', '5', '1000', '42', 'n', '1', 'y'];
  try {
    const plan = await interview(async question => { const answer=answers.shift(); assert.notEqual(answer,undefined,question); return answer!; }, () => {});
    assert.ok(plan); assert.equal(plan.starter,'empty'); assert.equal(plan.manifest.inputs.tmp105_1.temperatureC,22);
    assert.equal(plan.manifest.scenarios[0].channel,'temperatureC'); assert.equal(plan.manifest.scenarios[0].kind,'sine');
    assert.equal(answers.length,0);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
});
test('guided creator configures MAX7219 distinct signals and module count without fake active-low controls', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-matrix-interview-'));
  const type = String(Object.keys(PERIPHERAL_REGISTRY).indexOf('max7219') + 1);
  const answers = [join(temporary, 'matrix'), '1', '1', 'y', type, '', '23', '23', '18', '5', '4', '1', 'n', '1', 'y'];
  const output: string[] = [];
  try {
    const plan = await interview(async question => {
      assert.doesNotMatch(question, /Active low/);
      const answer = answers.shift(); assert.notEqual(answer, undefined, question); return answer!;
    }, text => output.push(text));
    assert.ok(plan);
    assert.equal(answers.length, 0);
    assert.deepEqual(plan.manifest.devices[0], { id: 'max7219_1', type: 'max7219', din: 23, clk: 18, load: 5, length: 4, color: 'red', activeLow: false });
    assert.ok(output.some(text => text.includes('already chosen for another device signal')));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('creator rejects symlink-parent paths into framework resources', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-creator-'));
  try {
    symlinkSync(frameworkRoot, join(temporary, 'alias'));
    assert.throws(() => checkDestination(join(temporary, 'alias', 'tools', 'generated')), /framework sources/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('creator keeps an empty application unless a starter is explicitly selected', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-creator-'));
  try {
    createProject({ directory: temporary, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' });
    assert.equal(readFileSync(join(temporary, 'main/main.c'), 'utf8').trim(), 'void app_main(void)\n{\n}');
    assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'espemu.json'), 'utf8')).devices, []);
    assert.throws(() => createProject({ directory: temporary, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' }), /not empty/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('invalid blinky pin and timing fail before any project files are generated', () => {
  assert.throws(() => blinkySource(34, false, 500));
  assert.throws(() => blinkySource(2, false, 0));
});

test('C++ starter keeps the ESP-IDF C entry ABI and uses generated device pin names',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'espemu-cpp-'));
  try{
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'front_led',type:'led',pin:4}]});
    createProject({directory:temporary,starter:'blinky',manifest,blink:{deviceId:'front_led',intervalMs:250},mode:'create',language:'cpp'});
    assert.equal(existsSync(join(temporary,'main/main.c')),false);
    const source=readFileSync(join(temporary,'main/main.cpp'),'utf8');assert.match(source,/extern "C" void app_main/);assert.match(source,/LED_PIN FRONT_LED_PIN/);
    assert.match(readFileSync(join(temporary,'main/device_pins.h'),'utf8'),/FRONT_LED_PIN GPIO_NUM_4/);
    assert.match(readFileSync(join(temporary,'main/CMakeLists.txt'),'utf8'),/main.cpp/);
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('C++ demo receives the packaged SDK and shared generated header in its C component',()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-cpp-demo-'));
  try{
    createProject({directory,starter:'demo',manifest:DEMO_MANIFEST,mode:'create',language:'cpp'});
    assert.match(readFileSync(join(directory,'components/espemu_demo/CMakeLists.txt'),'utf8'),/INCLUDE_DIRS "\." "\.\.\/\.\.\/main" REQUIRES espemu_devices/);
    assert.match(readFileSync(join(directory,'main/device_pins.h'),'utf8'),/#include "espemu_devices.h"/);
    assert.match(readFileSync(join(directory,'main/main.cpp'),'utf8'),/extern "C" void app_main/);
    assert.ok(existsSync(join(directory,'components/espemu_devices/espemu_devices.c')));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('wizard uses compact default hints and only shows detailed pin help on request',async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'espemu-compact-'));
  const questions:string[]=[],output:string[]=[];
  const answers=[join(temporary,'project'),'1','1','n','','n'];
  try{
    await interview(async question=>{questions.push(question);const answer=answers.shift();assert.notEqual(answer,undefined,question);return answer!;},text=>output.push(text));
    assert.ok(questions.includes('? Add a device? (y/N) '));
    assert.ok(questions.includes('? Create project? (Y/n) '));
    assert.doesNotMatch(output.join('\n'),/Step \d|Answer yes\/no|Enter chooses|Peripherals are|Current circuit|Unavailable pins/);
    assert.equal(questions.length,6);
    assert.equal(answers.length,0);
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('default GPIO prompts quietly choose free pins without dumping wiring guidance',async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'espemu-quiet-pins-'));
  const questions:string[]=[],output:string[]=[];
  const answers=[join(temporary,'project'),'1','1','y','8','','','n','y','8','','','n','n','','y'];
  try{
    const plan=await interview(async question=>{questions.push(question);const answer=answers.shift();assert.notEqual(answer,undefined,question);return answer!;},text=>output.push(text));
    assert.ok(plan);
    assert.deepEqual(plan.manifest.devices.map(device=>(device as {pin:number}).pin),[27,16]);
    assert.deepEqual(questions.filter(question=>question.startsWith('? GPIO pin')),['? GPIO pin (27) ','? GPIO pin (16) ']);
    assert.doesNotMatch(output.join('\n'),/Available .*pins|Unavailable pins|Pins:|Real-board caution|free suggestion|Enter accepts/);
    assert.equal(answers.length,0);
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('terminal wizard uses select/confirm prompts without repeating menus or explanations',async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'espemu-terminal-prompts-'));
  const questions:string[]=[],output:string[]=[];
  try{
    const plan=await interview(async()=>assert.fail('Terminal prompts must own input'),text=>output.push(text),join(temporary,'project'),{
      text:async(message,initial)=>{questions.push(message);return initial;},
      select:async(message,choices,initial)=>{questions.push(message);assert.ok(choices.some(choice=>choice.value===initial));return initial;},
      confirm:async(message,initial)=>{questions.push(message);return initial;},
    });
    assert.ok(plan);assert.equal(plan.mode,'create');assert.equal(plan.starter,'empty');
    assert.deepEqual(questions,['Project directory','Language','Starter','Add a device?','After generating files','Create project?']);
    assert.doesNotMatch(output.join('\n'),/1\. Empty|1\. C|Answer yes\/no|Enter chooses|Step \d/);
    assert.equal(existsSync(plan.directory),false);
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('starting the simulator from the wizard requires an explicit run choice',async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'espemu-explicit-run-'));
  const answers=[join(temporary,'project'),'1','1','n','3','y'];
  try{
    const plan=await interview(async question=>{const answer=answers.shift();assert.notEqual(answer,undefined,question);return answer!;},()=>{});
    assert.ok(plan);assert.equal(plan.mode,'run');assert.equal(answers.length,0);
    assert.equal(existsSync(plan.directory),false);
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('interactive creator cancels cleanly on Ctrl-C before generating any files', { timeout: 10000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-cancel-'));
  const child = spawn('bash', [join(frameworkRoot, 'tools/create-project.sh')], { cwd: temporary, stdio: ['pipe','pipe','pipe'] });
  try {
    let output = '';
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`No interactive prompt: ${output}`)), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('Project directory')) { clearTimeout(timer); done(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const exited = new Promise<number | null>(done => child.once('exit', done));
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    assert.equal(existsSync(join(temporary, 'my_project')), false);
  } finally {
    child.stdin.destroy(); child.kill('SIGTERM');
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('one-component mode adds one device and preserves firmware and edited documentation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-add-component-'));
  const answers=['5','extra_led','','','','y'],questions:string[]=[];
  try{
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'status',type:'led',pin:2}]});
    createProject({directory,starter:'blinky',manifest,blink:{deviceId:'status',intervalMs:500},mode:'create'});
    writeFileSync(join(directory,'README.md'),'User documentation\n');
    const source=readFileSync(join(directory,'main/main.c'),'utf8'),cmake=readFileSync(join(directory,'main/CMakeLists.txt'),'utf8'),original=readFileSync(join(directory,'espemu.json'),'utf8');
    const plan=await interviewComponent(async question=>{questions.push(question);const answer=answers.shift();assert.notEqual(answer,undefined,question);return answer!;},()=>{},directory);
    assert.ok(plan);assert.equal(readFileSync(join(directory,'espemu.json'),'utf8'),original);
    assert.deepEqual(plan.manifest.devices.map(device=>device.id),['status','extra_led']);
    assert.equal((plan.manifest.devices[1] as {pin:number}).pin,16);
    assert.doesNotMatch(questions.join('\n'),/Project directory|Language|Starter|After generating files|Add a device/);
    const result=addComponent(plan);assert.ok(result.preserved.includes('README.md'));
    assert.equal(readFileSync(join(directory,'main/main.c'),'utf8'),source);assert.equal(readFileSync(join(directory,'main/CMakeLists.txt'),'utf8'),cmake);
    assert.equal(readFileSync(join(directory,'README.md'),'utf8'),'User documentation\n');
    assert.match(readFileSync(join(directory,'main/device_pins.h'),'utf8'),/#define EXTRA_LED_PIN GPIO_NUM_16/);
    assert.equal(JSON.parse(readFileSync(join(directory,'espemu.json'),'utf8')).devices.length,2);
    assert.equal(existsSync(join(directory,'build')),false);assert.equal(answers.length,0);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('one-component mode reuses named I2C buses and selects an unoccupied address',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-add-i2c-')),answers=['1','outside','','35','y'];
  try{
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',buses:[{id:'sensors',type:'i2c',controller:0,sda:21,scl:22}],devices:[{id:'room',type:'tmp105',bus:'sensors',address:72}],inputs:{room:{temperatureC:20}}});
    createProject({directory,starter:'empty',manifest,mode:'create'});
    const plan=await interviewComponent(async question=>{const answer=answers.shift();assert.notEqual(answer,undefined,question);return answer!;},()=>{},directory);
    assert.ok(plan);addComponent(plan);
    assert.deepEqual(plan.manifest.devices[1],{id:'outside',type:'tmp105',bus:'sensors',address:73});
    assert.equal(plan.manifest.inputs.room.temperatureC,20);assert.equal(plan.manifest.inputs.outside.temperatureC,35);assert.equal(answers.length,0);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('component cancellation makes no changes and stale manifests are not overwritten',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-add-cancel-')),answers=['8','','','n','n','8','','','n','y'];
  try{
    createProject({directory,starter:'empty',manifest:EMPTY_MANIFEST,mode:'create'});
    const original=readFileSync(join(directory,'espemu.json'),'utf8'),ledger=readFileSync(join(directory,'.espemu-generated.json'),'utf8');
    const ask=async(question:string)=>{const answer=answers.shift();assert.notEqual(answer,undefined,question);return answer!;};
    assert.equal(await interviewComponent(ask,()=>{},directory),null);
    assert.equal(readFileSync(join(directory,'espemu.json'),'utf8'),original);assert.equal(readFileSync(join(directory,'.espemu-generated.json'),'utf8'),ledger);
    const plan=await interviewComponent(ask,()=>{},directory);assert.ok(plan);
    writeFileSync(join(directory,'espemu.json'),original+'\n');assert.throws(()=>addComponent(plan),/circuit changed during setup/);
    assert.equal(readFileSync(join(directory,'espemu.json'),'utf8'),original+'\n');assert.equal(readFileSync(join(directory,'.espemu-generated.json'),'utf8'),ledger);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('one-component mode refuses symlink manifests before asking questions',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-add-symlink-'));
  try{
    createProject({directory,starter:'empty',manifest:EMPTY_MANIFEST,mode:'create'});
    const target=join(directory,'external.json');writeFileSync(target,JSON.stringify(EMPTY_MANIFEST));
    rmSync(join(directory,'espemu.json'));symlinkSync(target,join(directory,'espemu.json'));
    await assert.rejects(interviewComponent(async()=>assert.fail('Must reject before prompting'),()=>{},directory),/regular file/);
    assert.equal(readFileSync(target,'utf8'),JSON.stringify(EMPTY_MANIFEST));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('one-component wizard takes named sensor polarity defaults from the registry',async()=>{
  for(const [prefix,activeLow] of [['A3144',true],['KY-038',false]] as const){
    const directory=mkdtempSync(join(tmpdir(),'espemu-named-default-'));
    try{
      createProject({directory,starter:'empty',manifest:EMPTY_MANIFEST,mode:'create'});
      let offered:boolean|undefined;
      const plan=await interviewComponent(async()=>assert.fail('Use terminal prompts'),()=>{},directory,{
        text:async(_message,initial)=>initial,
        select:async(_message,choices)=>choices.find(choice=>choice.name.startsWith(prefix))!.value,
        confirm:async(message,initial)=>{if(message==='Active low?')offered=initial;return initial;},
      });
      assert.ok(plan);assert.equal(offered,activeLow);
      assert.equal((plan.manifest.devices[0] as {activeLow:boolean}).activeLow,activeLow);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});

test('piped answers to make add_component are queued and early end of input changes nothing', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-piped-'));
  const run = (input: string) => new Promise<{ code: number | null; output: string }>(done => {
    const child = spawn('bash', [join(frameworkRoot, 'tools/create-project.sh'), '--add-component', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => done({ code, output })); child.stdin.end(input);
  });
  try {
    createProject({ directory, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' });
    const original = readFileSync(join(directory, 'espemu.json'), 'utf8');
    const truncated = await run('bme280\nclimate\n');
    assert.equal(truncated.code, 1, truncated.output); assert.match(truncated.output, /Input ended before every question was answered/);
    assert.equal(readFileSync(join(directory, 'espemu.json'), 'utf8'), original);
    const complete = await run('bme280\nclimate\n\n24\n\n55\ny\n');
    assert.equal(complete.code, 0, complete.output);
    const manifest = JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8'));
    assert.deepEqual(manifest.devices.map((device: { id: string; type: string }) => [device.id, device.type]), [['climate', 'bme280']]);
    assert.equal(manifest.inputs.climate.humidityPct, 55);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('noninteractive device specs use wizard defaults and validate overrides', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-device-spec-'));
  try {
    createProject({ directory, starter: 'empty', manifest: ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'status', type: 'led', pin: 16 }] }), mode: 'create' });
    const led = await componentFromSpec('led', directory);
    assert.deepEqual(led.manifest.devices[1], { id: 'led_2', type: 'led', pin: 2, activeLow: false, color: 'red' });
    const sensor = await componentFromSpec('{"type":"bme280","id":"climate","label":"Greenhouse air","inputs":{"temperatureC":31}}', directory);
    addComponent(sensor);
    const written = JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8'));
    assert.deepEqual(written.devices[1], { id: 'climate', label: 'Greenhouse air', type: 'bme280', bus: 'i2c0', address: 118 });
    assert.equal(written.inputs.climate.temperatureC, 31); assert.equal(written.inputs.climate.humidityPct, 45);
    assert.match(readFileSync(join(directory, 'main/device_pins.h'), 'utf8'), /CLIMATE_I2C_ADDRESS 0x76/);
    await assert.rejects(componentFromSpec('{"type":"led","pin":16}', directory), /GPIO16: already wired to status/);
    await assert.rejects(componentFromSpec('{"type":"led","inputs":{"x":1}}', directory), /no physical-input channels/);
    await assert.rejects(componentFromSpec('lamp', directory), /Unknown device type lamp/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wizard offers a board pull-up for open-collector modules on input-only pins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-pullup-wizard-'));
  try {
    createProject({ directory, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' });
    const questions: string[] = [];
    const plan = await interviewComponent(async () => assert.fail('Use terminal prompts'), () => {}, directory, {
      text: async (message, initial) => message === 'GPIO pin' ? '34' : initial,
      select: async (_message, choices) => choices.find(choice => choice.name.startsWith('YL-69'))!.value,
      confirm: async (message, initial) => { questions.push(message); return initial; },
    });
    assert.ok(plan); assert.ok(questions.some(question => question.startsWith('Pull-up resistor')));
    assert.deepEqual(plan.manifest.devices[0], { id: 'yl_69_1', type: 'yl_69', pin: 34, activeLow: true, pullUp: true });
    assert.deepEqual(plan.manifest.gpioInputs, [{ pin: 34, level: 1 }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('device specs answer every wizard prompt and reject bad values without hanging', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-device-spec-errors-'));
  try {
    createProject({ directory, starter: 'empty', manifest: ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'status', type: 'led', pin: 16 }] }), mode: 'create' });
    await assert.rejects(componentFromSpec('{"type":"led","id":"status"}', directory), /already used/);
    await assert.rejects(componentFromSpec('{"type":"led","id":"a b"}', directory), /Invalid|match/);
    await assert.rejects(componentFromSpec('{"type":"led","pin":34}', directory), /input-only/);
    const pir = await componentFromSpec('{"type":"hc_sr501","id":"motion","pin":25}', directory);
    assert.deepEqual(pir.manifest.devices[1], { id: 'motion', type: 'hc_sr501', pin: 25, activeLow: false });
    assert.deepEqual(pir.manifest.gpioInputs, [{ pin: 25, level: 0 }]);
    const lamp = await componentFromSpec('{"type":"led","id":"lamp","pin":26,"color":"amber","activeLow":true}', directory);
    assert.deepEqual(lamp.manifest.devices[1], { id: 'lamp', type: 'led', pin: 26, activeLow: true, color: 'amber' });
    const strip = await componentFromSpec('{"type":"ws2812b","id":"strip","pin":18,"length":12}', directory);
    assert.deepEqual(strip.manifest.devices[1], { id: 'strip', type: 'ws2812b', pin: 18, length: 12, activeLow: false });
    await assert.rejects(componentFromSpec('{"type":"bme280","address":119,"inputs":{"temperatureC":500}}', directory), /from -40 to 85/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wizard skips the pull-up question for active-high contacts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-pullup-skip-'));
  try {
    createProject({ directory, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' });
    const questions: string[] = [];
    const plan = await interviewComponent(async () => assert.fail('Use terminal prompts'), () => {}, directory, {
      text: async (message, initial) => message === 'GPIO pin' ? '35' : initial,
      select: async (_message, choices) => choices.find(choice => choice.name === 'Switch')!.value,
      confirm: async (message, initial) => { questions.push(message); return message === 'Active low?' ? false : initial; },
    });
    assert.ok(plan); assert.ok(!questions.some(question => question.startsWith('Pull-up')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('device specs add an ESP32-CAM camera without pin prompts and merge partial wiring overrides', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-camera-spec-'));
  try {
    createProject({ directory, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' });
    const plain = await componentFromSpec('ov2640', directory);
    assert.deepEqual(plain.manifest.devices[0], { id: 'ov2640_1', type: 'ov2640', signals: { pwdn: 32, reset: -1, xclk: 0, sda: 26, scl: 27, d0: 5, d1: 18, d2: 19, d3: 21, d4: 36, d5: 39, d6: 34, d7: 35, vsync: 25, href: 23, pclk: 22 } });
    const custom = await componentFromSpec('{"type":"ov2640","id":"eye","signals":{"pwdn":-1,"xclk":4}}', directory);
    addComponent(custom);
    const written = JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8'));
    assert.equal(written.devices[0].signals.xclk, 4); assert.equal(written.devices[0].signals.pwdn, -1); assert.equal(written.devices[0].signals.vsync, 25);
    const header = readFileSync(join(directory, 'main/device_pins.h'), 'utf8');
    assert.match(header, /#define EYE_XCLK_PIN GPIO_NUM_4\n/); assert.match(header, /#define EYE_PWDN_PIN -1\n/);
    await assert.rejects(componentFromSpec('ov2640', directory), /at most one camera/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('device specs add a 20x4 LCD at the common 0x27 backpack address and a speaker on free output pins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-lcd-spec-'));
  try {
    createProject({ directory, starter: 'empty', manifest: EMPTY_MANIFEST, mode: 'create' });
    const lcd = await componentFromSpec('{"type":"hd44780","id":"panel","size":"20x4"}', directory);
    assert.deepEqual(lcd.manifest.devices[0], { id: 'panel', type: 'hd44780', bus: 'i2c0', address: 0x27, size: '20x4' });
    addComponent(lcd);
    const plain = await componentFromSpec('hd44780', directory);
    assert.equal((plain.manifest.devices[1] as { address: number }).address, 0x3f, 'next free default is the PCF8574A address');
    const speaker = await componentFromSpec('max98357a', directory);
    assert.deepEqual(speaker.manifest.devices[1], { id: 'max98357a_2', type: 'max98357a', bclk: 26, lrclk: 25, din: 27 });
    const custom = await componentFromSpec('{"type":"max98357a","din":4,"bclk":16,"lrclk":17}', directory);
    assert.deepEqual(custom.manifest.devices[1], { id: 'max98357a_2', type: 'max98357a', bclk: 16, lrclk: 17, din: 4 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('setup --web serves a token-guarded creator with a folder picker and creates the chosen project only on submit', { timeout: 60000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'espemu-web-setup-'));
  mkdirSync(join(parent, 'workspace', 'boards'), { recursive: true });
  mkdirSync(join(parent, '.hidden'));
  writeFileSync(join(parent, 'notes.txt'), 'file, not a folder');
  mkdirSync(join(parent, 'taken')); writeFileSync(join(parent, 'taken', 'keep.txt'), 'mine');
  const child = spawn(process.execPath, ['--import', join(frameworkRoot, 'node_modules/tsx/dist/loader.mjs'), join(frameworkRoot, 'tools/project-creator.ts'), '--web'], { cwd: parent, env: { ...process.env, ESPEMU_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
  try {
    for (let step = 0; step < 500 && !/#session=/.test(output); step++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /#session=/, output);
    const url = new URL(/(http:\/\/127\.0\.0\.1:\d+\/create#session=[0-9a-f]+)/.exec(output)![1]);
    const token = new URLSearchParams(url.hash.slice(1)).get('session')!;
    const get = (path: string, headers: Record<string, string> = { 'X-ESPEmu-Creator': token }) => fetch(new URL(path, url.origin), { headers });
    const location = realpathSync(parent);
    assert.equal((await get('/api/creator-session', {})).status, 403, 'the token is required');
    assert.equal((await get(`/api/creator-folders?path=${encodeURIComponent(location)}`, { 'X-ESPEmu-Creator': 'f'.repeat(token.length) })).status, 403, 'folder listing is guarded too');
    const session = await (await get('/api/creator-session')).json();
    assert.deepEqual({ ...session, home: undefined }, { v: 1, mode: 'create', location, name: 'my_project', home: undefined }, 'without a directory the page proposes my_project in the current folder');
    const { request } = await import('node:http');
    const forged = await new Promise<number>((done, fail) => request({ host: '127.0.0.1', port: url.port, path: '/api/creator-session', headers: { Host: 'attacker.example', 'X-ESPEmu-Creator': token } }, response => { response.resume(); done(response.statusCode!); }).on('error', fail).end());
    assert.equal(forged, 403, 'a rebinding Host header is rejected even with the token');
    const listing = await (await get(`/api/creator-folders?path=${encodeURIComponent(location)}`)).json();
    assert.deepEqual(listing, { path: location, parent: dirname(location), folders: ['taken', 'workspace'], truncated: false }, 'only visible folders are listed');
    assert.equal((await get(`/api/creator-folders?path=${encodeURIComponent(join(location, 'missing'))}`)).status, 400);
    const check = async (where: string, name: string) => (await get(`/api/creator-check?location=${encodeURIComponent(where)}&name=${encodeURIComponent(name)}`)).json();
    assert.match((await check(location, 'taken')).error, /not empty/);
    assert.match((await check(location, '../escape')).error, /project name/);
    assert.match((await check('relative/path', 'ok')).error, /absolute location/);
    assert.deepEqual(await check(join(location, 'workspace', 'boards'), 'blinker'), { ok: true, directory: join(location, 'workspace', 'boards', 'blinker') });
    const submit = (body: unknown, headers: Record<string, string> = {}) => fetch(new URL('/api/creator-submit', url.origin), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ESPEmu-Creator': token, ...headers }, body: JSON.stringify(body) });
    const config = { v: 1, starter: 'empty', language: 'c', manifest: { v: 1, target: 'esp32', devices: [{ id: 'status', type: 'led', pin: 2 }] } };
    assert.equal((await submit({ location, name: 'x', config }, { Origin: 'http://evil.example' })).status, 403, 'cross-origin pages cannot submit');
    const invalid = await submit({ location, name: 'blinker', config: { v: 1, starter: 'blinky', manifest: EMPTY_MANIFEST } });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Blinky requires/);
    assert.equal((await submit({ location, name: 'taken', config })).status, 400, 'a nonempty folder is refused at submit too');
    const [first, second] = await Promise.allSettled([submit({ location: join(location, 'workspace', 'boards'), name: 'blinker', config }), submit({ location: join(location, 'workspace', 'boards'), name: 'second', config })]);
    const statuses = [first, second].map(result => result.status === 'fulfilled' ? result.value.status : 'closed');
    assert.equal(statuses.filter(status => status === 200).length, 1, `exactly one concurrent submit creates a project (rejected drafts left the session open): ${statuses}`);
    assert.ok(statuses.every(status => status === 200 || status === 409 || status === 'closed'), `${statuses}`);
    const winner = statuses[0] === 200 ? 'blinker' : 'second';
    assert.equal(existsSync(join(parent, 'workspace', 'boards', winner === 'blinker' ? 'second' : 'blinker')), false, 'the refused submit leaves no folder');
    assert.equal(await exited, 0, output);
    assert.match(readFileSync(join(parent, 'workspace', 'boards', winner, 'main/device_pins.h'), 'utf8'), /#define STATUS_PIN GPIO_NUM_2/);
    assert.equal(existsSync(join(parent, 'my_project')), false);
    assert.equal(readFileSync(join(parent, 'taken', 'keep.txt'), 'utf8'), 'mine');
    assert.match(output, new RegExp(`Created .*${winner}`));
  } finally { child.kill(); rmSync(parent, { recursive: true, force: true }); }
});

test('setup --web refuses a nonempty directory before serving anything', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-web-nonempty-'));
  try {
    writeFileSync(join(directory, 'keep.txt'), 'mine');
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(frameworkRoot, 'tools/project-creator.ts'), directory, '--web'], { cwd: frameworkRoot, env: { ...process.env, ESPEMU_NO_BROWSER: '1' }, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not empty/);
    assert.doesNotMatch(result.stdout, /session=/);
    assert.equal(readFileSync(join(directory, 'keep.txt'), 'utf8'), 'mine');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

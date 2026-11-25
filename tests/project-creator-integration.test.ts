import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProject } from '../tools/project-creator.ts';
import { ProjectManifestSchema } from '../shared/manifest.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';

for (const language of ['c','cpp'] as const) test(`generated ${language} blinky builds with device_pins.h and toggles its declared GPIO in QEMU`, { timeout: 150000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-generated-blinky-'));
  const directory = join(temporary, 'blinky');
  let runtime: ProjectRuntime | null = null;
  let web: ChildProcess | null = null;
  let webExited: Promise<void> | null = null;
  try {
    const manifest = ProjectManifestSchema.parse({ v: 1, target: 'esp32', devices: [{ id: 'status_led', type: 'led', pin: 2, activeLow: true, color: 'blue' }] });
    createProject({ directory, starter: 'blinky', manifest, blink: { deviceId: 'status_led', intervalMs: 200 }, mode: 'create', language });
    const build = spawnSync('make', ['-C', directory, 'build'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(build.status, 0, (build.stderr + build.stdout).slice(-5000));
    runtime = new ProjectRuntime(root, manifest, (callbacks, project) => new QemuProcess(root, callbacks, { ...process.env, ESPEMU_PROJECT: directory, ESPEMU_FLASH: join(directory, 'build/qemu_flash.bin') }, project));
    await runtime.start();
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, JSON.stringify({ error: runtime!.snapshot().error, console: runtime!.snapshot().console.slice(-8) }));
        await delay(20);
      }
    };
    const pin = () => runtime!.snapshot().gpio?.pins.find(pin => pin.pin === 2);
    await wait(() => pin()?.outputEnabled === true);
    const initial = pin()!.level;
    await wait(() => pin()?.level !== initial);
    await wait(() => pin()?.level === initial);
    assert.equal(runtime.snapshot().latest, null, 'Generated blinky must not require special UART telemetry');
    assert.equal(runtime.snapshot().peripherals[0].id, 'status_led');
    assert.equal(runtime.snapshot().peripherals[0].activeLow, true);
    assert.deepEqual(runtime.snapshot().deviceStates, {});
    await runtime.close(); runtime = null;
    web = spawn('make', ['-C', directory, 'web'], { cwd: root, env: { ...process.env, PORT: '4145' }, detached: true, stdio: ['pipe','pipe','pipe'] });
    webExited = new Promise(done => web!.once('exit', () => done()));
    let output = '';
    web.stdout?.on('data', chunk => { output = (output + chunk).slice(-10000); });
    web.stderr?.on('data', chunk => { output = (output + chunk).slice(-10000); });
    const deadline = Date.now() + 30000;
    let url: string | undefined;
    while (!(url = /ESPEmu control backend: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1])) {
      assert.equal(web.exitCode, null, output);
      assert.ok(Date.now() < deadline, `Web startup timed out: ${output}`);
      await delay(20);
    }
    let live: { manifest: { devices: { id: string }[] }; latest: unknown; gpio: { pins: { pin: number; outputEnabled: boolean }[] } } | null = null;
    while (!live?.gpio?.pins.find(pin => pin.pin === 2)?.outputEnabled) {
      assert.ok(Date.now() < deadline, output);
      const response = await fetch(`${url}/api/state`); live = await response.json(); await delay(20);
    }
    assert.equal(live.manifest.devices[0].id, 'status_led');
    assert.equal(live.latest, null);
    assert.equal((await fetch(`${url}/health`)).ok, true);
    assert.doesNotMatch(output, /idf\.py|Executing action: all/, 'make web should not rebuild firmware');
    assert.doesNotMatch(output, /added \d+ packages|vite v|ninja:|> .* build/, 'make web should reuse prepared emulator and web artifacts');
  } finally {
    await runtime?.close();
    if (web?.pid) {
      try { process.kill(-web.pid, 'SIGINT'); } catch {}
      await Promise.race([webExited, delay(3000)]);
      if (web.exitCode === null && web.signalCode === null) {
        try { process.kill(-web.pid, 'SIGKILL'); } catch {}
        await webExited;
      }
      web.stdin?.destroy();
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('generated sensor project automatically supplies SDK headers, drivers and CMake links', {timeout:150000},async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'espemu-packaged-sdk-'));
  let runtime:ProjectRuntime|null=null;
  try{
    const manifest=ProjectManifestSchema.parse(JSON.parse(readFileSync(join(root,'tests/fixtures/device-sdk/espemu.json'),'utf8')));
    createProject({directory,starter:'empty',manifest,mode:'create',language:'cpp'});
    writeFileSync(join(directory,'main/main.cpp'),readFileSync(join(root,'tests/fixtures/device-sdk/main/main.cpp'),'utf8').replace('#include "espemu_devices.h"','#include "device_pins.h"'));
    const applicationBuild='idf_component_register(SRCS "main.cpp" INCLUDE_DIRS "." REQUIRES esp_driver_gpio)\n';
    writeFileSync(join(directory,'main/CMakeLists.txt'),applicationBuild);
    const build=spawnSync('make',['-C',directory,'build'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(build.status,0,(build.stderr+build.stdout).slice(-6000));
    assert.equal(readFileSync(join(directory,'main/CMakeLists.txt'),'utf8'),applicationBuild);
    runtime=new ProjectRuntime(root,manifest,(callbacks,project)=>new QemuProcess(root,callbacks,{...process.env,ESPEMU_PROJECT:directory,ESPEMU_FLASH:join(directory,'build/qemu_flash.bin')},project));
    await runtime.start();const deadline=Date.now()+15000;
    while(!runtime.snapshot().console.some(line=>line.includes('SDK tmp=25.00 lux=320.0 gyro=0.00'))||!runtime.snapshot().ws2812?.devices[0]?.frames){assert.ok(Date.now()<deadline,JSON.stringify({error:runtime.snapshot().error,console:runtime.snapshot().console.slice(-8)}));await delay(20);}
    assert.ok(runtime.snapshot().console.some(line=>line.includes('SDK temperature=23.00')));
    assert.deepEqual(runtime.snapshot().ws2812!.devices[0].pixels,[[255,0,0]]);
  }finally{await runtime?.close();rmSync(directory,{recursive:true,force:true});}
});

for (const language of ['c','cpp'] as const) test(`generated ${language} matrix-only project packages MAX7219 SDK and CMake links`, {timeout:150000}, async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'espemu-packaged-matrix-'));
  let runtime:ProjectRuntime|null=null;
  try{
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'matrix',type:'max7219',din:23,clk:18,load:5,length:2}]});
    createProject({directory,starter:'empty',manifest,mode:'create',language});
    writeFileSync(join(directory,`main/main.${language}`),`#include "device_pins.h"
${language==='cpp'?'extern "C" ':''}void app_main(void)
{
    espemu_max7219_t display;
    ESP_ERROR_CHECK(espemu_max7219_init(&display, MATRIX_DIN_PIN, MATRIX_CLK_PIN, MATRIX_LOAD_PIN, MATRIX_MODULE_COUNT));
    const uint8_t near_rows[8] = {0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81};
    const uint8_t far_rows[8] = {0xff, 0x81, 0xbd, 0xa5, 0xa5, 0xbd, 0x81, 0xff};
    ESP_ERROR_CHECK(espemu_max7219_set_rows(&display, 0, near_rows));
    ESP_ERROR_CHECK(espemu_max7219_set_rows(&display, 1, far_rows));
    printf("PACKAGED MATRIX READY\\n");
}
`);
    const applicationBuild=`idf_component_register(SRCS "main.${language}" INCLUDE_DIRS "." REQUIRES esp_driver_gpio)\n`;
    writeFileSync(join(directory,'main/CMakeLists.txt'),applicationBuild);
    const build=spawnSync('make',['-C',directory,'build'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(build.status,0,(build.stderr+build.stdout).slice(-6000));
    assert.equal(readFileSync(join(directory,'main/CMakeLists.txt'),'utf8'),applicationBuild);
    runtime=new ProjectRuntime(root,manifest,(callbacks,project)=>new QemuProcess(root,callbacks,{...process.env,ESPEMU_PROJECT:directory,ESPEMU_FLASH:join(directory,'build/qemu_flash.bin')},project));
    await runtime.start();const deadline=Date.now()+15000;
    while(!runtime.snapshot().console.some(line=>line.includes('PACKAGED MATRIX READY'))||
      runtime.snapshot().max7219?.devices[0].modules[0].rows[0]!==0x81||
      runtime.snapshot().max7219?.devices[0].modules[1].rows[0]!==255){
      assert.ok(Date.now()<deadline,JSON.stringify({error:runtime.snapshot().error,console:runtime.snapshot().console.slice(-8)}));
      await delay(20);
    }
    assert.equal(runtime.snapshot().latest,null);
    const modules=runtime.snapshot().max7219!.devices[0].modules;
    assert.deepEqual(modules[0].rows,[0x81,0x42,0x24,0x18,0x18,0x24,0x42,0x81]);
    assert.deepEqual(modules[1].rows,[255,129,189,165,165,189,129,255]);
  }finally{await runtime?.close();rmSync(directory,{recursive:true,force:true});}
});

test('generated SHT3x project reads CRC-checked words, survives boot-time faults and packages no unused drivers', {timeout:150000}, async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'espemu-packaged-sht3x-'));
  const { startProject } = await import('../tools/project-regression.ts');
  let project: Awaited<ReturnType<typeof startProject>> | undefined;
  try{
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',buses:[{id:'i2c0',type:'i2c',controller:0,sda:21,scl:22}],
      devices:[{id:'cabinet',type:'sht3x',bus:'i2c0',address:0x44},{id:'vent',type:'sht3x',bus:'i2c0',address:0x45}],
      inputs:{cabinet:{temperatureC:21.5,humidityPct:40,invalid:true},vent:{temperatureC:-12.25,humidityPct:92.5}}});
    createProject({directory,starter:'empty',manifest,mode:'create'});
    writeFileSync(join(directory,'main/main.c'),`#include "device_pins.h"
void app_main(void)
{
    ESP_ERROR_CHECK(espemu_i2c_init(I2C0_I2C_PORT, I2C0_SDA_PIN, I2C0_SCL_PIN, 100000));
    espemu_sht3x_t cabinet, vent;
    ESP_ERROR_CHECK(espemu_sht3x_init(&cabinet, CABINET_I2C_PORT, CABINET_I2C_ADDRESS));
    ESP_ERROR_CHECK(espemu_sht3x_init(&vent, VENT_I2C_PORT, VENT_I2C_ADDRESS));
    while (true) {
        espemu_sht3x_reading_t inside = {0}, outside = {0};
        esp_err_t inside_result = espemu_sht3x_read(&cabinet, &inside);
        esp_err_t outside_result = espemu_sht3x_read(&vent, &outside);
        espemu_telemetry_t packet;
        espemu_telemetry_begin(&packet);
        if (inside_result == ESP_OK) espemu_telemetry_value(&packet, "cabinet_rh", inside.humidity_pct, "%RH");
        else espemu_telemetry_missing(&packet, "cabinet_rh", "%RH");
        espemu_telemetry_value(&packet, "cabinet_error", inside_result, "");
        if (outside_result == ESP_OK) espemu_telemetry_value(&packet, "vent_c", outside.temperature_c, "C");
        else espemu_telemetry_missing(&packet, "vent_c", "C");
        ESP_ERROR_CHECK(espemu_telemetry_send(&packet));
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
`);
    const build=spawnSync('make',['-C',directory,'build'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(build.status,0,(build.stderr+build.stdout).slice(-6000));
    assert.doesNotMatch(build.stdout+build.stderr,/espressif\/led_strip/,'an SHT3x-only circuit does not download the LED-strip dependency');
    assert.equal(readFileSync(join(directory,'components/espemu_devices/CMakeLists.txt'),'utf8').includes('bme280'),false);
    project=await startProject(directory);
    const near=(value:unknown,expected:number,precision:number)=>typeof value==='number'&&Math.abs(value-expected)<=precision;
    await project.waitFor(state=>project!.channel('cabinet_error',state)===0x109&&project!.channel('cabinet_rh',state)===null&&near(project!.channel('vent_c',state),-12.25,0.003),20000);
    await project.input('cabinet',{invalid:false});
    await project.waitFor(state=>near(project!.channel('cabinet_rh',state),40,0.002)&&project!.channel('cabinet_error',state)===0);
    await project.input('cabinet',{connected:false});
    await project.waitFor(state=>project!.channel('cabinet_rh',state)===null&&state.events.some(event=>event.source==='i2c'&&/^0x44.*nack/i.test(event.message)));
    assert.ok(near(project.channel('vent_c'),-12.25,0.003));
  }finally{await project?.stop();rmSync(directory,{recursive:true,force:true});}
});

test('generated C++ camera project packages esp32-camera and captures supplied JPEG, RGB565 and YUV422 frames over I2S DMA', {timeout:300000}, async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'espemu-packaged-camera-'));
  const { startProject } = await import('../tools/project-regression.ts');
  let project: Awaited<ReturnType<typeof startProject>> | undefined;
  try{
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'cam',type:'ov2640'}]});
    createProject({directory,starter:'empty',manifest,mode:'create',language:'cpp'});
    assert.match(readFileSync(join(directory,'components/espemu_devices/idf_component.yml'),'utf8'),/espressif\/esp32-camera: "2\.1\.7"/);
    // Three configurations from the generated macro: five JPEG, three RGB565, then YUV422 captures.
    writeFileSync(join(directory,'main/main.cpp'),`#include "device_pins.h"

static uint32_t hash(const camera_fb_t *frame)
{
    uint32_t value = 0;
    for (size_t index = 0; index < frame->len; index++) value = value * 31 + frame->buf[index];
    return value;
}

extern "C" void app_main(void)
{
    camera_config_t config = CAM_CAMERA_CONFIG(PIXFORMAT_JPEG, FRAMESIZE_QQVGA);
    ESP_ERROR_CHECK(esp_camera_init(&config));
    for (int captured = 0;;) {
        camera_fb_t *frame = esp_camera_fb_get();
        if (frame) {
            printf("CAMERA %ux%u format=%d len=%u hash=%08lx\\n", (unsigned)frame->width, (unsigned)frame->height, (int)frame->format, (unsigned)frame->len, (unsigned long)hash(frame));
            esp_camera_fb_return(frame);
            if (++captured == 5 || captured == 8) {
                ESP_ERROR_CHECK(esp_camera_deinit());
                config = CAM_CAMERA_CONFIG(captured == 5 ? PIXFORMAT_RGB565 : PIXFORMAT_YUV422, FRAMESIZE_QQVGA);
                ESP_ERROR_CHECK(esp_camera_init(&config));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
`);
    const build=spawnSync('make',['-C',directory,'build'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
    assert.equal(build.status,0,(build.stderr+build.stdout).slice(-6000));
    project=await startProject(directory);
    const hash=(bytes:Uint8Array)=>{let value=0;for(const byte of bytes)value=(Math.imul(value,31)+byte)>>>0;return value.toString(16).padStart(8,'0');};
    type State=Awaited<ReturnType<typeof startProject>>['state'];
    const captured=(text:string,count=1)=>(state:State)=>state.console.filter(line=>line.includes(text)).length>=count;
    const sensor=(format:string)=>(state:State)=>state.camera?.sensor.format===format&&state.camera.sensor.width===160&&state.camera.sensor.height===120;
    await project.waitFor(sensor('jpeg'),30000);
    assert.equal(project.state.camera?.status,'no-source');
    const jpeg=new Uint8Array(2400);jpeg.set([0xff,0xd8,0xff,0xe0]);for(let index=4;index<jpeg.length-2;index++)jpeg[index]=(index*7)%251;jpeg.set([0xff,0xd9],jpeg.length-2);
    await assert.rejects(project.cameraFrame('cam',{format:'rgb565',width:160,height:120,data:new Uint8Array(16)}),/width x height x 2/);
    await project.cameraFrame('cam',{format:'jpeg',width:160,height:120,data:jpeg});
    await project.waitFor(captured(`CAMERA 160x120 format=4 len=${jpeg.length} hash=${hash(jpeg)}`,5),40000);
    await project.waitFor(sensor('rgb565'),30000);
    assert.equal(project.state.camera?.status,'mismatch','the JPEG source no longer matches the reconfigured sensor');
    const rgb=new Uint8Array(160*120*2);for(let index=0;index<rgb.length;index++)rgb[index]=(index*13+(index>>9))&0xff;
    await project.cameraFrame('cam',{format:'rgb565',width:160,height:120,data:rgb});
    await project.waitFor(captured(`CAMERA 160x120 format=0 len=${rgb.length} hash=${hash(rgb)}`,3),40000);
    await project.waitFor(sensor('yuv422'),30000);
    const yuv=rgb.map((value,index)=>value^index>>3&0xff);
    await project.cameraFrame('cam',{format:'yuv422',width:160,height:120,data:yuv});
    await project.waitFor(captured(`CAMERA 160x120 format=1 len=${yuv.length} hash=${hash(yuv)}`,2),40000);
    assert.equal(project.state.camera?.dma.descriptorErrors,0);
  }finally{await project?.stop();rmSync(directory,{recursive:true,force:true});}
});

test('generated LCD + speaker project shows SDK text on the HD44780 and plays tones through I2S TX DMA', {timeout:300000}, async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'espemu-packaged-speaker-lcd-'));
  const { startProject } = await import('../tools/project-regression.ts');
  const { LcdStateSchema, lcdCells } = await import('../shared/lcd.ts');
  let project: Awaited<ReturnType<typeof startProject>> | undefined;
  try{
    const config=JSON.parse(readFileSync(join(root,'tests/fixtures/speaker-lcd/project-config.json'),'utf8'));
    createProject({directory,starter:'empty',manifest:ProjectManifestSchema.parse(config.manifest),mode:'create',language:'c'});
    writeFileSync(join(directory,'main/main.c'),readFileSync(join(root,'tests/fixtures/speaker-lcd/main.c'),'utf8'));
    const build=spawnSync('make',['-C',directory,'build'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
    assert.equal(build.status,0,(build.stderr+build.stdout).slice(-6000));
    project=await startProject(directory);
    type State=Awaited<ReturnType<typeof startProject>>['state'];
    const rows=(state:State)=>{const parsed=LcdStateSchema.safeParse(state.deviceStates.lcd);return parsed.success?lcdCells(parsed.data,20,4).map(row=>row.map(cell=>cell.glyph?'#':cell.character).join('').trimEnd()):[];};
    await project.waitFor(state=>rows(state)[3]==='Tones 3',30000);
    const text=rows(project.state);
    assert.equal(text[0],'ESPEmu jukebox #','custom CGRAM glyph after ROM text');
    assert.match(text[1],/^Playing (440|880) Hz$/);
    assert.equal(LcdStateSchema.parse(project.state.deviceStates.lcd).ignoredWhileBusy,0,'the SDK waits out the busy flag');
    const speaker=project.state.speaker!;
    assert.deepEqual([speaker.controller,speaker.rate,speaker.bits,speaker.descriptorErrors],[1,16000,16,0]);
    const {rate,samples}=project.speakerAudio('speaker');
    assert.equal(rate,16000);
    const pitch=(slice:Int16Array)=>{let crossings=0,first=-1,last=-1;for(let index=1;index<slice.length;index++)if(slice[index-1]<0&&slice[index]>=0){crossings++;if(first<0)first=index;last=index;}return (crossings-1)*rate/(last-first);};
    const pitches=[];for(let offset=0;offset+1600<=samples.length;offset+=1600)pitches.push(Math.round(pitch(samples.subarray(offset,offset+1600))));
    assert.ok(pitches.filter(value=>value===440).length>=3&&pitches.filter(value=>value===880).length>=3,pitches.join(' '));
    let peak=0;for(const sample of samples)peak=Math.max(peak,Math.abs(sample));
    assert.ok(peak>11900&&peak<=12000,`amplitude ${peak}`);
  }finally{await project?.stop();rmSync(directory,{recursive:true,force:true});}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProject } from '../server/project.ts';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { EMPTY_MANIFEST, DEMO_MANIFEST, ProjectManifestSchema, type ProjectManifest } from '../shared/manifest.ts';
import { digitalInputLevel } from '../shared/registry.ts';

const root = resolve(import.meta.dirname, '..');
function runtime(manifest: ProjectManifest, image: string) {
  return new ProjectRuntime(root, manifest, (callbacks, project) => new QemuProcess(root, callbacks, { ...process.env, ESPEMU_FLASH: resolve(root,image) }, project));
}
async function until(instance: ProjectRuntime, predicate: () => boolean) {
  const deadline = Date.now()+10000;
  while (!predicate()) { assert.ok(Date.now()<deadline, JSON.stringify({error:instance.snapshot().error,console:instance.snapshot().console.slice(-6)})); await delay(20); }
}
test('packaged BME280 SDK supplies working C/C++ init/read calls without application callbacks', {timeout:30000},async()=>{
  const manifest=loadProject(root,{ESPEMU_PROJECT:resolve(root,'tests/fixtures/device-sdk')}).manifest;
  const instance=runtime(manifest,'.cache/device-sdk/qemu_flash.bin');
  try{
    await instance.start();await until(instance,()=>instance.snapshot().console.some(line=>line.includes('SDK temperature=23.00')));
    await until(instance,()=>instance.snapshot().console.some(line=>line.includes('SDK tmp=25.00 lux=320.0 gyro=0.00'))&&!!instance.snapshot().ws2812?.devices[0]?.frames);
    assert.deepEqual(instance.snapshot().ws2812!.devices[0].pixels,[[255,0,0]]);
    assert.equal((await instance.command({v:1,id:'sdk-motion',epoch:0,action:'input',deviceId:'motion',channel:'gyroXdps',value:90})).ok,true);
    await until(instance,()=>instance.snapshot().console.some(line=>line.includes('gyro=90.00')));
    assert.equal((await instance.command({v:1,id:'sdk-input',epoch:0,action:'input',deviceId:'environment',channel:'temperatureC',value:40})).ok,true);
    await until(instance,()=>instance.snapshot().console.some(line=>line.includes('SDK temperature=40.00')));
    assert.equal((await instance.command({v:1,id:'sdk-invalid',epoch:0,action:'input',deviceId:'environment',channel:'invalid',value:true})).ok,true);
    await until(instance,()=>instance.snapshot().console.some(line=>line.includes('SDK error=264')));
  }finally{await instance.close();}
});

test('actual empty firmware boots with no sensors, inputs or implicit GPIO wiring', {timeout:15000}, async () => {
  const instance=runtime(EMPTY_MANIFEST,'.cache/empty-firmware/qemu_flash.bin');
  try { await instance.start(); await until(instance,()=>instance.snapshot().console.some(line=>line.includes('Returned from app_main()'))); assert.equal(instance.health().ready,true); assert.deepEqual(instance.snapshot().deviceStates,{}); assert.deepEqual(instance.snapshot().inputs,{}); assert.deepEqual(instance.snapshot().peripherals,[]); assert.equal(instance.snapshot().latest,null); }
  finally {await instance.close();}
});

test('fresh project launches reload manifest wiring and initial physical inputs without editing source', {timeout:20000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'espemu-project-reload-'));
  const filename=join(directory,'espemu.json');
  try{
    const declaration={v:1,target:'esp32',devices:[{id:'status',type:'led',pin:4},{id:'button',type:'button',pin:27}],gpioInputs:[{pin:27,level:0}]};
    const text=JSON.stringify(declaration);writeFileSync(filename,text);
    for(let attempt=0;attempt<2;attempt++){
      const project=loadProject('/',{ESPEMU_PROJECT:directory}).manifest;
      const instance=runtime(project,'.cache/gpio-firmware/qemu_flash.bin');
      try{await instance.start();await until(instance,()=>instance.snapshot().gpio?.pins.find(pin=>pin.pin===4)?.level===1);assert.equal(instance.snapshot().peripherals[0].id,'status');assert.equal(instance.snapshot().gpioInputs[0].level,0);assert.equal(readFileSync(filename,'utf8'),text);}
      finally{await instance.close();}
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('actual manifest GPIO-only circuit works without application telemetry', {timeout:15000}, async () => {
  const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'blink',type:'led',pin:2},{id:'press',type:'button',pin:27},{id:'echo',type:'led',pin:4}]});
  const instance=runtime(manifest,'.cache/gpio-firmware/qemu_flash.bin');
  const pin=(number:number)=>instance.snapshot().gpio?.pins.find(value=>value.pin===number);
  try {await instance.start();await until(instance,()=>pin(2)?.outputEnabled===true);const initial=pin(2)!.level;await until(instance,()=>pin(2)!.level!==initial);
    assert.equal(instance.snapshot().latest,null); assert.equal((await instance.command({v:1,id:'press',epoch:0,action:'gpio-inputs',pins:[{pin:27,level:0}]})).ok,true);
    await until(instance,()=>pin(4)?.level===1); assert.equal(instance.exportFile().gpioInputs[0].level,0);
  }finally{await instance.close();}
});
test('named digital outputs reach ordinary firmware with driven and open-collector inactive levels', {timeout:20000},async()=>{
  for(const type of ['hc_sr501','a3144'] as const){
    const manifest=ProjectManifestSchema.parse({v:1,target:'esp32',devices:[{id:'sensor',type,pin:27},{id:'echo',type:'led',pin:4}]});
    const instance=runtime(manifest,'.cache/gpio-firmware/qemu_flash.bin');
    const observed=()=>instance.snapshot().gpio?.pins.find(pin=>pin.pin===27);
    const echo=()=>instance.snapshot().gpio?.pins.find(pin=>pin.pin===4);
    const activeLow=type==='a3144';
    try{
      await instance.start();await until(instance,()=>observed()?.pullUp===true&&echo()?.outputEnabled===true);
      await until(instance,()=>observed()?.level===(activeLow?1:0)&&echo()?.level===(activeLow?0:1));
      assert.equal(observed()!.externallyDriven,!activeLow);
      for(const asserted of [true,false]){
        const level=digitalInputLevel(type,activeLow,asserted);
        assert.equal((await instance.command({v:1,id:`${type}-${asserted}`,epoch:instance.snapshot().epoch,action:'gpio-inputs',pins:[{pin:27,level}]})).ok,true);
        const expected=activeLow?(asserted?0:1):(asserted?1:0);
        await until(instance,()=>observed()?.level===expected&&echo()?.level===(expected?0:1)&&instance.snapshot().console.some(line=>line.includes(`button=${expected}`)));
        assert.equal(observed()!.externallyDriven,level!==null);
      }
      assert.equal(instance.snapshot().latest,null,'No special application telemetry is needed for sensor outputs');
      assert.equal((await instance.command({v:1,id:'reset-input',epoch:0,action:'reset'})).ok,true);
      assert.equal((await instance.command({v:1,id:'resume-input',epoch:1,action:'run'})).ok,true);
      await until(instance,()=>observed()?.pullUp===true&&observed()?.level===(activeLow?1:0));
    }finally{await instance.close();}
  }
});

test('actual ordinary I2C firmware reads a sensor subset and two independently configured instances', {timeout:30000}, async () => {
  const bus=DEMO_MANIFEST.buses;
  const single=ProjectManifestSchema.parse({v:1,target:'esp32',buses:bus,devices:[{id:'room',type:'tmp105',bus:'i2c0',address:72}],inputs:{room:{temperatureC:20}}});
  const dual=ProjectManifestSchema.parse({...single,devices:[...single.devices,{id:'outside',type:'tmp105',bus:'i2c0',address:73}],inputs:{room:{temperatureC:20},outside:{temperatureC:35}}});
  for(const manifest of [single,dual]) {
    const instance=runtime(manifest,'.cache/multi-sensor/qemu_flash.bin');
    try{await instance.start();await until(instance,()=>instance.snapshot().console.some(line=>line.includes('address=72 temperature=20.0')));
      if(manifest.devices.length===2)await until(instance,()=>instance.snapshot().console.some(line=>line.includes('address=73 temperature=35.0')));
      assert.equal(Object.keys(instance.snapshot().deviceStates).length,manifest.devices.length);assert.equal(instance.snapshot().latest,null);
      const inputs=structuredClone(instance.snapshot().inputs);inputs.room.temperatureC=30;
      assert.equal((await instance.command({v:1,id:'input',epoch:0,action:'inputs',inputs})).ok,true);
      await until(instance,()=>instance.snapshot().console.some(line=>line.includes('address=72 temperature=30.0')));
      assert.equal(instance.exportFile().inputs.room.temperatureC,30);
      assert.equal((await instance.command({v:1,id:'field',epoch:0,action:'input',deviceId:'room',channel:'temperatureC',value:40})).ok,true);
      await until(instance,()=>instance.snapshot().console.some(line=>line.includes('address=72 temperature=40.0')));
      assert.equal((await instance.command({v:1,id:'invalid-field',epoch:0,action:'input',deviceId:'room',channel:'constructor',value:1})).ok,false);
    }finally{await instance.close();}
  }
});
test('existing demo firmware exercises every supported device through ordinary GPIO/I2C/RMT APIs', {timeout:20000}, async()=>{
  const instance=runtime(DEMO_MANIFEST,'firmware/build/qemu_flash.bin');
  try{
    await instance.start();await until(instance,()=>instance.snapshot().latest?.channels['tmp105.temperatureC']?.value===25&&instance.snapshot().ws2812?.devices.every(device=>device.frames>1)===true);
    assert.equal(Object.keys(instance.snapshot().deviceStates).length,4);
    assert.equal(instance.snapshot().latest!.channels['mpu6050.gyroXdps'].value,0);
    assert.equal(instance.snapshot().latest!.channels['mpu6050.accelZg'].value,1);
    for(const pin of [2,16,17,23])assert.equal(instance.snapshot().gpio?.pins.find(entry=>entry.pin===pin)?.outputEnabled,true);
    assert.equal(instance.snapshot().ws2812!.devices.find(device=>device.id==='strip')!.pixels.length,8);
    assert.ok(instance.snapshot().ws2812!.devices.find(device=>device.id==='strip')!.pixels.some(pixel=>pixel.some(value=>value>0)));
    assert.equal((await instance.command({v:1,id:'press',epoch:0,action:'gpio-inputs',pins:[{pin:27,level:0},{pin:26,level:1}]})).ok,true);
    await until(instance,()=>instance.snapshot().latest?.channels['digital.buttonPressed']?.value===1&&instance.snapshot().latest?.channels['digital.switchOn']?.value===1&&instance.snapshot().gpio?.pins.find(pin=>pin.pin===23)?.level===1&&instance.snapshot().gpio?.pins.find(pin=>pin.pin===17)?.level===1);
    assert.equal(instance.snapshot().gpio?.pins.find(pin=>pin.pin===23)?.level,1);
    assert.equal((await instance.command({v:1,id:'rotate',epoch:0,action:'input',deviceId:'mpu6050',channel:'gyroXdps',value:90})).ok,true);
    await until(instance,()=>instance.snapshot().latest?.channels['mpu6050.gyroXdps']?.value===90&&instance.snapshot().latest?.channels['digital.probeLevel']?.value===1&&instance.snapshot().gpio?.pins.find(pin=>pin.pin===2)?.level===1);
    assert.equal(instance.snapshot().latest!.channels['digital.probeLevel'].value,1);
  }
  finally{await instance.close();}
});

test('ordinary MPU6050 I2C firmware reads browser motion inputs and drives its own GPIO LED', {timeout:20000},async()=>{
  const manifest=loadProject(root,{ESPEMU_PROJECT:resolve(root,'tests/fixtures/gyro-firmware')}).manifest;
  const instance=runtime(manifest,'.cache/gyro-firmware/qemu_flash.bin');
  const led=()=>instance.snapshot().gpio?.pins.find(pin=>pin.pin===2);
  try{
    await instance.start();await until(instance,()=>instance.snapshot().latest?.channels['rotation.x']?.value===0&&led()?.outputEnabled===true);
    assert.equal(led()!.level,0);
    const inputs=structuredClone(instance.snapshot().inputs);inputs.motion.gyroXdps=90;inputs.motion.accelXg=.5;inputs.motion.accelZg=Math.sqrt(.75);
    assert.equal((await instance.command({v:1,id:'move',epoch:0,action:'inputs',inputs})).ok,true);
    await until(instance,()=>instance.snapshot().latest?.channels['rotation.x']?.value===90&&led()?.level===1);
    assert.equal(instance.snapshot().latest!.channels['acceleration.x'].value,.5);
    assert.equal((await instance.command({v:1,id:'bad-gesture',epoch:0,action:'input-fields',deviceId:'motion',fields:{gyroXdps:180,accelYg:17}})).ok,false);
    assert.equal(instance.snapshot().inputs.motion.gyroXdps,90);
    assert.equal((await instance.command({v:1,id:'gesture',epoch:0,action:'input-fields',deviceId:'motion',fields:{gyroXdps:-45,gyroYdps:10,gyroZdps:0,accelXg:0,accelYg:.5,accelZg:Math.sqrt(.75)}})).ok,true);
    await until(instance,()=>instance.snapshot().latest?.channels['rotation.x']?.value===-45);
    assert.equal(instance.snapshot().inputs.motion.temperatureC,25);
    assert.equal((await instance.command({v:1,id:'unknown-gesture',epoch:0,action:'input-fields',deviceId:'motion',fields:{constructor:1}})).ok,false);
    assert.equal((await instance.command({v:1,id:'stop-y',epoch:0,action:'input-fields',deviceId:'motion',fields:{gyroYdps:0,accelYg:0}})).ok,true);
    inputs.motion.gyroXdps=0;inputs.motion.accelXg=0;inputs.motion.accelZg=1;
    assert.equal((await instance.command({v:1,id:'rest',epoch:0,action:'inputs',inputs})).ok,true);
    await until(instance,()=>instance.snapshot().latest?.channels['rotation.x']?.value===0&&led()?.level===0);
    assert.equal((await instance.command({v:1,id:'reset',epoch:0,action:'reset'})).ok,true);
    assert.equal(instance.snapshot().phase,'paused');
    assert.equal((await instance.command({v:1,id:'resume',epoch:1,action:'run'})).ok,true);
    await until(instance,()=>instance.snapshot().epoch===1&&instance.snapshot().latest?.channels['rotation.x']?.value===0);
  }finally{await instance.close();}
});

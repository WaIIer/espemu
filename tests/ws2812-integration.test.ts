import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectRuntime } from '../server/project-runtime.ts';
import { QemuProcess } from '../server/qemu.ts';
import { loadProject } from '../server/project.ts';

test('ordinary led_strip RMT firmware drives single and strip WS2812 instances through decoded waveforms', {timeout:20000},async()=>{
  const root=resolve(import.meta.dirname,'..');
  const project=loadProject(root,{ESPEMU_PROJECT:resolve(root,'tests/fixtures/ws2812')}).manifest;
  const runtime=new ProjectRuntime(root,project,(callbacks,manifest)=>new QemuProcess(root,callbacks,{...process.env,ESPEMU_FLASH:resolve(root,'.cache/ws2812/qemu_flash.bin')},manifest));
  try{
    await runtime.start();const deadline=Date.now()+15000;
    while(!runtime.snapshot().console.some(line=>line.includes('WS2812 phase='))||!runtime.snapshot().ws2812?.devices.find(device=>device.id==='strip'&&device.frames>0)){
      assert.ok(Date.now()<deadline,JSON.stringify({error:runtime.snapshot().error,ws:runtime.snapshot().ws2812,console:runtime.snapshot().console.slice(-10)}));await delay(20);
    }
    const state=runtime.snapshot();
    const strip=state.ws2812!.devices.find(device=>device.id==='strip')!;
    assert.equal(strip.pixels.length,8);
    assert.equal(strip.pixels[7][0],140,JSON.stringify(state.ws2812));assert.equal(strip.pixels[7][1],10);
    assert.ok(state.ws2812!.devices.find(device=>device.id==='pixel')!.frames>0);
    assert.equal(state.latest,null);
    const frames=strip.frames;
    while((runtime.snapshot().ws2812?.devices.find(device=>device.id==='strip')?.frames??0)<=frames){assert.ok(Date.now()<deadline);await delay(20);}
  }finally{await runtime.close();}
});

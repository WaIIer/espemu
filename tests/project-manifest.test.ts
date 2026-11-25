import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProject } from '../server/project.ts';
import { QemuProcess } from '../server/qemu.ts';

test('selected project loads its manifest read-only and missing manifests mean empty circuits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-manifest-'));
  try {
    assert.deepEqual(loadProject(directory, {}).manifest.devices, []);
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify({ v: 1, target: 'esp32', devices: [{ id: 'status', type: 'led', pin: 2 }] }));
    assert.equal(loadProject('/', { ESPEMU_PROJECT: directory }).manifest.devices[0].id, 'status');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('selecting a project loads its own flash image without an explicit flash override',async()=>{
  const root=resolve(import.meta.dirname,'..'),directory=mkdtempSync(join(tmpdir(),'espemu-selected-project-'));
  let console='';
  const emulator=new QemuProcess(root,{stdout:chunk=>{console+=chunk;},stderr:()=>{},exited:()=>{}},{...process.env,ESPEMU_PROJECT:directory,ESPEMU_FLASH:undefined});
  try{
    mkdirSync(join(directory,'build'));copyFileSync(join(root,'.cache/empty-firmware/qemu_flash.bin'),join(directory,'build/qemu_flash.bin'));
    writeFileSync(join(directory,'espemu.json'),'{"v":1,"target":"esp32","devices":[]}');
    await emulator.start();await emulator.command('cont');const deadline=Date.now()+6000;
    while(!console.includes('Returned from app_main()')){assert.ok(Date.now()<deadline,console.slice(-2000));await new Promise(done=>setTimeout(done,20));}
    assert.equal(console.includes('ESP_EMU '),false);
  }finally{await emulator.close();rmSync(directory,{recursive:true,force:true});}
});
test('invalid project manifests fail before QEMU starts with a configuration path in the error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'espemu-manifest-'));
  let activity = false;
  const process = new QemuProcess(resolve(import.meta.dirname, '..'), { stdout: () => { activity = true; }, stderr: () => { activity = true; }, exited: () => { activity = true; } }, { ...globalThis.process.env, ESPEMU_PROJECT: directory });
  try {
    writeFileSync(join(directory, 'espemu.json'), JSON.stringify({ v: 1, target: 'esp32c3' }));
    await assert.rejects(process.start(), /Invalid project manifest.*target/);
    assert.equal(activity, false);
  } finally { await process.close(); rmSync(directory, { recursive: true, force: true }); }
});

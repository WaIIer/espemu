import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digitalInputLevel, normalizeGpioInputs, PERIPHERAL_GROUPS, PERIPHERAL_REGISTRY, peripheralGroup } from '../shared/registry.ts';
import { CommandSchema, PeripheralsSchema, GpioInputsSchema } from '../shared/protocol.ts';
import { digitalChannel, rgbDisplay } from '../shared/digital-display.ts';
import type { GpioState } from '../shared/protocol.ts';

test('framework GPIO inputs reject flash pins, duplicates, invalid values and unknown fields', () => {
  assert.equal(GpioInputsSchema.safeParse([{ pin: 27, level: 0 }]).success, true);
  for (const pins of [[{ pin: 6, level: 1 }], [{ pin: 2, level: 2 }], [{ pin: 27, level: null }, { pin: 27, level: 1 }]])
    assert.equal(GpioInputsSchema.safeParse(pins).success, false);
});

test('RGB display uses the same observed GPIO states as individual LEDs and reports input channels explicitly', () => {
  const state: GpioState = {v:1,virtualMs:100,pins:[16,17,18].map((pin,index)=>({pin,level:index===0?1:0,outputLatch:index===0?1:0,outputEnabled:index!==2,externallyDriven:false,openDrain:false,pullUp:false,pullDown:false,contended:false}))};
  const rgb=rgbDisplay(state,[16,17,18],false);
  assert.equal(rgb.status,'partial');
  assert.deepEqual(rgb.channels.map(channel=>channel.status),['high','low','input']);
  assert.equal(rgb.channels[0].on,digitalChannel(state,16,false).on);
  assert.equal(rgb.channels[1].on,digitalChannel(state,17,false).on);
  assert.equal(rgbDisplay(null,[16,17,18],false).status,'unavailable');
  assert.equal(digitalChannel(state,17,true).on,true);
});
test('framework peripheral configuration validates LED output capabilities and RGB pins', () => {
  const led = { id: 'led', label: 'LED', kind: 'led', pin: 2, color: 'red', activeLow: false };
  assert.equal(PeripheralsSchema.safeParse([led]).success, true);
  assert.equal(PeripheralsSchema.safeParse([{ ...led, pin: 34 }]).success, false);
  assert.equal(PeripheralsSchema.safeParse([led, led]).success, false);
  assert.equal(PeripheralsSchema.safeParse([{ id: 'rgb', label: 'RGB', kind: 'rgb', pins: [2,2,4], activeLow: false }]).success, false);
  assert.equal(CommandSchema.safeParse({ v: 1, id: 'x', epoch: 0, action: 'peripherals', peripherals: [led] }).success, true);
});

test('named sensor modules reuse externally driven digital inputs',()=>{
  const motion={id:'motion',label:'HC-SR501',kind:'hc_sr501',pin:34,activeLow:false};
  const touch={id:'touch',label:'TTP223',kind:'ttp223',pin:27,activeLow:false};
  assert.equal(PeripheralsSchema.safeParse([motion,touch]).success,true);
  assert.equal(PeripheralsSchema.safeParse([{...motion,pin:6}]).success,false);
  assert.equal(GpioInputsSchema.safeParse([{pin:motion.pin,level:1},{pin:touch.pin,level:0}]).success,true);
});

test('named outputs drive inactive levels or release only for open-collector/contact devices',()=>{
  assert.equal(digitalInputLevel('hc_sr501',false,true),1);
  assert.equal(digitalInputLevel('hc_sr501',false,false),0);
  assert.equal(digitalInputLevel('hc_sr501',true,false),1);
  assert.equal(digitalInputLevel('ttp223',false,false),0);
  assert.equal(digitalInputLevel('a3144',true,true),0);
  assert.equal(digitalInputLevel('a3144',true,false),null);
  assert.equal(digitalInputLevel('sw_520d',true,false),null);
  assert.equal(digitalInputLevel('button',true,false),null);
  assert.equal(digitalInputLevel('switch',false,false),null);
  assert.equal(digitalInputLevel('ky_038',false,false),0);
  assert.equal(digitalInputLevel('ky_038',false,true),null);
});

test('every named module uses a valid GPIO wire schema',()=>{
  const modules=Object.entries(PERIPHERAL_REGISTRY).filter(([,definition])=>'drive' in definition);
  assert.equal(modules.length,20);
  for(const [kind,definition]of modules){
    const device=definition.config.parse({id:kind,type:kind,pin:34});
    const {type,...config}=device;
    assert.equal(PeripheralsSchema.safeParse([{...config,kind:type,label:definition.label}]).success,true,kind);
  }
});

test('declared pull-ups hold released open-collector and contact inputs high', () => {
  assert.equal(digitalInputLevel('yl_69', true, false), null);
  assert.equal(digitalInputLevel('yl_69', true, false, true), 1);
  assert.equal(digitalInputLevel('yl_69', true, true, true), 0);
  assert.equal(digitalInputLevel('button', true, false, true), 1);
  assert.equal(digitalInputLevel('hc_sr501', false, false, true), 0);
  assert.deepEqual(normalizeGpioInputs([{ id: 'soil', type: 'yl_69', pin: 34, activeLow: true, pullUp: true }, { id: 'door', type: 'reed_59170', pin: 35, activeLow: true }], []), [{ pin: 34, level: 1 }]);
  assert.equal(PERIPHERAL_REGISTRY.hc_sr501.config.safeParse({ id: 'pir', type: 'hc_sr501', pin: 4, pullUp: true }).success, false);
  assert.equal(PeripheralsSchema.safeParse([{ id: 'soil', label: 'Soil', kind: 'yl_69', pin: 34, activeLow: true, pullUp: true }]).success, true);
});

test('every registry type belongs to one creator group', () => {
  const counts = Object.fromEntries(PERIPHERAL_GROUPS.map(group => [group, 0]));
  for (const type of Object.keys(PERIPHERAL_REGISTRY) as (keyof typeof PERIPHERAL_REGISTRY)[]) counts[peripheralGroup(type)]++;
  assert.ok(Object.values(counts).every(count => count > 0), JSON.stringify(counts));
  for (const [type, definition] of Object.entries(PERIPHERAL_REGISTRY)) assert.equal(peripheralGroup(type as keyof typeof PERIPHERAL_REGISTRY) === 'Digital sensor modules', 'drive' in definition, type);
  assert.deepEqual([peripheralGroup('sht3x'), peripheralGroup('ws2812b'), peripheralGroup('probe'), peripheralGroup('yl_69')], ['I2C sensors', 'Outputs and displays', 'Buttons, switches and probes', 'Digital sensor modules']);
});

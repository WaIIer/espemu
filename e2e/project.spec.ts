import { test, expect } from '@playwright/test';
import { PERIPHERAL_REGISTRY } from '../shared/registry';
test('actual GPIO circuit displays firmware LEDs/RGB and browser button reaches firmware without telemetry',async({page},info)=>{
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await expect(page.getByRole('region',{name:'GPIO devices'})).toBeVisible();
  const led=page.getByRole('article',{name:'Blink LED peripheral'}).getByRole('img');
  await expect(led).toHaveAttribute('aria-label','Blink LED on');await expect(led).toHaveAttribute('aria-label','Blink LED off');
  const button=page.getByRole('button',{name:'Press Button',exact:true});await button.hover();await page.mouse.down();
  await expect(page.getByRole('article',{name:'Button LED peripheral'}).getByRole('img')).toHaveAttribute('aria-label','Button LED on');
  await page.mouse.up();await expect(page.getByRole('article',{name:'Button LED peripheral'}).getByRole('img')).toHaveAttribute('aria-label','Button LED off');
  const state=await(await page.request.get('/api/state')).json();expect(state.latest).toBeNull();expect(state.manifest.devices).toHaveLength(5);expect(state.deviceStates).toEqual({});
  await page.getByRole('button',{name:'pause',exact:true}).click();await expect(page.locator('.phase')).toHaveText('paused');const frozen=(await led.getAttribute('aria-label'))!;
  await page.waitForTimeout(700);await expect(led).toHaveAttribute('aria-label',frozen);await page.getByRole('button',{name:'run',exact:true}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export circuit',exact:true}).click();expect((await download).suggestedFilename()).toBe('espemu.json');
  for(const viewport of [{width:1440,height:1000},{width:375,height:812},{width:320,height:740}]){
    await page.setViewportSize(viewport);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`gpio-${viewport.width}.png`),fullPage:true});
  }
});
test('active runs show fixed wiring without project editing controls',async({page})=>{
  await page.goto('/');await expect(page.getByRole('button',{name:'pause',exact:true})).toBeEnabled();
  const panel=page.getByRole('region',{name:'GPIO devices'});
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Add device',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Remove|Import/})).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  const original=await(await page.request.get('/api/topology')).json();
  await page.reload();
  await expect(page.getByRole('article',{name:'Blink LED peripheral'})).toContainText('GPIO2');
  expect(await(await page.request.get('/api/topology')).json()).toEqual(original);
  await expect(page.getByRole('button',{name:'Press Button',exact:true})).toBeEnabled();
});

test('named sensor controls deliver driven, active-low and active-high comparator outputs to firmware',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await expect(page.getByRole('button',{name:'pause',exact:true})).toBeEnabled();
  for(const type of ['hc_sr501','a3144','ky_038'] as const){
    const state=await(await page.request.get('/api/state')).json();
    const label=PERIPHERAL_REGISTRY[type].label;
    const manifest={v:1,target:'esp32',devices:[{id:'sensor',label,type,pin:27},{id:'echo',label:'Echo LED',type:'led',pin:4}],gpioInputs:[]};
    const response=await page.request.post('/api/import',{data:{v:1,id:`load-${type}`,epoch:state.epoch,file:manifest}});
    expect(response.ok()).toBe(true);
    const control=page.getByRole('checkbox',{name:`Toggle ${label}`,exact:true});
    const activeLow=type==='a3144';
    const pin=async()=>{const next=await(await page.request.get('/api/state')).json();return next.gpio.pins.find((entry:{pin:number})=>entry.pin===27);};
    const echo=page.getByRole('article',{name:'Echo LED peripheral'}).getByRole('img');
    await expect(control).not.toBeChecked();
    await expect.poll(async()=>(await pin()).level).toBe(activeLow?1:0);
    await expect(echo).toHaveAttribute('aria-label',activeLow?'Echo LED off':'Echo LED on');
    for(const asserted of [true,false]){
      await control.click();await expect(control).toBeChecked({checked:asserted});
      const level=activeLow?(asserted?0:1):(asserted?1:0);
      await expect.poll(async()=>(await pin()).level).toBe(level);
      await expect(echo).toHaveAttribute('aria-label',level?'Echo LED off':'Echo LED on');
      const next=await(await page.request.get('/api/state')).json();
      expect(next.latest).toBeNull();
      expect(next.console.some((line:string)=>line.includes(`button=${level}`))).toBe(true);
      const externallyDriven=type==='hc_sr501'||(activeLow?asserted:!asserted);
      expect((await pin()).externallyDriven).toBe(externallyDriven);
    }
    await expect(page.getByRole('button',{name:/Import|Remove/})).toHaveCount(0);
  }
  for(const viewport of [{width:1440,height:1000},{width:375,height:812},{width:320,height:740}]){
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`named-modules-${viewport.width}.png`),fullPage:true});
  }
  expect(errors).toEqual([]);
});

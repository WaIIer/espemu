import { test, expect } from '@playwright/test';
test('demo firmware and QEMU state remain independently observable with registry controls',async({page},info)=>{
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await page.getByRole('tab',{name:'Inputs',exact:true}).click();
  const model=page.getByRole('article',{name:'tmp105 QEMU state'});
  await expect(model.locator('[data-channel=temperatureC]')).toHaveText('25.00');
  await page.getByRole('spinbutton',{name:'tmp105 temperatureC input'}).fill('42');
  await page.getByRole('spinbutton',{name:'tmp105 temperatureC input'}).press('Tab');
  await expect(model.locator('[data-channel=temperatureC]')).toHaveText('42.00');
  await expect.poll(async()=>{const state=await(await page.request.get('/api/state')).json();return state.latest?.channels['tmp105.temperatureC']?.value;}).toBe(42);
  const connected=page.getByRole('checkbox',{name:'tmp105 connected',exact:true});
  const invalid=page.getByRole('checkbox',{name:'tmp105 invalid',exact:true});
  await connected.click();await expect(connected).not.toBeChecked();await expect(model.locator('.reading-status')).toHaveText('disconnected');
  await connected.click();await expect(connected).toBeChecked();
  await invalid.click();await expect(invalid).toBeChecked();await expect(model.locator('.reading-status')).toHaveText('invalid');
  await invalid.click();await expect(invalid).not.toBeChecked();
  await page.getByRole('tab',{name:'Application',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Application chart channel'})).toBeVisible();
  await page.getByRole('tab',{name:'Circuit',exact:true}).click();
  for(const viewport of [{width:1440,height:1000},{width:375,height:812},{width:320,height:740}]){
    await page.setViewportSize(viewport);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect.poll(()=>page.locator('.runtime-bitmap').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(viewport.width<600?360:1000);
    await page.screenshot({path:info.outputPath(`demo-${viewport.width}.png`),fullPage:true});
  }
});
test('active demo wiring stays fixed while dragging the gyro reaches real firmware',async({page},info)=>{
  await page.goto('/');await expect(page.getByRole('button',{name:'pause',exact:true})).toBeEnabled();
  const original=await(await page.request.get('/api/topology')).json();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  const panel=page.getByRole('region',{name:'GPIO peripherals'});
  await expect(panel.getByRole('combobox')).toHaveCount(0);await expect(panel.getByRole('spinbutton')).toHaveCount(0);await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('group',{name:'WS2812 strip pixels',exact:true}).getByRole('img')).toHaveCount(8);
  const canvas=page.locator('canvas[data-gyro-id="mpu6050"]');
  for(const viewport of [{width:1440,height:1000},{width:375,height:812},{width:320,height:740}]){
    await page.setViewportSize(viewport);await canvas.scrollIntoViewIfNeeded();
    await page.getByRole('button',{name:'Reset mpu6050 orientation',exact:true}).click();
    await expect.poll(async()=>{const state=await(await page.request.get('/api/state')).json();return state.inputs.mpu6050.accelZg;}).toBe(1);
    const colored=await canvas.evaluate((element:HTMLCanvasElement)=>{
      const copy=document.createElement('canvas');copy.width=element.width;copy.height=element.height;
      const context=copy.getContext('2d')!;context.drawImage(element,0,0);
      const pixels=context.getImageData(0,0,copy.width,copy.height).data;let boardPixels=0;
      for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]>20&&pixels[index+1]>pixels[index]*1.15&&pixels[index+1]>pixels[index+2]*1.05)boardPixels++;
      return boardPixels;
    });
    expect(colored).toBeGreaterThan(50);
    const bounds=(await canvas.boundingBox())!;
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width/2+55,bounds.y+bounds.height/2+30,{steps:10});await page.mouse.up();
    await expect.poll(async()=>{
      const state=await(await page.request.get('/api/state')).json();
      const input=state.inputs.mpu6050.accelXg,observed=state.latest?.channels['mpu6050.accelXg']?.value;
      return {viewport:viewport.width,input,observed,moved:Math.abs(input)>.15,
        matched:typeof observed==='number'&&Math.abs(input-observed)<.02,
        errors:await page.locator('.gyro-workbench .field-error').allTextContents()};
    },{timeout:10000}).toMatchObject({viewport:viewport.width,input:expect.any(Number),observed:expect.any(Number),moved:true,matched:true,errors:[]});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await(await page.request.get('/api/topology')).json()).toEqual(original);
    await page.screenshot({path:info.outputPath(`gyro-${viewport.width}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'Reset mpu6050 orientation',exact:true}).click();
  await expect.poll(async()=>{const state=await(await page.request.get('/api/state')).json();return state.inputs.mpu6050.accelZg;}).toBe(1);
});

test('gyro release applies its final pointer position when intermediate moves are missing',async({page})=>{
  await page.setViewportSize({width:375,height:812});await page.goto('/');
  await expect(page.getByRole('button',{name:'pause',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Reset mpu6050 orientation',exact:true}).click();
  await expect.poll(async()=>{const state=await(await page.request.get('/api/state')).json();return state.inputs.mpu6050.accelZg;}).toBe(1);
  const canvas=page.locator('canvas[data-gyro-id="mpu6050"]');
  await canvas.scrollIntoViewIfNeeded();
  const bounds=(await canvas.boundingBox())!;
  const horizontal=bounds.x+bounds.width/2,vertical=bounds.y+bounds.height/2;
  await page.mouse.move(horizontal,vertical);await page.mouse.down();
  await canvas.dispatchEvent('pointerup',{pointerId:1,clientX:horizontal+55,clientY:vertical+30});
  await page.mouse.up();
  await expect.poll(async()=>{
    const state=await(await page.request.get('/api/state')).json();
    const input=state.inputs.mpu6050.accelXg,observed=state.latest?.channels['mpu6050.accelXg']?.value;
    return {viewport:page.viewportSize()?.width,input,observed,moved:Math.abs(input)>.15,
      matched:typeof observed==='number'&&Math.abs(input-observed)<.02,
      errors:await page.locator('.gyro-workbench .field-error').allTextContents()};
  },{timeout:10000}).toMatchObject({viewport:375,input:expect.any(Number),observed:expect.any(Number),moved:true,matched:true,errors:[]});
});

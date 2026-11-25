import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectCreatorConfigSchema } from '../shared/project-creator';

test('session-free creator copies JSON that the normal setup script turns into each local starter', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('dialog', dialog => void dialog.accept());
  const runtimeRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) runtimeRequests.push(request.url()); });
  page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/ws') runtimeRequests.push(socket.url()); });
  await page.goto('/create');
  await expect(page.getByRole('heading', { name: 'Create an ESP-IDF project' })).toBeVisible();
  const temporary = mkdtempSync(join(tmpdir(), 'espemu-browser-creator-'));
  try {
    for (const starter of ['empty', 'blinky', 'demo'] as const) {
      await page.getByLabel('Starter', { exact: true }).selectOption(starter);
      await page.getByLabel('Language', { exact: true }).selectOption('cpp');
      if (starter === 'blinky') await page.getByLabel('On/off interval (ms)').fill('250');
      await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('JSON copied.');
      const text = await page.evaluate(() => navigator.clipboard.readText());
      expect(text).toBe(await page.getByLabel('Project JSON', { exact: true }).inputValue());
      const config = ProjectCreatorConfigSchema.parse(JSON.parse(text));
      expect(config.starter).toBe(starter);
      expect(config.language).toBe('cpp');
      const directory = join(temporary, starter);
      const result = spawnSync('bash', [resolve('tools/setup-project.sh'), directory, '--config', '-'], {
        input: text, encoding: 'utf8', timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(directory, 'espemu.json'), 'utf8'))).toEqual(config.manifest);
      const source = readFileSync(join(directory, 'main/main.cpp'), 'utf8');
      expect(source).toContain('extern "C" void app_main(void)');
      if (starter === 'empty') expect(config.manifest.devices).toEqual([]);
      if (starter === 'blinky') expect(source).toContain('#define BLINK_INTERVAL_MS 250');
      if (starter === 'demo') expect(existsSync(join(directory, 'components/espemu_demo/demo.c'))).toBe(true);
      expect(existsSync(join(directory, 'build'))).toBe(false);
    }
    expect(runtimeRequests).toEqual([]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('registry-backed devices, advanced scenarios and invalid edits are validated before copy', async ({ page }) => {
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/create/');
  await page.getByLabel('Device type').selectOption('tmp105');
  await page.getByLabel('Device id').fill('room');
  await page.getByLabel('Initial Temperature (C)').fill('21');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  let config = ProjectCreatorConfigSchema.parse(JSON.parse(await page.getByLabel('Project JSON', { exact: true }).inputValue()));
  expect(config.manifest.inputs.room.temperatureC).toBe(21);
  expect(config.manifest.buses[0].sda).toBe(21);
  expect(config.manifest.devices[0]).toMatchObject({ id: 'room', address: 72 });
  await expect(page.getByLabel('I2C address')).toHaveValue('73');

  await page.getByLabel('Device type').selectOption('ws2812b');
  await expect(page.getByLabel('GPIO pin').locator('option[value="21"]')).toHaveCount(0);
  await expect(page.getByLabel('GPIO pin').locator('option[value="34"]')).toHaveCount(0);
  await page.getByLabel('LED count').fill('8');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  config = ProjectCreatorConfigSchema.parse(JSON.parse(await page.getByLabel('Project JSON', { exact: true }).inputValue()));
  expect(config.manifest.devices[1]).toMatchObject({ type: 'ws2812b', length: 8 });
  config.manifest.scenarios.push({ deviceId: 'room', channel: 'temperatureC', kind: 'sine', offset: 21, amplitude: 5, periodMs: 1000, seed: 42, frames: [] });
  await page.getByText('Edit the circuit as JSON', { exact: true }).click();
  await page.getByLabel('Circuit JSON', { exact: true }).fill(JSON.stringify(config.manifest));
  const valid = await page.getByLabel('Project JSON', { exact: true }).inputValue();
  expect(ProjectCreatorConfigSchema.parse(JSON.parse(valid)).manifest.scenarios).toEqual(config.manifest.scenarios);

  await page.getByLabel('Circuit JSON', { exact: true }).fill('{');
  await expect(page.getByRole('button', { name: 'Copy JSON', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Project JSON', { exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Circuit JSON', { exact: true }).fill(JSON.stringify(config.manifest));
  await page.getByRole('button', { name: 'Remove room', exact: true }).click();
  config = ProjectCreatorConfigSchema.parse(JSON.parse(await page.getByLabel('Project JSON', { exact: true }).inputValue()));
  expect(config.manifest.inputs).toEqual({});
  expect(config.manifest.scenarios).toEqual([]);
  await page.getByLabel('Starter', { exact: true }).selectOption('blinky');
  await page.getByRole('button', { name: 'Remove status_led', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy JSON', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Blinky requires');
});

test('creator restores an invalid draft, renames devices, undoes removal and reopens a download', async ({ page }) => {
  const errors: string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',entry=>{if(entry.type()==='error')errors.push(entry.text());});
  await page.goto('/create');
  await page.getByLabel('Device id').fill('room-alarm');
  expect(await page.getByLabel('Device id').evaluate((element:HTMLInputElement)=>element.checkValidity())).toBe(true);
  await page.getByRole('button',{name:'Add device',exact:true}).click();
  await page.getByRole('button',{name:'Edit room-alarm'}).click();
  await page.getByLabel('Device id').fill('alarm');
  await page.getByRole('button',{name:'Save device'}).click();
  await page.getByRole('button',{name:'Remove alarm'}).click();
  await page.getByRole('button',{name:'Undo'}).click();
  await expect(page.getByRole('button',{name:'Edit alarm'})).toBeVisible();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download JSON'}).click();
  const configuration=await (await download).path();
  await page.getByText('Edit the circuit as JSON',{exact:true}).click();
  await page.getByLabel('Circuit JSON',{exact:true}).fill('{');
  await page.reload();
  await expect(page.getByRole('button',{name:'Edit alarm'})).toBeDisabled();
  await page.getByText('Edit the circuit as JSON',{exact:true}).click();
  await expect(page.getByLabel('Circuit JSON',{exact:true})).toHaveValue('{');
  await page.getByLabel('Open project configuration').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{')});
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Circuit JSON',{exact:true})).toHaveValue('{');
  await page.getByLabel('Open project configuration').setInputFiles(configuration!);
  await expect(page.getByRole('button',{name:'Edit alarm'})).toBeEnabled();
  page.once('dialog',dialog=>void dialog.dismiss());
  await page.getByLabel('Starter',{exact:true}).selectOption('demo');
  await expect(page.getByLabel('Starter',{exact:true})).toHaveValue('empty');
  await expect(page.getByRole('button',{name:'Edit alarm'})).toBeVisible();
  expect(errors).toEqual([]);
});

test('copy failure selects the JSON for manual copying and the creator fits mobile screens', async ({ page },info) => {
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Clipboard denied'); } } });
  });
  await page.goto('/create');
  await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Clipboard denied');
  const selected = await page.getByLabel('Project JSON', { exact: true }).evaluate(element => {
    const textarea = element as HTMLTextAreaElement;
    return textarea.selectionEnd - textarea.selectionStart === textarea.value.length;
  });
  expect(selected).toBe(true);
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Copy JSON', exact: true })).toBeEnabled();
    await page.screenshot({path:info.outputPath(`creator-${width}.png`),fullPage:true});
  }
  expect(errors).toEqual([]);
});

test('web creator offers registry polarity defaults rather than fixed UI assumptions',async({page})=>{
  await page.goto('/create');
  await page.getByLabel('Device type').selectOption('button');
  await expect(page.getByLabel('Active low',{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'Add device',exact:true}).click();
  const config=ProjectCreatorConfigSchema.parse(JSON.parse(await page.getByLabel('Project JSON',{exact:true}).inputValue()));
  expect(config.manifest.devices[0]).toMatchObject({type:'button',activeLow:true});
  await page.getByLabel('Device type').selectOption('switch');
  await expect(page.getByLabel('Active low',{exact:true})).not.toBeChecked();
  await page.getByLabel('Device type').selectOption('a3144');
  await expect(page.getByLabel('Active low',{exact:true})).toBeChecked();
  await page.getByLabel('Device type').selectOption('ky_038');
  await expect(page.getByLabel('Active low',{exact:true})).not.toBeChecked();
});

test('moving or removing a shared probe preserves the driving switch', async ({ page }) => {
  await page.goto('/create');
  const circuit = { v: 1, target: 'esp32', devices: [{ type: 'switch', id: 'toggle', pin: 27 }, { type: 'probe', id: 'observe', pin: 27 }], gpioInputs: [{ pin: 27, level: 1 }] };
  await page.getByLabel('Open project configuration').setInputFiles({ name: 'shared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ v: 1, starter: 'empty', manifest: circuit })) });
  const project = async () => ProjectCreatorConfigSchema.parse(JSON.parse(await page.getByLabel('Project JSON', { exact: true }).inputValue())).manifest;
  await page.getByRole('button', { name: 'Edit observe' }).click();
  const editor = page.getByRole('region', { name: 'Edit observe' });
  await editor.getByLabel('GPIO pin').selectOption('26');
  await editor.getByRole('button', { name: 'Save device' }).click();
  expect((await project()).devices.find(device => device.id === 'observe')).toMatchObject({ pin: 26 });
  expect((await project()).gpioInputs).toEqual(circuit.gpioInputs);
  await page.getByRole('button', { name: 'Edit observe' }).click();
  await editor.getByLabel('GPIO pin').selectOption('27');
  await editor.getByRole('button', { name: 'Save device' }).click();
  await page.getByRole('button', { name: 'Remove observe' }).click();
  expect((await project()).gpioInputs).toEqual(circuit.gpioInputs);
});

test('drafts at the size limit survive reload and oversized edits leave them intact', async ({ page }) => {
  await page.goto('/create');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await page.getByText('Edit the circuit as JSON', { exact: true }).click();
  const field = page.getByLabel('Circuit JSON', { exact: true });
  const valid = await field.inputValue();
  const limit = 1024 * 1024;
  await field.fill(valid.padEnd(limit));
  expect((await field.inputValue()).length).toBe(limit);
  await field.fill(valid.padEnd(limit + 1));
  await expect(page.getByRole('alert')).toContainText('previous draft is unchanged');
  expect((await field.inputValue()).length).toBe(limit);
  await page.reload();
  await page.getByText('Edit the circuit as JSON', { exact: true }).click();
  expect((await field.inputValue()).length).toBe(limit);
  await expect(page.getByRole('button', { name: 'Edit led_1' })).toBeVisible();
});

test('demo device removal cannot export a configuration that breaks bundled firmware',async({page})=>{
  await page.goto('/create');
  await page.getByLabel('Starter',{exact:true}).selectOption('demo');
  await page.getByRole('button',{name:'Remove status_led',exact:true}).click();
  await expect(page.getByRole('button',{name:'Copy JSON',exact:true})).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('The bundled demo needs status_led');
  await expect(page.getByLabel('Project JSON',{exact:true})).toHaveValue('');
});

test('web creator exports matrix wiring with distinct free output pins',async({page},info)=>{
  await page.goto('/create');
  await page.getByLabel('Device type').selectOption('max7219');
  await expect(page.getByLabel('Active low',{exact:true})).toHaveCount(0);
  for(const signal of ['DIN','CLK','LOAD'])await expect(page.getByLabel(`${signal} GPIO`).locator('option[value="34"]')).toHaveCount(0);
  await page.getByLabel('Device id').fill('display');
  await page.getByLabel('Module count').fill('4');
  await page.getByLabel('LED color').selectOption('amber');
  await page.getByRole('button',{name:'Add device',exact:true}).click();
  const config=ProjectCreatorConfigSchema.parse(JSON.parse(await page.getByLabel('Project JSON',{exact:true}).inputValue()));
  const device=config.manifest.devices[0];
  expect(device.type).toBe('max7219');
  if(device.type!=='max7219')throw new Error('Expected MAX7219 creator output');
  expect(device).toMatchObject({id:'display',length:4,color:'amber',activeLow:false});
  expect(new Set([device.din,device.clk,device.load]).size).toBe(3);
  await expect(page.getByLabel('DIN GPIO').locator(`option[value="${device.din}"]`)).toHaveCount(0);
  await page.getByLabel('Device type').selectOption('led');
  for(const pin of [device.din,device.clk,device.load])await expect(page.getByLabel('GPIO pin').locator(`option[value="${pin}"]`)).toHaveCount(0);
  for(const width of [1440,375,320]){
    await page.setViewportSize({width,height:812});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`matrix-creator-${width}.png`),fullPage:true});
  }
});

test('espemu new --web lets the page pick the project name and location like a new-project wizard', async ({ page }, info) => {
  const parent = mkdtempSync(join(tmpdir(), 'espemu-web-e2e-'));
  mkdirSync(join(parent, 'workspace', 'boards'), { recursive: true });
  const location = realpathSync(parent);
  const { spawn } = await import('node:child_process');
  const child = spawn('bash', [resolve('tools/setup-project.sh'), '--web'], { cwd: parent, env: { ...process.env, ESPEMU_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(done => child.on('exit', done));
  try {
    await expect.poll(() => /http:\/\/127\.0\.0\.1:\d+\/create#session=[0-9a-f]+/.exec(output)?.[0], { timeout: 60000 }).toBeTruthy();
    page.on('dialog', dialog => void dialog.accept());
    await page.goto(/http:\/\/127\.0\.0\.1:\d+\/create#session=[0-9a-f]+/.exec(output)![0]);
    const card = page.getByRole('region', { name: 'New project' });
    const finish = page.getByRole('region', { name: 'Create project' });
    await expect(card.getByLabel('Project name')).toHaveValue('my_project');
    await expect(card.locator('[data-project-path]')).toHaveText(`Creates ${join(location, 'my_project')}`);
    await card.getByLabel('Project name').fill('../bad');
    await expect(card.getByRole('alert')).toContainText('project name');
    await expect(finish.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await card.getByLabel('Project name').fill('web_blinky');
    await card.getByLabel('Use default location').uncheck();
    await card.getByRole('button', { name: 'Browse…' }).click();
    const picker = page.getByRole('dialog', { name: 'Choose project location' });
    await expect(picker.getByLabel('Folder path')).toHaveValue(location);
    await picker.getByRole('button', { name: 'workspace' }).click();
    await expect(picker.getByLabel('Folder path')).toHaveValue(join(location, 'workspace'));
    await expect(picker.getByRole('button', { name: 'boards' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('web-picker-desktop.png') });
    await picker.getByRole('button', { name: 'Use this folder' }).click();
    await expect(picker).toBeHidden();
    await expect(card.getByLabel('Location', { exact: true })).toHaveValue(join(location, 'workspace'));
    await expect(card.locator('[data-project-path]')).toHaveText(`Creates ${join(location, 'workspace', 'web_blinky')}`);
    await page.getByLabel('Starter').selectOption('blinky');
    expect(existsSync(join(location, 'workspace', 'web_blinky'))).toBe(false);
    await page.screenshot({ path: info.outputPath('web-setup-desktop.png'), fullPage: true });
    const devices = await page.getByRole('heading', { name: 'Devices' }).boundingBox();
    const button = await finish.getByRole('button', { name: 'Create project' }).boundingBox();
    expect(button!.y).toBeGreaterThan(devices!.y);
    await expect(page.getByRole('button', { name: 'Copy JSON' })).toHaveCount(0);
    await expect(finish).toContainText(`Creates ${join(location, 'workspace', 'web_blinky')}`);
    await finish.getByRole('button', { name: 'Create project' }).click();
    await expect(finish.getByRole('status')).toContainText(join(location, 'workspace', 'web_blinky'));
    expect(await exited).toBe(0);
    expect(readFileSync(join(location, 'workspace', 'web_blinky', 'main/main.c'), 'utf8')).toMatch(/BLINK_INTERVAL_MS 500/);
    expect(output).toMatch(/Created .*web_blinky/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('web-setup-mobile.png'), fullPage: true });
  } finally { child.kill(); rmSync(parent, { recursive: true, force: true }); }
});

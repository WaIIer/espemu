import { test, expect } from '@playwright/test';
import type { ProjectState } from '../shared/runtime';

test('real firmware matrix pixels, daisy chain modes and lifecycle render without fabricated readings', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const single = page.getByRole('article', { name: 'Single matrix peripheral' });
  const chain = page.getByRole('article', { name: 'Matrix chain peripheral' });
  await expect(single.locator('svg')).toHaveAttribute('data-status', 'active');
  await expect(single.locator('circle[data-row="0"][data-column="0"]')).toHaveAttribute('data-on', 'true');
  await expect(single.locator('circle[data-row="0"][data-column="1"]')).toHaveAttribute('data-on', 'false');
  await expect(single.locator('circle[data-row="0"][data-column="7"]')).toHaveAttribute('data-on', 'true');
  await expect(single).toContainText('DIN GPIO23');
  await expect(single).toContainText('Intensity 15/15');
  const far = chain.locator('[data-module="1"]');
  await expect(far.locator('svg')).toHaveAttribute('data-status', 'display test');
  await expect(far.locator('circle[data-on="true"]')).toHaveCount(64);
  await expect(far).toContainText('Intensity 15/15');
  await page.getByRole('button', { name: 'pause', exact: true }).click();
  await expect(page.locator('.phase')).toHaveText('paused');
  const before = await (await page.request.get('/api/state')).json() as ProjectState;
  await page.waitForTimeout(250);
  const paused = await (await page.request.get('/api/state')).json() as ProjectState;
  expect(paused.max7219).toEqual(before.max7219);
  expect(paused.latest).toBeNull();
  await page.getByRole('button', { name: 'run', exact: true }).click();
  await expect(far.locator('svg')).toHaveAttribute('data-status', 'shutdown');
  await expect(far.locator('circle[data-on="true"]')).toHaveCount(0);
  await expect(chain.locator('[data-module="0"] svg')).toHaveAttribute('data-status', 'active');
  await page.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(page.locator('.phase')).toHaveText('paused');
  await expect(single.locator('svg')).toHaveAttribute('data-status', 'shutdown');
  await page.getByRole('button', { name: 'run', exact: true }).click();
  await expect(single.locator('svg')).toHaveAttribute('data-status', 'active');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export circuit', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('espemu.json');
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(single).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`matrix-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

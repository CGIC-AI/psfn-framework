import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    root: resolve(import.meta.dirname, '..'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Reading fixture did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); });

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`preserves reading position during streaming at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/companion-ui/e2e/fixtures/mobile-reading.html`);
    const log = page.getByRole('log');
    await expect(log).toBeVisible();
    await expect.poll(() => log.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
    await log.evaluate(node => { node.scrollTop = 120; });
    await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next token' }).click();
    await expect(page.getByRole('button', { name: 'New messages · Jump to latest' })).toBeVisible();
    expect(await log.evaluate(node => node.scrollTop)).toBe(120);
    await page.getByRole('button', { name: 'Switch view' }).click();
    await page.getByRole('button', { name: 'Next token' }).click();
    await page.getByRole('button', { name: 'Switch view' }).click();
    expect(await log.evaluate(node => node.scrollTop)).toBe(120);
    await page.getByRole('button', { name: 'New messages · Jump to latest' }).click();
    await expect.poll(() => log.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('retains a browser installation invitation until Settings opens', async ({ page }) => {
  await page.goto(`${origin}/companion-ui/e2e/fixtures/mobile-reading.html`);
  await expect(page.getByRole('log')).toBeVisible();
  await page.evaluate(() => {
    const invitation = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => { document.documentElement.dataset.installPrompted = 'true'; },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    window.dispatchEvent(invitation);
  });
  expect(await page.evaluate(() => document.documentElement.dataset.installPrompted)).toBeUndefined();
  await page.getByRole('button', { name: 'Installation', exact: true }).click();
  await page.getByRole('button', { name: 'Install PSFN Chat' }).click();
  await expect(page.getByRole('status')).toContainText('Installation dismissed');
  expect(await page.evaluate(() => document.documentElement.dataset.installPrompted)).toBe('true');
});

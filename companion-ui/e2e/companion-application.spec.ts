import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { humanoidModel } from '../src/lib/avatar/model-fixture.js';

const CANOPY = '11111111-1111-4111-8111-111111111111';
const MEADOW = '22222222-2222-4222-8222-222222222222';
const pathFor = (id: string) => `/companion-ui/companions/${id}/ws`;
let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({ root: resolve(import.meta.dirname, '..'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Companion application fixture did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

async function attachCluster(page: Page) {
  const sockets = new Map<string, WebSocketRoute>();
  const frames: Array<{ companionId: string; resource: string; body: unknown }> = [];
  let signedIn = true;
  let displayStateBinding = 'a'.repeat(64);
  await page.route('**/v1/fleet-auth/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown;
    switch (pathname) {
      case '/v1/fleet-auth/session/status':
        body = signedIn ? { schemaVersion: 1, state: 'signed_in', displayStateBinding, guestMode: 'disabled', websocketPath: pathFor(CANOPY), human: { provider: 'discord', label: 'Partner', role: 'owner' } }
          : { schemaVersion: 1, state: 'signed_out', guestMode: 'disabled' };
        break;
      case '/v1/fleet-auth/session/csrf': body = { csrfToken: 'c'.repeat(43) }; break;
      case '/v1/fleet-auth/session/refresh': body = { csrfToken: 'c'.repeat(43), principalStatus: 'active', idleExpiresAt: new Date(Date.now() + 3600_000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 7200_000).toISOString() }; break;
      case '/v1/fleet-auth/companions': body = { schemaVersion: 1, companions: [
        { companionId: CANOPY, displayName: 'Canopy', websocketPath: pathFor(CANOPY) },
        { companionId: MEADOW, displayName: 'Meadow', websocketPath: pathFor(MEADOW) },
      ] }; break;
      case '/v1/fleet-auth/approvals': body = { schemaVersion: 1, approvals: [] }; break;
      case '/v1/fleet-auth/logout':
        signedIn = false;
        await route.fulfill({ status: 204, headers: { 'Cache-Control': 'no-store' } });
        return;
      default: throw new Error(`Unexpected cluster request: ${pathname}`);
    }
    await route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } });
  });
  await page.routeWebSocket('**/companion-ui/companions/*/ws', socket => {
    const companionId = new URL(socket.url()).pathname.split('/')[3]!;
    sockets.set(companionId, socket);
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'session.configure') {
        socket.send(JSON.stringify({ schemaVersion: 1, type: 'session.ready', device: { id: 'shared-display', label: 'Shared display' },
          capabilities: ['text', 'audio_output', 'touch'], telemetryScopes: ['status', 'approvals'], eventCapabilities: ['approvals.v2'] }));
        return;
      }
      frames.push({ companionId, resource: frame.resource, body: frame.body });
      let result: unknown;
      switch (frame.resource) {
        case 'shards.list': result = []; break;
        case 'conversation.interact': result = { content: `Reply from ${companionId === CANOPY ? 'Canopy' : 'Meadow'}: ${frame.body.content}`, channelId: `fixture-${companionId}`, inputTokens: 1, outputTokens: 1 }; break;
        case 'conversation.interrupt': result = { interrupted: true, interactionId: frame.body.interactionId }; break;
        case 'embodiment.status': result = { generation: 0, version: 0, primaryPresent: false, currentDeviceIsPrimary: false, lastDecision: null }; break;
        case 'embodiment.handoff': result = { generation: 1, version: 1, primaryPresent: true, currentDeviceIsPrimary: true, lastDecision: { decision: 'handoff', reason: 'user_requested', decidedAt: new Date().toISOString() } }; break;
        default: return;
      }
      socket.send(JSON.stringify({ schemaVersion: 1, type: 'result', requestId: frame.requestId, ok: true, result }));
    });
  });
  await page.goto(`${origin}/companion-ui/`);
  await expect(page.getByLabel('Message your companion', { exact: true })).toBeEnabled();
  return { sockets, frames, switchAccount: () => { displayStateBinding = 'b'.repeat(64); } };
}

async function selectCompanion(page: Page, label: string) {
  await page.getByRole('button', { name: 'Choose a companion', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^Talk to ${label}`) }).click();
  await expect(page.getByLabel('Message your companion', { exact: true })).toBeEnabled();
}

test('routes chat and restores drafts by companion while approvals remain visible in avatar mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { sockets, frames } = await attachCluster(page);
  const composer = page.getByLabel('Message your companion', { exact: true });
  await composer.fill('Canopy draft');
  await selectCompanion(page, 'Meadow');
  await expect(composer).toHaveValue('');
  await composer.fill('Meadow message');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Reply from Meadow: Meadow message', { exact: true })).toBeVisible();
  expect(frames.find(frame => frame.resource === 'conversation.interact')).toEqual({ companionId: MEADOW, resource: 'conversation.interact', body: { content: 'Meadow message' } });
  await selectCompanion(page, 'Canopy');
  await expect(composer).toHaveValue('Canopy draft');
  await page.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Canopy', exact: true })).toBeVisible();
  sockets.get(CANOPY)!.send(JSON.stringify({ schemaVersion: 1, type: 'event', event: { type: 'approval.requested', data: {
    id: 'approval-browser', title: 'Review a document', requestedAt: new Date().toISOString(), redactedContext: 'A bounded request', status: 'pending',
    sourceSystem: 'tool-access', attribution: { parentId: CANOPY, parentLabel: 'Canopy' }, action: 'read', scope: 'workspace', reason: 'Review requested', grantMode: { kind: 'once' },
  } } }));
  await expect(page.getByText('Review a document', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('avatar-approval.png') });
});

test('loads a local VRM for one companion and clears it for another companion and logout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await attachCluster(page);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: '3D model', exact: true }).click();
  await page.getByLabel('Choose a VRM or GLB model').setInputFiles({ name: 'canopy.vrm', mimeType: 'model/gltf-binary', buffer: Buffer.from(humanoidModel('1')) });
  await expect(page.getByText('canopy.vrm', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await page.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset view', exact: true })).toBeEnabled();
  await expect(page.getByRole('img', { name: /Canopy local 3D model/ })).toBeVisible();
  await page.getByRole('button', { name: 'Thread', exact: true }).click();
  await selectCompanion(page, 'Meadow');
  await page.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Meadow', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset view', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByLabel('Partner authority')).toContainText('Signed out');
  await expect(page.locator('canvas.vrm-avatar-canvas')).toHaveCount(0);
  await expect(page.getByLabel('Message your companion', { exact: true })).toHaveValue('');
});

test('claims primary embodiment only after an explicit device handoff', async ({ page }) => {
  const { frames } = await attachCluster(page);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByText('No device is currently the primary embodiment.', { exact: true })).toBeVisible();
  expect(frames.some(frame => frame.resource === 'embodiment.handoff')).toBe(false);
  await page.getByRole('button', { name: 'Use this device as primary', exact: true }).click();
  await expect(page.getByText('This device is the primary embodiment.', { exact: true })).toBeVisible();
  expect(frames.find(frame => frame.resource === 'embodiment.handoff')).toEqual({
    companionId: CANOPY, resource: 'embodiment.handoff', body: { expectedGeneration: 0, decisionId: expect.any(String), reason: 'user_requested' },
  });
});

for (const boundary of ['companion selection', 'socket loss', 'approval polling'] as const) {
  test(`clears another tab’s same-label account state on ${boundary}`, async ({ page }) => {
    const { switchAccount, sockets } = await attachCluster(page);
    await page.getByLabel('Message your companion', { exact: true }).fill('Previous Partner private draft');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Animated sprite', exact: true }).click();
    await page.getByRole('button', { name: 'Close Settings' }).click();
    if (boundary === 'approval polling') await page.clock.install();
    switchAccount();
    if (boundary === 'companion selection') await selectCompanion(page, 'Meadow');
    else if (boundary === 'socket loss') sockets.get(CANOPY)!.close({ code: 4401, reason: 'Authority changed' });
    else await page.clock.runFor(5000);
    await expect(page.getByLabel('Message your companion', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Message your companion', { exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'No avatar', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Partner authority')).toContainText('Partner');
  });
}

test('uses selected local sprite artwork only for its companion', async ({ page }) => {
  await attachCluster(page);
  const names = ['manifest.json', 'expr-mini.png', 'expr-avatar.png', 'tool.png', 'touch.png'];
  const files = await Promise.all(names.map(async name => ({ name,
    mimeType: name.endsWith('.json') ? 'application/json' : 'image/png',
    buffer: await readFile(resolve(import.meta.dirname, '../public/sprites', name)),
  })));
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Animated sprite', exact: true }).click();
  await page.getByLabel('Choose sprite pack files').setInputFiles(files);
  await expect(page.getByRole('button', { name: 'Use default artwork', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await page.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.locator('.avatar-view .sprite-image')).toHaveCSS('background-image', /blob:/);
  await page.getByRole('button', { name: 'Thread', exact: true }).click();
  await selectCompanion(page, 'Meadow');
  await page.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.locator('.avatar-view .sprite-image')).toHaveCount(0);
  await page.getByRole('button', { name: 'Thread', exact: true }).click();
  await selectCompanion(page, 'Canopy');
  await page.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.locator('.avatar-view .sprite-image')).toHaveCSS('background-image', /blob:/);
});

test('offers Stop for a typed spoken reply and keeps the chat when synthesis fails', async ({ page }) => {
  const { sockets, frames } = await attachCluster(page);
  await page.getByLabel('Message your companion', { exact: true }).fill('Tell me a story');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Reply from Canopy: Tell me a story', { exact: true })).toBeVisible();
  const socket = sockets.get(CANOPY)!;
  const emit = (event: unknown) => socket.send(JSON.stringify({ schemaVersion: 1, type: 'event', event }));
  const wav = Buffer.alloc(44 + 16000 * 2 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  emit({ type: 'text', data: 'audio-init' });
  emit({ type: 'audio', data: wav.toString('base64') });
  emit({ type: 'text', data: 'audio-end' });
  await page.getByRole('button', { name: 'Stop voice playback', exact: true }).click();
  expect(frames.some(frame => frame.resource === 'conversation.interrupt')).toBe(true);
  emit({ type: 'error-event', data: { message: 'A provider failure', scope: 'speech' } });
  await expect(page.getByText('Spoken reply unavailable. The text reply is still available in chat.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message your companion', { exact: true })).toBeEnabled();
  await page.waitForTimeout(750);
  await expect(page.getByText('Reply from Canopy: Tell me a story', { exact: true })).toBeVisible();
  expect(sockets.get(CANOPY)).toBe(socket);
});

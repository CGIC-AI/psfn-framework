import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// Only the external provider is a wire-protocol fixture. Browser requests,
// cookies, WebSockets, gateway, agent, Garden and Postgres are real services.
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const SOCKET_PATH = `/companion-ui/companions/${COMPANION_ID}/ws`;
const UNKNOWN_SOCKET_PATH = '/companion-ui/companions/22222222-2222-4222-8222-222222222222/ws';
const adminToken = process.env.ADMIN_TOKEN;
const gardenBase = process.env.PSFN_SMOKE_GARDEN_BASE;
if (!adminToken || !gardenBase || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(gardenBase)) {
  throw new Error('Runtime browser tests require disposable Garden and administrator credentials');
}

interface Reply {
  content: string;
  channelId: string;
}
interface DurableTurn {
  record: {
    turnId: string;
    requestId: string;
    status: string;
    userMessage: { content: string };
    assistantMessage: { content: string };
  };
}

async function sessionStatus(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(async () => {
    const response = await fetch('/v1/fleet-auth/session/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Session status returned ${response.status}`);
    return await response.json() as Record<string, unknown>;
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/fleet/login');
  await page.getByLabel('Administrator token').fill(adminToken!);
  await page.getByRole('button', { name: 'Login with administrator token' }).click();
  await expect(page).toHaveURL(/\/fleet\/?$/u);
  await page.goto('/companion-ui/');
  await expect(page.getByLabel('Connection ready', { exact: true })).toBeVisible();
  expect(await sessionStatus(page)).toMatchObject({
    state: 'signed_in', guestMode: 'disabled', websocketPath: SOCKET_PATH,
    human: { provider: 'admin_token', role: 'owner' },
  });
}

async function durableTurn(channelId: string, message: string): Promise<DurableTurn | undefined> {
  const response = await fetch(`${gardenBase}/api/admin/sessions/${encodeURIComponent(channelId)}`, {
    headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  const session = await response.json() as { turns: DurableTurn[] };
  return session.turns.find(turn => turn.record.userMessage.content === message);
}

async function socketOutcome(page: Page, path: string, sendAction = false): Promise<unknown> {
  return await page.evaluate(({ path, sendAction }) => new Promise(resolve => {
    const socket = new WebSocket(`${location.origin.replace(/^http/u, 'ws')}${path}`);
    const timer = setTimeout(() => finish({ kind: 'timeout' }), 10_000);
    function finish(value: unknown) {
      clearTimeout(timer);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      resolve(value);
    }
    socket.onopen = () => {
      if (!sendAction) return finish({ kind: 'opened' });
      socket.send(JSON.stringify({ schemaVersion: 1, type: 'session.configure', eventCapabilities: ['approvals.v2'] }));
    };
    socket.onerror = () => finish({ kind: 'denied' });
    socket.onclose = event => finish({ kind: 'closed', code: event.code });
    socket.onmessage = event => {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type === 'session.ready') {
        socket.send(JSON.stringify({
          schemaVersion: 1, requestId: 'smoke-unknown-companion',
          action: 'companion.interact', resource: 'conversation.interact',
          body: { content: 'This unknown companion must not receive a turn.' },
        }));
      } else if (frame.type === 'result') finish({ kind: 'result', frame });
    };
  }), { path, sendAction });
}

test('key owner receives a real reply, verifies durable storage after reload, then clears browser authority', async ({ page, context }, testInfo) => {
  const message = `Browser durability probe ${randomUUID()}. Please acknowledge this message.`;
  const requests = new Set<string>();
  const replies: Reply[] = [];
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const frame = JSON.parse(payload) as { resource?: string; requestId: string; body?: { content?: string } };
      if (frame.resource === 'conversation.interact' && frame.body?.content === message) requests.add(frame.requestId);
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const frame = JSON.parse(payload) as { type?: string; requestId: string; ok?: boolean; result?: Reply };
      if (frame.type === 'result' && requests.has(frame.requestId) && frame.ok && frame.result) replies.push(frame.result);
    });
  });
  await signIn(page);
  const authCookie = (await context.cookies()).find(cookie => cookie.name === 'psfn_token');
  expect(authCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
  await page.getByRole('textbox', { name: 'Message your companion' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => replies.length, { timeout: 30_000 }).toBe(1);
  const reply = replies[0]!;
  expect(reply.content.length).toBeGreaterThan(0);
  await expect(page.getByRole('log').getByText(reply.content, { exact: true })).toBeVisible();
  await expect.poll(async () => (await durableTurn(reply.channelId, message))?.record.status).toBe('completed');
  const beforeReload = (await durableTurn(reply.channelId, message))!.record;
  expect(beforeReload.assistantMessage.content).toBe(reply.content);

  // The current browser has no transcript hydration API. This checks reconnect
  // plus durable server data; it deliberately makes no UI-history-restored claim.
  await page.reload();
  await expect(page.getByLabel('Connection ready', { exact: true })).toBeVisible();
  expect((await durableTurn(reply.channelId, message))?.record).toEqual(beforeReload);
  await page.getByRole('textbox', { name: 'Message your companion' }).fill('Unsent private draft');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect.poll(() => sessionStatus(page)).toMatchObject({ state: 'signed_out', guestMode: 'disabled' });
  expect((await context.cookies()).some(cookie => cookie.name === 'psfn_token')).toBe(false);
  await expect(page.getByRole('textbox', { name: 'Message your companion' })).toHaveValue('');
  await expect(page.getByRole('log')).not.toContainText(reply.content);
  expect(await socketOutcome(page, SOCKET_PATH)).toEqual({ kind: 'denied' });
  await testInfo.attach('durable-browser-turn.json', {
    body: JSON.stringify({
      turnId: beforeReload.turnId, requestId: beforeReload.requestId,
      responseHash: createHash('sha256').update(reply.content).digest('hex'),
      durableRereadAfterReload: true, logoutDeniedNewSocket: true,
    }, null, 2), contentType: 'application/json',
  });
});

test('signed-out browsers cannot borrow key authority and an unknown companion cannot receive a turn', async ({ page, browser }) => {
  await signIn(page);
  const unsigned = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const other = await unsigned.newPage();
    await other.goto(`${process.env.PSFN_SMOKE_FLEET_ORIGIN}/companion-ui/`);
    expect(await sessionStatus(other)).toMatchObject({ state: 'signed_out', guestMode: 'disabled' });
    expect(await socketOutcome(other, SOCKET_PATH)).toEqual({ kind: 'denied' });
    const unknown = await socketOutcome(page, UNKNOWN_SOCKET_PATH, true);
    expect(unknown).toMatchObject({ kind: 'result', frame: { ok: false } });
  } finally {
    await unsigned.close();
  }
});

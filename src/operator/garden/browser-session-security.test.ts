import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromPartial } from '@total-typescript/shoehorn';
import { GardenOperatorSurface } from './operator-surface.js';
import { AdminServer } from './server.js';
import { GardenAdminTransportServer } from './transport-server.js';
import { EventBus } from '../../shared/event-bus.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { getRecentDiagnosticLogRecords } from '../../shared/logger.js';

const running: Lifecycle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of running.splice(0).reverse()) await server.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function surface(host = '127.0.0.1', port = 0, proxy = false) {
  return new GardenOperatorSurface({
    port, host, token: 'invented-standalone-operator-secret',
    ...(proxy ? { publicOrigin: 'https://garden.example.test', trustedProxyAddresses: ['127.0.0.1'] } : {}),
    config: fromPartial<SubstrateConfig>({ characterName: 'Juniper' }),
    transportEndpoint: { mode: 'socket', socketPath: '/tmp/invented-garden-security-test.sock', timeoutMs: 1000 },
  });
}

async function listen(kind: 'operator' | 'admin' = 'operator', trustedProxyAddresses = ['127.0.0.1']) {
  const allocator = http.createServer();
  await new Promise<void>(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const address = allocator.address();
  if (!address || typeof address === 'string') throw new Error('No test listener address');
  const port = address.port;
  await new Promise<void>(resolve => allocator.close(() => resolve()));
  const config = fromPartial<SubstrateConfig>({ characterName: 'Juniper' });
  const eventBus = new EventBus();
  const services = fromPartial<GardenAdminDomainServices>({});
  const shared = { port, host: '127.0.0.1', token: 'invented-standalone-operator-secret',
    publicOrigin: 'https://garden.example.test', trustedProxyAddresses, config };
  const directory = mkdtempSync(join(tmpdir(), 'garden-security-'));
  directories.push(directory);
  const socketPath = join(directory, 'garden.sock');
  const backend = new GardenAdminTransportServer({ config, eventBus, services,
    endpoint: { mode: 'socket', socketPath } });
  await backend.start();
  backend.markRuntimeReady();
  running.push(backend);
  const server = kind === 'operator'
    ? new GardenOperatorSurface({ ...shared, transportEndpoint: { mode: 'socket', socketPath, timeoutMs: 1000 } })
    : new AdminServer({ ...shared, eventBus, services });
  await server.init();
  await server.start();
  running.push(server);
  return port;
}

function upgrade(port: number, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/admin/events`, {
      headers: { Host: 'garden.example.test', 'X-Forwarded-Proto': 'https', ...headers },
    });
    ws.once('open', () => { ws.terminate(); resolve(101); });
    ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); });
    ws.once('error', reject);
  });
}

function request(port: number, method: string, path: string, body = '', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path,
      headers: { Host: 'garden.example.test', 'X-Forwarded-Proto': 'https', ...headers } }, res => {
      let data = '';
      res.on('data', chunk => { data += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function login(port: number) {
  const page = await request(port, 'GET', '/login');
  const proof = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
  const challengeCookie = page.headers['set-cookie']!.map(value => value.split(';')[0]).join('; ');
  const response = await request(port, 'POST', '/login', new URLSearchParams({
    token: 'invented-standalone-operator-secret', csrf: proof,
  }).toString(), { Cookie: challengeCookie, Origin: 'https://garden.example.test' });
  expect(response.status).toBe(302);
  const cookies = response.headers['set-cookie']!;
  return {
    cookie: cookies.map(value => value.split(';')[0]).join('; '),
    csrf: /^__Host-psfn_csrf=([^;]+)/.exec(cookies.find(value => value.startsWith('__Host-psfn_csrf='))!)![1]!,
  };
}

describe('standalone Garden browser security through real listeners', () => {
  it('keeps browser challenges and authority at their issuing listener, requiring one replica per origin', async () => {
    const issuer = await listen();
    const other = await listen();
    const session = await login(issuer);
    expect(await upgrade(issuer, { Cookie: session.cookie, Origin: 'https://garden.example.test' })).toBe(101);
    expect((await request(other, 'GET', '/', '', { Cookie: session.cookie })).status).toBe(401);
    expect(await upgrade(other, { Cookie: session.cookie, Origin: 'https://garden.example.test' })).toBe(403);

    const challenge = await request(issuer, 'GET', '/login');
    const proof = /name="csrf" value="([^"]+)"/.exec(challenge.body)![1]!;
    const cookie = challenge.headers['set-cookie']!.map(value => value.split(';')[0]).join('; ');
    const crossListenerLogin = await request(other, 'POST', '/login', new URLSearchParams({
      token: 'invented-standalone-operator-secret', csrf: proof,
    }).toString(), { Cookie: cookie, Origin: 'https://garden.example.test' });
    expect(crossListenerLogin.status).toBe(403);
    expect(crossListenerLogin.headers['set-cookie']).toBeUndefined();
  });

  it('refuses token-authenticated plaintext on a non-loopback listener', async () => {
    const server = surface('0.0.0.0');
    // Register only a listener that actually started so the RED run cleans up.
    const start = server.start().then(() => { running.push(server); });
    await expect(start).rejects.toThrow(/TLS|HTTPS|trusted proxy/i);
  });

  it('exchanges a login challenge and token for a secure opaque session', async () => {
    const port = await listen();
    const page = await request(port, 'GET', '/login');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = page.headers['set-cookie']!.map(value => value.split(';')[0]).join('; ');
    const login = await request(port, 'POST', '/login', new URLSearchParams({
      token: 'invented-standalone-operator-secret', csrf: csrf!,
    }).toString(), { Cookie: cookie, Origin: 'https://garden.example.test' });
    expect(login.status).toBe(302);
    expect(login.headers['set-cookie']?.join('\n')).not.toContain('invented-standalone-operator-secret');
    expect(login.headers['set-cookie']).toContainEqual(expect.stringMatching(/^__Host-psfn_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=900;/));
  });

  it('rejects an unsafe cookie-authenticated request without CSRF proof', async () => {
    const port = await listen();
    const session = await login(port);
    const response = await request(port, 'POST', '/api/admin/logout', '', {
      Cookie: session.cookie, Origin: 'https://garden.example.test',
    });
    expect(response.status).toBe(403);
  });

  it.each(['operator', 'admin'] as const)('%s rejects same-site sibling WebSocket Origins even with a valid session', async kind => {
    const port = await listen(kind);
    const session = await login(port);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://sibling.example.test' })).toBe(403);
  });

  it('sets browser security headers on the login response', async () => {
    const port = await listen();
    const response = await request(port, 'GET', '/login');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it.each(['operator', 'admin'] as const)('%s admits only the exact proxy Origin and Host and preserves bearer automation', async kind => {
    const port = await listen(kind);
    const session = await login(port);
    for (const origin of ['https://hostile.invalid', 'https://sibling.example.test', 'http://garden.example.test', 'null', 'https://garden.example.test.attacker.invalid']) {
      expect(await upgrade(port, { Cookie: session.cookie, Origin: origin })).toBe(403);
    }
    expect(await upgrade(port, { Cookie: session.cookie })).toBe(403);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://garden.example.test', Host: 'sibling.example.test', 'X-Forwarded-Host': 'garden.example.test' })).toBe(403);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://garden.example.test', 'X-Forwarded-Proto': 'http' })).toBe(403);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://garden.example.test' })).toBe(101);
    expect(await upgrade(port, { Authorization: 'Bearer invented-standalone-operator-secret' })).toBe(101);
    expect((await request(port, 'POST', '/api/admin/logout', '', {
      Authorization: 'Bearer invented-standalone-operator-secret',
    })).status).toBe(200);
  });

  it.each(['operator', 'admin'] as const)('%s invalidates rotated, logged-out, and expired sessions on HTTP and WebSocket', async kind => {
    const port = await listen(kind);
    const old = await login(port);
    const rotated = await request(port, 'POST', '/login', new URLSearchParams({
      token: 'invented-standalone-operator-secret', csrf: old.csrf,
    }).toString(), { Cookie: old.cookie, Origin: 'https://garden.example.test' });
    expect(rotated.status).toBe(302);
    expect(await upgrade(port, { Cookie: old.cookie, Origin: 'https://garden.example.test' })).toBe(403);
    const session = await login(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/admin/events`, {
      headers: { Host: 'garden.example.test', 'X-Forwarded-Proto': 'https', Cookie: session.cookie, Origin: 'https://garden.example.test' },
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<void>(resolve => { ws.once('close', () => resolve()); });
    const logout = await request(port, 'POST', '/api/admin/logout', '', {
      Cookie: session.cookie, Origin: 'https://garden.example.test', 'X-CSRF-Token': session.csrf,
    });
    expect(logout.status).toBe(200);
    await closed;
    expect((await request(port, 'GET', '/', '', { Cookie: session.cookie })).status).toBe(401);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://garden.example.test' })).toBe(403);
    const expiring = await login(port);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 901_000);
    expect((await request(port, 'GET', '/', '', { Cookie: expiring.cookie })).status).toBe(401);
    expect(await upgrade(port, { Cookie: expiring.cookie, Origin: 'https://garden.example.test' })).toBe(403);
  });

  it('admits configured proxy networks and ignores forwarded peer claims from an untrusted socket', async () => {
    const trusted = await listen('operator', ['127.0.0.0/24']);
    expect((await request(trusted, 'GET', '/login')).status).toBe(200);
    const untrusted = await listen('operator', ['192.0.2.0/24']);
    const response = await request(untrusted, 'GET', '/login', '', {
      'X-Forwarded-For': '192.0.2.1', Forwarded: 'for=192.0.2.1;proto=https;host=garden.example.test',
    });
    expect(response.status).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('bounds login challenges without evicting active operators and reclaims expired entries', async () => {
    const port = await listen('admin');
    const session = await login(port);
    for (let index = 0; index < 1023; index++) {
      expect((await request(port, 'GET', '/login')).status).toBe(200);
    }
    expect((await request(port, 'GET', '/login')).status).toBe(503);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://garden.example.test' })).toBe(101);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 301_000);
    expect((await request(port, 'GET', '/login')).status).toBe(200);
    expect(await upgrade(port, { Cookie: session.cookie, Origin: 'https://garden.example.test' })).toBe(101);
  });

  it('completes the browser exchange through an actual certificate-validated TLS proxy', async () => {
    const port = await listen();
    const directory = mkdtempSync(join(tmpdir(), 'garden-test-tls-'));
    directories.push(directory);
    const keyPath = join(directory, 'proxy.key');
    const certPath = join(directory, 'proxy.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=garden.example.test', '-addext', 'subjectAltName=DNS:garden.example.test',
      '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    const cert = readFileSync(certPath);
    const proxy = https.createServer({ key: readFileSync(keyPath), cert, minVersion: 'TLSv1.3' }, (req, res) => {
      const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method, path: req.url,
        headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      });
      upstream.on('error', error => res.destroy(error));
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    running.push(fromPartial<Lifecycle>({ stop: async () => {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    } }));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('No TLS proxy address');
    const throughTls = (method: string, body = '', cookie?: string) => new Promise<{
      status: number; body: string; headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = https.request({ hostname: '127.0.0.1', port: address.port, ca: cert,
        servername: 'garden.example.test', method, path: '/login',
        headers: { Host: 'garden.example.test', Origin: 'https://garden.example.test', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
        let data = '';
        res.on('data', chunk => { data += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
    const page = await throughTls('GET');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const challenge = page.headers['set-cookie']!.map(value => value.split(';')[0]).join('; ');
    const response = await throughTls('POST', new URLSearchParams({
      token: 'invented-standalone-operator-secret', csrf,
    }).toString(), challenge);
    expect(response.status).toBe(302);
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['set-cookie']![0]).toContain('; Secure; HttpOnly; SameSite=Strict;');
  });

  it('does not record admin tokens, session identifiers, or CSRF proofs in diagnostic logs', async () => {
    const port = await listen();
    const session = await login(port);
    await request(port, 'POST', '/api/admin/logout', '', { Cookie: session.cookie, Origin: 'https://hostile.invalid' });
    await upgrade(port, { Cookie: session.cookie, Origin: 'https://sibling.example.test' });
    const logs = JSON.stringify(getRecentDiagnosticLogRecords());
    for (const value of ['invented-standalone-operator-secret', session.csrf,
      ...session.cookie.split('; ').map(cookie => cookie.split('=')[1]!)]) {
      expect(logs).not.toContain(value);
    }
  });

  it('expires the previous raw-token cookie when a browser returns over the secure proxy', async () => {
    const port = await listen();
    const response = await request(port, 'GET', '/login', '', {
      Cookie: 'psfn_token=invented-standalone-operator-secret',
    });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toContainEqual(expect.stringMatching(/^psfn_token=;.*Max-Age=0;/));
    expect(response.headers['set-cookie']?.join('\n')).not.toContain('invented-standalone-operator-secret');
  });

  it('authorizes the served SPA bootstrap by hash while retaining the WSS and no-store policy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'garden-csp-spa-'));
    directories.push(directory);
    mkdirSync(join(directory, 'admin-ui', 'build'), { recursive: true });
    writeFileSync(join(directory, 'admin-ui', 'build', 'index.html'),
      '<!doctype html><html><body><script>window.gardenBootstrap = true;</script></body></html>');
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const port = await listen();
    const session = await login(port);
    const response = await request(port, 'GET', '/', '', { Cookie: session.cookie });
    expect(response.status).toBe(200);
    expect(response.body).toContain('window.gardenBootstrap = true;');
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' 'sha256-ATZBZQ5zh/75Y6trr1cZvJnkMHavciBj0LDSyj9CJVo='");
    expect(csp).toContain("connect-src 'self' wss://garden.example.test");
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

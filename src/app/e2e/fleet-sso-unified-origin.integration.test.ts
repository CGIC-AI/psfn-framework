import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import {
  digestGardenRouteAuthorization,
  validateGardenRequestMetadata,
} from '../../boundary/fleet-auth/request-capability-target.js';
import { GatewayFleetSsoRouter } from '../../boundary/gateway/fleet-sso-router.js';
import type { FleetAuthorizationContext } from '../../boundary/gateway/fleet-authorization-context.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { isRecord } from '../../shared/utils/types.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const SESSION_A = 'a'.repeat(43);
const SESSION_B = 'b'.repeat(43);
const CANONICAL_ORIGIN = 'https://fleet.example.test';
const NOW_SECONDS = 1_783_000_000;
const WORKLOAD_SOURCE = `
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
let hits = 0;
const server = createServer((request, response) => {
  if (request.url === '/__test_hits') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ hits, pid: process.pid }));
    return;
  }
  hits += 1;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    marker: readFileSync('same-name.txt', 'utf8'),
    path: request.url,
    pid: process.pid,
    hits,
    forwarded: {
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      capability: request.headers['x-psfn-request-capability'],
      requestId: request.headers['x-psfn-capability-request-id'],
      decisionId: request.headers['x-psfn-capability-decision'],
    },
  }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: address.port, pid: process.pid }) + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function context(
  companionId: string,
  action: FleetAuthorizationContext['authorization']['action'],
): FleetAuthorizationContext {
  return Object.freeze({
    principalId: companionId === COMPANION_A
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    providerSubject: Object.freeze({ provider: 'discord', subjectId: `subject-${companionId}` }),
    companionId,
    contact: Object.freeze({
      bindingId: randomUUID(),
      contactId: randomUUID(),
      bindingVersion: 1,
    }),
    operator: Object.freeze({ grantId: randomUUID(), role: 'owner', grantVersion: 1 }),
    session: Object.freeze({
      recordId: randomUUID(),
      audience: 'fleet',
      assurance: 'oauth',
      authnVersion: 1,
      authzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
      provider: 'discord',
      providerSubjectId: `subject-${companionId}`,
    }),
    authorization: Object.freeze({ action, decision: 'allow' }),
    authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
    provenance: Object.freeze({
      source: 'gateway_fleet_authorization_snapshot',
      authorizationEventId: randomUUID(),
      resolvedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
    }),
  });
}

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    return address.port;
  });
}

async function spawnWorkload(marker: string): Promise<{
  child: ChildProcess;
  port: number;
  pid: number;
  root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-sso-workload-'));
  writeFileSync(join(root, 'same-name.txt'), marker, 'utf8');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', WORKLOAD_SOURCE], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startup = await Promise.race([
    once(child.stdout!, 'data').then(([chunk]) => JSON.parse(String(chunk)) as {
      port: number;
      pid: number;
    }),
    once(child, 'exit').then(([code]) => {
      throw new Error(`fleet workload exited before listen: ${String(code)}`);
    }),
  ]);
  return { child, root, ...startup };
}

function getHitCount(port: number): Promise<{ hits: number; pid: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/__test_hits' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    request.once('error', reject);
    request.end();
  });
}

function get(port: number, path: string, session: string): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path,
      headers: {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_session=${session}`,
        authorization: 'Bearer browser-credential-must-not-cross',
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('unified Fleet SSO two-companion process boundary', () => {
  const servers: Server[] = [];
  const children: ChildProcess[] = [];
  const workloadRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    }));
    for (const root of workloadRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('routes identical relative resources only to the authorized companion and stops after revocation', async () => {
    const workloadA = await spawnWorkload('workspace-a/same-name.txt');
    const workloadB = await spawnWorkload('workspace-b/same-name.txt');
    children.push(workloadA.child, workloadB.child);
    workloadRoots.push(workloadA.root, workloadB.root);
    const companionUiHits: IncomingHttpHeaders[] = [];
    const companionUi = createServer((request, response) => {
      companionUiHits.push({ ...request.headers });
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<main>companion-ui:${request.url}</main>`);
    });
    servers.push(companionUi);
    const companionUiPort = await listen(companionUi);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const notBefore = new Date((NOW_SECONDS - 60) * 1_000).toISOString();
    const notAfter = new Date((NOW_SECONDS + 3_600) * 1_000).toISOString();
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-sso-e2e',
      kid: 'e2e-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => NOW_SECONDS,
    });
    const verifier = createRequestCapabilityVerifier({
      issuer: 'fleet-sso-e2e',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-sso-e2e',
        kid: 'e2e-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore,
        notAfter,
        status: 'active',
      }],
    });
    let revokedA = false;
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin: CANONICAL_ORIGIN,
      trustProxy: true,
      upstreams: [
        { companionId: COMPANION_A, origin: new URL(`http://127.0.0.1:${workloadA.port}`) },
        { companionId: COMPANION_B, origin: new URL(`http://127.0.0.1:${workloadB.port}`) },
      ],
      companionUi: {
        companionId: COMPANION_A,
        origin: new URL(`http://127.0.0.1:${companionUiPort}`),
      },
      broker: {
        resolveAuthorizationContext: async (input: unknown) => {
          if (!isRecord(input) || typeof input.sessionToken !== 'string'
            || typeof input.companionId !== 'string' || typeof input.action !== 'string') {
            throw new Error('denied');
          }
          const expected = input.sessionToken === SESSION_A ? COMPANION_A
            : input.sessionToken === SESSION_B ? COMPANION_B : undefined;
          if (!expected || expected !== input.companionId || (revokedA && expected === COMPANION_A)) {
            throw new Error('denied');
          }
          return context(
            expected,
            input.action as FleetAuthorizationContext['authorization']['action'],
          );
        },
      },
      signer,
      verifier,
      replay: {
        consume: async input => ({ outcome: 'consumed', result: input.consumeResult }),
      },
      portalProjection: {
        resolve: async () => ({
          schemaVersion: 1,
          generatedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
          session: { state: 'authenticated' },
          companions: [],
        }),
      },
      nowSeconds: () => NOW_SECONDS,
    });
    const edge = createServer((request, response) => { void router.handle(request, response); });
    servers.push(edge);
    const edgePort = await listen(edge);

    const resourcePath = '/api/admin/dashboard';
    const responseA = await get(
      edgePort,
      `/companions/${COMPANION_A}/garden${resourcePath}`,
      SESSION_A,
    );
    expect(responseA.status).toBe(200);
    const payloadA = JSON.parse(responseA.body);
    expect(payloadA).toEqual(expect.objectContaining({
      marker: 'workspace-a/same-name.txt',
      path: resourcePath,
      pid: workloadA.pid,
      hits: 1,
    }));
    expect(workloadA.pid).not.toBe(workloadB.pid);
    expect(payloadA.forwarded.cookie).toBeUndefined();
    expect(payloadA.forwarded.authorization).toBeUndefined();
    expect(payloadA.forwarded.capability).toBeTypeOf('string');

    const metadata = validateGardenRequestMetadata({ rawTarget: resourcePath, method: 'GET' });
    expect(() => verifier.verifyOperatorTransport({
      token: String(payloadA.forwarded.capability),
      companionId: COMPANION_A,
      method: metadata.method,
      canonicalRequestTarget: metadata.canonicalRequestTarget,
      action: metadata.action,
      authorizationDigest: digestGardenRouteAuthorization(metadata.authorization),
      bodyLength: 0,
      requestId: String(payloadA.forwarded.requestId),
      decisionId: String(payloadA.forwarded.decisionId),
      nowSeconds: NOW_SECONDS,
    })).not.toThrow();

    const crossRead = await get(
      edgePort,
      `/companions/${COMPANION_B}/garden${resourcePath}`,
      SESSION_A,
    );
    expect(crossRead.status).toBe(404);
    expect(await getHitCount(workloadB.port)).toEqual({ hits: 0, pid: workloadB.pid });

    const responseB = await get(
      edgePort,
      `/companions/${COMPANION_B}/garden${resourcePath}`,
      SESSION_B,
    );
    expect(responseB.status).toBe(200);
    expect(JSON.parse(responseB.body)).toEqual(expect.objectContaining({
      marker: 'workspace-b/same-name.txt',
      path: resourcePath,
      pid: workloadB.pid,
      hits: 1,
    }));

    const companionUiA = await get(edgePort, '/companion-ui/app.js?v=1', SESSION_A);
    expect(companionUiA.status).toBe(200);
    expect(companionUiA.body).toBe('<main>companion-ui:/companion-ui/app.js?v=1</main>');
    expect(companionUiHits).toHaveLength(1);
    expect(companionUiHits[0]!.cookie).toBeUndefined();
    expect(companionUiHits[0]!.authorization).toBeUndefined();
    expect(companionUiHits[0]!['x-psfn-request-capability']).toBeUndefined();

    const companionUiB = await get(edgePort, '/companion-ui/app.js?v=1', SESSION_B);
    expect(companionUiB.status).toBe(404);
    expect(companionUiHits).toHaveLength(1);

    revokedA = true;
    const revoked = await get(
      edgePort,
      `/companions/${COMPANION_A}/garden${resourcePath}`,
      SESSION_A,
    );
    expect(revoked.status).toBe(404);
    expect(await getHitCount(workloadA.port)).toEqual({ hits: 1, pid: workloadA.pid });
  });
});

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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import { compileGatewayGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import { parseGardenCapabilityContext } from '../../boundary/fleet-auth/garden-capability-context.js';
import { GatewayFleetSsoRouter } from '../../boundary/gateway/fleet-sso-router.js';
import {
  FleetAuthorizationDeniedError,
  type FleetAuthorizationContext,
} from '../../boundary/gateway/fleet-authorization-context.js';
import { GatewayFleetPortalProjection } from '../../boundary/gateway/fleet-portal-projection.js';
import { fleetAuthRoleAllowsAction } from '../../boundary/fleet-auth/role-action-policy.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  privacyBreakGlassPurpose,
  privacyBreakGlassSubjectScopeDigest,
} from '../../shared/contracts/privacy-break-glass.js';
import { isRecord } from '../../shared/utils/types.js';
import type { FleetAuthRole } from '../../system/config/fleet-auth-config.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const COMPANION_C = createCompanionId('33333333-3333-4333-8333-333333333333');
const COMPANION_D = createCompanionId('44444444-4444-4444-8444-444444444444');
const UNKNOWN_COMPANION = createCompanionId('55555555-5555-4555-8555-555555555555');
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
      context: request.headers['x-psfn-capability-context'],
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
  role: FleetAuthRole = 'owner',
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
    operator: Object.freeze({ grantId: randomUUID(), role, grantVersion: 1 }),
    session: Object.freeze({
      recordId: companionId === COMPANION_A
        ? 'aaaaaaaa-0000-4000-8000-000000000001'
        : 'bbbbbbbb-0000-4000-8000-000000000001',
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

function get(
  port: number,
  path: string,
  session: string,
  headerOverrides: IncomingHttpHeaders = {},
): Promise<{
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
        ...headerOverrides,
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

function post(
  port: number,
  path: string,
  session: string,
  body: string,
  headerOverrides: IncomingHttpHeaders = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_session=${session}`,
        origin: CANONICAL_ORIGIN,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
        ...headerOverrides,
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
    request.end(body);
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
    const consumeGrant = vi.fn(async () => ({
      grantId: '99999999-9999-4999-8999-999999999999',
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      browserSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      assurance: 'webauthn_uv' as const,
      credentialFloorGeneration: 2,
      expiresAt: new Date((NOW_SECONDS + 300) * 1_000),
    }));
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
      jitStepUp: { consumeGrant },
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

    const revealBody = JSON.stringify({
      subjectScopeDigest: 'a'.repeat(64),
      purpose: 'Review my own memory',
      memoryRevision: 3,
      classifierVersion: 1,
      classifierEvidenceDigest: 'b'.repeat(64),
    });
    const revealPath = '/api/admin/memory/memory-a/reveal';
    const reveal = await post(
      edgePort,
      `/companions/${COMPANION_A}/garden${revealPath}`,
      SESSION_A,
      revealBody,
      { 'x-psfn-jit-grant': '99999999-9999-4999-8999-999999999999' },
    );
    expect(reveal.status).toBe(200);
    expect(consumeGrant).toHaveBeenCalledWith(expect.objectContaining({
      grantId: '99999999-9999-4999-8999-999999999999',
      token: SESSION_A,
      requestOrigin: CANONICAL_ORIGIN,
      binding: expect.objectContaining({
        subjectScopeDigest: 'a'.repeat(64),
        purpose: 'Review my own memory',
        memoryRevision: 3,
        classifierEvidenceDigest: 'b'.repeat(64),
      }),
    }));
    const revealPayload = JSON.parse(reveal.body);
    const revealContext = parseGardenCapabilityContext(
      String(revealPayload.forwarded.context),
      COMPANION_A,
    );
    const revealedCapability = verifier.verifyOperator({
      token: String(revealPayload.forwarded.capability),
      target: compileGatewayGardenRequestTarget({
        rawTarget: revealPath,
        method: 'POST',
        companionId: COMPANION_A,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(revealBody),
      }),
      requestId: revealContext.requestId,
      decisionId: revealContext.decisionId,
      versions: revealContext.versions,
      nowSeconds: NOW_SECONDS,
    });
    expect(revealedCapability.authContext.sessionAssurance).toBe('webauthn_uv');

    const missingGrant = await post(
      edgePort,
      `/companions/${COMPANION_A}/garden${revealPath}`,
      SESSION_A,
      revealBody,
    );
    expect(missingGrant.status).toBe(404);
    expect(consumeGrant).toHaveBeenCalledTimes(1);

    const breakGlassRequest = {
      reasonCategory: 'incident_response' as const,
      reason: 'Contain an active account compromise.',
    };
    const breakGlassConfirmBody = JSON.stringify(breakGlassRequest);
    const breakGlassConfirmPath =
      '/api/admin/privacy-break-glass/memory/memory-private-b/confirm';
    const ownerWithoutUv = await post(
      edgePort,
      `/companions/${COMPANION_A}/garden${breakGlassConfirmPath}`,
      SESSION_A,
      breakGlassConfirmBody,
    );
    expect(ownerWithoutUv.status).toBe(404);

    const breakGlassConfirm = await post(
      edgePort,
      `/companions/${COMPANION_A}/garden${breakGlassConfirmPath}`,
      SESSION_A,
      breakGlassConfirmBody,
      { 'x-psfn-jit-grant': '99999999-9999-4999-8999-999999999999' },
    );
    expect(breakGlassConfirm.status).toBe(200);
    expect(consumeGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      grantId: '99999999-9999-4999-8999-999999999999',
      token: SESSION_A,
      requestOrigin: CANONICAL_ORIGIN,
      binding: expect.objectContaining({
        subjectScopeDigest: privacyBreakGlassSubjectScopeDigest({
          companionId: COMPANION_A,
          action: 'privacy.break_glass',
          routeId: 'POST /api/admin/privacy-break-glass/memory/:id/confirm',
          resourceKind: 'memory',
          resourceId: 'memory-private-b',
        }),
        purpose: privacyBreakGlassPurpose(breakGlassRequest),
        memoryRevision: 1,
      }),
    }));
    const breakGlassConfirmPayload = JSON.parse(breakGlassConfirm.body);
    const breakGlassContext = parseGardenCapabilityContext(
      String(breakGlassConfirmPayload.forwarded.context),
      COMPANION_A,
    );
    const breakGlassCapability = verifier.verifyOperator({
      token: String(breakGlassConfirmPayload.forwarded.capability),
      target: compileGatewayGardenRequestTarget({
        rawTarget: breakGlassConfirmPath,
        method: 'POST',
        companionId: COMPANION_A,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(breakGlassConfirmBody),
      }),
      requestId: breakGlassContext.requestId,
      decisionId: breakGlassContext.decisionId,
      versions: breakGlassContext.versions,
      nowSeconds: NOW_SECONDS,
    });
    expect(breakGlassCapability.authContext.sessionAssurance).toBe('break_glass');

    const breakGlassDecidePath =
      '/api/admin/privacy-break-glass/memory/memory-private-b/decide';
    const breakGlassDecideBody = JSON.stringify({
      ...breakGlassRequest,
      confirmToken: 'f'.repeat(64),
    });
    const jitOnDecision = await post(
      edgePort,
      `/companions/${COMPANION_A}/garden${breakGlassDecidePath}`,
      SESSION_A,
      breakGlassDecideBody,
      { 'x-psfn-jit-grant': '99999999-9999-4999-8999-999999999999' },
    );
    expect(jitOnDecision.status).toBe(404);
    const breakGlassDecision = await post(
      edgePort,
      `/companions/${COMPANION_A}/garden${breakGlassDecidePath}`,
      SESSION_A,
      breakGlassDecideBody,
    );
    expect(breakGlassDecision.status).toBe(200);
    expect(consumeGrant).toHaveBeenCalledTimes(2);

    const dashboardContext = parseGardenCapabilityContext(
      String(payloadA.forwarded.context),
      COMPANION_A,
    );
    expect(() => verifier.verifyOperator({
      token: String(payloadA.forwarded.capability),
      target: compileGatewayGardenRequestTarget({
        rawTarget: resourcePath,
        method: 'GET',
        companionId: COMPANION_A,
        body: Buffer.alloc(0),
      }),
      requestId: dashboardContext.requestId,
      decisionId: dashboardContext.decisionId,
      versions: dashboardContext.versions,
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

    const companionUiA = await get(edgePort, '/companion-ui/app.js', SESSION_A);
    expect(companionUiA.status).toBe(200);
    expect(companionUiA.body).toBe('<main>companion-ui:/companion-ui/app.js</main>');
    expect(companionUiHits).toHaveLength(1);
    expect(companionUiHits[0]!.cookie).toBeUndefined();
    expect(companionUiHits[0]!.authorization).toBeUndefined();
    expect(companionUiHits[0]!['x-psfn-request-capability']).toBeUndefined();

    const companionUiB = await get(edgePort, '/companion-ui/app.js', SESSION_B);
    expect(companionUiB.status).toBe(200);
    expect(companionUiHits).toHaveLength(2);
    expect(companionUiHits[1]!.cookie).toBeUndefined();

    const queryBearingShell = await get(edgePort, '/companion-ui/app.js?code=secret', SESSION_A);
    expect(queryBearingShell.status).toBe(404);
    expect(companionUiHits).toHaveLength(2);

    revokedA = true;
    const revoked = await get(
      edgePort,
      `/companions/${COMPANION_A}/garden${resourcePath}`,
      SESSION_A,
    );
    expect(revoked.status).toBe(404);
    expect(await getHitCount(workloadA.port)).toEqual({ hits: 4, pid: workloadA.pid });
  });

  it('certifies disjoint bounded projections, stateless links, and outages', async () => {
    const workloadA = await spawnWorkload('workspace-a/portal-owner');
    const workloadB = await spawnWorkload('workspace-b/portal-admin');
    children.push(workloadA.child, workloadB.child);
    workloadRoots.push(workloadA.root, workloadB.root);

    const unavailable = createServer();
    const unavailablePort = await listen(unavailable);
    await new Promise<void>((resolve, reject) => unavailable.close((error) => {
      if (error) reject(error);
      else resolve();
    }));

    const generatedAt = NOW_SECONDS * 1_000;
    const snapshot = () => ({
      generatedAt,
      connections: [
        {
          companionId: COMPANION_A,
          state: 'ready' as const,
          health: 'healthy' as const,
          stateReason: 'rpc_message_received',
          connectedAt: generatedAt - 10_000,
          lastSeenAt: generatedAt - 1_000,
        },
        {
          companionId: COMPANION_B,
          state: 'degraded' as const,
          health: 'stale' as const,
          stateReason: 'heartbeat_stale',
          connectedAt: generatedAt - 20_000,
          lastSeenAt: generatedAt - 5_000,
        },
      ],
      lastSeenByCompanionId: { [COMPANION_C]: generatedAt - 60_000 },
      recentViolationsByCompanionId: { [COMPANION_C]: 2 },
      unattributedRecentViolationCount: 1,
      recentViolationWindowMs: 3_600_000,
    });
    const fleet = [
      { companionId: COMPANION_A },
      { companionId: COMPANION_B },
      { companionId: COMPANION_C },
      { companionId: COMPANION_D },
    ];
    const grants = new Map<string, readonly { companionId: string; role: FleetAuthRole }[]>([
      [SESSION_A, [
        { companionId: COMPANION_A, role: 'owner' },
        { companionId: COMPANION_C, role: 'guest' },
      ]],
      [SESSION_B, [
        { companionId: COMPANION_B, role: 'admin' },
        { companionId: COMPANION_D, role: 'member' },
      ]],
    ]);
    const revokedSessions = new Set<string>();
    const portalProjection = new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async (input: unknown) => {
          if (!isRecord(input) || typeof input.sessionToken !== 'string') {
            throw new FleetAuthorizationDeniedError('malformed_request');
          }
          if (revokedSessions.has(input.sessionToken)) {
            throw new FleetAuthorizationDeniedError('session_revoked');
          }
          const sessionGrants = grants.get(input.sessionToken);
          if (!sessionGrants) throw new FleetAuthorizationDeniedError('session_absent');
          return {
            companions: sessionGrants.map(grant => ({
              companionId: grant.companionId,
              gardenLinkEligible: fleetAuthRoleAllowsAction(grant.role, 'garden.read'),
            })),
          };
        },
      },
      fleet,
      source: { getFleetConnectionSnapshot: snapshot },
      now: () => new Date(generatedAt),
    });

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-portal-production-e2e',
      kid: 'production-e2e-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => NOW_SECONDS,
    });
    const verifier = createRequestCapabilityVerifier({
      issuer: 'fleet-portal-production-e2e',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-portal-production-e2e',
        kid: 'production-e2e-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: new Date((NOW_SECONDS - 60) * 1_000).toISOString(),
        notAfter: new Date((NOW_SECONDS + 3_600) * 1_000).toISOString(),
        status: 'active',
      }],
    });
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin: CANONICAL_ORIGIN,
      trustProxy: true,
      upstreams: [
        { companionId: COMPANION_A, origin: new URL(`http://127.0.0.1:${workloadA.port}`) },
        { companionId: COMPANION_B, origin: new URL(`http://127.0.0.1:${workloadB.port}`) },
        { companionId: COMPANION_C, origin: new URL(`http://127.0.0.1:${unavailablePort}`) },
      ],
      broker: {
        resolveAuthorizationContext: async (input: unknown) => {
          if (!isRecord(input) || typeof input.sessionToken !== 'string'
            || typeof input.companionId !== 'string' || typeof input.action !== 'string') {
            throw new Error('denied');
          }
          const role = grants.get(input.sessionToken)
            ?.find(grant => grant.companionId === input.companionId)?.role;
          if (!role || revokedSessions.has(input.sessionToken)) throw new Error('denied');
          return context(
            input.companionId,
            input.action as FleetAuthorizationContext['authorization']['action'],
            role,
          );
        },
      },
      signer,
      verifier,
      replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
      portalProjection,
      nowSeconds: () => NOW_SECONDS,
    });
    const edge = createServer((request, response) => { void router.handle(request, response); });
    servers.push(edge);
    const edgePort = await listen(edge);

    const ownerPortal = await get(edgePort, '/v1/fleet/portal', SESSION_A);
    expect(ownerPortal.status).toBe(200);
    expect(JSON.parse(ownerPortal.body)).toMatchObject({
      companions: [
        {
          companionId: COMPANION_A,
          availability: 'online',
          gardenPath: `/companions/${COMPANION_A}/garden`,
        },
      ],
    });
    expect(JSON.parse(ownerPortal.body).companions).toHaveLength(1);
    expect(ownerPortal.body).not.toContain(COMPANION_B);
    expect(ownerPortal.body).not.toContain(COMPANION_D);
    expect(ownerPortal.body).not.toMatch(/gardenPort|stateReason|violation/u);

    const adminPortal = await get(edgePort, '/v1/fleet/portal', SESSION_B);
    expect(adminPortal.status).toBe(200);
    expect(JSON.parse(adminPortal.body)).toMatchObject({
      companions: [
        {
          companionId: COMPANION_B,
          availability: 'degraded',
          gardenPath: `/companions/${COMPANION_B}/garden`,
        },
      ],
    });
    expect(JSON.parse(adminPortal.body).companions).toHaveLength(1);
    expect(adminPortal.body).not.toContain(COMPANION_A);
    expect(adminPortal.body).not.toContain(COMPANION_C);

    const ownerGardenPath = `/companions/${COMPANION_A}/garden/api/admin/dashboard`;
    const adminGardenPath = `/companions/${COMPANION_B}/garden/api/admin/dashboard`;
    expect((await get(edgePort, ownerGardenPath, SESSION_A)).status).toBe(200);
    expect((await get(edgePort, adminGardenPath, SESSION_B)).status).toBe(200);

    const unauthorized = await get(edgePort, adminGardenPath, SESSION_A);
    const unknown = await get(
      edgePort,
      `/companions/${UNKNOWN_COMPANION}/garden/api/admin/dashboard`,
      SESSION_A,
    );
    expect({ status: unauthorized.status, body: unauthorized.body }).toEqual({
      status: unknown.status,
      body: unknown.body,
    });
    expect(await getHitCount(workloadB.port)).toEqual({ hits: 1, pid: workloadB.pid });

    const spoofedHost = await get(edgePort, '/fleet', SESSION_A, {
      'x-forwarded-host': 'attacker.example.test',
    });
    expect(spoofedHost.status).toBe(400);

    revokedSessions.add(SESSION_A);
    const revokedNavigation = await get(edgePort, ownerGardenPath, SESSION_A);
    expect(revokedNavigation.status).toBe(404);
    expect(await getHitCount(workloadA.port)).toEqual({ hits: 1, pid: workloadA.pid });

    const publicRawAttempt = await get(edgePort, '/fleet/status.json', SESSION_B);
    expect(publicRawAttempt.status).toBe(404);
    expect(publicRawAttempt.body).not.toMatch(/gardenPort|recentViolationWindowMs/u);
  });
});

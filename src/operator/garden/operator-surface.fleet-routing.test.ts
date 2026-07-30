import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  compileGatewayGardenRequestTarget,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
  type RequestCapabilityParentBinding,
} from '../../boundary/fleet-auth/request-capability.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  buildGardenCapabilityHeaders,
} from './garden-admission.js';
import { AtomicRequestCapabilityReplayPort } from './atomic-request-capability-replay.js';
import { FleetGardenControlPlane } from './fleet-garden-control-plane.js';
import { FleetGardenDirectDatabase } from './fleet-garden-direct-database.js';
import { FleetGardenTargetRegistry } from './fleet-garden-target-registry.js';
import type { FleetGardenDirectDatabaseServices } from './local-admin-contract.js';
import {
  GardenOperatorSurface,
  type FleetGardenTransportProxyPort,
} from './operator-surface.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const VERSIONS: RequestCapabilityAuthorityVersions = Object.freeze({
  authorityGeneration: 2,
  globalAuthEpoch: 3,
  sessionAuthnVersion: 5,
  sessionAuthzVersion: 7,
  bindingVersion: 11,
  grantVersion: 13,
  policyVersion: 17,
});
const keyPair = generateKeyPairSync('ed25519');
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const verifierConfig = {
  issuer: 'fleet-auth',
  maxTtlSeconds: 30,
  keys: [{
    issuer: 'fleet-auth',
    kid: 'active',
    publicKeyPem,
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2040-01-01T00:00:00.000Z',
    status: 'active' as const,
  }],
};

function signedRequest(companionId: typeof COMPANION_A, jti: string): IncomingMessage {
  return signedRequestForTarget(companionId, jti, '/api/admin/dashboard');
}

function signedRequestForTarget(
  companionId: typeof COMPANION_A,
  jti: string,
  innerTarget: string,
  options: {
    method?: 'GET' | 'PATCH' | 'POST';
    body?: Buffer;
    provider?: 'discord' | 'testing_harness';
  } = {},
): IncomingMessage {
  const method = options.method ?? 'GET';
  const body = options.body ?? Buffer.alloc(0);
  const target = compileGatewayGardenRequestTarget({
    rawTarget: innerTarget,
    method,
    companionId,
    body,
  });
  const requestId = `aaaaaaaa-aaaa-4aaa-8aaa-${jti.padEnd(12, '0').slice(0, 12)}`;
  const decisionId = `bbbbbbbb-bbbb-4bbb-8bbb-${jti.padEnd(12, '0').slice(0, 12)}`;
  const capabilitySigner = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active',
    privateKeyPem,
    ttlSeconds: 30,
    generateJti: () => jti,
  });
  const capabilityInput = {
    target,
    requestId,
    decisionId,
    authContext: {
      principalId: options.provider === 'testing_harness' ? 'testing-harness' : 'principal-1',
      provider: options.provider ?? 'discord',
      providerSubjectId: options.provider === 'testing_harness'
        ? 'testing-harness'
        : '12345678901234567',
      companionId,
      contactBindingId: 'binding-1',
      contactId: 'contact-1',
      operatorGrantId: 'grant-1',
      role: 'admin',
      sessionRecordId: 'session-1',
      sessionAssurance: 'oauth' as const,
      fleetAccessMode: 'multi_admin' as const,
      authorizationEventId: 'event-1',
      resolvedAt: '2030-01-01T00:00:00.000Z',
    },
    versions: VERSIONS,
  };
  const token = options.provider === 'testing_harness'
    ? capabilitySigner.signTestingHarness(capabilityInput)
    : capabilitySigner.signOperator(capabilityInput);
  const request = Readable.from(body.byteLength > 0 ? [body] : []) as IncomingMessage;
  request.method = method;
  request.url = `/companions/${companionId}/garden${innerTarget}`;
  request.headers = {
    ...buildGardenCapabilityHeaders({
      token,
      context: { requestId, decisionId, versions: VERSIONS },
    }),
    'content-length': String(body.byteLength),
    ...(body.byteLength > 0 ? { 'content-type': 'application/json' } : {}),
  };
  return request;
}

function config(): SubstrateConfig {
  return {
    multiCompanion: true,
    companionId: COMPANION_A,
    companionFleet: {
      persistenceRoot: '/runtime',
      workspacesRoot: '/runtime/workspaces',
      sharedWorkspacePath: '/runtime/workspaces/shared',
      companions: [COMPANION_A, COMPANION_B].map(companionId => ({
        companionId,
        companionDataDir: `/runtime/companions/${companionId}`,
        characterCardPath: `/runtime/companions/${companionId}/companion.json`,
        personalWorkspacePath: `/runtime/workspaces/personal/${companionId}`,
        postgresSchema: companionId === COMPANION_A ? 'companion_a' : 'companion_b',
      })),
    },
    fleetAuthVerifier: { requestCapabilities: verifierConfig } as SubstrateConfig['fleetAuthVerifier'],
  } as SubstrateConfig;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition never became true');
}

class CapturingResponse {
  status = 0;
  body = '';

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

interface RoutedFleetRequest {
  companionId: string;
  requestPath: string;
  body: Buffer;
}

function createFleetProxySurface(
  routed: RoutedFleetRequest[],
  providerIdentities: unknown[] = [],
): GardenOperatorSurface {
  const registry = new FleetGardenTargetRegistry([{
    companionId: COMPANION_A,
    endpoint: { mode: 'socket', socketPath: '/run/admin-a.sock', timeoutMs: 1_000 },
  }]);
  const controlPlane = new FleetGardenControlPlane({
    registry,
    verifier: createRequestCapabilityVerifier(verifierConfig),
    replay: new AtomicRequestCapabilityReplayPort(),
    testingHarness: { enabled: true },
  });
  return new GardenOperatorSurface({
    port: 1,
    host: '127.0.0.1',
    config: config(),
    fleetControlPlane: controlPlane,
    fleetTransport: {
      close: callback => callback(),
      probeAll: async () => undefined,
      proxyBufferedApiRequest: (target, _req, _res, body, _headers, requestPath) => {
        routed.push({ companionId: target.companionId, requestPath, body });
      },
      handleTelemetryUpgrade: () => {
        throw new Error('not used');
      },
    },
    fleetChildAssertions: {
      exchange: async (input) => {
        providerIdentities.push(input.providerIdentity);
        return {
          token: `child-${input.parentVerified.jti}`,
          context: {
            requestId: input.parentVerified.requestId,
            decisionId: input.parentVerified.decisionId,
            versions: input.parentVerified.versions,
            parent: {
              audience: input.parentVerified.audience as RequestCapabilityParentBinding['audience'],
              requestId: input.parentVerified.requestId,
              decisionId: input.parentVerified.decisionId,
              jti: input.parentVerified.jti,
              targetDigest: input.parentVerified.targetDigest,
            },
          },
        };
      },
    },
  });
}

describe('GardenOperatorSurface fleet transport routing', () => {
  it.each([
    {
      label: 'wishlist',
      jti: '1',
      method: 'GET' as const,
      innerTarget: '/api/admin/wishlist',
      body: Buffer.alloc(0),
    },
    {
      label: 'concerns limit',
      jti: '2',
      method: 'GET' as const,
      innerTarget: '/api/admin/concerns?includeResolved=true&limit=100',
      body: Buffer.alloc(0),
    },
    {
      label: 'settings save',
      jti: '3',
      method: 'PATCH' as const,
      innerTarget: '/api/admin/settings',
      body: Buffer.from(JSON.stringify({ activeTimezone: 'UTC' })),
    },
    {
      label: 'settings owner-file save',
      jti: '4',
      method: 'POST' as const,
      innerTarget: '/api/admin/settings/providers',
      body: Buffer.from('configJson=%7B%22schemaVersion%22%3A1%7D'),
    },
    {
      label: 'CogSec Firewall policy',
      jti: '5',
      method: 'GET' as const,
      innerTarget: '/api/admin/intake/policy',
      body: Buffer.alloc(0),
    },
    {
      label: 'CogSec Firewall source lists',
      jti: '6',
      method: 'GET' as const,
      innerTarget: '/api/admin/intake/source-lists',
      body: Buffer.alloc(0),
    },
    {
      label: 'drift review',
      jti: '7',
      method: 'GET' as const,
      innerTarget: '/api/admin/intake/drift-reviews',
      body: Buffer.alloc(0),
    },
  ])('routes $label through the companion-scoped Fleet Garden proxy', async ({
    jti,
    method,
    innerTarget,
    body,
  }) => {
    const routed: RoutedFleetRequest[] = [];
    const surface = createFleetProxySurface(routed);
    const request = signedRequestForTarget(
      COMPANION_A,
      jti,
      innerTarget,
      { method, body },
    );

    await (
      surface as unknown as {
        handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }
    ).handleFleetRequest(request, {} as ServerResponse);

    expect(routed).toEqual([{
      companionId: COMPANION_A,
      requestPath: innerTarget,
      body,
    }]);
  });

  it('dispatches testing-harness admissions with their provider-scoped identity', async () => {
    const routed: RoutedFleetRequest[] = [];
    const providerIdentities: unknown[] = [];
    const surface = createFleetProxySurface(routed, providerIdentities);
    const request = signedRequestForTarget(
      COMPANION_A,
      '8',
      '/api/admin/settings',
      { provider: 'testing_harness' },
    );

    await (
      surface as unknown as {
        handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }
    ).handleFleetRequest(request, {} as ServerResponse);

    expect(providerIdentities).toEqual([{
      provider: 'testing_harness',
      audience: 'testing-harness',
    }]);
    expect(routed).toHaveLength(1);
  });

  it('uses fleet routing for a one-entry roster', () => {
    const oneEntryConfig = {
      ...config(),
      multiCompanion: false,
      companionFleet: {
        ...config().companionFleet!,
        companions: [config().companionFleet!.companions[0]!],
      },
    };
    const registry = new FleetGardenTargetRegistry([{
      companionId: COMPANION_A,
      endpoint: { mode: 'socket', socketPath: '/run/admin-a.sock', timeoutMs: 1_000 },
    }]);
    const surface = new GardenOperatorSurface({
      port: 1,
      host: '127.0.0.1',
      config: oneEntryConfig,
      fleetControlPlane: new FleetGardenControlPlane({
        registry,
        verifier: createRequestCapabilityVerifier(verifierConfig),
        replay: new AtomicRequestCapabilityReplayPort(),
      }),
      fleetTransport: {
        close: callback => callback(),
        probeAll: async () => undefined,
        proxyBufferedApiRequest: () => undefined,
        handleTelemetryUpgrade: () => undefined,
      },
    });

    expect(surface).toBeDefined();
  });

  it('serves approved direct-database routes in Garden with the admitted companion binding', async () => {
    const registry = new FleetGardenTargetRegistry([
      {
        companionId: COMPANION_A,
        endpoint: { mode: 'socket', socketPath: '/run/admin-a.sock', timeoutMs: 1_000 },
      },
      {
        companionId: COMPANION_B,
        endpoint: { mode: 'socket', socketPath: '/run/admin-b.sock', timeoutMs: 1_000 },
      },
    ]);
    const controlPlane = new FleetGardenControlPlane({
      registry,
      verifier: createRequestCapabilityVerifier(verifierConfig),
      replay: new AtomicRequestCapabilityReplayPort(),
    });
    const directBindings: string[] = [];
    const directDatabase = new FleetGardenDirectDatabase({
      config: {
        ...config(),
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://fleet-garden-test.invalid/psfn',
      },
      companionIds: [COMPANION_A, COMPANION_B],
      createServices: (_config, companionId) => ({
        modelUsage: {
          getModelUsageData: async () => {
            directBindings.push(companionId);
            return {};
          },
        },
        observerEvalSidecar: {
          queryObservations: async () => {
            directBindings.push(companionId);
            return {};
          },
        },
      }) as unknown as FleetGardenDirectDatabaseServices,
    });
    const surface = new GardenOperatorSurface({
      port: 1,
      host: '127.0.0.1',
      config: config(),
      fleetControlPlane: controlPlane,
      fleetTransport: {
        close: callback => callback(),
        probeAll: async () => undefined,
        proxyBufferedApiRequest: () => {
          throw new Error('direct database route must not proxy to an agent');
        },
        handleTelemetryUpgrade: () => {
          throw new Error('not used');
        },
      },
      fleetDirectDatabase: directDatabase,
      fleetChildAssertions: {
        exchange: async () => {
          throw new Error('direct database route must not exchange an agent child assertion');
        },
      },
    });

    const handleFleetRequest = (
      surface as unknown as {
        handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }
    ).handleFleetRequest.bind(surface);
    const observerResponse = new CapturingResponse();
    const modelUsageResponse = new CapturingResponse();
    await Promise.all([
      handleFleetRequest(
        signedRequestForTarget(
          COMPANION_A,
          'c',
          '/api/admin/evals/observer-sidecar/observations',
        ),
        observerResponse as unknown as ServerResponse,
      ),
      handleFleetRequest(
        signedRequestForTarget(COMPANION_B, 'd', '/api/admin/model-usage'),
        modelUsageResponse as unknown as ServerResponse,
      ),
    ]);
    await waitFor(() => observerResponse.body.length > 0 && modelUsageResponse.body.length > 0);

    expect(directBindings.sort()).toEqual([COMPANION_A, COMPANION_B].sort());
    expect(observerResponse.status).toBe(200);
    expect(modelUsageResponse.status).toBe(200);
    expect(directDatabase.handleHttp({
      admission: {
        target: { canonicalPath: '/api/admin/evals/observer-sidecar/health' },
      } as never,
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
    })).toBe(false);
  });

  it('keeps concurrent child exchanges and proxy dispatch bound to their admitted targets', async () => {
    const registry = new FleetGardenTargetRegistry([
      {
        companionId: COMPANION_A,
        endpoint: { mode: 'socket', socketPath: '/run/admin-a.sock', timeoutMs: 1_000 },
      },
      {
        companionId: COMPANION_B,
        endpoint: { mode: 'socket', socketPath: '/run/admin-b.sock', timeoutMs: 1_000 },
      },
    ]);
    registry.reportHealth(COMPANION_A, {
      status: 'unavailable',
      probedAt: '2030-01-01T00:00:00.000Z',
      reason: 'stale probe result',
    });
    registry.reportHealth(COMPANION_B, {
      status: 'ready',
      probedAt: '2030-01-01T00:00:00.000Z',
    });
    const controlPlane = new FleetGardenControlPlane({
      registry,
      verifier: createRequestCapabilityVerifier(verifierConfig),
      replay: new AtomicRequestCapabilityReplayPort(),
    });
    const pending: Array<{
      companionId: string;
      release: () => void;
    }> = [];
    const routed: Array<{ companionId: string; socketPath: string; requestPath: string }> = [];
    const fleetTransport: FleetGardenTransportProxyPort = {
      close: callback => callback(),
      probeAll: async () => controlPlane.probe(),
      proxyBufferedApiRequest: (target, _req, _res, _body, _headers, requestPath) => {
        routed.push({
          companionId: target.companionId,
          socketPath: target.endpoint.mode === 'socket' ? target.endpoint.socketPath : '',
          requestPath,
        });
      },
      handleTelemetryUpgrade: () => {
        throw new Error('not used');
      },
    };
    const surface = new GardenOperatorSurface({
      port: 1,
      host: '127.0.0.1',
      config: config(),
      fleetControlPlane: controlPlane,
      fleetTransport,
      fleetChildAssertions: {
        exchange: input => new Promise((resolve) => {
          pending.push({
            companionId: input.target.companionId,
            release: () => resolve({
              token: `child-${input.target.companionId}`,
              context: {
                requestId: input.parentVerified.requestId,
                decisionId: input.parentVerified.decisionId,
                versions: input.parentVerified.versions,
                parent: {
                  audience: input.parentVerified.audience as `operator:${string}`,
                  requestId: input.parentVerified.requestId,
                  decisionId: input.parentVerified.decisionId,
                  jti: input.parentVerified.jti,
                  targetDigest: input.parentVerified.targetDigest,
                },
              },
            }),
          });
        }),
      },
    });

    const response = {} as ServerResponse;
    const handleFleetRequest = (
      surface as unknown as {
        handleFleetRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }
    ).handleFleetRequest.bind(surface);
    const requestA = handleFleetRequest(signedRequest(COMPANION_A, 'a'), response);
    const requestB = handleFleetRequest(signedRequest(COMPANION_B, 'b'), response);
    await waitFor(() => pending.length === 2);
    pending.find(item => item.companionId === COMPANION_B)!.release();
    pending.find(item => item.companionId === COMPANION_A)!.release();
    await Promise.all([requestA, requestB]);

    expect(routed).toEqual([
      {
        companionId: COMPANION_B,
        socketPath: '/run/admin-b.sock',
        requestPath: '/api/admin/dashboard',
      },
      {
        companionId: COMPANION_A,
        socketPath: '/run/admin-a.sock',
        requestPath: '/api/admin/dashboard',
      },
    ]);
  });

  it('keeps public fleet health aggregate and non-enumerating', async () => {
    const registry = new FleetGardenTargetRegistry([{
      companionId: COMPANION_A,
      endpoint: {
        mode: 'socket',
        socketPath: '/run/private-admin-a.sock',
        timeoutMs: 1_000,
      },
    }]);
    registry.reportHealth(COMPANION_A, {
      status: 'unavailable',
      probedAt: '2030-01-01T00:00:00.000Z',
      reason: 'connect ENOENT /run/private-admin-a.sock',
    });
    const controlPlane = new FleetGardenControlPlane({
      registry,
      verifier: createRequestCapabilityVerifier(verifierConfig),
      replay: new AtomicRequestCapabilityReplayPort(),
    });
    const fleetTransport: FleetGardenTransportProxyPort = {
      close: callback => callback(),
      probeAll: async () => undefined,
      proxyBufferedApiRequest: () => {
        throw new Error('public health must not proxy a target');
      },
      handleTelemetryUpgrade: () => {
        throw new Error('public health must not upgrade a target');
      },
    };
    const surface = new GardenOperatorSurface({
      port: 1,
      host: '127.0.0.1',
      config: config(),
      fleetControlPlane: controlPlane,
      fleetTransport,
    });
    let status = 0;
    let body = '';
    const res = {
      writableEnded: false,
      destroyed: false,
      writeHead(nextStatus: number) {
        status = nextStatus;
        return this;
      },
      end(nextBody: string) {
        body = nextBody;
        this.writableEnded = true;
        return this;
      },
    } as unknown as ServerResponse;

    await (
      surface as unknown as { handleHealth(response: ServerResponse): Promise<void> }
    ).handleHealth(res);

    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({
      status: 'degraded',
      gardenDenialsLastHour: expect.any(Number),
      dependencies: { adminTransports: { status: 'unready' } },
    });
    expect(body).not.toContain(COMPANION_A);
    expect(body).not.toContain('/run/private-admin-a.sock');
  });
});

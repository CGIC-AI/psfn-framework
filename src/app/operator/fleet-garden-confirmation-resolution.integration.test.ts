/**
 * Fleet Garden resolution of gateway-owned approvals (psfn-framework-wi8z6).
 *
 * The production chain, over real loopback HTTP:
 *
 *   gateway-signed operator parent capability (as the SSO router issues it)
 *     -> GardenOperatorSurface + FleetGardenControlPlane + FleetGardenOperatorRouter
 *        with the gateway clients built by operator startup's own composition
 *     -> gateway ApiServer /v1/internal/fleet-auth/confirmations/resolve
 *     -> GatewayFleetAuthChildAssertionBroker (verify, scoped consume, reauthorize)
 *     -> GatewayFleetConfirmationResolution
 *     -> real gateway approval boundary and confirmation queue.
 *
 * Only the SSO reauthorization store (Postgres-backed in production) and the
 * per-companion agent transport (for agent-local fallthrough) are test ports.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_TOKEN_REQUEST_CAPABILITY_PRINCIPAL_ID,
  ADMIN_TOKEN_REQUEST_CAPABILITY_SUBJECT_ID,
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthContext,
  type RequestCapabilityAuthorityVersions,
} from '../../boundary/fleet-auth/request-capability.js';
import { compileGatewayGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import { compileRequestCapabilityReplayConsumption } from '../../boundary/fleet-auth/request-capability-replay.js';
import {
  GatewayFleetAuthChildAssertionBroker,
  type ChildAssertionAuthorityInput,
} from '../../boundary/gateway/fleet-auth-child-assertions.js';
import { GatewayFleetConfirmationResolution } from '../../boundary/gateway/fleet-auth-confirmation-resolution.js';
import {
  createGatewayApprovalBoundaryService,
  type ApprovalBoundaryService,
} from '../../boundary/gateway/approval-boundary.js';
import { GatewayNtfyNotifier } from '../../boundary/gateway/ntfy-notifier.js';
import { ApiServer } from '../../channels/api/server.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../core/session/manager.js';
import { EventBus } from '../../shared/event-bus.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { AtomicRequestCapabilityReplayPort } from '../../operator/garden/atomic-request-capability-replay.js';
import { InMemoryRequestCapabilityReplayPort, buildGardenCapabilityHeaders } from '../../operator/garden/garden-admission.js';
import { FleetGardenControlPlane } from '../../operator/garden/fleet-garden-control-plane.js';
import { FleetGardenTargetRegistry } from '../../operator/garden/fleet-garden-target-registry.js';
import { GardenOperatorSurface } from '../../operator/garden/operator-surface.js';
import { createOperatorGatewayClients, resolveGatewayAuthPlan } from './gateway-auth-plan.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const UNKNOWN_COMPANION = createCompanionId('55555555-5555-4555-8555-555555555555');
const CHAT_API_KEY = 'fleet-confirmation-chat-key';
const ADMIN_TOKEN = 'fleet-confirmation-admin-token';
const ISSUER = 'fleet-confirmation-e2e';
const KID = 'active';
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
const verifierConfig = {
  issuer: ISSUER,
  maxTtlSeconds: 30,
  keys: [{
    issuer: ISSUER,
    kid: KID,
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2040-01-01T00:00:00.000Z',
    status: 'active' as const,
  }],
};
const signer = createGatewayRequestCapabilitySigner({
  issuer: ISSUER,
  kid: KID,
  privateKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  ttlSeconds: 30,
});

type Actor = 'admin_token' | 'sso_admin' | 'sso_guest';

function authContext(actor: Actor, companionId: CompanionId): RequestCapabilityAuthContext {
  if (actor === 'admin_token') {
    return {
      principalId: ADMIN_TOKEN_REQUEST_CAPABILITY_PRINCIPAL_ID,
      provider: 'admin_token',
      providerSubjectId: ADMIN_TOKEN_REQUEST_CAPABILITY_SUBJECT_ID,
      companionId,
      contactBindingId: `admin-token-binding-${companionId}`,
      contactId: `admin-token-contact-${companionId}`,
      operatorGrantId: `admin-token-grant-${companionId}`,
      role: 'owner',
      sessionRecordId: `admin-token-session-${companionId}`,
      sessionAssurance: 'break_glass',
      fleetAccessMode: 'sole_admin',
      authorizationEventId: randomUUID(),
      resolvedAt: '2030-01-01T00:00:00.000Z',
    };
  }
  return {
    principalId: actor === 'sso_guest' ? 'principal-guest' : 'principal-human',
    provider: 'discord',
    providerSubjectId: '12345678901234567',
    companionId,
    contactBindingId: 'binding-1',
    contactId: 'contact-1',
    operatorGrantId: 'grant-1',
    role: actor === 'sso_guest' ? 'guest' : 'admin',
    sessionRecordId: 'session-1',
    sessionAssurance: 'oauth',
    fleetAccessMode: 'multi_admin',
    authorizationEventId: randomUUID(),
    resolvedAt: '2030-01-01T00:00:00.000Z',
  };
}

interface IssuedRequest {
  readonly companionId: CompanionId;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly parent: {
    readonly token: string;
    readonly rawTarget: string;
    readonly requestId: string;
    readonly decisionId: string;
  };
}

/**
 * Issues one operator parent exactly as the gateway SSO router does: compile
 * the canonical Garden target, sign it, and consume it in the gateway replay
 * store before forwarding it to the operator.
 */
async function issue(input: {
  readonly companionId: CompanionId;
  readonly actor: Actor;
  readonly body: unknown;
  readonly rawTarget?: string;
}): Promise<IssuedRequest> {
  const body = Buffer.from(JSON.stringify(input.body));
  const target = compileGatewayGardenRequestTarget({
    rawTarget: input.rawTarget ?? '/api/admin/confirmations/resolve',
    method: 'POST',
    companionId: input.companionId,
    body,
  });
  const requestId = randomUUID();
  const decisionId = randomUUID();
  const signInput = {
    target,
    requestId,
    decisionId,
    authContext: authContext(input.actor, input.companionId),
    versions: VERSIONS,
  };
  const token = signer.signOperator(signInput);
  const verified = verifier.verifyOperator({ token, ...signInput });
  const issued = await gatewayReplay.consume(
    compileRequestCapabilityReplayConsumption({ token, verified, target }),
  );
  expect(issued.outcome).toBe('consumed');
  return {
    companionId: input.companionId,
    body,
    headers: buildGardenCapabilityHeaders({
      token,
      context: { requestId, decisionId, versions: VERSIONS },
    }),
    parent: { token, rawTarget: target.canonicalRequestTarget, requestId, decisionId },
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        listener.close(() => reject(new Error('Failed to allocate test port')));
        return;
      }
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function post(
  port: number,
  path: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': body.byteLength,
      },
    }, (res) => {
      let text = '';
      res.on('data', chunk => { text += String(chunk); });
      res.on('end', () => {
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) as unknown : null; } catch { /* plain-text denial */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

function gardenConfig(): SubstrateConfig {
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
        postgresRole: companionId === COMPANION_A ? 'companion_a_runtime' : 'companion_b_runtime',
      })),
    },
    fleetAuthVerifier: { requestCapabilities: verifierConfig } as SubstrateConfig['fleetAuthVerifier'],
  } as SubstrateConfig;
}

function approvalBoundary(): ApprovalBoundaryService {
  return createGatewayApprovalBoundaryService({
    policyConfig: {
      workspacePath: '/workspace',
      homeAssistant: { enabled: false, hubBaseUrl: 'http://hub.test.invalid', tokenConfigured: false },
    },
    ntfyNotifier: new GatewayNtfyNotifier(),
    discordAdapter: {
      id: 'test-dock',
      outbound: { textChunkLimit: 2000, sendText: async () => {} },
    },
    confirmation: { operatorDiscordChannelId: 'operator-test' },
    capabilityTierProvider: () => 'apprentice',
    eventBus: new EventBus(),
    parentLabelProvider: () => 'Companion',
    audit: async () => 1,
    auditComplete: async () => {},
    recordMethodSuccess: () => {},
    recordMethodFailure: () => {},
  });
}

const verifier = createRequestCapabilityVerifier(verifierConfig);
let gatewayReplay: InMemoryRequestCapabilityReplayPort;

describe('Fleet Garden resolution of gateway-owned approvals', () => {
  let gateway: ApiServer;
  let surface: GardenOperatorSurface;
  let gatewayPort: number;
  let gardenPort: number;
  let boundary: ApprovalBoundaryService;
  let effects: string[];
  let denials: string[];
  let agentForwards: Array<{ companionId: string; requestPath: string }>;
  let reauthorizations: ChildAssertionAuthorityInput[];
  let reauthorizeDecision: 'allow' | 'deny';

  async function enqueue(owner: CompanionId): Promise<string> {
    const entry = await boundary.requestExplicitApproval({
      authenticatedCompanionId: owner,
      request: {
        method: 'memory.deletion.validate',
        action: 'delete memory',
        scope: 'memory:fixture',
        params: { memoryId: 'fixture' },
        companionReason: 'Fixture deletion proposal',
      },
      execute: async () => {
        effects.push(owner);
        return 'deleted';
      },
      onDenied: async () => {
        denials.push(owner);
      },
    });
    return entry.id;
  }

  function pending(id: string): boolean {
    return boundary.listPendingConfirmations().some(entry => entry.id === id);
  }

  async function resolveThroughGarden(request: IssuedRequest, body: Buffer = request.body) {
    return await post(
      gardenPort,
      `/companions/${request.companionId}/garden/api/admin/confirmations/resolve`,
      body,
      request.headers,
    );
  }

  beforeEach(async () => {
    effects = [];
    denials = [];
    agentForwards = [];
    reauthorizations = [];
    reauthorizeDecision = 'allow';
    gatewayReplay = new InMemoryRequestCapabilityReplayPort();
    boundary = approvalBoundary();
    const broker = new GatewayFleetAuthChildAssertionBroker({
      verifier,
      signer,
      replay: gatewayReplay,
      authority: {
        reauthorize: async (input) => {
          reauthorizations.push(input);
          return reauthorizeDecision === 'allow'
            ? { decision: 'allow', decisionId: randomUUID(), versions: input.parent.versions }
            : { decision: 'deny' };
        },
      },
    });
    gatewayPort = await allocatePort();
    gateway = new ApiServer({
      port: gatewayPort,
      host: '127.0.0.1',
      companionId: COMPANION_A,
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: { recordAssistantMessage: vi.fn() } as unknown as SessionManager,
      apiKey: CHAT_API_KEY,
      adminToken: ADMIN_TOKEN,
      fleetAuthChildAssertions: broker,
      fleetAuthConfirmations: new GatewayFleetConfirmationResolution({
        parentAuthority: broker,
        confirmations: {
          resolveForOwner: async (companionId, params, resolver) => await boundary
            .resolveConfirmationForOwner(companionId, params, resolver),
        },
      }),
    });
    await gateway.start();

    // Operator startup: the same plan and client composition main.ts uses.
    const plan = resolveGatewayAuthPlan({
      fleetSsoEnabled: true,
      gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      adminToken: ADMIN_TOKEN,
    });
    gardenPort = await allocatePort();
    surface = new GardenOperatorSurface({
      port: gardenPort,
      host: '127.0.0.1',
      config: gardenConfig(),
      fleetControlPlane: new FleetGardenControlPlane({
        registry: new FleetGardenTargetRegistry([COMPANION_A, COMPANION_B].map(companionId => ({
          companionId,
          endpoint: {
            mode: 'socket' as const,
            socketPath: `/run/garden-admin-${companionId}.sock`,
            timeoutMs: 1_000,
          },
        }))),
        verifier,
        replay: new AtomicRequestCapabilityReplayPort(),
      }),
      fleetTransport: {
        close: callback => callback(),
        probeAll: async () => undefined,
        // An agent cannot resolve gateway-owned approvals; like the agent's
        // admin route it answers with a not_found resolution.
        proxyBufferedApiRequest: (target, _req, res, body, _headers, requestPath) => {
          agentForwards.push({ companionId: target.companionId, requestPath });
          const { id } = JSON.parse(body.toString('utf8')) as { id: string };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            message: 'Confirmation request not found.',
            status: 'not_found',
            executed: false,
            id,
          }));
        },
        handleTelemetryUpgrade: () => {
          throw new Error('not used');
        },
      },
      ...createOperatorGatewayClients(plan, { confirmationRequestTimeoutMs: 5_000 }),
    });
    await surface.init();
    await surface.start();
  });

  afterEach(async () => {
    await surface.stop();
    await gateway.stop();
  });

  it('denies then approves tool-created approvals with exactly one effect and no replay effect', async () => {
    const deniedId = await enqueue(COMPANION_A);
    const deny = await resolveThroughGarden(await issue({
      companionId: COMPANION_A,
      actor: 'admin_token',
      body: { id: deniedId, decision: 'deny' },
    }));
    expect(deny).toEqual({
      status: 200,
      body: expect.objectContaining({ ok: true, status: 'denied', executed: false }),
    });
    expect(effects).toEqual([]);
    expect(denials).toEqual([COMPANION_A]);

    const approvedId = await enqueue(COMPANION_A);
    const approve = await resolveThroughGarden(await issue({
      companionId: COMPANION_A,
      actor: 'admin_token',
      body: { id: approvedId, decision: 'approve' },
    }));
    expect(approve).toEqual({
      status: 200,
      body: expect.objectContaining({ ok: true, status: 'approved', executed: true }),
    });
    expect(effects).toEqual([COMPANION_A]);
    // Admin-token parents carry their signed gateway decision; no SSO session.
    expect(reauthorizations).toEqual([]);
    expect(agentForwards).toEqual([]);

    // A fresh authorized request for the same decision finds nothing pending
    // at the gateway; the agent fallthrough cannot resolve it either.
    const replayed = await resolveThroughGarden(await issue({
      companionId: COMPANION_A,
      actor: 'admin_token',
      body: { id: approvedId, decision: 'approve' },
    }));
    expect(replayed).toEqual({
      status: 200,
      body: expect.objectContaining({ ok: false, status: 'not_found', executed: false }),
    });
    expect(agentForwards).toEqual([{
      companionId: COMPANION_A,
      requestPath: '/api/admin/confirmations/resolve',
    }]);
    expect(effects).toEqual([COMPANION_A]);

    const history = boundary.listConfirmationHistory();
    expect(history.find(entry => entry.id === approvedId)).toMatchObject({
      resolver: {
        kind: 'operator',
        id: `fleet-garden:${COMPANION_A}:admin_token:${ADMIN_TOKEN_REQUEST_CAPABILITY_PRINCIPAL_ID}`,
      },
    });
  });

  it('attributes an SSO human and reauthorizes current authority at the gateway', async () => {
    const id = await enqueue(COMPANION_A);
    const result = await resolveThroughGarden(await issue({
      companionId: COMPANION_A,
      actor: 'sso_admin',
      body: { id, decision: 'approve' },
    }));
    expect(result.status).toBe(200);
    expect(effects).toEqual([COMPANION_A]);
    expect(reauthorizations).toHaveLength(1);
    expect(reauthorizations[0]).toMatchObject({
      operator: { kind: 'operator_process', companionId: COMPANION_A },
      parent: { companionId: COMPANION_A, action: 'confirmations.manage' },
      childTarget: { companionId: COMPANION_A, action: 'confirmations.manage' },
    });
    expect(boundary.listConfirmationHistory().find(entry => entry.id === id)).toMatchObject({
      resolver: { kind: 'operator', id: `fleet-garden:${COMPANION_A}:discord:principal-human` },
    });
  });

  it('fails closed when current SSO authority is revoked', async () => {
    reauthorizeDecision = 'deny';
    const id = await enqueue(COMPANION_A);
    const result = await resolveThroughGarden(await issue({
      companionId: COMPANION_A,
      actor: 'sso_admin',
      body: { id, decision: 'approve' },
    }));
    expect(result.status).toBe(403);
    expect(effects).toEqual([]);
    expect(pending(id)).toBe(true);
  });

  it('fails closed for a guest principal', async () => {
    const id = await enqueue(COMPANION_A);
    const result = await resolveThroughGarden(await issue({
      companionId: COMPANION_A,
      actor: 'sso_guest',
      body: { id, decision: 'approve' },
    }));
    expect(result.status).toBe(403);
    expect(effects).toEqual([]);
    expect(pending(id)).toBe(true);
  });

  it('never resolves another companion\'s approval', async () => {
    const id = await enqueue(COMPANION_A);
    const result = await resolveThroughGarden(await issue({
      companionId: COMPANION_B,
      actor: 'admin_token',
      body: { id, decision: 'approve' },
    }));
    expect(result).toEqual({
      status: 200,
      body: expect.objectContaining({ ok: false, status: 'not_found', executed: false }),
    });
    expect(agentForwards).toEqual([{
      companionId: COMPANION_B,
      requestPath: '/api/admin/confirmations/resolve',
    }]);
    expect(effects).toEqual([]);
    expect(pending(id)).toBe(true);
  });

  it('rejects an unknown companion, a tampered body and a replayed capability at the Garden', async () => {
    const id = await enqueue(COMPANION_A);
    const unknown = await resolveThroughGarden(await issue({
      companionId: UNKNOWN_COMPANION,
      actor: 'admin_token',
      body: { id, decision: 'approve' },
    }));
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);

    const signedDeny = await issue({
      companionId: COMPANION_A,
      actor: 'admin_token',
      body: { id, decision: 'deny' },
    });
    const tampered = await resolveThroughGarden(
      signedDeny,
      Buffer.from(JSON.stringify({ id, decision: 'approve' })),
    );
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    expect(tampered.status).toBeLessThan(500);
    expect(effects).toEqual([]);
    expect(pending(id)).toBe(true);

    const first = await resolveThroughGarden(signedDeny);
    expect(first.status).toBe(200);
    const replay = await resolveThroughGarden(signedDeny);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    expect(effects).toEqual([]);
    expect(denials).toEqual([COMPANION_A]);
  });

  it('rejects ordinary credentials at the Garden and at the gateway door', async () => {
    const id = await enqueue(COMPANION_A);
    const body = Buffer.from(JSON.stringify({ id, decision: 'approve' }));
    for (const token of [CHAT_API_KEY, ADMIN_TOKEN]) {
      const garden = await post(
        gardenPort,
        `/companions/${COMPANION_A}/garden/api/admin/confirmations/resolve`,
        body,
        { Authorization: `Bearer ${token}` },
      );
      expect(garden.status).toBeGreaterThanOrEqual(400);
      expect(garden.status).toBeLessThan(500);
      const door = await post(
        gatewayPort,
        '/v1/internal/fleet-auth/confirmations/resolve',
        Buffer.from(JSON.stringify({ schemaVersion: 1, companionId: COMPANION_A, id, decision: 'approve' })),
        { Authorization: `Bearer ${token}` },
      );
      expect(door.status).toBe(400);
    }
    expect(effects).toEqual([]);
    expect(pending(id)).toBe(true);
  });

  function doorEnvelope(issued: IssuedRequest): Buffer {
    return Buffer.from(JSON.stringify({
      schemaVersion: 1,
      companionId: issued.companionId,
      parent: {
        token: issued.parent.token,
        target: {
          rawTarget: issued.parent.rawTarget,
          method: 'POST',
          bodyBase64: issued.body.toString('base64url'),
          headers: null,
        },
        requestId: issued.parent.requestId,
        decisionId: issued.parent.decisionId,
        versions: VERSIONS,
      },
    }));
  }

  it('consumes a parent at the gateway door at most once', async () => {
    const id = await enqueue(COMPANION_A);
    const envelope = doorEnvelope(await issue({
      companionId: COMPANION_A,
      actor: 'admin_token',
      body: { id, decision: 'approve' },
    }));
    const first = await post(gatewayPort, '/v1/internal/fleet-auth/confirmations/resolve', envelope);
    expect(first).toEqual({
      status: 200,
      body: expect.objectContaining({ id, status: 'approved', executed: true }),
    });
    const second = await post(gatewayPort, '/v1/internal/fleet-auth/confirmations/resolve', envelope);
    expect(second).toEqual({ status: 403, body: { error: 'confirmation_resolution_denied' } });
    expect(effects).toEqual([COMPANION_A]);
  });

  it('refuses a parent signed for any other Garden action at the gateway door', async () => {
    const id = await enqueue(COMPANION_A);
    const escalation = await issue({
      companionId: COMPANION_A,
      actor: 'admin_token',
      body: { id, decision: 'approve' },
      rawTarget: `/api/admin/escalations/${id}/resolve`,
    });
    const result = await post(
      gatewayPort,
      '/v1/internal/fleet-auth/confirmations/resolve',
      doorEnvelope(escalation),
    );
    expect(result).toEqual({ status: 403, body: { error: 'confirmation_resolution_denied' } });
    expect(effects).toEqual([]);
    expect(pending(id)).toBe(true);
  });
});

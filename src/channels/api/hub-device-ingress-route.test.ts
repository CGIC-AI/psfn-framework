import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { ApiServer } from './server.js';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { deriveApiKeyPrincipalId } from '../backplane/http/auth.js';
import {
  GatewayHubDeviceIngressService,
  type HubDeviceAssertionVerifierPort,
  type HubDeviceHumanAttachmentPort,
} from '../../boundary/fleet-auth/hub-device-ingress.js';
import { HubDeviceAssertionRejectedError } from '../../boundary/fleet-auth/hub-device-assertion.js';
import type { ApiRuntimeChatRequest, ApiServerRuntime } from './types.js';
import type { FleetAuthHttpRoutes } from './server/fleet-auth-routes.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../core/session/manager.js';

const TOKEN = 'hub-satellite-secret-key';
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const ASSERTION = 'header.claims.signature';

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') return reject(new Error('No port'));
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function post(
  port: number,
  body: object,
  assertion: string | string[] | null = ASSERTION,
  closeConnection = false,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...(assertion !== null ? { 'x-psfn-hub-device-assertion': assertion } : {}),
        'x-psfn-satellite-claim-type': 'hub-device',
        'x-psfn-satellite-id': 'office',
        'x-psfn-satellite-endpoint-id': 'office-device',
        'x-psfn-satellite-session-id': 'realtime:office-device:session',
        'x-channel-privacy': 'public',
        'x-author-id': 'forged-human',
        'x-canonical-contact-id': 'forged-contact',
        ...(closeConnection ? { connection: 'close' } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function registry(includeEnrollment = true) {
  return parseSatelliteRegistryConfig({
    schemaVersion: 1,
    enabled: true,
    satellites: [{
      satelliteId: 'office', displayName: 'Office', mobility: 'static', placeId: 'office',
      endpoints: [{
        endpointId: 'office-device', displayName: 'Office Device',
        claimTypes: ['hub-device'], promptChannelType: 'satellite_hub',
        auth: { mode: 'api_key', apiKeyPrincipalIds: [deriveApiKeyPrincipalId(TOKEN)] },
        defaultIdentity: {
          authorId: 'legacy-human', authorName: 'Legacy Human',
          canonicalContactId: 'contact-legacy-human', channelPrivacy: 'private',
        },
        maxCapabilities: ['text'], telemetryScopes: ['presence'],
        ...(includeEnrollment ? {
          hubDeviceEnrollment: {
            deviceId: 'office-device', enrollmentVersion: 7, enrollmentStatus: 'active',
          },
        } : {}),
      }],
    }],
  });
}

const fleetRoutes = {
  applyLifecycleCorsPolicy: () => 'not_applicable',
  matches: () => false,
  handle: async () => undefined,
} as unknown as FleetAuthHttpRoutes;

describe('ApiServer authenticated Hub device ingress', () => {
  const running: ApiServer[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map(server => server.stop()));
  });

  async function start(
    verifyAndConsume: HubDeviceAssertionVerifierPort['verifyAndConsume'],
    satelliteRegistry = registry(),
    useProvider = false,
  ) {
    const requests: ApiRuntimeChatRequest[] = [];
    const connectionIds: string[] = [];
    const fences: Array<Parameters<HubDeviceHumanAttachmentPort['fenceDevice']>[0]> = [];
    const runtime: ApiServerRuntime = {
      handleHealth: async () => { throw new Error('unused'); },
      handleTelemetryIngest: async () => { throw new Error('unused'); },
      handleChatCompletion: async input => {
        requests.push(input);
        return { ok: true, response: { content: 'ok', channelId: 'device', inputTokens: 1, outputTokens: 1 } };
      },
    };
    const port = await allocatePort();
    const server = new ApiServer({
      port, host: '127.0.0.1',
      agentLoop: {} as SubstrateAgent,
      eventBus: new EventBus(), sessionManager: {} as SessionManager,
      runtime,
      ...(useProvider
        ? { satelliteRegistryProvider: () => satelliteRegistry }
        : { satelliteRegistry }),
      satelliteApiKeys: [TOKEN],
      companionId: COMPANION_ID,
      fleetAuthBootstrapOnly: true, fleetAuthHttpRoutes: fleetRoutes,
      hubDeviceCompanionId: COMPANION_ID,
      hubDeviceIngress: new GatewayHubDeviceIngressService({
        verifyAndConsume,
        enrollmentAuthority: {
          resolve: async input => input.authenticatedConnection,
        },
        attachments: {
          attach: async (input) => {
            connectionIds.push(input.connection.connectionId);
            return {
              attachmentId: '018f0f10-79b2-4cc7-8c99-0242ac120003',
              disposition: 'guest_created',
              deviceActor: Object.freeze({
                kind: 'hub_device',
                principal: input.devicePrincipal,
                connectionId: input.connection.connectionId,
              }),
              actor: Object.freeze({ kind: 'guest', companionId: input.connection.companionId }),
              channel: Object.freeze({
                source: 'server',
                id: `hub-device:${'0'.repeat(64)}`,
                companionId: input.connection.companionId,
              }),
            };
          },
          fenceDevice: async input => { fences.push(input); },
        },
      }),
    });
    await server.start();
    running.push(server);
    return { server, port, requests, connectionIds, fences };
  }

  it('verifies server-owned bindings and forwards sibling guest/device contexts', async () => {
    const verifier = vi.fn(async (_assertion: string, expected: {
      deviceId: string; enrollmentVersion: number; companionId: string; sessionId: string; placeId?: string;
    }) => ({
      kind: 'hub_device' as const, issuer: 'psfn-satellite-hub', keyId: 'hub-key',
      deviceId: expected.deviceId, enrollmentVersion: expected.enrollmentVersion,
      enrollmentAssurance: 'device_credential' as const, placeId: expected.placeId,
      audience: 'https://fleet.example.test', companionId: expected.companionId,
      sessionId: expected.sessionId, issuedAt: new Date(), expiresAt: new Date(Date.now() + 30_000),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    }));
    const { port, requests } = await start(verifier);
    const response = await post(port, {
      model: 'companion', messages: [{ role: 'user', content: 'hello', name: 'forged-human' }],
      satellite_claim: { device_id: 'browser-forgery' }, channel_metadata: { author: 'browser' },
    });

    expect(response.status).toBe(200);
    expect(verifier).toHaveBeenCalledWith(ASSERTION, {
      deviceId: 'office-device', enrollmentVersion: 7, enrollmentStatus: 'active',
      companionId: COMPANION_ID, sessionId: 'realtime:office-device:session', placeId: 'office',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.hubDevicePrincipal).toMatchObject({
      kind: 'hub_device', deviceId: 'office-device', companionId: COMPANION_ID,
    });
    expect(requests[0]?.hubDeviceAttachment).toMatchObject({
      deviceActor: { kind: 'hub_device' },
      actor: { kind: 'guest', companionId: COMPANION_ID },
      channel: { source: 'server', companionId: COMPANION_ID },
    });
    expect(requests[0]?.companionId).toBe(COMPANION_ID);
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.headers['x-psfn-hub-device-assertion']).toBeUndefined();
    expect(requests[0]?.headers['x-channel-privacy']).toBeUndefined();
    expect(requests[0]?.headers['x-author-id']).toBeUndefined();
    expect(requests[0]?.headers['x-canonical-contact-id']).toBeUndefined();
    expect(requests[0]?.request.messages[0]).not.toHaveProperty('name');
    expect(requests[0]).not.toHaveProperty('humanPrincipal');
  });

  it('admits Hub devices from the canonical live registry provider', async () => {
    const verifier = vi.fn(async (_assertion: string, expected: {
      deviceId: string; enrollmentVersion: number; companionId: string; sessionId: string; placeId?: string;
    }) => ({
      kind: 'hub_device' as const, issuer: 'psfn-satellite-hub', keyId: 'hub-key',
      deviceId: expected.deviceId, enrollmentVersion: expected.enrollmentVersion,
      enrollmentAssurance: 'device_credential' as const, placeId: expected.placeId,
      audience: 'https://fleet.example.test', companionId: expected.companionId,
      sessionId: expected.sessionId, issuedAt: new Date(), expiresAt: new Date(Date.now() + 30_000),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    }));
    const { port, requests } = await start(verifier, registry(), true);

    await expect(post(port, {
      model: 'companion', messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toMatchObject({ status: 200 });
    expect(requests).toHaveLength(1);
    expect(verifier).toHaveBeenCalledOnce();
  });

  it('binds attachment authority to the exact server socket connection', async () => {
    const verifier = vi.fn(async (_assertion: string, expected: {
      deviceId: string; enrollmentVersion: number; companionId: string; sessionId: string; placeId?: string;
    }) => ({
      kind: 'hub_device' as const, issuer: 'psfn-satellite-hub', keyId: 'hub-key',
      deviceId: expected.deviceId, enrollmentVersion: expected.enrollmentVersion,
      enrollmentAssurance: 'device_credential' as const, placeId: expected.placeId,
      audience: 'https://fleet.example.test', companionId: expected.companionId,
      sessionId: expected.sessionId, issuedAt: new Date(), expiresAt: new Date(Date.now() + 30_000),
      jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    }));
    const { port, connectionIds } = await start(verifier);
    const request = { model: 'companion', messages: [{ role: 'user' as const, content: 'hello' }] };
    await expect(post(port, request, ASSERTION, true)).resolves.toMatchObject({ status: 200 });
    await expect(post(port, request, ASSERTION, true)).resolves.toMatchObject({ status: 200 });

    expect(connectionIds).toHaveLength(2);
    expect(connectionIds[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(connectionIds[1]).not.toBe(connectionIds[0]);
  });

  it('fences the durable device attachment when server enrollment is removed', async () => {
    const verifier = vi.fn(async () => { throw new Error('must not verify'); });
    const { port, fences } = await start(verifier, registry(false));

    await expect(post(port, {
      model: 'companion', messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toMatchObject({ status: 403, body: { error: { type: 'hub_device_not_enrolled' } } });
    expect(verifier).not.toHaveBeenCalled();
    expect(fences).toEqual([{
      assertionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      connectionId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      reason: 'enrollment_authority_changed',
    }]);
  });

  it('fails closed with sanitized errors for rejection, verifier outage, or body authority conflict', async () => {
    const malformedVerifier = vi.fn(async () => { throw new Error('must not verify'); });
    const malformed = await start(malformedVerifier);
    const missing = await post(malformed.port, { model: 'companion', messages: [{ role: 'user', content: 'hello' }] }, null);
    const multiple = await post(malformed.port, { model: 'companion', messages: [{ role: 'user', content: 'hello' }] }, [ASSERTION, ASSERTION]);
    expect(missing).toMatchObject({ status: 401, body: { error: { type: 'invalid_hub_device_assertion' } } });
    expect(multiple).toMatchObject({ status: 401, body: { error: { type: 'invalid_hub_device_assertion' } } });
    expect(malformedVerifier).not.toHaveBeenCalled();

    const rejected = await start(async () => { throw new HubDeviceAssertionRejectedError('signature leaked detail'); });
    const rejectedResponse = await post(rejected.port, { model: 'companion', messages: [{ role: 'user', content: 'hello' }] });
    expect(rejectedResponse).toMatchObject({ status: 401, body: { error: { type: 'hub_device_assertion_rejected' } } });
    expect(JSON.stringify(rejectedResponse.body)).not.toContain('signature leaked detail');

    const unavailable = await start(async () => { throw new Error('postgres://secret@db unavailable'); });
    const unavailableResponse = await post(unavailable.port, { model: 'companion', messages: [{ role: 'user', content: 'hello' }] });
    expect(unavailableResponse).toMatchObject({ status: 503, body: { error: { type: 'hub_device_ingress_unavailable' } } });
    expect(JSON.stringify(unavailableResponse.body)).not.toContain('postgres://');

    const conflictVerifier = vi.fn(async () => { throw new Error('must not verify'); });
    const conflict = await start(conflictVerifier);
    const conflictResponse = await post(conflict.port, {
      model: 'companion', messages: [{ role: 'user', content: 'hello' }], deviceId: 'forged',
    });
    expect(conflictResponse).toMatchObject({ status: 400, body: { error: { type: 'conflicting_hub_device_authority' } } });
    expect(conflictVerifier).not.toHaveBeenCalled();
  });
});

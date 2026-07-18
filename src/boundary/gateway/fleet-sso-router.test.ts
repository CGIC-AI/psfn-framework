import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  GatewayFleetSsoRouter,
  resolveFleetSsoBrowserOrigin,
} from './fleet-sso-router.js';
import { resolveFleetSsoGardenUpstreams } from '../fleet-auth/fleet-sso-transport.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import type { FleetAuthorizationContext } from './fleet-authorization-context.js';

function request(headers: IncomingMessage['headers'], encrypted = false): Pick<IncomingMessage, 'headers' | 'socket'> {
  return {
    headers,
    socket: { encrypted } as IncomingMessage['socket'],
  };
}

describe('unified Fleet SSO origin provenance', () => {
  const canonicalOrigin = 'https://fleet.example.test';

  it('accepts only the exact direct TLS Host without forwarded metadata', () => {
    expect(resolveFleetSsoBrowserOrigin(
      request({ host: 'fleet.example.test' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toBe(canonicalOrigin);
    expect(() => resolveFleetSsoBrowserOrigin(
      request({ host: 'fleet.example.test', 'x-forwarded-proto': 'https' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toThrow(/Forwarded origin metadata is forbidden/u);
    expect(() => resolveFleetSsoBrowserOrigin(
      request({ host: 'attacker.example.test' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toThrow(/provenance is invalid/u);
  });

  it('admits fleet Garden chat with one server-derived companion target', async () => {
    const companionId = '11111111-1111-4111-8111-111111111111';
    const nowSeconds = 1_783_000_000;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-chat-test',
      kid: 'fleet-chat-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => nowSeconds,
    });
    const verifier = createRequestCapabilityVerifier({
      issuer: 'fleet-chat-test',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-chat-test',
        kid: 'fleet-chat-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: '2026-07-01T00:00:00.000Z',
        notAfter: '2026-07-03T00:00:00.000Z',
        status: 'active',
      }],
    });
    const authorization: FleetAuthorizationContext = Object.freeze({
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSubject: Object.freeze({ provider: 'discord', subjectId: 'subject-a' }),
      companionId,
      contact: Object.freeze({
        bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        bindingVersion: 1,
      }),
      operator: Object.freeze({
        grantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        role: 'owner',
        grantVersion: 1,
      }),
      session: Object.freeze({
        recordId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        audience: 'fleet',
        assurance: 'oauth',
        authnVersion: 1,
        authzVersion: 1,
        bindingVersion: 1,
        grantVersion: 1,
        policyVersion: 1,
        provider: 'discord',
        providerSubjectId: 'subject-a',
      }),
      authorization: Object.freeze({ action: 'companion.interact', decision: 'allow' }),
      authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
      provenance: Object.freeze({
        source: 'gateway_fleet_authorization_snapshot',
        authorizationEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        resolvedAt: new Date(nowSeconds * 1_000).toISOString(),
      }),
    });
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker: { resolveAuthorizationContext: vi.fn(async () => authorization) },
      signer,
      verifier,
      replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
      portalProjection: { resolve: vi.fn(async () => { throw new Error('not used'); }) },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      nowSeconds: () => nowSeconds,
    });
    const body = Buffer.from(JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const incoming = Readable.from([body]) as IncomingMessage;
    incoming.method = 'POST';
    incoming.url = `/companions/${companionId}/garden/v1/chat/completions`;
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
      cookie: `__Host-psfn_session=${'s'.repeat(43)}`,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const handler = vi.fn(async (admission) => {
      expect(admission.companionId).toBe(companionId);
      expect(admission.authorization).toBe(authorization);
      expect(admission.body).toEqual(body);
    });
    router.registerGardenChatHandler(handler);

    await router.handle(incoming, response);

    expect(response.writeHead).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('accepts one explicit HTTPS proxy shape and rejects spoofed/mixed variants', () => {
    const exactHeaders = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
    };
    expect(resolveFleetSsoBrowserOrigin(
      request(exactHeaders),
      { canonicalOrigin, trustProxy: true },
    )).toBe(canonicalOrigin);
    for (const headers of [
      { ...exactHeaders, 'x-forwarded-host': 'attacker.example.test' },
      { ...exactHeaders, 'x-forwarded-proto': 'http' },
      { ...exactHeaders, 'x-forwarded-for': '198.51.100.9, 203.0.113.8' },
      { ...exactHeaders, forwarded: 'host=attacker.example.test;proto=https' },
    ]) {
      expect(() => resolveFleetSsoBrowserOrigin(
        request(headers),
        { canonicalOrigin, trustProxy: true },
      )).toThrow();
    }
  });

  it('derives one exact loopback Garden for a single-companion deployment', () => {
    expect(resolveFleetSsoGardenUpstreams({
      companionId: '11111111-1111-4111-8111-111111111111',
      gardenPort: 3001,
      env: {},
    })).toMatchObject([{
      companionId: '11111111-1111-4111-8111-111111111111',
      origin: new URL('http://127.0.0.1:3001'),
    }]);
    expect(() => resolveFleetSsoGardenUpstreams({
      companionId: 'not-a-companion-id',
      gardenPort: 3001,
      env: {},
    })).toThrow(/RFC4122 UUID/u);
  });
});

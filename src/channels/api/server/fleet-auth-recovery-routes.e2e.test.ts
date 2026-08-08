import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  trustedHostRecoveryResource,
} from '../../../boundary/fleet-auth/request-capability.js';
import type {
  TrustedHostRecoveryReplayConsumption,
  TrustedHostRecoveryReplayPort,
} from '../../../boundary/fleet-auth/request-capability-replay.js';
import {
  GatewayTrustedHostGardenRecoveryService,
  type TrustedHostRecoveryAuthoritySnapshot,
} from '../../../boundary/gateway/trusted-host-garden-recovery.js';
import {
  FLEET_AUTH_RECOVERY_CONSUME_PATH,
  FLEET_AUTH_RECOVERY_CREDENTIAL_HEADER,
  FLEET_AUTH_RECOVERY_ISSUE_PATH,
  FLEET_AUTH_RECOVERY_REVOKE_PATH,
  FleetAuthRecoveryHttpRoutes,
} from './fleet-auth-recovery-routes.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL = 'independent-trusted-host-credential';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createRecoveryService(): GatewayTrustedHostGardenRecoveryService {
  const keys = generateKeyPairSync('ed25519');
  let floor: TrustedHostRecoveryAuthoritySnapshot = {
    lineageId: 'a'.repeat(64),
    provisioningSecret: 'b'.repeat(64),
    authorityGeneration: 1,
    activationGeneration: 1,
    restoreCheckpoint: 0,
    revocationCheckpoint: 0,
    tombstones: [],
  };
  const consumed = new Map<string, TrustedHostRecoveryReplayConsumption>();
  const replay: TrustedHostRecoveryReplayPort = {
    auditRecovery: async () => undefined,
    consumeRecovery: async input => {
      const key = `${input.issuer}:${input.jti}`;
      const prior = consumed.get(key);
      if (!prior) {
        consumed.set(key, input);
        return { outcome: 'consumed', result: input.consumeResult };
      }
      const fields = [
        'capabilityDigest', 'targetDigest', 'bodyDigest', 'audienceDigest',
        'companionDigest', 'actionDigest', 'resourceDigest', 'parentDigest',
        'decisionDigest', 'authorityVersionsDigest',
      ] as const;
      return fields.some(field => input[field] !== prior[field])
        ? { outcome: 'mismatch' }
        : { outcome: 'replayed', result: prior.consumeResult };
    },
  };
  return new GatewayTrustedHostGardenRecoveryService({
    configuredCredential: CREDENTIAL,
    knownCompanionIds: new Set([COMPANION_ID]),
    signer: createGatewayRequestCapabilitySigner({
      issuer: 'fleet-auth',
      kid: 'active-key',
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ttlSeconds: 30,
    }),
    verifier: createRequestCapabilityVerifier({
      issuer: 'fleet-auth',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-auth',
        kid: 'active-key',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        notBefore: '2020-01-01T00:00:00.000Z',
        notAfter: '2100-01-01T00:00:00.000Z',
        status: 'active',
      }],
    }),
    replay,
    authority: {
      readTrustedHost: () => floor,
      revokeRecoveryCredential: input => {
        floor = {
          ...floor,
          revocationCheckpoint: floor.revocationCheckpoint + 1,
          tombstones: [...floor.tombstones, {
            kind: 'recovery_credential',
            resourceHash: digest(input.credentialId),
          }],
        };
        return { trustedHost: floor };
      },
    },
  });
}

function scope() {
  return {
    companionId: COMPANION_ID,
    action: 'recovery.begin',
    resource: trustedHostRecoveryResource(COMPANION_ID),
    reason: 'Open only the exact Garden recovery entrypoint',
  };
}

describe('trusted-host Garden recovery HTTP E2E', () => {
  let server: Server;
  let port = 0;

  beforeEach(async () => {
    const routes = new FleetAuthRecoveryHttpRoutes(createRecoveryService());
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!routes.matches(request.method, url.pathname)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      void routes.handle(request, response, url);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => (
      error ? reject(error) : resolve()
    )));
  });

  async function post(path: string, body: string, headers: Record<string, string> = {}) {
    return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
      (resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            [FLEET_AUTH_RECOVERY_CREDENTIAL_HEADER]: CREDENTIAL,
            ...headers,
          },
        }, response => {
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
      },
    );
  }

  it('issues and consumes only an exact recovery capability with durable retry semantics', async () => {
    const issuedResponse = await post(FLEET_AUTH_RECOVERY_ISSUE_PATH, JSON.stringify(scope()));
    expect(issuedResponse.status).toBe(201);
    const issued = JSON.parse(issuedResponse.body) as { token: string };
    expect(issued.token).toBeTypeOf('string');
    expect(issuedResponse.headers['set-cookie']).toBeUndefined();

    const consumeBody = JSON.stringify({ ...scope(), token: issued.token });
    const first = await post(FLEET_AUTH_RECOVERY_CONSUME_PATH, consumeBody);
    const retry = await post(FLEET_AUTH_RECOVERY_CONSUME_PATH, consumeBody);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.body)).toEqual(JSON.parse(first.body));
    expect(JSON.parse(first.body)).toEqual(expect.objectContaining({
      kind: 'trusted_host_garden_recovery_receipt',
      outcome: 'recovery_ready',
      action: 'recovery.begin',
      companionId: COMPANION_ID,
    }));

    const byteMutated = JSON.stringify({ ...scope(), token: issued.token }, null, 2);
    const mismatch = await post(FLEET_AUTH_RECOVERY_CONSUME_PATH, byteMutated);
    expect(mismatch.status).toBe(409);
    expect(JSON.parse(mismatch.body).error.type).toBe('recovery_replay_mismatch');
  });

  it('rejects browser, proxy, standalone-auth, query, and non-dedicated route access', async () => {
    for (const headers of [
      { Origin: 'https://fleet.example.test' },
      { Forwarded: 'for=127.0.0.1' },
      { Authorization: 'Bearer standalone-token' },
      { Cookie: 'session=standalone' },
      { Host: 'attacker.example.test' },
    ]) {
      const response = await post(FLEET_AUTH_RECOVERY_ISSUE_PATH, JSON.stringify(scope()), headers);
      expect(response.status).toBe(403);
    }
    expect((await post(`${FLEET_AUTH_RECOVERY_ISSUE_PATH}?wide=true`, JSON.stringify(scope()))).status)
      .toBe(400);
    expect((await post('/v1/fleet-auth/garden', JSON.stringify(scope()))).status).toBe(404);
  });

  it('revokes the credential without minting a session or reusable fallback token', async () => {
    const response = await post(FLEET_AUTH_RECOVERY_REVOKE_PATH, JSON.stringify(scope()));
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    const revoked = JSON.parse(response.body);
    expect(revoked).toEqual(expect.objectContaining({
      kind: 'trusted_host_recovery_credential_revocation',
      revocationCheckpoint: 1,
    }));
    expect(revoked).not.toHaveProperty('token');
    expect((await post(FLEET_AUTH_RECOVERY_ISSUE_PATH, JSON.stringify(scope()))).status).toBe(403);
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { requireGardenRouteCapability } from '../../boundary/fleet-auth/garden-route-capabilities.js';
import { requireGardenRouteAuthorization } from '../../boundary/fleet-auth/garden-route-authorization.js';
import { InMemoryBiographicalProfileStore } from '../../faculties/memory/biographical/in-memory-store.js';
import type { BiographicalClaimSource } from '../../faculties/memory/biographical/types.js';
import { buildAdminBiographicalReviewRoutes } from './api-routes-biographical-review.js';
import { createStandaloneGardenRequestContext, type GardenRequestContext } from './garden-request-context.js';
import type { AdminApiRoute } from './routes/types.js';
import { AdminBiographicalReviewService } from './services/biographical-review-service.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const DIGEST = 'a'.repeat(64);

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(body?: string): void {
    this.body = body ?? '';
    this.resolveDone();
  }
}

function source(): BiographicalClaimSource {
  return {
    ref: 'memory:private-v', revision: '7', evidenceDigest: DIGEST,
    sensitivityAtProjection: 'intimate', subjectEvidenceDigest: DIGEST,
    consentFingerprint: DIGEST,
  };
}

function context(routeId: string, pathParams: Readonly<Record<string, string>>): GardenRequestContext {
  return createStandaloneGardenRequestContext({
    authorization: requireGardenRouteAuthorization(routeId),
    routeId,
    companionId: 'purrs',
    pathParams,
    query: {},
  });
}

async function invoke(input: {
  routes: AdminApiRoute[];
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  context?: GardenRequestContext;
}): Promise<{ status: number; body: unknown }> {
  const route = input.routes.find(candidate => candidate.method === input.method && candidate.match(input.path));
  if (!route) throw new Error(`route not found: ${input.method} ${input.path}`);
  const response = new CapturingResponse();
  route.handle(
    { headers: {}, url: input.path } as IncomingMessage,
    response as unknown as ServerResponse,
    route.match(input.path) ?? {},
    input.context,
  );
  await response.done;
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
}

describe('Garden biographical review routes', () => {
  it('declares admin-only bounded reads and explicit-confirmation mutations', () => {
    const list = requireGardenRouteCapability('GET /api/admin/biographical-claims');
    const detail = requireGardenRouteCapability('GET /api/admin/biographical-claims/:claimId');
    const review = requireGardenRouteCapability('POST /api/admin/biographical-claims/:claimId/review');
    expect([list, detail].map(route => ({
      action: route.authorization.action,
      role: route.authorization.baseRole,
      body: route.body.mode,
    }))).toEqual([
      { action: 'memory.read', role: 'admin', body: 'forbidden' },
      { action: 'memory.read', role: 'admin', body: 'forbidden' },
    ]);
    expect(review).toMatchObject({
      body: { mode: 'required' },
      authorization: {
        action: 'memory.manage', baseRole: 'admin', requirements: { confirmation: 'explicit' },
      },
    });
  });

  it('redacts list/detail and records parseable stale reviews in biography audit', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: 'tea', polarity: 'likes',
      },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });
    const routes = buildAdminBiographicalReviewRoutes({
      service,
      withBody: (_req, _res, callback) => callback(JSON.stringify({
        action: 'approve', claimDigest: 'b'.repeat(64), sourceSetDigest: claim.sourceSetDigest,
      })),
    });
    const listResult = await invoke({
      routes, method: 'GET', path: '/api/admin/biographical-claims',
      context: context('GET /api/admin/biographical-claims', {}),
    });
    expect(listResult).toMatchObject({ status: 200, body: { claims: [{ id: claim.id }] } });
    expect(JSON.stringify(listResult.body)).not.toContain('sourceBody');

    const stale = await invoke({
      routes, method: 'POST', path: `/api/admin/biographical-claims/${claim.id}/review`,
      context: context('POST /api/admin/biographical-claims/:claimId/review', { claimId: claim.id }),
    });
    expect(stale).toMatchObject({ status: 409, body: { reason: 'stale-claim-digest' } });
    expect(await store.listReviewAudits(claim.id, 20)).toMatchObject([
      { decision: 'denied', reason: 'stale-claim-digest', actorAuthorityRef: 'garden-standalone:operator' },
    ]);
  });

  it('rejects missing authority and body actor injection, auditing malformed attempts only in Garden timeline', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: 'tea', polarity: 'likes',
      },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const audit = vi.fn();
    const body = {
      action: 'approve', claimDigest: claim.claimDigest, sourceSetDigest: claim.sourceSetDigest,
      actor: { kind: 'operator', authorityRef: 'attacker:chosen' },
    };
    const routes = buildAdminBiographicalReviewRoutes({
      service: new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW }),
      withBody: (_req, _res, callback) => callback(JSON.stringify(body)),
      appendAuditTimelineEntry: audit,
    });
    const path = `/api/admin/biographical-claims/${claim.id}/review`;
    expect(await invoke({ routes, method: 'POST', path })).toMatchObject({ status: 403 });
    expect(await invoke({
      routes, method: 'POST', path,
      context: context('POST /api/admin/biographical-claims/:claimId/review', { claimId: claim.id }),
    })).toMatchObject({ status: 400, body: { reason: 'malformed' } });
    expect(audit).toHaveBeenCalledWith(
      'memory_mutation', 'denied', expect.stringContaining('malformed action'),
      [`claimId=${claim.id}`], 'operator', expect.anything(),
    );
    expect(await store.listReviewAudits(claim.id, 20)).toEqual([]);
    expect((await store.getClaim(claim.id))?.status).toBe('candidate');
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAdminSharedWorkspaceRoutes } from './api-routes-shared-workspace.js';
import {
  AdminSharedWorkspaceService,
  SHARED_WORKSPACE_CREDENTIAL_HEADER,
  type SharedWorkspaceCredentials,
} from './services/shared-workspace-service.js';
import type { AdminApiRoute } from './routes/types.js';

const CREDENTIALS: SharedWorkspaceCredentials = {
  proposerToken: 'proposal-credential-aaaaaaaaaaaaaaaa',
  reviewerToken: 'reviewer-credential-bbbbbbbbbbbbbbbb',
  cogSecToken: 'cogsec-credential-cccccccccccccccccc',
};

class CapturingResponse {
  status = 0;
  body = '';
  writeHead(status: number): this { this.status = status; return this; }
  end(body?: string): this { this.body = body ?? ''; return this; }
}

function makeRequest(url: string, body: string, credential?: string): IncomingMessage {
  return {
    url,
    headers: {
      host: 'localhost',
      ...(credential ? { [SHARED_WORKSPACE_CREDENTIAL_HEADER]: credential } : {}),
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data') listener(body);
      if (event === 'end') listener();
      return this;
    },
  } as IncomingMessage;
}

async function invoke(
  route: AdminApiRoute,
  url: string,
  body: Record<string, unknown>,
  credential?: string,
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const params = route.match(new URL(url, 'http://localhost').pathname);
  route.handle(
    makeRequest(url, JSON.stringify(body), credential),
    response as unknown as ServerResponse,
    params ?? {},
  );
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('shared workspace admin write authentication', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { service: AdminSharedWorkspaceService; routes: AdminApiRoute[] } {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shared-routes-'));
    roots.push(root);
    for (const path of [
      'artifacts', 'reviews', 'cogsec-decisions', 'provenance/events', 'transactions', '.locks',
    ]) mkdirSync(join(root, path), { recursive: true });
    const service = new AdminSharedWorkspaceService(root, CREDENTIALS);
    return {
      service,
      routes: buildAdminSharedWorkspaceRoutes({
        service,
        withBody: (req, _res, callback) => {
          let body = '';
          req.on('data', chunk => { body += String(chunk); });
          req.on('end', () => callback(body));
        },
      }),
    };
  }

  it('derives proposer, CogSec, and reviewer identities from distinct credentials', async () => {
    const { service, routes } = fixture();
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;
    const proposed = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'guide.md',
      content: '# Reviewed\n',
      mediaType: 'text/markdown',
      provenance: 'operator source',
    }, CREDENTIALS.proposerToken);
    expect(proposed.status).toBe(201);
    const proposal = JSON.parse(proposed.body);
    expect(proposal.proposer).toMatchObject({ role: 'proposer' });
    expect(proposal.proposer.id).not.toContain(CREDENTIALS.proposerToken);

    const decisionRoute = routes.find(route => route.match(
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/decision`,
    ))!;
    const wrongRole = await invoke(
      decisionRoute,
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/decision`,
      { decision: 'approve' },
      CREDENTIALS.proposerToken,
    );
    expect(wrongRole.status).toBe(401);

    const cogSecRoute = routes.find(route => route.match(
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/cogsec`,
    ))!;
    const cogSec = await invoke(
      cogSecRoute,
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/cogsec`,
      { decision: 'approved' },
      CREDENTIALS.cogSecToken,
    );
    expect(cogSec.status).toBe(201);
    expect(JSON.parse(cogSec.body).reviewer.role).toBe('cogsec');

    const reviewed = await invoke(
      decisionRoute,
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/decision`,
      { decision: 'approve' },
      CREDENTIALS.reviewerToken,
    );
    expect(reviewed.status).toBe(200);
    expect(JSON.parse(reviewed.body)).toMatchObject({ status: 'approved', reviewer: { role: 'reviewer' } });
    expect(service.readArtifact('guide.md').content).toBe('# Reviewed\n');
  });

  it('rejects JSON identity assertions and missing credentials', async () => {
    const { routes } = fixture();
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;
    const assertedIdentity = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'guide.md',
      content: 'x',
      mediaType: 'text/plain',
      provenance: 'source',
      actorId: 'forged-operator',
    }, CREDENTIALS.proposerToken);
    expect(assertedIdentity.status).toBe(400);
    expect(assertedIdentity.body).toContain('identity claims are forbidden');

    const missingCredential = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'guide.md',
      content: 'x',
      mediaType: 'text/plain',
      provenance: 'source',
    });
    expect(missingCredential.status).toBe(401);
  });

  it('refuses to start with shared credentials that are not independent', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shared-routes-'));
    roots.push(root);
    mkdirSync(join(root, 'transactions'), { recursive: true });
    const same = 'same-credential-aaaaaaaaaaaaaaaaaa';
    expect(() => new AdminSharedWorkspaceService(root, {
      proposerToken: same,
      reviewerToken: same,
      cogSecToken: 'different-cogsec-cccccccccccccccc',
    })).toThrow(/credentials must be distinct/);
  });
});

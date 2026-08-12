import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAdminSharedWorkspaceRoutes } from './api-routes-shared-workspace.js';
import { AdminSharedWorkspaceService } from './services/shared-workspace-service.js';
import type { AdminApiRoute } from './routes/types.js';
import type { GardenRequestContext } from './garden-request-context.js';
import type { AdminAutomataService } from './services/automata-service.js';

class CapturingResponse {
  status = 0;
  body = '';
  writeHead(status: number): this { this.status = status; return this; }
  end(body?: string): this { this.body = body ?? ''; return this; }
}

function makeRequest(url: string, body: string): IncomingMessage {
  return {
    url,
    headers: {
      host: 'localhost',
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
  context?: GardenRequestContext,
): Promise<CapturingResponse> {
  const response = new CapturingResponse();
  const params = route.match(new URL(url, 'http://localhost').pathname);
  route.handle(
    makeRequest(url, JSON.stringify(body)),
    response as unknown as ServerResponse,
    params ?? {},
    context,
  );
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('shared workspace admin write authentication', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(
    automataService?: AdminAutomataService,
    automataLessonProposalPolicy = { maxChangeChars: 80, maxSourceIds: 2 },
  ): {
    service: AdminSharedWorkspaceService;
    routes: AdminApiRoute[];
  } {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shared-routes-'));
    roots.push(root);
    for (const path of [
      'artifacts', 'reviews', 'cogsec-decisions', 'provenance/events', 'transactions', '.locks',
    ]) mkdirSync(join(root, path), { recursive: true });
    const service = new AdminSharedWorkspaceService(root);
    return {
      service,
      routes: buildAdminSharedWorkspaceRoutes({
        service,
        automataService,
        automataLessonProposalPolicy,
        withBody: (req, _res, callback) => {
          let body = '';
          req.on('data', chunk => { body += String(chunk); });
          req.on('end', () => callback(body));
        },
      }),
    };
  }

  it('derives proposer, CogSec, and reviewer identities from signed request contexts', async () => {
    const { service, routes } = fixture();
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;
    const proposed = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'guide.md',
      content: '# Reviewed\n',
      mediaType: 'text/markdown',
      provenance: 'operator source',
    }, context('POST /api/admin/shared-workspace/proposals'));
    expect(proposed.status).toBe(201);
    const proposal = JSON.parse(proposed.body);
    expect(proposal.proposer).toMatchObject({ role: 'proposer' });
    expect(proposal.proposer.id).toContain('principal-a');

    const decisionRoute = routes.find(route => route.match(
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/decision`,
    ))!;
    const wrongRole = await invoke(
      decisionRoute,
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/decision`,
      { decision: 'approve' },
      context('POST /api/admin/shared-workspace/proposals'),
    );
    expect(wrongRole.status).toBe(401);

    const cogSecRoute = routes.find(route => route.match(
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/cogsec`,
    ))!;
    const cogSec = await invoke(
      cogSecRoute,
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/cogsec`,
      { decision: 'approved' },
      context(
        'POST /api/admin/shared-workspace/reviews/:reviewId/cogsec',
        ['cogsec'],
        'principal-cogsec',
      ),
    );
    expect(cogSec.status).toBe(201);
    expect(JSON.parse(cogSec.body).reviewer.role).toBe('cogsec');

    const reviewed = await invoke(
      decisionRoute,
      `/api/admin/shared-workspace/reviews/${proposal.reviewId}/decision`,
      { decision: 'approve' },
      context(
        'POST /api/admin/shared-workspace/reviews/:reviewId/decision',
        ['cogsec', 'independent_reviewer'],
        'principal-reviewer',
      ),
    );
    expect(reviewed.status).toBe(200);
    expect(JSON.parse(reviewed.body)).toMatchObject({ status: 'approved', reviewer: { role: 'reviewer' } });
    expect(service.readArtifact('guide.md').content).toBe('# Reviewed\n');
  });

  it('rejects JSON identity assertions and missing trusted contexts', async () => {
    const { routes } = fixture();
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;
    const assertedIdentity = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'guide.md',
      content: 'x',
      mediaType: 'text/plain',
      provenance: 'source',
      actorId: 'forged-operator',
    }, context('POST /api/admin/shared-workspace/proposals'));
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

  it('rejects client-built artifacts that bypass Automata proposal validation', async () => {
    const { routes } = fixture();
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;
    const response = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'automata/lesson-proposals/client-built.json',
      content: '{}',
      mediaType: 'application/json',
      provenance: 'automata-lesson:client-built',
    }, context('POST /api/admin/shared-workspace/proposals'));

    expect(response.status).toBe(400);
    expect(response.body).toContain('server-validated proposal action');
  });

  it('builds Automata diffs server-side from the current redacted lesson group', async () => {
    const lessonGroup = {
      groupId: `automata-lesson:v1:${'a'.repeat(64)}`,
      automatonClass: 'subagent.bounded',
      promptRevision: 'sha256:prompt-r1',
      toolName: 'repo',
      failureCategory: 'missing-instruction',
      lessonCode: 'read-before-edit',
      sourceCount: 2,
      support: 'supported' as const,
      evidenceQuality: 'verified' as const,
      sourceFindingIds: ['finding-1', 'finding-2'],
      evidenceIds: [`sha256:${'b'.repeat(64)}`],
      sourceTraceTruncated: false,
      contradiction: { present: false, sourceFindingIds: [] },
      inferenceOnly: false,
      interpretation: 'candidate-pattern-not-verified-defect' as const,
    };
    const automataService = {
      getSnapshot: async () => ({ lessons: { groups: [lessonGroup] } }) as never,
    } satisfies AdminAutomataService;
    const { service, routes } = fixture(automataService);
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;

    const response = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      kind: 'automata_lesson',
      groupId: lessonGroup.groupId,
      target: { kind: 'instruction', id: 'memory.extraction', baseRevision: 'sha256:prompt-r1' },
      before: 'Inspect the task.',
      after: 'Inspect the task.\nRead relevant files before editing.',
    }, context('POST /api/admin/shared-workspace/proposals'));

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'pending' });
    const [review] = service.getSnapshot().reviews;
    expect(review?.artifactPath).toMatch(/^automata\/lesson-proposals\/[0-9a-f]{64}\.json$/u);
    expect(JSON.parse(review!.content)).toMatchObject({
      state: 'review_required',
      source: { sourceFindingIds: ['finding-1', 'finding-2'] },
      safeguards: { appliesChange: false, promotesPrimaryMemory: false, publishesTelemetry: false },
    });
    expect(review?.content).toContain('+Read relevant files before editing.');
  });

  it('enforces owner limits independently of the submitted Automata lesson request', async () => {
    const lessonGroup = {
      groupId: `automata-lesson:v1:${'a'.repeat(64)}`,
      automatonClass: 'subagent.bounded',
      promptRevision: 'sha256:prompt-r1',
      toolName: 'repo',
      failureCategory: 'missing-instruction',
      lessonCode: 'read-before-edit',
      sourceCount: 2,
      support: 'supported' as const,
      evidenceQuality: 'verified' as const,
      sourceFindingIds: ['finding-1', 'finding-2'],
      evidenceIds: [`sha256:${'b'.repeat(64)}`],
      sourceTraceTruncated: false,
      contradiction: { present: false, sourceFindingIds: [] },
      inferenceOnly: false,
      interpretation: 'candidate-pattern-not-verified-defect' as const,
    };
    const automataService = {
      getSnapshot: async () => ({ lessons: { groups: [lessonGroup] } }) as never,
    } satisfies AdminAutomataService;
    const proposal = {
      kind: 'automata_lesson',
      groupId: lessonGroup.groupId,
      target: { kind: 'instruction', id: 'memory.extraction', baseRevision: 'sha256:prompt-r1' },
      before: 'Inspect the task.',
      after: 'Inspect the task. Read relevant files before editing.',
    };

    const sourceBound = fixture(automataService, { maxChangeChars: 80, maxSourceIds: 1 });
    const sourceResponse = await invoke(
      sourceBound.routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!,
      '/api/admin/shared-workspace/proposals',
      proposal,
      context('POST /api/admin/shared-workspace/proposals'),
    );
    expect(sourceResponse.status).toBe(400);
    expect(sourceResponse.body).toContain('bounded source trace');
    expect(sourceBound.service.getSnapshot().reviews).toEqual([]);

    const changeBound = fixture(automataService, { maxChangeChars: 20, maxSourceIds: 2 });
    const changeResponse = await invoke(
      changeBound.routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!,
      '/api/admin/shared-workspace/proposals',
      proposal,
      context('POST /api/admin/shared-workspace/proposals'),
    );
    expect(changeResponse.status).toBe(400);
    expect(changeResponse.body).toContain('maxChangeChars');
    expect(changeBound.service.getSnapshot().reviews).toEqual([]);
  });

  it('does not accept a reusable browser credential as workflow identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shared-routes-'));
    roots.push(root);
    for (const path of ['artifacts', 'reviews', 'cogsec-decisions', 'provenance/events', 'transactions', '.locks']) {
      mkdirSync(join(root, path), { recursive: true });
    }
    const routes = buildAdminSharedWorkspaceRoutes({
      service: new AdminSharedWorkspaceService(root),
      withBody: (req, _res, callback) => {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => callback(body));
      },
    });
    const proposalRoute = routes.find(route => route.match('/api/admin/shared-workspace/proposals'))!;
    const response = await invoke(proposalRoute, '/api/admin/shared-workspace/proposals', {
      artifactPath: 'guide.md', content: 'x', mediaType: 'text/plain', provenance: 'source',
    });
    expect(response.status).toBe(401);
  });
});
function context(
  routeId: string,
  approvals: Array<'cogsec' | 'independent_reviewer'> = [],
  principalId = 'principal-a',
): GardenRequestContext {
  const strong = approvals.length > 0;
  const authorization = Object.freeze({
    action: 'shared_workspace.manage' as const,
    baseRole: 'admin' as const,
    resource: Object.freeze({ scope: 'governed_shared_workspace' as const, area: 'shared_workspace' as const }),
    subjectRelation: 'current_companion' as const,
    requirements: Object.freeze({
      assurance: strong ? 'escalated' as const : 'oauth' as const,
      confirmation: strong ? 'explicit' as const : 'none' as const,
      approvals: Object.freeze(approvals),
    }),
    publicAccess: 'never' as const,
    recoveryAccess: 'forbidden' as const,
  });
  return Object.freeze({
    kind: 'fleet_principal', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', authorizationEventId: 'event-a',
    resolvedAt: '2030-01-01T00:00:00.000Z', issuedAt: 1, expiresAt: 2,
    versions: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1 }),
    actor: Object.freeze({ kind: 'fleet_principal', principalId, provider: 'discord',
      providerSubjectId: '12345678901234567', contactId: 'contact-a', contactBindingId: 'binding-a',
      role: 'admin', operatorGrantId: 'grant-a', sessionRecordId: 'session-a',
      sessionAssurance: strong ? 'escalated' : 'oauth', accessMode: 'multi_admin' }),
    action: 'shared_workspace.manage',
    resource: Object.freeze({ routeId, scope: 'governed_shared_workspace', area: 'shared_workspace',
      companionId: '11111111-1111-4111-8111-111111111111', pathParams: Object.freeze({}), query: Object.freeze({}) }),
    subjectRelation: 'current_companion', authorization,
  });
}

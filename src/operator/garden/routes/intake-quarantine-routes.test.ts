// htm9.11 — Garden intake quarantine + firewall-policy route tests.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { AdminBodyReader } from './types.js';
import { buildAdminIntakeQuarantineRoutes } from './intake-quarantine-routes.js';
import type {
  AdminIntakeQuarantineItemView,
  AdminIntakeQuarantineService,
} from '../services/intake-quarantine-service.js';
import type { AdminSettingsService } from '../services/types.js';

class CapturingResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => {
      this.resolveDone = resolve;
    });
  }

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
    this.resolveDone();
  }
}

const SAMPLE_ITEM: AdminIntakeQuarantineItemView = {
  id: 'env-sample-000001',
  status: 'held',
  mode: 'enforce',
  sourceClass: 'web_fetch',
  sourceRiskTier: 'untrusted',
  originRef: 'https://suspect.example/page',
  riskLabels: ['injection/override_attempt'],
  scores: { 'l1-rule-engine': 1 },
  heldAt: '2025-06-15T12:00:00.000Z',
  expiresAt: '2025-06-22T12:00:00.000Z',
  ttlRemainingMs: 1_000,
  contentSha256: 'c'.repeat(64),
  rawTextTruncated: false,
  safeRepresentationAvailable: true,
  flywheelTarget: { kind: 'site', pattern: 'suspect.example' },
};

type AuditCall = { actionType: string; decision: string; narrative: string; details?: Array<string | null | undefined> };

async function invokeRoute(input: {
  quarantineService?: Partial<AdminIntakeQuarantineService>;
  settingsService?: Partial<AdminSettingsService>;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  auditCalls?: AuditCall[];
}): Promise<{ statusCode: number; body: unknown }> {
  const withBody: AdminBodyReader = (_req, _res, cb) => {
    cb(typeof input.body === 'string' ? input.body : JSON.stringify(input.body));
  };
  const routes = buildAdminIntakeQuarantineRoutes({
    quarantineService: (input.quarantineService ?? {}) as AdminIntakeQuarantineService,
    settingsService: (input.settingsService ?? {}) as AdminSettingsService,
    withBody,
    appendAuditTimelineEntry: (actionType, decision, narrative, details) => {
      input.auditCalls?.push({ actionType, decision, narrative, ...(details ? { details } : {}) });
    },
  });
  const route = routes.find(candidate => candidate.method === input.method && candidate.match(input.path));
  if (!route) {
    throw new Error(`Route not found: ${input.method} ${input.path}`);
  }
  const params = route.match(input.path) ?? {};
  const res = new CapturingResponse();
  route.handle({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, params);
  await res.done;
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as unknown,
  };
}

describe('admin intake quarantine routes (htm9.11)', () => {
  it('GET /api/admin/intake/policy returns the read-only policy view', async () => {
    const policy = { mode: 'enforce', quarantine: { itemTtlHours: 168, maxHeldItems: 500 } };
    const result = await invokeRoute({
      settingsService: { getIntakePolicyOverview: () => policy as never },
      method: 'GET',
      path: '/api/admin/intake/policy',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ policy });
  });

  it('GET /api/admin/intake/quarantine lists the queue', async () => {
    const result = await invokeRoute({
      quarantineService: { listItems: () => ({ items: [SAMPLE_ITEM] }) },
      method: 'GET',
      path: '/api/admin/intake/quarantine',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ items: [SAMPLE_ITEM] });
  });

  it('GET /api/admin/intake/quarantine/:id returns the detail or 404', async () => {
    const detail = { ...SAMPLE_ITEM, rawText: 'raw', extractedFields: {}, transitions: [] };
    const getItem = vi.fn((id: string) => (id === SAMPLE_ITEM.id ? detail : undefined));
    const found = await invokeRoute({
      quarantineService: { getItem },
      method: 'GET',
      path: `/api/admin/intake/quarantine/${SAMPLE_ITEM.id}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.body).toEqual({ item: detail });
    expect(getItem).toHaveBeenCalledWith(SAMPLE_ITEM.id);

    const missing = await invokeRoute({
      quarantineService: { getItem },
      method: 'GET',
      path: '/api/admin/intake/quarantine/unknown-id-0001',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('POST :id/confirm issues a token and writes a needs_approval audit entry', async () => {
    const beginDecision = vi.fn().mockReturnValue({
      ok: true,
      confirmToken: 'f'.repeat(64),
      expiresAtMs: 123,
      summary: 'This will release the RAW held content...',
    });
    const auditCalls: AuditCall[] = [];
    const result = await invokeRoute({
      quarantineService: { beginDecision },
      method: 'POST',
      path: `/api/admin/intake/quarantine/${SAMPLE_ITEM.id}/confirm`,
      body: { action: 'release_raw', sourceList: 'always_allow' },
      auditCalls,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ ok: true, confirmToken: 'f'.repeat(64) });
    expect(beginDecision).toHaveBeenCalledWith({
      id: SAMPLE_ITEM.id,
      action: 'release_raw',
      sourceList: 'always_allow',
    });
    expect(auditCalls).toEqual([expect.objectContaining({
      actionType: 'gateway_policy',
      decision: 'needs_approval',
      narrative: expect.stringContaining('step 1 of 2'),
    })]);
  });

  it('POST :id/decide executes with the token and audits the full decision context', async () => {
    const resolveDecision = vi.fn().mockReturnValue({
      ok: true,
      item: { ...SAMPLE_ITEM, status: 'released_raw' },
      message: 'Applied release_raw',
      cogSecCaseId: 'cogsec_case_9',
    });
    const auditCalls: AuditCall[] = [];
    const result = await invokeRoute({
      quarantineService: { resolveDecision },
      method: 'POST',
      path: `/api/admin/intake/quarantine/${SAMPLE_ITEM.id}/decide`,
      body: {
        action: 'release_raw',
        confirmToken: 'f'.repeat(64),
        reason: 'reviewed; benign',
      },
      auditCalls,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ ok: true, message: 'Applied release_raw' });
    expect(resolveDecision).toHaveBeenCalledWith({
      id: SAMPLE_ITEM.id,
      action: 'release_raw',
      confirmToken: 'f'.repeat(64),
      reason: 'reviewed; benign',
    });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ actionType: 'gateway_policy', decision: 'allowed' });
    const details = (auditCalls[0].details ?? []).filter(Boolean);
    expect(details).toEqual(expect.arrayContaining([
      `envelopeId=${SAMPLE_ITEM.id}`,
      'action=release_raw',
      `sha256=${'c'.repeat(64)}`,
      'cogSecCaseId=cogsec_case_9',
      expect.stringContaining('reason='),
    ]));
  });

  it('propagates service refusals with their status and a denied audit entry', async () => {
    const resolveDecision = vi.fn().mockReturnValue({
      ok: false,
      status: 403,
      message: 'Missing or invalid confirm token; request a fresh confirmation first',
    });
    const auditCalls: AuditCall[] = [];
    const result = await invokeRoute({
      quarantineService: { resolveDecision },
      method: 'POST',
      path: `/api/admin/intake/quarantine/${SAMPLE_ITEM.id}/decide`,
      body: { action: 'discard', confirmToken: 'x', reason: 'r' },
      auditCalls,
    });
    expect(result.statusCode).toBe(403);
    expect((result.body as { error: string }).error).toContain('confirm token');
    expect(auditCalls[0].decision).toBe('denied');
  });

  it('rejects invalid decision bodies fail-closed with denied audit entries', async () => {
    const resolveDecision = vi.fn();
    const beginDecision = vi.fn();
    const cases: Array<{ path: string; body: unknown }> = [
      // decide: missing token/reason, bad action, unknown keys
      { path: 'decide', body: { action: 'release_raw' } },
      { path: 'decide', body: { action: 'release_raw', confirmToken: 't' } },
      { path: 'decide', body: { action: 'obliterate', confirmToken: 't', reason: 'r' } },
      { path: 'decide', body: { action: 'discard', confirmToken: 't', reason: 'r', force: true } },
      { path: 'decide', body: { action: 'discard', confirmToken: 't', reason: 'r', sourceList: 'nuke' } },
      // confirm: token/reason are not allowed at step 1
      { path: 'confirm', body: { action: 'discard', confirmToken: 't' } },
      { path: 'confirm', body: { action: 'nope' } },
      { path: 'confirm', body: '{not json' },
    ];
    for (const testCase of cases) {
      const auditCalls: AuditCall[] = [];
      const result = await invokeRoute({
        quarantineService: { resolveDecision, beginDecision },
        method: 'POST',
        path: `/api/admin/intake/quarantine/${SAMPLE_ITEM.id}/${testCase.path}`,
        body: testCase.body,
        auditCalls,
      });
      expect(result.statusCode, JSON.stringify(testCase)).toBe(400);
      expect(auditCalls[0]?.decision, JSON.stringify(testCase)).toBe('denied');
    }
    expect(resolveDecision).not.toHaveBeenCalled();
    expect(beginDecision).not.toHaveBeenCalled();
  });

  it('the detail matcher does not swallow the confirm/decide POST paths', async () => {
    const routes = buildAdminIntakeQuarantineRoutes({
      quarantineService: {} as AdminIntakeQuarantineService,
      settingsService: {} as AdminSettingsService,
      withBody: (_req, _res, cb) => cb('{}'),
      appendAuditTimelineEntry: undefined,
    });
    const detailRoute = routes.find(route => route.method === 'GET'
      && route.match('/api/admin/intake/quarantine/some-id'));
    expect(detailRoute).toBeDefined();
    expect(detailRoute?.match('/api/admin/intake/quarantine/some-id/confirm')).toBeNull();
    expect(detailRoute?.match('/api/admin/intake/quarantine/some-id/decide')).toBeNull();
  });
});

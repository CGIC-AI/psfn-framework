// htm9.13 — Garden intake source-list route tests.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { IntakeSourceListsConfig } from '../../../system/config/intake-policy-config.js';
import type { AdminBodyReader } from './types.js';
import { buildAdminIntakeSourceListRoutes } from './intake-source-list-routes.js';
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

const SAMPLE_LISTS: IntakeSourceListsConfig = {
  trustedSites: [{ pattern: '*.arxiv.org', addedBy: 'operator', addedAt: 1_700_000_000_000 }],
  deniedSites: [],
  trustedPeople: [],
  deniedPeople: [],
};

type AuditCall = { decision: string; narrative: string };

async function invokeRoute(
  service: Partial<AdminSettingsService>,
  method: 'GET' | 'POST',
  body: unknown,
  auditCalls?: AuditCall[],
): Promise<{ statusCode: number; body: unknown }> {
  const withBody: AdminBodyReader = (_req, _res, cb) => {
    cb(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const routes = buildAdminIntakeSourceListRoutes({
    settingsService: service as AdminSettingsService,
    withBody,
    appendAuditTimelineEntry: (actionType, decision, narrative) => {
      expect(actionType).toBe('settings_change');
      auditCalls?.push({ decision, narrative });
    },
  });
  const path = '/api/admin/intake/source-lists';
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  if (!route) {
    throw new Error(`Route not found: ${method} ${path}`);
  }
  const params = route.match(path) ?? {};
  const res = new CapturingResponse();
  route.handle({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, params);
  await res.done;
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as unknown,
  };
}

describe('admin intake source-list routes (htm9.13)', () => {
  it('lists the source lists', async () => {
    const result = await invokeRoute({ getIntakeSourceLists: () => SAMPLE_LISTS }, 'GET', undefined);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ lists: SAMPLE_LISTS });
  });

  it('adds an entry through the settings service and audit-logs it', async () => {
    const mutateIntakeSourceList = vi.fn().mockReturnValue({ ok: true, message: 'added' });
    const auditCalls: AuditCall[] = [];
    const result = await invokeRoute({
      mutateIntakeSourceList,
      getIntakeSourceLists: () => SAMPLE_LISTS,
    }, 'POST', {
      action: 'add',
      list: 'trustedSites',
      pattern: '*.arxiv.org',
      note: 'preprints',
    }, auditCalls);
    expect(result.statusCode).toBe(200);
    expect(mutateIntakeSourceList).toHaveBeenCalledWith({
      action: 'add',
      list: 'trustedSites',
      pattern: '*.arxiv.org',
      note: 'preprints',
    });
    expect(result.body).toMatchObject({ ok: true, lists: { trustedSites: [expect.any(Object)] } });
    expect(auditCalls).toEqual([
      { decision: 'allowed', narrative: expect.stringContaining('added an intake source-list entry') },
    ]);
  });

  it('removes an entry and audit-logs it', async () => {
    const mutateIntakeSourceList = vi.fn().mockReturnValue({ ok: true, message: 'removed' });
    const auditCalls: AuditCall[] = [];
    const result = await invokeRoute({
      mutateIntakeSourceList,
      getIntakeSourceLists: () => SAMPLE_LISTS,
    }, 'POST', { action: 'remove', list: 'trustedSites', pattern: '*.arxiv.org' }, auditCalls);
    expect(result.statusCode).toBe(200);
    expect(auditCalls[0].decision).toBe('allowed');
    expect(auditCalls[0].narrative).toContain('removed an intake source-list entry');
  });

  it('rejects unknown fields, bad actions, and unknown lists fail-closed', async () => {
    const mutateIntakeSourceList = vi.fn();
    for (const payload of [
      { action: 'add', list: 'trustedSites', pattern: 'x.org', regex: '.*' },
      { action: 'upsert', list: 'trustedSites', pattern: 'x.org' },
      { action: 'add', list: 'trustedRegexes', pattern: 'x.org' },
      { action: 'add', list: 'trustedSites', pattern: '' },
      { action: 'add', list: 'trustedSites', pattern: 'x.org', note: 42 },
    ]) {
      const auditCalls: AuditCall[] = [];
      const result = await invokeRoute({ mutateIntakeSourceList }, 'POST', payload, auditCalls);
      expect(result.statusCode, JSON.stringify(payload)).toBe(400);
      expect(auditCalls[0]?.decision).toBe('denied');
    }
    expect(mutateIntakeSourceList).not.toHaveBeenCalled();
  });

  it('propagates owner-file validation failures as 400s with a denied audit entry', async () => {
    const mutateIntakeSourceList = vi.fn().mockReturnValue({
      ok: false,
      message: "sourceLists.trustedSites pattern 'not a host' is malformed: exact host or '*.domain.tld' suffix only (no schemes, ports, paths, or regex)",
    });
    const auditCalls: AuditCall[] = [];
    const result = await invokeRoute({ mutateIntakeSourceList }, 'POST', {
      action: 'add',
      list: 'trustedSites',
      pattern: 'not a host',
    }, auditCalls);
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: string }).error).toContain('malformed');
    expect(auditCalls[0].decision).toBe('denied');
  });

  it('rejects invalid JSON payloads', async () => {
    const result = await invokeRoute({}, 'POST', '{not json');
    expect(result.statusCode).toBe(400);
  });
});

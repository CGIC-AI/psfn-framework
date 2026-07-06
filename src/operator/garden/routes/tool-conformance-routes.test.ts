import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildAdminToolConformanceRoutes } from './tool-conformance-routes.js';
import type { AdminToolConformanceService } from '../services/tool-conformance-service.js';
import { ToolConformanceHarnessError, type ToolConformanceRunResult } from '../../../core/agent/tool-conformance/types.js';
import type { AdminBodyReader } from './types.js';

class CapturingResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
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

const withBody: AdminBodyReader = (_req, _res, cb) => cb('');
const withTriggerBody = (trigger: string): AdminBodyReader => (_req, _res, cb) => cb(JSON.stringify({ trigger }));

async function invoke(
  method: 'GET' | 'POST',
  path: string,
  service: AdminToolConformanceService | null,
  bodyReader: AdminBodyReader = withBody,
): Promise<{ statusCode: number; body: unknown }> {
  const routes = buildAdminToolConformanceRoutes({ toolConformance: service, withBody: bodyReader });
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  if (!route) throw new Error(`Route not found: ${method} ${path}`);
  const res = new CapturingResponse();
  route.handle({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, route.match(path) ?? {});
  await res.done;
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

function sampleResult(trigger: ToolConformanceRunResult['trigger']): ToolConformanceRunResult {
  return { schemaVersion: 1, ranAt: 1, trigger, results: [] };
}

describe('admin tool-conformance routes', () => {
  it('GET latest returns the persisted run', async () => {
    const service: AdminToolConformanceService = {
      run: async () => sampleResult('manual'),
      getLatest: () => sampleResult('manual'),
    };
    const response = await invoke('GET', '/api/admin/tool-conformance/latest', service);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(sampleResult('manual'));
  });

  it('GET latest returns 404 when no run recorded', async () => {
    const service: AdminToolConformanceService = { run: async () => sampleResult('manual'), getLatest: () => null };
    const response = await invoke('GET', '/api/admin/tool-conformance/latest', service);
    expect(response.statusCode).toBe(404);
  });

  it('POST run triggers a sweep and returns the result', async () => {
    let captured: string | undefined;
    const service: AdminToolConformanceService = {
      run: async (trigger) => { captured = trigger; return sampleResult(trigger); },
      getLatest: () => null,
    };
    const response = await invoke('POST', '/api/admin/tool-conformance/run', service, withTriggerBody('post_rollout'));
    expect(captured).toBe('post_rollout');
    expect(response.statusCode).toBe(200);
    expect((response.body as ToolConformanceRunResult).trigger).toBe('post_rollout');
  });

  it('POST run rejects an invalid trigger with 400', async () => {
    const service: AdminToolConformanceService = { run: async () => sampleResult('manual'), getLatest: () => null };
    const response = await invoke('POST', '/api/admin/tool-conformance/run', service, withTriggerBody('bogus'));
    expect(response.statusCode).toBe(400);
  });

  it('POST run surfaces a harness fault as 500', async () => {
    const service: AdminToolConformanceService = {
      run: async () => { throw new ToolConformanceHarnessError('unclassified live tools: foo'); },
      getLatest: () => null,
    };
    const response = await invoke('POST', '/api/admin/tool-conformance/run', service);
    expect(response.statusCode).toBe(500);
    expect((response.body as { error: string }).error).toBe('Tool conformance harness fault');
  });

  it('fails closed with 503 when the backend is unavailable', async () => {
    const get = await invoke('GET', '/api/admin/tool-conformance/latest', null);
    expect(get.statusCode).toBe(503);
    const post = await invoke('POST', '/api/admin/tool-conformance/run', null);
    expect(post.statusCode).toBe(503);
  });
});

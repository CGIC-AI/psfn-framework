import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { AdminBodyReader } from './types.js';
import { buildAdminSessionRoutes } from './session-routes.js';
import type { AdminSessionService } from '../services/types.js';

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

function makeRoutes(service: Partial<AdminSessionService>, body: unknown) {
  const withBody: AdminBodyReader = (_req, _res, cb) => {
    cb(JSON.stringify(body));
  };
  return buildAdminSessionRoutes({
    sessionService: service as AdminSessionService,
    withBody,
  });
}

async function invokeRoute(
  service: Partial<AdminSessionService>,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const routes = makeRoutes(service, body);
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

describe('admin session search routes', () => {
  function findFirstMatch(service: Partial<AdminSessionService>, path: string) {
    const routes = makeRoutes(service, undefined);
    return routes.find(candidate => candidate.method === 'GET' && candidate.match(path));
  }

  it('routes session search ahead of the generic messages route and forwards query and limit', async () => {
    const searchSessionMessages = vi.fn().mockResolvedValue({
      sessionId: 'api:target',
      query: 'poison',
      limit: 50,
      hits: [],
    });
    const getSessionMessages = vi.fn();
    const path = '/api/admin/sessions/api%3Atarget/search';
    const route = findFirstMatch({ searchSessionMessages, getSessionMessages }, path);
    if (!route) throw new Error('search route not matched');

    const res = new CapturingResponse();
    route.handle(
      { headers: {}, url: `${path}?q=poison&limit=50` } as IncomingMessage,
      res as unknown as ServerResponse,
      route.match(path) ?? {},
    );
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ sessionId: 'api:target', query: 'poison' });
    expect(searchSessionMessages).toHaveBeenCalledWith('api:target', 'poison', 50);
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects session search without a query before service execution', async () => {
    const searchSessionMessages = vi.fn();
    const path = '/api/admin/sessions/api%3Atarget/search';
    const route = findFirstMatch({ searchSessionMessages }, path);
    if (!route) throw new Error('search route not matched');

    const res = new CapturingResponse();
    route.handle(
      { headers: {}, url: path } as IncomingMessage,
      res as unknown as ServerResponse,
      route.match(path) ?? {},
    );
    await res.done;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'q is required' });
    expect(searchSessionMessages).not.toHaveBeenCalled();
  });
});

describe('admin session CogSec routes', () => {
  it('parses CogSec preview input and forwards the safe remediation contract', async () => {
    const previewCogSecRemediation = vi.fn().mockResolvedValue({
      ok: true,
      counts: { l0Rows: 1 },
    });
    const body = {
      sourceChannelId: 'discord:guild:room',
      affectedMessageRanges: [{
        sourceChannelId: 'discord:guild:room',
        logicalSessionId: 'discord:guild:room:old',
        messageIds: [7],
      }],
      type: 'content_poisoning',
      severity: 'high',
      reason: 'operator-selected contaminated row',
      actor: 'operator:garden',
      cutEpoch: false,
    };

    const response = await invokeRoute(
      { previewCogSecRemediation },
      'POST',
      '/api/admin/session-routes/cogsec/preview',
      body,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, counts: { l0Rows: 1 } });
    expect(previewCogSecRemediation).toHaveBeenCalledWith({
      sourceChannelId: 'discord:guild:room',
      affectedMessageRanges: [{
        sourceChannelId: 'discord:guild:room',
        logicalSessionId: 'discord:guild:room:old',
        messageIds: [7],
      }],
      type: 'content_poisoning',
      severity: 'high',
      reason: 'operator-selected contaminated row',
      actor: 'operator:garden',
      cutEpoch: false,
    });
  });

  it('rejects malformed CogSec route payloads before service execution', async () => {
    const previewCogSecRemediation = vi.fn();

    const response = await invokeRoute(
      { previewCogSecRemediation },
      'POST',
      '/api/admin/session-routes/cogsec/preview',
      {
        sourceChannelId: 'discord:guild:room',
        messageIds: [7],
        type: 'content_poisoning',
        severity: 'high',
        reason: 'operator-selected contaminated row',
        cutEpoch: 'false',
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      message: 'cutEpoch must be a boolean',
    });
    expect(previewCogSecRemediation).not.toHaveBeenCalled();
  });
});

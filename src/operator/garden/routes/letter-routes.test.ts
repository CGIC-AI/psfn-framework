import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import type { LetterRecord } from '../../../core/letters/contracts.js';
import type { AdminLetterService } from '../services/types.js';
import { buildAdminLetterRoutes } from './letter-routes.js';

const LETTER: LetterRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  author: 'partner',
  recipient: 'companion',
  subject: 'For later',
  body: 'An unhurried thought.',
  state: 'placed',
  createdAt: 100,
  updatedAt: 100,
  placedAt: 100,
};

class CapturingResponse extends ServerResponse {
  status = 0;
  body = '';
  readonly done: Promise<void>;
  private finishCapture: () => void = () => undefined;

  constructor(req: IncomingMessage) {
    super(req);
    this.done = new Promise(resolve => { this.finishCapture = resolve; });
  }

  override writeHead(statusCode: number): this {
    this.status = statusCode;
    return this;
  }

  override end(chunk?: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void): this {
    this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk ?? []).toString(encoding);
    callback?.();
    this.finishCapture();
    return this;
  }
}

function serviceStub(): AdminLetterService {
  return {
    compose: vi.fn(async () => LETTER),
    list: vi.fn(async () => [LETTER]),
    read: vi.fn(async () => ({ ...LETTER, state: 'read', readAt: 200 })),
    place: vi.fn(async () => LETTER),
    archive: vi.fn(async () => ({ ...LETTER, state: 'archived', archivedAt: 300 })),
    countWaiting: vi.fn(async () => 1),
  };
}

async function invoke(input: {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  service: AdminLetterService;
}): Promise<{ status: number; body: unknown }> {
  const requestPath = input.path.split('?')[0]!;
  const routes = buildAdminLetterRoutes({
    letterService: input.service,
    withBody: (_req, _res, callback) => callback(JSON.stringify(input.body)),
  });
  const route = routes.find(candidate => candidate.method === input.method && candidate.match(requestPath));
  if (!route) throw new Error(`Letter route not found: ${input.method} ${requestPath}`);
  const req = new IncomingMessage(new Socket());
  req.url = input.path;
  const res = new CapturingResponse(req);
  route.handle(req, res, route.match(requestPath) ?? {});
  await res.done;
  return { status: res.status, body: JSON.parse(res.body) as unknown };
}

describe('admin letter routes', () => {
  it('lists the partner bin with a quiet waiting count', async () => {
    const service = serviceStub();
    const result = await invoke({
      method: 'GET', path: '/api/admin/letters?direction=inbox', service,
    });

    expect(result).toMatchObject({ status: 200, body: { letters: [LETTER], waitingCount: 1 } });
    expect(service.list).toHaveBeenCalledWith({ party: 'partner', direction: 'inbox' });
  });

  it('binds Garden composition to partner authorship and never accepts an author field', async () => {
    const service = serviceStub();
    const result = await invoke({
      method: 'POST',
      path: '/api/admin/letters',
      body: { subject: 'For later', body: 'An unhurried thought.' },
      service,
    });

    expect(result.status).toBe(201);
    expect(service.compose).toHaveBeenCalledWith({
      author: 'partner', recipient: 'companion', subject: 'For later', body: 'An unhurried thought.',
    });

    const rejected = await invoke({
      method: 'POST',
      path: '/api/admin/letters',
      body: { author: 'machinery', subject: 'x', body: 'y' },
      service,
    });
    expect(rejected.status).toBe(400);
  });

  it('exposes only place, recipient-read, and archive transitions', async () => {
    const service = serviceStub();
    const base = `/api/admin/letters/${LETTER.id}`;
    expect((await invoke({ method: 'POST', path: `${base}/place`, service })).status).toBe(200);
    expect((await invoke({ method: 'POST', path: `${base}/read`, service })).status).toBe(200);
    expect((await invoke({ method: 'POST', path: `${base}/archive`, service })).status).toBe(200);
    expect(service.read).toHaveBeenCalledWith(LETTER.id, 'partner');
  });
});

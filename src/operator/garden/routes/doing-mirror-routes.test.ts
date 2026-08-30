import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { DoingMirrorItem } from '../../../core/doing-mirror/contracts.js';
import type { AdminDoingMirrorService } from '../services/types.js';
import { buildAdminDoingMirrorRoutes } from './doing-mirror-routes.js';

const ITEM = {
  source: {
    itemType: 'wishlist',
    itemId: '9863edac-42bd-4b57-a693-fde2f85ffbd1',
    ref: 'wish:9863edac-42bd-4b57-a693-fde2f85ffbd1',
    title: 'Plant a moon garden',
    createdAt: 100,
    origin: { kind: 'companion', provenanceRefs: ['wish:source'] },
  },
  disposition: {
    itemType: 'wishlist',
    itemId: '9863edac-42bd-4b57-a693-fde2f85ffbd1',
    state: 'open',
    version: 0,
    updatedAt: 100,
    updatedBy: 'companion',
  },
} satisfies DoingMirrorItem;

function serviceStub(): AdminDoingMirrorService {
  return {
    list: vi.fn(async () => [ITEM]),
    get: vi.fn(async () => ITEM),
    transition: vi.fn(async input => ({
      ...ITEM,
      disposition: {
        itemType: input.itemType,
        itemId: input.itemId,
        state: input.state,
        version: 1,
        updatedAt: 200,
        updatedBy: 'partner',
        notification: { letterId: 'letter-1', subject: input.subject, body: input.body, deliveredAt: 200 },
      },
    } as DoingMirrorItem)),
  };
}

async function invoke(input: {
  method: 'GET' | 'POST';
  path: string;
  service?: AdminDoingMirrorService;
  body?: unknown;
}) {
  const routes = buildAdminDoingMirrorRoutes({
    doingMirrorService: input.service,
    withBody: (_req, _res, cb) => cb(JSON.stringify(input.body ?? {})),
  });
  const route = routes.find(candidate => candidate.method === input.method && candidate.match(input.path));
  if (!route) throw new Error('route not found');
  const params = route.match(input.path) ?? {};
  const req = Object.assign(new EventEmitter(), { url: input.path }) as IncomingMessage;
  let status = 0;
  let body = '';
  const res = {
    writeHead: vi.fn((code: number) => { status = code; }),
    end: vi.fn((chunk?: string) => { body = chunk ?? ''; }),
    setHeader: vi.fn(),
  } as unknown as ServerResponse;
  route.handle(req, res, params);
  await vi.waitFor(() => expect((res.end as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

describe('admin doing-mirror routes', () => {
  it('lists source-backed dispositions and fails closed without the backend', async () => {
    const service = serviceStub();
    await expect(invoke({ method: 'GET', path: '/api/admin/doing-mirror', service }))
      .resolves.toMatchObject({ status: 200, body: { items: [ITEM] } });
    await expect(invoke({ method: 'GET', path: '/api/admin/doing-mirror' }))
      .resolves.toMatchObject({ status: 503 });
  });

  it('passes exact Partner-authored disposition and Letter text to the service', async () => {
    const service = serviceStub();
    const itemPath = `/api/admin/doing-mirror/wishlist/${ITEM.source.itemId}`;
    const result = await invoke({
      method: 'POST',
      path: itemPath,
      service,
      body: {
        state: 'considering',
        reason: 'Checking dates.',
        subject: 'Your moon garden',
        body: 'I am considering this.',
      },
    });

    expect(result.status).toBe(200);
    expect(service.transition).toHaveBeenCalledWith({
      itemType: 'wishlist',
      itemId: ITEM.source.itemId,
      state: 'considering',
      reason: 'Checking dates.',
      subject: 'Your moon garden',
      body: 'I am considering this.',
    });
  });

  it('rejects decline without a reason before the service boundary', async () => {
    const service = serviceStub();
    const result = await invoke({
      method: 'POST',
      path: `/api/admin/doing-mirror/wishlist/${ITEM.source.itemId}`,
      service,
      body: { state: 'declined', subject: 'A decision', body: 'I cannot do this.' },
    });
    expect(result.status).toBe(400);
    expect(service.transition).not.toHaveBeenCalled();
  });
});

import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { CompanionWish } from '../../../faculties/wiki/personal-wishlist.js';
import type { AdminWishlistService } from '../services/types.js';
import { buildAdminWishlistRoutes } from './wishlist-routes.js';
import type { AdminBodyReader } from './types.js';

const WISH: CompanionWish = {
  schemaVersion: 1,
  kind: 'companion_wish',
  id: '66666666-6666-4666-8666-666666666666',
  ref: 'wish:66666666-6666-4666-8666-666666666666',
  text: 'Spend a day at the botanical garden',
  state: 'open',
  visibility: 'primary_contact',
  createdAt: '2026-07-16T12:00:00.000Z',
  updatedAt: '2026-07-16T12:00:00.000Z',
};

class CapturingResponse extends ServerResponse {
  status = 0;
  body = '';
  readonly done: Promise<void>;
  private finishCapture: () => void = () => undefined;

  constructor(req: IncomingMessage) {
    super(req);
    this.done = new Promise(resolve => {
      this.finishCapture = resolve;
    });
  }

  override writeHead(statusCode: number): this {
    this.status = statusCode;
    return this;
  }

  override end(
    chunk?: string | Uint8Array,
    encoding?: BufferEncoding,
    callback?: () => void,
  ): this {
    this.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk ?? []).toString(encoding);
    callback?.();
    this.finishCapture();
    return this;
  }
}

async function invoke(input: {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  service?: AdminWishlistService;
}): Promise<{ status: number; body: unknown }> {
  const withBody: AdminBodyReader = (_req, _res, callback) => callback(JSON.stringify(input.body));
  const routes = buildAdminWishlistRoutes({
    wishlistService: input.service,
    withBody,
  });
  const route = routes.find(candidate => candidate.method === input.method && candidate.match(input.path));
  if (!route) throw new Error(`Wishlist route not found: ${input.method} ${input.path}`);
  const req = new IncomingMessage(new Socket());
  const res = new CapturingResponse(req);
  route.handle(req, res, route.match(input.path) ?? {});
  await res.done;
  return { status: res.status, body: JSON.parse(res.body) };
}

function createService(): AdminWishlistService {
  return {
    listWishes: vi.fn(async () => ({ wishes: [WISH], boundary: 'personal wishlist' })),
    acknowledgeWish: vi.fn(async () => ({ ...WISH, state: 'acknowledged' })),
    respondToWish: vi.fn(async (_ref, response, _letter) => ({
      ...WISH,
      state: 'acknowledged',
      operatorResponse: response,
    })),
    convertWishToBead: vi.fn(async () => ({ ...WISH, state: 'planned', beadId: 'wish-22' })),
    completeWish: vi.fn(async () => ({ ...WISH, state: 'done' })),
  };
}

describe('admin wishlist routes', () => {
  it('lists canonical wishes and exposes unavailable state honestly', async () => {
    const service = createService();
    const listed = await invoke({ method: 'GET', path: '/api/admin/wishlist', service });
    expect(listed).toMatchObject({ status: 200, body: { wishes: [WISH] } });

    const unavailable = await invoke({ method: 'GET', path: '/api/admin/wishlist' });
    expect(unavailable).toMatchObject({ status: 503, body: { error: 'Wishlist backend unavailable' } });
  });

  it('routes acknowledge, respond, convert, and done mutations with their Letter text', async () => {
    const service = createService();
    const base = `/api/admin/wishlist/${WISH.id}`;
    const letter = { subject: 'About the botanical garden', body: 'I read this and I am on it.' };

    expect((await invoke({
      method: 'POST', path: `${base}/acknowledge`, body: letter, service,
    })).status).toBe(200);
    expect((await invoke({
      method: 'POST',
      path: `${base}/respond`,
      body: { response: 'I hear you.', ...letter },
      service,
    })).status).toBe(200);
    expect((await invoke({
      method: 'POST',
      path: `${base}/convert-to-bead`,
      body: { issueType: 'task', priority: 2 },
      service,
    })).status).toBe(200);
    expect((await invoke({
      method: 'POST', path: `${base}/done`, body: letter, service,
    })).status).toBe(200);

    // p4rmp: the exact Partner-authored Letter text reaches the disposition
    // lifecycle; the route never invents or reshapes it.
    expect(service.acknowledgeWish).toHaveBeenCalledWith(WISH.id, letter);
    expect(service.respondToWish).toHaveBeenCalledWith(WISH.id, 'I hear you.', letter);
    expect(service.completeWish).toHaveBeenCalledWith(WISH.id, letter);
    expect(service.convertWishToBead).toHaveBeenCalledWith(WISH.id, {
      issueType: 'task',
      priority: 2,
    });
  });

  it('rejects empty or unknown Letter fields on a disposition action', async () => {
    const service = createService();
    const base = `/api/admin/wishlist/${WISH.id}`;

    const blank = await invoke({
      method: 'POST', path: `${base}/done`, body: { subject: '   ', body: 'text' }, service,
    });
    expect(blank.status).toBe(400);
    expect(service.completeWish).not.toHaveBeenCalled();

    const unknown = await invoke({
      method: 'POST',
      path: `${base}/acknowledge`,
      body: { subject: 'A', body: 'B', response: 'nope' },
      service,
    });
    expect(unknown.status).toBe(400);
    expect(service.acknowledgeWish).not.toHaveBeenCalled();
  });

  it('rejects unknown and invalid mutation fields before service dispatch', async () => {
    const service = createService();
    const base = `/api/admin/wishlist/${WISH.id}`;

    const unknown = await invoke({
      method: 'POST',
      path: `${base}/respond`,
      body: { response: 'yes', notify: true },
      service,
    });
    expect(unknown.status).toBe(400);
    expect(service.respondToWish).not.toHaveBeenCalled();

    const invalid = await invoke({
      method: 'POST',
      path: `${base}/convert-to-bead`,
      body: { priority: 9 },
      service,
    });
    expect(invalid.status).toBe(400);
    expect(service.convertWishToBead).not.toHaveBeenCalled();
  });
});

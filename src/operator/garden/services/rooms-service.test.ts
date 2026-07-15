import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { MAX_ROOM_ROSTER_LIMIT } from '../../../core/contacts/types.js';
import { createTestPostgresContactStore } from '../../../test-support/postgres-contact-store.js';
import { buildAdminRoomRoutes } from '../api-routes-rooms.js';
import { createAdminRoomsService } from './rooms-service.js';

const ROOM_X = 'discord:room-x';
const ROOM_Y = 'discord:room-y';

async function seed(): Promise<{ contactStore: ContactStorePort }> {
  const { pool, store } = await createTestPostgresContactStore();
  const alice = await store.upsert({ displayName: 'Alice', trustLevel: 'trusted', relationshipType: 'friend' });
  const bob = await store.upsert({ displayName: 'Bob', trustLevel: 'regular', relationshipType: 'acquaintance' });
  const dave = await store.upsert({ displayName: 'Dave', trustLevel: 'trusted', relationshipType: 'friend' });
  await store.recordChannelActivity(alice.id, 'discord', ROOM_X, 'invite_only');
  await store.recordChannelActivity(bob.id, 'discord', ROOM_X, 'invite_only');
  await store.recordChannelActivity(dave.id, 'discord', ROOM_Y, 'private');
  for (const activity of pool.contactChannelActivity.values()) {
    if (activity.contact_id === bob.id) activity.last_seen = '2020-01-01T00:00:00.000Z';
    if (activity.contact_id === alice.id) activity.last_seen = '2024-06-01T00:00:00.000Z';
    if (activity.contact_id === dave.id) activity.last_seen = '2024-08-01T00:00:00.000Z';
  }
  return { contactStore: store };
}

class CapturingResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }
  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as IncomingMessage;
}

async function invokeRoute(
  routes: ReturnType<typeof buildAdminRoomRoutes>,
  method: string,
  path: string,
  url: string = path,
): Promise<CapturingResponse> {
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  const response = new CapturingResponse();
  const params = route?.match(path) ?? {};
  route?.handle(makeRequest(url), response as unknown as ServerResponse, params);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('AdminRoomsService', () => {
  it('lists known rooms with totals', async () => {
    const { contactStore } = await seed();
    const service = createAdminRoomsService({ contactStore });
    const data = await service.listRooms();
    expect(data.total).toBe(2);
    expect(data.rooms.map(r => r.channelId)).toEqual([ROOM_Y, ROOM_X]);
  });

  it('returns a paginated roster ordered by last-seen desc', async () => {
    const { contactStore } = await seed();
    const service = createAdminRoomsService({ contactStore });
    const params = new URLSearchParams({ channel: 'discord', limit: '1', offset: '0' });
    const page = await service.getRoomRoster(ROOM_X, params);
    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.members.map(m => m.displayName)).toEqual(['Alice']);
  });

  it('clamps an over-large limit to the hard maximum', async () => {
    const { contactStore } = await seed();
    const service = createAdminRoomsService({ contactStore });
    const data = await service.getRoomRoster(ROOM_X, new URLSearchParams({ limit: '100000' }));
    expect(data.limit).toBe(MAX_ROOM_ROSTER_LIMIT);
  });

  it('returns empty data when no contact store is wired (fail-closed read)', async () => {
    const service = createAdminRoomsService({ contactStore: null });
    expect((await service.listRooms()).rooms).toEqual([]);
    expect((await service.getRoomRoster(ROOM_X)).members).toEqual([]);
  });
});

describe('buildAdminRoomRoutes', () => {
  it('serves GET /api/admin/rooms', async () => {
    const { contactStore } = await seed();
    const routes = buildAdminRoomRoutes({ roomsService: createAdminRoomsService({ contactStore }) });
    const res = await invokeRoute(routes, 'GET', '/api/admin/rooms');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.rooms).toHaveLength(2);
  });

  it('serves GET /api/admin/rooms/:channelId/roster with query params', async () => {
    const { contactStore } = await seed();
    const routes = buildAdminRoomRoutes({ roomsService: createAdminRoomsService({ contactStore }) });
    const encoded = encodeURIComponent(ROOM_X);
    const res = await invokeRoute(
      routes,
      'GET',
      `/api/admin/rooms/${encoded}/roster`,
      `/api/admin/rooms/${encoded}/roster?channel=discord&limit=10`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.channelId).toBe(ROOM_X);
    expect(body.total).toBe(2);
    expect(body.members.map((m: { displayName: string }) => m.displayName)).toEqual(['Alice', 'Bob']);
  });
});

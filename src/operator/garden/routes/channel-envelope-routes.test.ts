// E3.2 — Garden channel Context Envelope route tests.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { AdminBodyReader } from './types.js';
import { buildAdminChannelEnvelopeRoutes } from './channel-envelope-routes.js';
import type { AdminChannelEnvelopeData, AdminSettingsService } from '../services/types.js';

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

const SAMPLE_DATA: AdminChannelEnvelopeData = {
  channels: [{
    channelId: 'room:friends',
    privacy: 'invite_only',
    broadcast: false,
    contactTracking: 'auto',
    source: 'channel_label',
    needsReview: false,
    hasLabel: true,
    label: { privacy: 'invite_only' },
  }],
  prefixOverrides: {},
  privatePrefixes: ['internal:'],
  broadcastPrefixes: ['twitter:'],
};

async function invokeRoute(
  service: Partial<AdminSettingsService>,
  method: 'GET' | 'POST',
  body: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const withBody: AdminBodyReader = (_req, _res, cb) => {
    cb(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const routes = buildAdminChannelEnvelopeRoutes({
    settingsService: service as AdminSettingsService,
    withBody,
  });
  const path = '/api/admin/channels/context-envelope';
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

describe('admin channel context-envelope routes', () => {
  it('lists channel envelope rows', async () => {
    const result = await invokeRoute({
      getChannelEnvelopeData: () => SAMPLE_DATA,
    }, 'GET', undefined);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(SAMPLE_DATA);
  });

  it('saves a channel label through the settings service and returns the refreshed view', async () => {
    const saveChannelEnvelopeLabel = vi.fn().mockReturnValue({
      ok: true,
      message: 'Channel envelope label saved for room:friends',
    });
    const result = await invokeRoute({
      saveChannelEnvelopeLabel,
      getChannelEnvelopeData: () => SAMPLE_DATA,
    }, 'POST', {
      channelId: 'room:friends',
      label: { privacy: 'invite_only' },
    });
    expect(result.statusCode).toBe(200);
    expect(saveChannelEnvelopeLabel).toHaveBeenCalledWith('room:friends', { privacy: 'invite_only' });
    expect(result.body).toMatchObject({ ok: true, data: { channels: [expect.any(Object)] } });
  });

  it('routes label removal (null label) through the settings service', async () => {
    const saveChannelEnvelopeLabel = vi.fn().mockReturnValue({ ok: true, message: 'removed' });
    const result = await invokeRoute({
      saveChannelEnvelopeLabel,
      getChannelEnvelopeData: () => SAMPLE_DATA,
    }, 'POST', { channelId: 'room:friends', label: null });
    expect(result.statusCode).toBe(200);
    expect(saveChannelEnvelopeLabel).toHaveBeenCalledWith('room:friends', null);
  });

  it('rejects payloads without a channelId fail-closed', async () => {
    const saveChannelEnvelopeLabel = vi.fn();
    const result = await invokeRoute({ saveChannelEnvelopeLabel }, 'POST', { label: { privacy: 'public' } });
    expect(result.statusCode).toBe(400);
    expect(saveChannelEnvelopeLabel).not.toHaveBeenCalled();
  });

  it('propagates validation failures from the owner-file path as 400s', async () => {
    const saveChannelEnvelopeLabel = vi.fn().mockReturnValue({
      ok: false,
      message: "Invalid channel envelope label: contextEnvelope.channels.room:x.privacy must be one of: private, invite_only, public",
    });
    const result = await invokeRoute({ saveChannelEnvelopeLabel }, 'POST', {
      channelId: 'room:x',
      label: { privacy: 'semi_private' },
    });
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: string }).error).toContain('privacy');
  });

  it('rejects invalid JSON payloads', async () => {
    const result = await invokeRoute({}, 'POST', '{not json');
    expect(result.statusCode).toBe(400);
  });
});

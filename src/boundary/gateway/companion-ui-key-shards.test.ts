import { describe, expect, it, vi } from 'vitest';
import { compileCompanionUiAction } from '../fleet-auth/companion-ui-action.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { dispatchCompanionUiKeyShard } from './companion-ui-key-shards.js';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const principal = { id: 'operator-key-principal', mode: 'api_key' as const };

function frame(resource: 'shards.list' | 'conversation.status') {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: 'request-1',
    action: 'companion.read',
    resource,
    body: {},
  }));
}

function compiled(raw: Buffer) {
  return compileCompanionUiAction(raw, companionId, {
    capabilities: ['text'],
    telemetryScopes: ['status'],
  });
}

describe('Companion UI key-path shard dispatch', () => {
  it('forwards shards frames with the key principal and the exact raw body', async () => {
    const raw = frame('shards.list');
    const runtime = {
      handleCompanionUiKeyShardAction: vi.fn(async () => ({ ok: true as const, response: [] })),
    };
    await expect(dispatchCompanionUiKeyShard({ compiled: compiled(raw), rawBody: raw, principal, runtime }))
      .resolves.toEqual({ handled: true, result: [] });
    expect(runtime.handleCompanionUiKeyShardAction).toHaveBeenCalledWith(companionId, {
      principal,
      rawBodyBase64Url: raw.toString('base64url'),
    });
  });

  it('leaves non-shard frames to the other key routes', async () => {
    const raw = frame('conversation.status');
    const runtime = { handleCompanionUiKeyShardAction: vi.fn() };
    await expect(dispatchCompanionUiKeyShard({ compiled: compiled(raw), rawBody: raw, principal, runtime }))
      .resolves.toEqual({ handled: false });
    expect(runtime.handleCompanionUiKeyShardAction).not.toHaveBeenCalled();
  });

  it('fails closed on an agent denial and on a non-key principal', async () => {
    const raw = frame('shards.list');
    const denied = {
      handleCompanionUiKeyShardAction: vi.fn(async () => ({
        ok: false as const,
        error: { status: 403, type: 'companion_ui_shard_action_denied', message: 'denied' },
      })),
    };
    await expect(dispatchCompanionUiKeyShard({
      compiled: compiled(raw), rawBody: raw, principal, runtime: denied,
    })).rejects.toThrow('companion_ui_shard_action_denied');
    const runtime = { handleCompanionUiKeyShardAction: vi.fn() };
    await expect(dispatchCompanionUiKeyShard({
      compiled: compiled(raw),
      rawBody: raw,
      principal: { id: 'local', mode: 'insecure_local' },
      runtime,
    })).rejects.toThrow('api_key principal');
    expect(runtime.handleCompanionUiKeyShardAction).not.toHaveBeenCalled();
  });
});

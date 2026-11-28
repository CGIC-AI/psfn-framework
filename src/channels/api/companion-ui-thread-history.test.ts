import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromAny } from '@total-typescript/shoehorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import { createTurnId } from '../../core/turns/id.js';
import { EventBus } from '../../shared/event-bus.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { AgentApiBackend } from './agent-backend.js';
import { readCompanionUiThreadHistory } from './companion-ui-thread-history.js';

// psfn-framework-jtr6e: the main-thread history read is authorized by the
// caller's own server-derived source channel, over real durable TurnRecords.

const COMPANION = createCompanionId('11111111-1111-4111-8111-111111111111');
const KEY_A = { id: 'operator-key-a', mode: 'api_key' as const };
const KEY_B = { id: 'operator-key-b', mode: 'api_key' as const };
const HUB_CHANNEL = `hub-device:${'b'.repeat(64)}`;

function config(): SubstrateConfig {
  return fromAny({
    primaryModel: 'test-model',
    primaryProvider: 'test',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    defaultContextWindow: 128_000,
    modelRoster: { chat: { model: 'test-model', provider: 'test', maxTokens: 1024, contextWindow: 128_000 } },
  });
}

function turn(
  channelId: string,
  at: number,
  user: string,
  assistant: string | undefined,
  status: TurnRecord['status'] = 'completed',
): TurnRecord {
  const turnId = createTurnId(at);
  return {
    schemaVersion: 1,
    turnId,
    requestId: `request-${turnId}`,
    channelId,
    channelType: 'api',
    startedAt: at,
    completedAt: at + 5,
    status,
    userMessage: { role: 'user', content: user, timestamp: at },
    ...(assistant === undefined
      ? {}
      : { assistantMessage: { role: 'assistant' as const, content: assistant, timestamp: at + 5 } }),
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
  };
}

async function record(manager: SessionManager, source: TurnRecord): Promise<void> {
  // The runtime stamps each record with the logical session it resolved to.
  const value = { ...source, sessionId: manager.resolveSessionChannelId(source.channelId) };
  manager.recordUserMessage(
    value.channelId,
    value.userMessage.content,
    'author',
    'Author',
    true,
    undefined,
    { turnId: value.turnId, requestId: value.requestId },
  );
  await manager.recordTurn(value);
}

function keyFrame(resource: 'conversation.history', body: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, requestId: 'history-request', action: 'companion.read', resource, body,
  })).toString('base64url');
}

function backend(sessionManager: SessionManager): AgentApiBackend {
  return new AgentApiBackend({
    agentLoop: fromAny({ handleMessage: vi.fn(), abort: vi.fn() }),
    eventBus: new EventBus(),
    sessionManager,
    companionId: COMPANION,
  });
}

describe('Companion UI main-thread history (jtr6e)', () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-ui-history-'));
    manager = new SessionManager(new SessionStore(dir), config());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only the caller channel even when the logical session is shared', async () => {
    // Both api: channels resolve to one active-context session, so a naive
    // session read would mix the two principals' transcripts.
    manager.setActiveContextSession('api:shared-room');
    await record(manager, turn('api:operator-key-a', 1_800_000_000_000, 'A asks first', 'A reply one'));
    await record(manager, turn('api:operator-key-b', 1_800_000_000_100, 'B private question', 'B private reply'));
    await record(manager, turn('api:operator-key-a', 1_800_000_000_200, 'A asks again', 'A reply two'));
    expect(manager.resolveSessionChannelId('api:operator-key-a')).toBe('api:shared-room');

    expect(readCompanionUiThreadHistory(manager, 'api:operator-key-a')).toEqual([
      { role: 'user', content: 'A asks first', createdAt: 1_800_000_000_000 },
      { role: 'assistant', content: 'A reply one', createdAt: 1_800_000_000_005 },
      { role: 'user', content: 'A asks again', createdAt: 1_800_000_000_200 },
      { role: 'assistant', content: 'A reply two', createdAt: 1_800_000_000_205 },
    ]);
    expect(JSON.stringify(readCompanionUiThreadHistory(manager, 'api:operator-key-a')))
      .not.toContain('B private');
  });

  it('omits failed turns, absent replies and oversized messages', async () => {
    const channel = 'api:operator-key-a';
    await record(manager, turn(channel, 1_800_000_001_000, 'failed ask', undefined, 'failed'));
    await record(manager, turn(channel, 1_800_000_001_100, 'silent ask', undefined));
    await record(manager, turn(channel, 1_800_000_001_200, 'huge ask', 'x'.repeat(65_537)));

    expect(readCompanionUiThreadHistory(manager, channel)).toEqual([
      { role: 'user', content: 'silent ask', createdAt: 1_800_000_001_100 },
      { role: 'user', content: 'huge ask', createdAt: 1_800_000_001_200 },
    ]);
  });

  it('serves the key principal its own thread and never another key principal', async () => {
    await record(manager, turn('api:operator-key-a', 1_800_000_002_000, 'mine', 'my reply'));
    await record(manager, turn('api:operator-key-b', 1_800_000_002_100, 'theirs', 'their reply'));
    const instance = backend(manager);

    await expect(instance.handleCompanionUiKeyShardAction({
      requestId: 'r1', principal: KEY_A, rawBodyBase64Url: keyFrame('conversation.history'),
    })).resolves.toEqual({
      ok: true,
      response: [
        { role: 'user', content: 'mine', createdAt: 1_800_000_002_000 },
        { role: 'assistant', content: 'my reply', createdAt: 1_800_000_002_005 },
      ],
    });
    await expect(instance.handleCompanionUiKeyShardAction({
      requestId: 'r2', principal: KEY_B, rawBodyBase64Url: keyFrame('conversation.history'),
    })).resolves.toMatchObject({ ok: true, response: [{ content: 'theirs' }, { content: 'their reply' }] });
  });

  it('serves history without a shard directory and fails closed on unauthorized key requests', async () => {
    await record(manager, turn('api:operator-key-a', 1_800_000_003_000, 'mine', 'my reply'));
    const instance = backend(manager);
    const denied = { ok: false, error: expect.objectContaining({ status: 403 }) };

    await expect(instance.handleCompanionUiKeyShardAction({
      requestId: 'r1', principal: { ...KEY_A, scope: 'satellite' }, rawBodyBase64Url: keyFrame('conversation.history'),
    })).resolves.toMatchObject(denied);
    await expect(instance.handleCompanionUiKeyShardAction({
      requestId: 'r2', principal: { id: 'local', mode: 'insecure_local' }, rawBodyBase64Url: keyFrame('conversation.history'),
    })).resolves.toMatchObject(denied);
    await expect(instance.handleCompanionUiKeyShardAction({
      requestId: 'r3', principal: KEY_A, rawBodyBase64Url: keyFrame('conversation.history', { limit: 1000 }),
    })).resolves.toMatchObject(denied);
  });

  it('reads the verified Hub attachment channel, not any browser-named thread', async () => {
    await record(manager, turn(HUB_CHANNEL, 1_800_000_004_000, 'hub ask', 'hub reply'));
    await record(manager, turn('api:operator-key-a', 1_800_000_004_100, 'key ask', 'key reply'));
    const instance = backend(manager);
    vi.spyOn(fromAny(instance), 'compileVerifiedCompanionUiCapability').mockReturnValue({
      frame: {
        schemaVersion: 1, requestId: 'signed-history', action: 'companion.read',
        resource: 'conversation.history', body: {},
      },
      target: {},
      physicalCeiling: { capabilities: ['text'], telemetryScopes: [] },
    });
    const principal = {
      kind: 'hub_device' as const, issuer: 'hub', keyId: 'key', deviceId: 'display', enrollmentVersion: 1,
      enrollmentAssurance: 'device_credential' as const, placeId: 'office', audience: 'https://fleet.example.test',
      companionId: COMPANION, sessionId: 'realtime:display:session', issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(), jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    };
    const attachment = {
      attachmentId: '018f0f10-79b2-4cc7-8c99-0242ac120003',
      disposition: 'created' as const,
      deviceActor: { kind: 'hub_device' as const, principal, connectionId: 'connection' },
      actor: {
        kind: 'human' as const,
        principalId: '33333333-3333-4333-8333-333333333333',
        companionId: COMPANION,
        providerSubject: { provider: 'discord' as const, subjectId: '12345678901234567' },
        contact: { bindingId: '44444444-4444-4444-8444-444444444444', contactId: 'contact', bindingVersion: 1 },
        operator: { grantId: '55555555-5555-4555-8555-555555555555', role: 'member' as const, grantVersion: 1 },
        session: { recordId: '66666666-6666-4666-8666-666666666666', authorityGeneration: 1, globalAuthEpoch: 1 },
      },
      channel: { source: 'server' as const, id: HUB_CHANNEL, companionId: COMPANION },
    };
    const params = {
      requestId: 'hub-history',
      principal: { id: 'gateway-principal', mode: 'api_key' as const },
      headers: {},
      hubDevicePrincipal: principal,
      hubDeviceAttachment: attachment,
      companionUiCapability: fromAny({}),
    };

    await expect(instance.handleCompanionUiShardAction(params)).resolves.toEqual({
      ok: true,
      response: [
        { role: 'user', content: 'hub ask', createdAt: 1_800_000_004_000 },
        { role: 'assistant', content: 'hub reply', createdAt: 1_800_000_004_005 },
      ],
    });
    await expect(instance.handleCompanionUiShardAction({
      ...params,
      hubDeviceAttachment: { ...attachment, actor: { kind: 'guest' as const, companionId: COMPANION } },
    })).resolves.toMatchObject({ ok: false, error: { status: 403 } });
  });
});

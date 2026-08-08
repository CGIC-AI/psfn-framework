import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { ShardDirectoryOperationalError } from '../../shared/contracts/shard-directory.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { LiveShardDirectory } from '../../faculties/shards/directory.js';
import { AgentApiBackend } from './agent-backend.js';
import { classifyCompanionUiShardActionFailure } from './companion-ui-shard-action-error.js';

const PARENT = createCompanionId('11111111-1111-4111-8111-111111111111');
const SHARD_ID = 'shard-test';

function authority() {
  const hubDevicePrincipal = {
    kind: 'hub_device' as const,
    issuer: 'psfn-satellite-hub',
    keyId: 'hub-key',
    deviceId: 'office-device',
    enrollmentVersion: 1,
    enrollmentAssurance: 'device_credential' as const,
    placeId: 'office',
    audience: 'https://fleet.example.test',
    companionId: PARENT,
    sessionId: 'realtime:office-device:session',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
  };
  const hubDeviceAttachment = {
    attachmentId: '018f0f10-79b2-4cc7-8c99-0242ac120003',
    disposition: 'created' as const,
    deviceActor: {
      kind: 'hub_device' as const,
      principal: hubDevicePrincipal,
      connectionId: 'authenticated-connection',
    },
    actor: {
      kind: 'human' as const,
      principalId: '33333333-3333-4333-8333-333333333333',
      companionId: PARENT,
      providerSubject: {
        provider: 'discord' as const,
        subjectId: '12345678901234567',
      },
      contact: {
        bindingId: '44444444-4444-4444-8444-444444444444',
        contactId: 'contact-current-human',
        bindingVersion: 1,
      },
      operator: {
        grantId: '55555555-5555-4555-8555-555555555555',
        role: 'member' as const,
        grantVersion: 1,
      },
      session: {
        recordId: '66666666-6666-4666-8666-666666666666',
        authorityGeneration: 1,
        globalAuthEpoch: 1,
      },
    },
    channel: {
      source: 'server' as const,
      id: `hub-device:${'a'.repeat(64)}`,
      companionId: PARENT,
    },
  };
  return { hubDevicePrincipal, hubDeviceAttachment };
}

function shardDirectory(handleMessage: () => Promise<never>): LiveShardDirectory {
  const directory = new LiveShardDirectory({
    parentCompanionId: () => PARENT,
    refreshDeployments: vi.fn(),
    deployments: () => [{
      id: SHARD_ID,
      name: 'Bounded shard',
      task: 'Bounded task',
      startedAt: 1,
      state: 'ready',
      health: 'healthy',
    }],
    intakeScreening: null,
  });
  directory.register(SHARD_ID, {
    channelId: `shard:${SHARD_ID}:human`,
    agentLoop: fromAny({
      handleMessage,
      cancelTurn: vi.fn(),
    }),
  });
  return directory;
}

function backend(directory: LiveShardDirectory): AgentApiBackend {
  const instance = new AgentApiBackend({
    agentLoop: fromAny({ handleMessage: vi.fn(), abort: vi.fn() }),
    eventBus: new EventBus(),
    sessionManager: fromAny({
      getMessageCount: vi.fn(() => 0),
      recordUserMessage: vi.fn(),
      recordAssistantMessage: vi.fn(),
    }),
    companionId: PARENT,
    shardDirectory: directory,
  });
  vi.spyOn(fromAny(instance), 'compileVerifiedCompanionUiCapability').mockReturnValue({
    frame: {
      schemaVersion: 1,
      requestId: 'signed-shard-request',
      action: 'companion.interact',
      resource: 'shards.interact',
      body: { shardId: SHARD_ID, content: 'bounded question' },
    },
    target: {},
    physicalCeiling: { capabilities: ['text'], telemetryScopes: [] },
  });
  return instance;
}

function params() {
  const attached = authority();
  return {
    requestId: 'shard-action-request',
    principal: { id: 'gateway-principal', mode: 'api_key' as const },
    headers: {},
    ...attached,
    companionUiCapability: fromAny({
      frame: { resource: 'shards.interact' },
    }),
  };
}

describe('AgentApiBackend Companion UI shard action failures', () => {
  it('keeps an unavailable shard generic and non-enumerating at 403', async () => {
    const directory = shardDirectory(async () => {
      throw new Error('should not execute');
    });
    directory.release(SHARD_ID);
    const instance = backend(directory);

    await expect(instance.handleCompanionUiShardAction(params()))
      .resolves.toEqual({
        ok: false,
        error: {
          status: 403,
          type: 'companion_ui_shard_action_denied',
          message: 'Companion UI shard action was denied',
        },
      });
  });

  it('maps an injected runtime/provider failure to generic temporary unavailability', async () => {
    const directory = shardDirectory(async () => {
      throw new Error('private provider failure detail');
    });
    const instance = backend(directory);

    const result = await instance.handleCompanionUiShardAction(params());

    expect(result).toEqual({
      ok: false,
      error: {
        status: 503,
        type: 'companion_ui_shard_action_unavailable',
        message: 'Companion UI shard action is temporarily unavailable',
      },
    });
    expect(JSON.stringify(result)).not.toContain('denied');
    expect(JSON.stringify(result)).not.toContain('private provider failure detail');
  });

  it('types canonical directory projection failures as operational', () => {
    const directory = new LiveShardDirectory({
      parentCompanionId: () => PARENT,
      refreshDeployments: () => {
        throw new Error('deployment refresh failed');
      },
      deployments: () => [],
      intakeScreening: null,
    });

    expect(() => directory.listShards(PARENT)).toThrow(ShardDirectoryOperationalError);
  });

  it('defaults ambiguous untyped failures to denial', () => {
    expect(classifyCompanionUiShardActionFailure(new Error('ambiguous failure')))
      .toMatchObject({
        status: 403,
        type: 'companion_ui_shard_action_denied',
        message: 'Companion UI shard action was denied',
      });
  });
});

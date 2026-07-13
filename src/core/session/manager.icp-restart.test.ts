import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SessionManager } from './manager.js';
import { buildSessionMetadataWithIcpCorrelation } from './icp-correlation-metadata.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../agent/contracts.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const CHANNEL = `companion-dm:${SENDER}:${RECIPIENT}`;
const SOURCE_ID = 'icp-initiation:33333333-3333-4333-8333-333333333333';
const GATEWAY_ID = 'companion-initiation-33333333-3333-4333-8333-333333333333';
const correlation = {
  conversationId: '44444444-4444-4444-8444-444444444444',
  rootInitiationId: '99999999-9999-4999-8999-999999999999',
  initiatedByCompanionId: SENDER,
  localCompanionId: SENDER,
  peerCompanionId: RECIPIENT,
  peerContactId: 'contact-nova',
  channelId: CHANNEL,
  turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
  messageId: SOURCE_ID,
  requestId: SOURCE_ID,
  chargeLane: 'companion_social' as const,
  surface: 'companion_dm' as const,
  costPurpose: 'conversation_turn' as const,
  costOriginStage: 'initiation' as const,
  fatigueDecision: 'not_evaluated' as const,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(dataDir: string, overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    dataDir,
    companionDataDir: dataDir,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    ...overrides,
  } as SubstrateConfig;
}

function manager(root: string, companion: 'sender' | 'recipient'): SessionManager {
  const dataDir = join(root, companion);
  return new SessionManager(
    new SessionStore(join(dataDir, 'sessions')),
    config(dataDir),
  );
}

describe('ICP L0 restart continuity', () => {
  it('recovers sender assistant/delivery truth and recipient source attribution independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-session-restart-'));
    roots.push(root);
    const sender = manager(root, 'sender');
    const recipient = manager(root, 'recipient');
    const assistantContent = 'Hey Nova, I was thinking about our garden plans.';

    sender.recordAssistantMessage(
      CHANNEL,
      assistantContent,
      'contact-nova',
      true,
      'contact-nova',
      {
        turnId: correlation.turnId as TurnID,
        requestId: SOURCE_ID,
        sourceMessageId: SOURCE_ID,
        metadata: buildSessionMetadataWithIcpCorrelation(
          undefined,
          correlation,
          { deliveryStatus: 'pending' },
        ),
      },
    );
    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'failed',
      error: 'peer route unavailable',
    });
    recipient.recordUserMessage(
      CHANNEL,
      assistantContent,
      SENDER,
      'Selene',
      true,
      'recipient-local-contact-selene',
      {
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082' as TurnID,
        requestId: GATEWAY_ID,
        sourceMessageId: GATEWAY_ID,
        metadata: buildSessionMetadataWithIcpCorrelation(undefined, correlation),
      },
    );

    const restartedSender = manager(root, 'sender');
    const restartedRecipient = manager(root, 'recipient');

    expect(restartedSender.findRecordedIcpInitiation(CHANNEL, SOURCE_ID)).toEqual({
      content: assistantContent,
      correlation,
    });
    expect(restartedSender.getRecentSessionEntries(CHANNEL, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('"status":"failed"'),
      }),
    ]));
    expect(restartedSender.getRecentMessages(CHANNEL, 10)).toEqual([]);
    expect(restartedRecipient.hasRecordedSourceMessage(CHANNEL, GATEWAY_ID)).toBe(true);
    expect(restartedRecipient.getRecentSessionEntries(CHANNEL, 10)).toEqual([
      expect.objectContaining({
        role: 'user',
        authorId: SENDER,
        authorName: 'Selene',
        content: assistantContent,
      }),
    ]);
  });

  it('serves a pending sender assistant entry only after durable delivered observation', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-session-delivery-gate-'));
    roots.push(root);
    const sender = manager(root, 'sender');

    sender.recordAssistantMessage(
      CHANNEL,
      'This must not enter context before delivery.',
      'contact-nova',
      true,
      'contact-nova',
      {
        turnId: correlation.turnId as TurnID,
        requestId: SOURCE_ID,
        sourceMessageId: SOURCE_ID,
        metadata: buildSessionMetadataWithIcpCorrelation(
          undefined,
          correlation,
          { deliveryStatus: 'pending' },
        ),
      },
    );

    expect(sender.getRecentMessages(CHANNEL, 10)).toEqual([]);

    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'delivered',
      gatewayMessageId: GATEWAY_ID,
      deliveredTo: [RECIPIENT],
      permitOutcome: 'consumed',
    });

    const restarted = manager(root, 'sender');
    expect(restarted.getRecentMessages(CHANNEL, 10)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'This must not enter context before delivery.',
      }),
    ]);
  });

  it('keeps failed sender output out of real pre-compaction extraction and summary side effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-sidework-quarantine-'));
    roots.push(root);
    const dataDir = join(root, 'sender');
    const sender = new SessionManager(
      new SessionStore(join(dataDir, 'sessions')),
      config(dataDir, {
        defaultContextWindow: 512,
        compactionThresholdPct: 1,
        modelRoster: {
          chat: { provider: 'test', model: 'test', contextWindow: 512, maxTokens: 128 },
        } as SubstrateConfig['modelRoster'],
      }),
    );
    const failedContent = 'FAILED PRIVATE OUTPUT MUST NEVER BECOME SHARED MEMORY';
    sender.recordAssistantMessage(
      CHANNEL,
      failedContent,
      'contact-nova',
      true,
      'contact-nova',
      {
        turnId: correlation.turnId as TurnID,
        requestId: SOURCE_ID,
        sourceMessageId: SOURCE_ID,
        metadata: buildSessionMetadataWithIcpCorrelation(
          undefined,
          correlation,
          { deliveryStatus: 'pending' },
        ),
      },
    );
    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'failed',
      error: 'peer unavailable',
    });
    for (let index = 0; index < 8; index += 1) {
      sender.recordUserMessage(CHANNEL, `Ordinary user context ${index} ${'A'.repeat(80)}`, 'user', 'User');
      sender.recordAssistantMessage(CHANNEL, `Ordinary delivered context ${index} ${'B'.repeat(80)}`);
    }

    const extractionInputs: string[] = [];
    sender.setPreCompactionExtractionHandler(async ({ entries }) => {
      extractionInputs.push(entries.map(entry => entry.content).join('\n'));
    });
    const complete = vi.fn<LLMProviderPort['complete']>().mockResolvedValue({
      content: 'Summary of ordinary delivered context.',
      model: 'test',
      inputTokens: 1,
      outputTokens: 1,
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(),
      complete,
    };

    await sender.scheduleAutoCompactionBetweenTurns({
      channelId: CHANNEL,
      systemPrompt: 'System',
      memoriesBlock: '',
      llmProvider,
    });

    expect(extractionInputs).toHaveLength(1);
    expect(extractionInputs[0]).not.toContain(failedContent);
    expect(complete).toHaveBeenCalled();
    expect(complete.mock.calls[0]?.[0].messages[0]?.content).not.toContain(failedContent);
  });
});

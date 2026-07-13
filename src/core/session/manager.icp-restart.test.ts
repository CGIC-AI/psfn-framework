import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SessionManager } from './manager.js';
import { buildSessionMetadataWithIcpCorrelation } from './icp-correlation-metadata.js';
import type { TurnID } from '../../shared/contracts/runtime.js';

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

function config(dataDir: string): SubstrateConfig {
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
});

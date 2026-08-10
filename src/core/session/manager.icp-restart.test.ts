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
const recoveryResponse = {
  content: 'Hey Nova, I was thinking about our garden plans.',
  channelId: CHANNEL,
  metadata: {
    model: 'test/icp-recovery',
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
    turnId: correlation.turnId as TurnID,
    requestId: correlation.requestId,
    icpCorrelation: correlation,
  },
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
          { deliveryStatus: 'pending', recoveryResponse },
        ),
      },
    );
    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'failed',
      error: 'peer route unavailable',
      recoveryResponse,
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
      recoveryResponse,
    });
    expect(restartedSender.getRecentSessionEntries(CHANNEL, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('"status":"failed"'),
      }),
    ]));
    expect(restartedSender.getRecentMessages(CHANNEL, 10)).toEqual([]);
    expect(restartedRecipient.hasRecordedSourceMessage(CHANNEL, GATEWAY_ID)).toBe(true);
    expect(restartedRecipient.findRecordedCompanionSourceMessage(CHANNEL, GATEWAY_ID)).toEqual({
      channelId: CHANNEL,
      sourceMessageId: GATEWAY_ID,
      content: assistantContent,
      authorId: SENDER,
      authorName: 'Selene',
      timestampMs: expect.any(Number),
      correlation,
    });
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
          { deliveryStatus: 'pending', recoveryResponse },
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
      recoveryResponse,
    });

    const restarted = manager(root, 'sender');
    expect(restarted.getRecentMessages(CHANNEL, 10)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'This must not enter context before delivery.',
      }),
    ]);
  });

  it('fails closed after restart when durable recovery state has a detached snapshot reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-detached-recovery-state-'));
    roots.push(root);
    const sender = manager(root, 'sender');

    sender.recordAssistantMessage(
      CHANNEL,
      recoveryResponse.content,
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
          {
            deliveryStatus: 'pending',
            recoveryResponse: {
              ...recoveryResponse,
              metadata: {
                ...recoveryResponse.metadata,
                internalStateSnapshotRef: 'internal-state-v1:detached',
              },
            },
          },
        ),
      },
    );

    const restarted = manager(root, 'sender');
    expect(() => restarted.findRecordedIcpInitiation(CHANNEL, SOURCE_ID))
      .toThrow(/internal state and snapshot reference must be a pair/i);
  });

  it('fails closed on the newest malformed observation instead of using older delivery truth', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-malformed-observation-'));
    roots.push(root);
    const sender = manager(root, 'sender');
    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'delivered',
      gatewayMessageId: GATEWAY_ID,
      deliveredTo: [RECIPIENT],
      recoveryResponse,
    });
    sender.appendSystemNote(
      CHANNEL,
      `{"schemaVersion":1,"kind":"icp_delivery","channelId":${JSON.stringify(CHANNEL)},`
        + `"sourceMessageId":${JSON.stringify(SOURCE_ID)},"status":`,
      'icp_delivery',
    );

    const restarted = manager(root, 'sender');
    expect(() => restarted.findIcpDeliveryObservation(CHANNEL, SOURCE_ID))
      .toThrow(/malformed JSON/i);
  });

  it.each([
    ['delivered without recovery evidence', {
      status: 'delivered',
      gatewayMessageId: GATEWAY_ID,
    }],
    ['failed without recovery evidence', {
      status: 'failed',
      error: 'peer route unavailable',
    }],
    ['delivered with whitespace-only transport content', {
      status: 'delivered',
      gatewayMessageId: GATEWAY_ID,
      recoveryResponse: { ...recoveryResponse, content: ' \n\t ' },
    }],
  ])('fails closed after restart for %s', (_label, fields) => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-invalid-delivery-evidence-'));
    roots.push(root);
    const sender = manager(root, 'sender');
    sender.appendSystemNote(CHANNEL, JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      ...fields,
    }), 'icp_delivery');

    const restarted = manager(root, 'sender');
    expect(() => restarted.findIcpDeliveryObservation(CHANNEL, SOURCE_ID))
      .toThrow(/missing recovery response|transport content/i);
  });

  it('recovers ICP initiation, observation, and source attribution beyond 5,000 later rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-session-deep-recovery-'));
    roots.push(root);
    const sender = manager(root, 'sender');
    const recipientSourceId = 'companion-initiation-deep-source';

    sender.recordAssistantMessage(
      CHANNEL,
      'Old pending initiation',
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
          { deliveryStatus: 'pending', recoveryResponse },
        ),
      },
    );
    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'failed',
      error: 'old failed delivery',
      recoveryResponse,
    });
    sender.recordUserMessage(CHANNEL, 'Old replayed recipient input', SENDER, 'Selene', true, undefined, {
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7083' as TurnID,
      requestId: recipientSourceId,
      sourceMessageId: recipientSourceId,
    });
    for (let index = 0; index < 5_001; index += 1) {
      sender.appendContextSystemNote(CHANNEL, `Later row ${index}`, 'deep-recovery-test');
    }

    const restarted = manager(root, 'sender');
    expect(restarted.findRecordedIcpInitiation(CHANNEL, SOURCE_ID)).toEqual({
      content: 'Old pending initiation',
      correlation,
      recoveryResponse,
    });
    expect(restarted.findIcpDeliveryObservation(CHANNEL, SOURCE_ID)).toEqual({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'failed',
      error: 'old failed delivery',
      recoveryResponse,
    });
    expect(restarted.hasRecordedSourceMessage(CHANNEL, recipientSourceId)).toBe(true);
  }, 60_000);

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
    sender.recordUserMessage(CHANNEL, 'Safe ordinary context before failed ICP output', 'user', 'User');
    sender.recordAssistantMessage(CHANNEL, 'Safe delivered context before failed ICP output');
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
      recoveryResponse,
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

  it.each([
    ['failed', false],
    ['delivered', true],
  ] as const)(
    'applies %s ICP delivery truth to a source-bounded compaction snapshot after its boundary',
    (status, includesIcpOutput) => {
      const root = mkdtempSync(join(tmpdir(), `psfn-icp-bounded-compaction-${status}-`));
      roots.push(root);
      const dataDir = join(root, 'sender');
      const store = new SessionStore(join(dataDir, 'sessions'));
      const sender = new SessionManager(store, config(dataDir, {
        modelRoster: {
          chat: { provider: 'test', model: 'test', contextWindow: 128_000, maxTokens: 4_096 },
        } as SubstrateConfig['modelRoster'],
      }));
      const compactedId = sender.recordUserMessage(
        CHANNEL,
        'already represented by the previous compaction',
        'user',
        'User',
      );
      expect(compactedId).not.toBeNull();
      store.insertCompaction(CHANNEL, 'previous summary', compactedId!);

      const gatedContent = `${status} ICP turn A output`;
      sender.recordAssistantMessage(
        CHANNEL,
        gatedContent,
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
            { deliveryStatus: 'pending', recoveryResponse },
          ),
        },
      );
      sender.recordIcpDeliveryObservation(status === 'delivered'
        ? {
            channelId: CHANNEL,
            sourceMessageId: SOURCE_ID,
            status,
            gatewayMessageId: GATEWAY_ID,
            deliveredTo: [RECIPIENT],
            permitOutcome: 'consumed',
            recoveryResponse,
          }
        : {
            channelId: CHANNEL,
            sourceMessageId: SOURCE_ID,
            status,
            error: 'peer unavailable',
            recoveryResponse,
          });
      sender.recordUserMessage(CHANNEL, 'successful turn B input', 'user', 'User');
      const successfulOutputId = sender.recordAssistantMessage(
        CHANNEL,
        'successful turn B output',
      );
      expect(successfulOutputId).not.toBeNull();

      const captured = sender.captureAutoCompactionRecentEntries({
        channelId: CHANNEL,
        maxSessionEntryId: successfulOutputId!,
        now: new Date(),
      });

      expect(captured.map(entry => entry.content)).toEqual([
        ...(includesIcpOutput ? [gatedContent] : []),
        'successful turn B input',
        'successful turn B output',
      ]);
      expect(captured.every(entry => entry.id > compactedId!)).toBe(true);
    },
  );

  it('does not compact across failed ICP output that later becomes delivered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-late-delivery-boundary-'));
    roots.push(root);
    const dataDir = join(root, 'sender');
    const store = new SessionStore(join(dataDir, 'sessions'));
    const sender = new SessionManager(store, config(dataDir, {
      defaultContextWindow: 512,
      sessionHistoryBudgetPct: 1,
      compactionThresholdPct: 99,
      modelRoster: {
        chat: {
          provider: 'test',
          model: 'test',
          contextWindow: 512,
          maxTokens: 128,
          contextBudget: { sessionHistoryMinTokens: 1 },
        },
      } as SubstrateConfig['modelRoster'],
    }));
    const oldContents = [
      `already summarized old context 1 ${'O'.repeat(20)}`,
      `already summarized old context 2 ${'O'.repeat(20)}`,
    ];
    const oldIds = oldContents.map(content => sender.recordUserMessage(
      CHANNEL,
      content,
      'user',
      'User',
    ));
    const lateDeliveredContent = `late delivered ICP turn A ${'A'.repeat(20)}`;
    const pendingId = sender.recordAssistantMessage(
      CHANNEL,
      lateDeliveredContent,
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
          { deliveryStatus: 'pending', recoveryResponse },
        ),
      },
    );
    expect(pendingId).not.toBeNull();
    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'failed',
      error: 'peer unavailable',
      recoveryResponse,
    });
    const successfulContents = Array.from(
      { length: 6 },
      (_, index) => `successful B context ${index + 1} ${'B'.repeat(20)}`,
    );
    let lastSuccessfulId: number | null = null;
    for (const content of successfulContents) {
      lastSuccessfulId = sender.recordUserMessage(CHANNEL, content, 'user', 'User');
    }
    expect(lastSuccessfulId).not.toBeNull();
    const complete = vi.fn<LLMProviderPort['complete']>().mockResolvedValue({
      content: 'summary of the old context only',
      model: 'test',
      inputTokens: 1,
      outputTokens: 1,
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await sender.scheduleAutoCompactionBetweenTurns({
      channelId: CHANNEL,
      systemPrompt: '',
      memoriesBlock: '',
      llmProvider: { stream: vi.fn(), complete } as LLMProviderPort,
      throwOnFailure: true,
    });

    const summaries = store.getCompactionSummaries(CHANNEL);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.coveredUpTo).toBe(oldIds[1]);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(lateDeliveredContent);
    expect(JSON.stringify(complete.mock.calls)).not.toContain('successful B context');

    sender.recordIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_ID,
      status: 'delivered',
      gatewayMessageId: GATEWAY_ID,
      deliveredTo: [RECIPIENT],
      permitOutcome: 'consumed',
      recoveryResponse,
    });
    const captured = sender.captureAutoCompactionRecentEntries({
      channelId: CHANNEL,
      maxSessionEntryId: lastSuccessfulId!,
      now: new Date(),
    });

    expect(captured.map(entry => entry.content)).toEqual([
      lateDeliveredContent,
      ...successfulContents,
    ]);
    expect(new Set(captured.map(entry => entry.id)).size).toBe(captured.length);
    expect(captured.every(entry => !oldContents.includes(entry.content))).toBe(true);
  });
});

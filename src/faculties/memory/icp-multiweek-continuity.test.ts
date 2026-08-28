import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { SessionManager } from '../../core/session/manager.js';
import { buildSessionMetadataWithIcpCorrelation } from '../../core/session/icp-correlation-metadata.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { InMemoryMemoryStore } from '../../test-support/in-memory-memory-store.js';
import { MemoryExtractor } from './extraction.js';
import { MemoryRetriever } from './retrieval.js';

const ASTER = '11111111-1111-4111-8111-111111111111';
const BRIAR = '22222222-2222-4222-8222-222222222222';
const CHANNEL = `companion-dm:${ASTER}:${BRIAR}`;
const DYAD_ID = '33333333-3333-4333-8333-333333333333';
const ROOT_INITIATION_ID = '44444444-4444-4444-8444-444444444444';
const ACTIVITY_IDS = [
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
] as const;
const EARLY_HISTORY = 'The north-window herb shelf should use cedar brackets.';

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runtimeConfig(
  dataDir: string,
  companionId: string,
  characterName: string,
): SubstrateConfig {
  return {
    companionId,
    characterName,
    dataDir,
    companionDataDir: dataDir,
    primaryModel: 'invented-chat-model',
    primaryProvider: 'invented-provider',
    extractionModel: 'invented-extraction-model',
    extractionProvider: 'invented-provider',
    modelRoster: {
      chat: {
        provider: 'invented-provider',
        model: 'invented-chat-model',
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    },
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 2,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
  } as SubstrateConfig;
}

function createAgentSession(
  root: string,
  label: 'aster' | 'briar',
  companionId: string,
  characterName: string,
): { manager: SessionManager; config: SubstrateConfig } {
  const dataDir = join(root, label);
  const config = runtimeConfig(dataDir, companionId, characterName);
  return {
    manager: new SessionManager(new SessionStore(join(dataDir, 'sessions')), config),
    config,
  };
}

function correlation(
  activityId: string,
  localCompanionId: string,
  peerCompanionId: string,
  turnId: string,
): IcpConversationCorrelation {
  return {
    dyadId: DYAD_ID,
    conversationId: activityId,
    rootInitiationId: ROOT_INITIATION_ID,
    initiatedByCompanionId: ASTER,
    localCompanionId,
    peerCompanionId,
    peerContactId: `contact-${peerCompanionId}`,
    channelId: CHANNEL,
    turnId,
    messageId: `message:${turnId}`,
    requestId: `request:${turnId}`,
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'reply',
    fatigueDecision: 'allow',
  };
}

function recordActivity(
  aster: SessionManager,
  briar: SessionManager,
  activityId: string,
  sequence: number,
  asterSpeech: string,
  briarSpeech: string,
): void {
  const asterTurnId = `018f22a2-52b8-7a3a-8c16-25b7b14f71${String(sequence).padStart(2, '0')}`;
  const briarTurnId = `018f22a2-52b8-7a3a-8c16-25b7b14f72${String(sequence).padStart(2, '0')}`;
  const asterCorrelation = correlation(activityId, ASTER, BRIAR, asterTurnId);
  const briarCorrelation = correlation(activityId, BRIAR, ASTER, briarTurnId);

  aster.recordAssistantMessage(CHANNEL, asterSpeech, undefined, true, undefined, {
    turnId: asterTurnId as TurnID,
    requestId: asterCorrelation.requestId,
    sourceMessageId: asterCorrelation.messageId,
    metadata: buildSessionMetadataWithIcpCorrelation(undefined, asterCorrelation),
  });
  briar.recordUserMessage(CHANNEL, asterSpeech, ASTER, 'Aster', true, undefined, {
    turnId: asterTurnId as TurnID,
    requestId: asterCorrelation.requestId,
    sourceMessageId: asterCorrelation.messageId,
    metadata: buildSessionMetadataWithIcpCorrelation(undefined, asterCorrelation),
  });
  aster.recordUserMessage(CHANNEL, briarSpeech, BRIAR, 'Briar', true, undefined, {
    turnId: briarTurnId as TurnID,
    requestId: briarCorrelation.requestId,
    sourceMessageId: briarCorrelation.messageId,
    metadata: buildSessionMetadataWithIcpCorrelation(undefined, briarCorrelation),
  });
  briar.recordAssistantMessage(CHANNEL, briarSpeech, undefined, true, undefined, {
    turnId: briarTurnId as TurnID,
    requestId: briarCorrelation.requestId,
    sourceMessageId: briarCorrelation.messageId,
    metadata: buildSessionMetadataWithIcpCorrelation(undefined, briarCorrelation),
  });
}

const embedding: EmbeddingProviderPort = {
  embed: vi.fn(async () => new Float32Array([1, 0, 0, 0])),
  embedBatch: vi.fn(async texts => texts.map(() => new Float32Array([1, 0, 0, 0]))),
  dims: 4,
};

async function extractEarlyHistory(input: {
  manager: SessionManager;
  config: SubstrateConfig;
  memoryStore: InMemoryMemoryStore;
  companionName: string;
  peerContactId: string;
}): Promise<void> {
  const llmClient = {
    stream: vi.fn(),
    complete: vi.fn(async () => ({
      content: `<response>
<fact>
<text>${EARLY_HISTORY}</text>
<type>relational</type>
<importance>0.9</importance>
<confidence>0.98</confidence>
<sensitivity>personal</sensitivity>
</fact>
</response>`,
      model: 'invented-extraction-model',
      inputTokens: 1,
      outputTokens: 1,
      toolCalls: [],
      stopReason: 'end_turn' as const,
    })),
  };
  const extractor = new MemoryExtractor(
    llmClient,
    input.manager,
    input.memoryStore.asPort(),
    embedding,
    new EventBus(),
    input.config,
  );

  await extractor.extract(CHANNEL, input.peerContactId);
  expect(llmClient.complete).toHaveBeenCalledOnce();
  expect(input.memoryStore.getAllActiveMemories()).toEqual([
    expect.objectContaining({
      text: EARLY_HISTORY,
      contactId: input.peerContactId,
      provenance: expect.objectContaining({
        channelId: CHANNEL,
        sessionId: CHANNEL,
        icpDyadId: DYAD_ID,
        sourceActivityIds: [ACTIVITY_IDS[0]],
      }),
    }),
  ]);
}

describe('in-process multi-week ICP memory continuity', () => {
  it('lets both restarted companions recall early dyad history after later bounded activities', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-multiweek-continuity-'));
    tempRoots.push(root);
    const asterMemories = new InMemoryMemoryStore();
    const briarMemories = new InMemoryMemoryStore();

    vi.setSystemTime(new Date('2026-07-06T09:00:00.000Z'));
    let aster = createAgentSession(root, 'aster', ASTER, 'Aster');
    let briar = createAgentSession(root, 'briar', BRIAR, 'Briar');
    recordActivity(
      aster.manager,
      briar.manager,
      ACTIVITY_IDS[0],
      1,
      'I found a place for the herb shelf by the north window.',
      'Let us use cedar brackets so the shelf holds up over time.',
    );
    await extractEarlyHistory({
      ...aster,
      memoryStore: asterMemories,
      companionName: 'Aster',
      peerContactId: 'contact-briar',
    });
    await extractEarlyHistory({
      ...briar,
      memoryStore: briarMemories,
      companionName: 'Briar',
      peerContactId: 'contact-aster',
    });

    vi.setSystemTime(new Date('2026-07-16T14:00:00.000Z'));
    aster = createAgentSession(root, 'aster', ASTER, 'Aster');
    briar = createAgentSession(root, 'briar', BRIAR, 'Briar');
    recordActivity(
      aster.manager,
      briar.manager,
      ACTIVITY_IDS[1],
      2,
      'The invented observatory walk was quieter than expected.',
      'I liked the blue mosaic near the entrance.',
    );

    vi.setSystemTime(new Date('2026-07-30T19:30:00.000Z'));
    aster = createAgentSession(root, 'aster', ASTER, 'Aster');
    briar = createAgentSession(root, 'briar', BRIAR, 'Briar');
    recordActivity(
      aster.manager,
      briar.manager,
      ACTIVITY_IDS[2],
      3,
      'I finished the invented tide-table puzzle.',
      'Next time I will bring the brass compass token.',
    );

    // A final process-local restart reconstructs both runtimes from their own
    // durable session roots and companion-local memory stores.
    aster = createAgentSession(root, 'aster', ASTER, 'Aster');
    briar = createAgentSession(root, 'briar', BRIAR, 'Briar');
    for (const agent of [aster, briar]) {
      expect(agent.manager.listRecentSessions()).toEqual([
        expect.objectContaining({ sessionId: CHANNEL, channelId: CHANNEL, messageCount: 6 }),
      ]);
      const entries = agent.manager.getRecentSessionEntries(CHANNEL, 10);
      expect(entries).toHaveLength(6);
      expect([...new Set(entries.map(entry => (
        JSON.parse(entry.metadata ?? '{}').icpCorrelation.conversationId
      ))) ]).toEqual(ACTIVITY_IDS);
    }

    const recallQuery = 'What did we decide about the north-window shelf and cedar brackets?';
    const asterRecall = await new MemoryRetriever(
      asterMemories.asPort(),
      embedding,
      aster.config,
    ).retrieve(
      recallQuery,
      CHANNEL,
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
      'contact-briar',
    );
    const briarRecall = await new MemoryRetriever(
      briarMemories.asPort(),
      embedding,
      briar.config,
    ).retrieve(
      recallQuery,
      CHANNEL,
      'primary',
      { isDirectMessage: true, privacyLevel: 'private' },
      'contact-aster',
    );

    expect(asterRecall).toContain(EARLY_HISTORY);
    expect(briarRecall).toContain(EARLY_HISTORY);
    expect(asterMemories.getAllActiveMemories()).toHaveLength(1);
    expect(briarMemories.getAllActiveMemories()).toHaveLength(1);
    expect(asterMemories.getAllActiveMemories()[0]?.id)
      .not.toBe(briarMemories.getAllActiveMemories()[0]?.id);
  });
});

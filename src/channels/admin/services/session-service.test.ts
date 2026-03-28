import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import { UserContinuityStore } from '../../../session/continuity.js';
import { SessionManager } from '../../../session/manager.js';
import { SessionStore } from '../../../session/store.js';
import { createTurnId } from '../../../turns/id.js';
import type { SubstrateConfig } from '../../../types.js';
import { AdminSessionDataService } from './session-service.js';

function makeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16_384, contextWindow: 1_000 },
    },
    ...overrides,
  };
}

describe('AdminSessionDataService', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-session-service-'));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns persisted turn observability without requiring live event-bus state', () => {
    const channelId = 'api:observability';
    const requestId = 'persisted-turn-1';
    const turnId = createTurnId();
    const userSessionEntryId = store.append({
      channelId,
      role: 'user',
      content: 'hello',
      timestamp: 1_700_000_000_000,
    });
    const assistantSessionEntryId = store.append({
      channelId,
      role: 'assistant',
      content: 'world',
      timestamp: 1_700_000_000_025,
    });

    store.appendTurnRecord({
      schemaVersion: 1,
      turnId,
      requestId,
      channelId,
      channelType: 'api',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_050,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'hello',
        timestamp: 1_700_000_000_000,
        sessionEntryId: userSessionEntryId,
        sourceMessageId: 'msg-user-1',
        authorId: 'user-1',
        authorName: 'User',
      },
      assistantMessage: {
        role: 'assistant',
        content: 'world',
        timestamp: 1_700_000_000_025,
        sessionEntryId: assistantSessionEntryId,
        sourceMessageId: 'msg-assistant-1',
      },
      toolCalls: [],
      contextManifestRef: 'session:api:observability|messages:2|memory_chars:64',
      internalStateSnapshotRef: 'trust:regular|contact:none|prompt:prompt-v1|memory:memory-v1|session:session-v1',
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      observability: {
        stages: [
          {
            observedAt: 1_700_000_000_010,
            turnId,
            requestId,
            channelId,
            callType: 'chat',
            purpose: 'agent.turn.stage.memory',
            stage: 'memory',
            elapsedMs: 10,
            data: {
              memoryChars: 64,
              proactiveRecallIncluded: true,
            },
          },
        ],
        retrievals: [
          {
            observedAt: 1_700_000_000_015,
            turnId,
            requestId,
            channelId,
            callType: 'chat',
            purpose: 'memory.retrieval',
            count: 1,
            retrievalSource: 'embedding',
            data: {
              candidateCount: 3,
              withheldCount: 1,
              withheldReasonCounts: {
                'trust.ceiling_exceeded': 1,
              },
            },
          },
        ],
        snapshot: {
          turnId,
          requestId,
          channelId,
          capturedAt: 1_700_000_000_020,
          trustLevel: 'regular',
          prompt: {
            staticPrefixTemplate: 'Static prefix',
            dynamicSuffixTemplate: 'Dynamic suffix',
            staticHash: 'static-hash',
            versionPointer: 'prompt-v1',
          },
          promptContext: {
            renderedStaticPrefix: 'Rendered static prefix',
            renderedDynamicSuffix: 'Rendered dynamic suffix',
            runtimeContext: 'Runtime context',
            memoryContextBlock: 'Memory block',
            scratchpadContext: 'Scratchpad block',
            assembledPrompt: 'Rendered static prefix\n\nRendered dynamic suffix',
            finalSystemPrompt: 'Final system prompt',
            messages: [
              { role: 'user', content: 'hello' },
              { role: 'assistant', content: 'world' },
            ],
          },
          toolContext: {
            activeTools: [
              {
                name: 'contact_lookup',
                description: 'Look up a contact.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            ],
            adaptiveSnapshot: {
              timestamp: 1_700_000_000_021,
              turnId,
              requestId,
              channelId,
              callType: 'chat',
              purpose: 'agent.tools.adaptive.snapshot',
              tools: [{ toolName: 'contact_lookup', source: 'core' }],
              skipped: [{ toolName: 'notify_operator', source: 'autoload', reason: 'not_needed_for_turn' }],
              counts: {
                core: 1,
                promoted: 0,
                extendedLoaded: 0,
                autoload: 0,
                deferred: 0,
                total: 1,
              },
              taskKind: null,
              intent: 'chat',
            },
          },
          sessionContext: {
            channelId,
            recentEntries: [],
            compactionSummaryTexts: ['summary-1'],
            focusKnowledgeTexts: ['focus-1'],
            continuityEntries: [],
            compactionPromptText: 'Compaction prompt snapshot',
            versionPointer: 'session-v1',
          },
          memory: {
            channelId,
            contactEmotionalMemories: [
              {
                id: 'mem-1',
                text: 'Observed memory',
                type: 'semantic',
                importance: 0.7,
                confidence: 0.8,
                emotionalValence: 0.1,
                salience: 0.9,
                sourceRef: 'source:api:observability',
                extractedAt: 1_700_000_000_001,
                lastAccessed: 1_700_000_000_002,
                accessCount: 1,
                tags: ['api'],
                sensitivity: 'personal',
              },
            ],
            semanticCandidates: [
              {
                id: 'mem-2',
                text: 'Allowed candidate',
                type: 'semantic',
                importance: 0.8,
                confidence: 0.8,
                emotionalValence: 0.05,
                salience: 0.7,
                sourceRef: 'source:api:observability',
                extractedAt: 1_700_000_000_003,
                lastAccessed: 1_700_000_000_004,
                accessCount: 1,
                tags: ['api'],
                sensitivity: 'public',
                similarity: 0.88,
              },
            ],
            lexicalCandidates: [],
            proactiveCandidates: [],
            withheldSummary: {
              totalCount: 1,
              reasonCounts: {
                'trust.ceiling_exceeded': 1,
              },
            },
            versionPointer: 'memory-v1',
          },
        },
      },
      versionPointers: {
        model: 'test-model',
        promptMode: 'default',
        promptStack: 'prompt-v1',
        memoryState: 'memory-v1',
        sessionState: 'session-v1',
      },
      provenanceRefs: [`turn:${turnId}`],
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const result = service.getSessionMessages(channelId);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.stages).toEqual([
      expect.objectContaining({
        stage: 'memory',
        callType: 'chat',
        data: expect.objectContaining({
          memoryChars: 64,
          proactiveRecallIncluded: true,
        }),
      }),
    ]);
    expect(result.turns[0]?.retrievals).toEqual([
      expect.objectContaining({
        retrievalSource: 'embedding',
        data: expect.objectContaining({
          candidateCount: 3,
          withheldCount: 1,
          withheldReasonCounts: {
            'trust.ceiling_exceeded': 1,
          },
        }),
      }),
    ]);
    expect(result.turns[0]?.snapshot).toMatchObject({
      trustLevel: 'regular',
      memory: {
        versionPointer: 'memory-v1',
        withheldSummary: {
          totalCount: 1,
          reasonCounts: {
            'trust.ceiling_exceeded': 1,
          },
        },
        semanticCandidates: [
          expect.objectContaining({
            text: 'Allowed candidate',
          }),
        ],
      },
      promptContext: {
        finalSystemPrompt: 'Final system prompt',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
      },
      toolContext: {
        activeTools: [
          {
            name: 'contact_lookup',
          },
        ],
        adaptiveSnapshot: {
          tools: [{ toolName: 'contact_lookup', source: 'core' }],
          skipped: [{ toolName: 'notify_operator', reason: 'not_needed_for_turn' }],
        },
      },
      sessionContext: {
        compactionPromptText: 'Compaction prompt snapshot',
      },
    });
  });

  it('surfaces continuity provenance for cross-channel inspection', () => {
    const continuityStore = new UserContinuityStore(join(dir, 'continuity'));
    continuityStore.append('canonical-contact-1', {
      channelId: 'discord:dm',
      role: 'assistant',
      content: 'Cross-channel continuity note',
      authorId: 'scheduler',
      authorName: 'Scheduler',
      timestamp: 1_700_000_200_000,
      originChannelId: 'discord:dm',
      channelVisibility: 'private',
    });

    store.append({
      channelId: 'api:session-1',
      role: 'user',
      content: 'Current channel message',
      authorId: 'canonical-contact-1',
      authorName: 'User',
      timestamp: 1_700_000_200_010,
      channelVisibility: 'private',
    });

    const continuityEntry = continuityStore.getRecent('canonical-contact-1', 10, undefined, 'api:session-1')[0];
    expect(continuityEntry).toBeDefined();

    const turnId = createTurnId();
    store.appendTurnRecord({
      schemaVersion: 1,
      turnId,
      requestId: 'req-continuity-1',
      channelId: 'api:session-1',
      channelType: 'api',
      startedAt: 1_700_000_200_000,
      completedAt: 1_700_000_200_050,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'Current channel message',
        timestamp: 1_700_000_200_010,
        authorId: 'canonical-contact-1',
        authorName: 'User',
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        model: 'test-model',
      },
      provenanceRefs: [`turn:${turnId}`],
      observability: {
        stages: [],
        retrievals: [],
        snapshot: {
          turnId,
          requestId: 'req-continuity-1',
          channelId: 'api:session-1',
          capturedAt: 1_700_000_200_020,
          trustLevel: 'regular',
          sessionContext: {
            channelId: 'api:session-1',
            recentEntries: [],
            compactionSummaryTexts: [],
            focusKnowledgeTexts: [],
            continuityEntries: [continuityEntry],
            versionPointer: 'session-v1',
          },
        },
      },
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const continuityEntryId = continuityEntry!.id;
    expect(continuityEntryId).toBeDefined();
    const result = service.getSessionMessages('api:session-1');
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.continuityProvenance).toEqual([
      expect.objectContaining({
        turnId,
        sessionEntryId: continuityEntryId,
        continuityUserId: 'canonical-contact-1',
        sourceChannelId: 'discord:dm',
        sourceVisibility: 'private',
        currentChannelId: 'api:session-1',
        currentVisibility: 'private',
        carriedAcrossChannels: true,
      }),
    ]);
  });

  it('surfaces role-envelope previews and promoted refs without exposing raw bodies', () => {
    const channelId = 'api:role-envelope-session';
    const requestId = 'role-envelope-turn-1';
    const turnId = createTurnId();
    const hiddenBody = 'raw internal envelope body should stay companion-private';
    const sessionManager = new SessionManager(store, makeConfig({ dataDir: dir }));

    const userSessionEntryId = sessionManager.recordUserMessage(
      channelId,
      'Please check in tomorrow if I go quiet.',
      'user-1',
      'User',
      undefined,
      undefined,
      {
        turnId,
        requestId,
      },
    );
    const assistantSessionEntryId = sessionManager.recordAssistantMessage(
      channelId,
      'Queued a gentle check-in reminder for tomorrow.',
      undefined,
      undefined,
      undefined,
      {
        turnId,
        requestId,
        roleEnvelopePreview: {
          schemaVersion: 1,
          envelopeId: 'env_admin_preview_1',
          internalRole: 'outreach_candidate',
          summary: 'Queued a gentle check-in reminder for tomorrow.',
          sourceStage: 'post_turn_appraisal',
          promotionTarget: 'turn_record_summary',
          promotedRef: 'turn_record_summary:env_admin_preview_1',
        },
      },
    );
    expect(userSessionEntryId).not.toBeNull();
    expect(assistantSessionEntryId).not.toBeNull();

    store.appendTurnRecord({
      schemaVersion: 1,
      turnId,
      requestId,
      channelId,
      channelType: 'api',
      startedAt: 1_700_000_100_000,
      completedAt: 1_700_000_100_050,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'Please check in tomorrow if I go quiet.',
        timestamp: 1_700_000_100_000,
        sessionEntryId: userSessionEntryId ?? undefined,
        sourceMessageId: 'msg-user-envelope-1',
        authorId: 'user-1',
        authorName: 'User',
      },
      assistantMessage: {
        role: 'assistant',
        content: 'Queued a gentle check-in reminder for tomorrow.',
        timestamp: 1_700_000_100_050,
        sessionEntryId: assistantSessionEntryId ?? undefined,
        sourceMessageId: 'msg-assistant-envelope-1',
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      roleEnvelopeRefs: sessionManager.getRoleEnvelopeRefsForEntries(
        channelId,
        [userSessionEntryId ?? 0, assistantSessionEntryId ?? 0],
      ),
      versionPointers: {
        model: 'test-model',
      },
      provenanceRefs: [`turn:${turnId}`],
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager,
      eventBus: new EventBus(),
    });

    const result = service.getSessionMessages(channelId);
    expect(result.roleEnvelopePreviews).toEqual([
      {
        sessionEntryId: assistantSessionEntryId,
        preview: {
          schemaVersion: 1,
          envelopeId: 'env_admin_preview_1',
          internalRole: 'outreach_candidate',
          summary: 'Queued a gentle check-in reminder for tomorrow.',
          sourceStage: 'post_turn_appraisal',
          promotionTarget: 'turn_record_summary',
          promotedRef: 'turn_record_summary:env_admin_preview_1',
        },
      },
    ]);
    expect(result.turns[0]?.roleEnvelopeRefs).toEqual(['turn_record_summary:env_admin_preview_1']);
    expect(result.turns[0]?.record.roleEnvelopeRefs).toEqual(['turn_record_summary:env_admin_preview_1']);
    expect(JSON.stringify(result)).not.toContain(hiddenBody);
  });

  it('lists and reads distinct sessions for the same logical channel', () => {
    const channelId = 'voxta:legacy:cf0a06ea';
    writeFileSync(join(dir, '20241119_voxta-legacy-cf0a06ea_alex_111111.jsonl'), [
      JSON.stringify({
        type: 'message',
        id: 1,
        channelId,
        role: 'user',
        content: 'older session',
        timestamp: 1_731_994_680_409,
      }),
      '',
    ].join('\n'));
    writeFileSync(join(dir, '20241225_voxta-legacy-cf0a06ea_alex_222222.jsonl'), [
      JSON.stringify({
        type: 'message',
        id: 1,
        channelId,
        role: 'assistant',
        content: 'newer session',
        timestamp: 1_735_138_451_488,
      }),
      '',
    ].join('\n'));

    const importedStore = new SessionStore(dir);
    const service = new AdminSessionDataService({
      sessionStore: importedStore,
      sessionManager: new SessionManager(importedStore, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const listed = service.listSessions().channels.filter(channel => channel.channelId === channelId);
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map(channel => channel.sessionId)).size).toBe(2);

    const contentBySessionId = new Map(
      listed.map(channel => [
        channel.sessionId,
        service.getSessionMessages(channel.sessionId).messages[0]?.content ?? '',
      ]),
    );
    expect(new Set(contentBySessionId.values())).toEqual(new Set(['older session', 'newer session']));

    for (const channel of listed) {
      const details = service.getSessionMessages(channel.sessionId);
      expect(details.sessionId).toBe(channel.sessionId);
      expect(details.channelId).toBe(channelId);
    }
  });
});

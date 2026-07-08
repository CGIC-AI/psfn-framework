import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import { UserContinuityStore } from '../../../core/session/continuity.js';
import { createUserContinuityPort } from '../../../core/session/cross-channel-continuity-port.js';
import { SessionManager } from '../../../core/session/manager.js';
import {
  buildToolObservationMetadata,
  normalizeToolObservation,
} from '../../../core/session/tool-observation.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { createSqliteTranscriptProjection } from '../../../persistence/sessions/transcript-projection.js';
import { createTurnId } from '../../../core/turns/id.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
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

  it('returns newest message page by default and older pages by beforeId cursor', () => {
    const channelId = 'api:paginated-session';
    for (let index = 1; index <= 250; index += 1) {
      store.append({
        channelId,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `Message ${index}`,
        timestamp: 1_700_000_000_000 + index,
      });
    }

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const firstPage = service.getSessionMessages(channelId);
    expect(firstPage.messages).toHaveLength(100);
    expect(firstPage.messages[0]?.content).toBe('Message 151');
    expect(firstPage.messages[99]?.content).toBe('Message 250');
    expect(firstPage.pagination).toMatchObject({
      limit: 100,
      beforeId: null,
      nextBeforeId: firstPage.messages[0]?.id,
      hasMoreOlder: true,
      totalMessages: 250,
      returnedMessages: 100,
    });

    const secondPage = service.getSessionMessages(channelId, {
      limit: 100,
      beforeId: firstPage.pagination.nextBeforeId,
    });
    expect(secondPage.messages).toHaveLength(100);
    expect(secondPage.messages[0]?.content).toBe('Message 51');
    expect(secondPage.messages[99]?.content).toBe('Message 150');
    expect(secondPage.pagination).toMatchObject({
      limit: 100,
      beforeId: firstPage.pagination.nextBeforeId,
      nextBeforeId: secondPage.messages[0]?.id,
      hasMoreOlder: true,
      totalMessages: 250,
      returnedMessages: 100,
    });

    const terminalPage = service.getSessionMessages(channelId, {
      limit: 100,
      beforeId: secondPage.pagination.nextBeforeId,
    });
    expect(terminalPage.messages).toHaveLength(50);
    expect(terminalPage.messages[0]?.content).toBe('Message 1');
    expect(terminalPage.messages[49]?.content).toBe('Message 50');
    expect(terminalPage.pagination).toMatchObject({
      limit: 100,
      beforeId: secondPage.pagination.nextBeforeId,
      nextBeforeId: null,
      hasMoreOlder: false,
      totalMessages: 250,
      returnedMessages: 50,
    });
  });

  it('searches session messages scoped to the requested session only', async () => {
    const searchDir = mkdtempSync(join(tmpdir(), 'admin-session-search-'));
    const searchStore = new SessionStore(searchDir, {
      transcriptProjection: createSqliteTranscriptProjection(join(searchDir, 'session-search.sqlite')),
    });
    try {
      const targetChannelId = 'api:search-target';
      const otherChannelId = 'api:search-other';
      const targetHitId = searchStore.append({
        channelId: targetChannelId,
        role: 'user',
        content: 'poisoned instruction planted here',
        timestamp: 1_700_000_000_001,
      });
      searchStore.append({
        channelId: targetChannelId,
        role: 'assistant',
        content: 'a clean unrelated response',
        timestamp: 1_700_000_000_002,
      });
      searchStore.append({
        channelId: otherChannelId,
        role: 'user',
        content: 'poisoned instruction in a different session',
        timestamp: 1_700_000_000_003,
      });

      const service = new AdminSessionDataService({
        sessionStore: searchStore,
        sessionManager: new SessionManager(searchStore, makeConfig({ dataDir: searchDir })),
        eventBus: new EventBus(),
      });

      const result = await service.searchSessionMessages(targetChannelId, 'poisoned');
      expect(result.sessionId).toBe(targetChannelId);
      expect(result.query).toBe('poisoned');
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.messageId).toBe(targetHitId);
      expect(result.hits[0]?.content).toContain('planted here');

      const blankQuery = await service.searchSessionMessages(targetChannelId, '   ');
      expect(blankQuery.hits).toEqual([]);
    } finally {
      rmSync(searchDir, { recursive: true, force: true });
    }
  });

  it('skips turn snapshots, compaction audits, and role-envelope previews in messagesOnly mode', () => {
    const channelId = 'api:messages-only';
    const firstMessageId = store.append({
      channelId,
      role: 'user',
      content: 'first message',
      timestamp: 1_700_000_000_001,
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'second message',
      timestamp: 1_700_000_000_002,
    });
    store.insertCompaction(channelId, 'summary of early rows', firstMessageId);

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const full = service.getSessionMessages(channelId);
    expect(full.compactionAuditViews.length).toBeGreaterThan(0);

    const light = service.getSessionMessages(channelId, { messagesOnly: true });
    expect(light.messages).toHaveLength(2);
    expect(light.pagination.totalMessages).toBe(2);
    expect(light.turns).toEqual([]);
    expect(light.compactionAuditViews).toEqual([]);
    expect(light.roleEnvelopePreviews).toEqual([]);
  });

  it('previews and applies CogSec remediation without exposing sealed content in safe event logs', async () => {
    const channelId = 'api:cogsec-admin';
    const dirtyText = 'DIRTY_ADMIN_COGSEC_TEXT';
    const dirtyMessageId = store.append({
      channelId,
      role: 'user',
      content: dirtyText,
      timestamp: 1,
      authorName: 'Operator',
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'clean response remains',
      timestamp: 2,
      authorName: 'Companion',
    });
    store.insertCompaction(channelId, 'DIRTY_ADMIN_COGSEC_SUMMARY', dirtyMessageId);

    const taintedMemory: PurrMemory = {
      id: 'memory-cogsec-admin',
      text: 'tainted memory linked by provenance',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.9,
      sourceRef: `${channelId}:extract|source:session|session:${channelId}|message:${dirtyMessageId}`,
      extractedAt: 1,
      lastAccessed: 1,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
    };
    const softDeleteMemory = vi.fn().mockResolvedValue({
      deleteId: 'delete-1',
      memoryId: taintedMemory.id,
      snapshot: taintedMemory,
      deletedAt: 1,
      deletedBy: 'operator:garden',
    });
    const memoryStore = {
      listMemories: vi.fn().mockResolvedValue([taintedMemory]),
      softDeleteMemory,
    } as unknown as MemoryStorePort;

    const config = makeConfig({ dataDir: dir });
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, config),
      eventBus: new EventBus(),
      memoryStore,
      config,
    });

    const input = {
      sourceChannelId: channelId,
      messageIds: [dirtyMessageId],
      type: 'memory_poisoning' as const,
      severity: 'high' as const,
      reason: 'operator selected contaminated row',
      actor: 'operator:garden',
      cutEpoch: false,
    };
    const preview = await service.previewCogSecRemediation(input);
    expect(preview.counts).toMatchObject({
      l0Rows: 1,
      projectionRows: 1,
      memories: 1,
      compactionSummaries: 1,
    });
    expect(JSON.stringify(preview)).not.toContain(dirtyText);

    const applied = await service.applyCogSecRemediation(input);
    expect(applied.tombstones).toHaveLength(1);
    expect(applied.tombstones[0]?.tombstonedL0RowCount).toBe(1);
    expect(applied.revocation.revokedMemoryIds).toEqual(['memory-cogsec-admin']);
    expect(softDeleteMemory).toHaveBeenCalledWith('memory-cogsec-admin', expect.objectContaining({
      deletedBy: 'operator:garden',
      reason: expect.stringContaining(applied.event.caseId),
    }));
    expect(store.getRecent(channelId, 5).map(entry => entry.content)).not.toContain(dirtyText);

    const events = await service.listCogSecEvents();
    const serializedEvents = JSON.stringify(events);
    expect(events.events[0]?.caseId).toBe(applied.event.caseId);
    expect(serializedEvents).not.toContain(dirtyText);
    expect(serializedEvents).not.toContain('cogsec-forensic://');
    expect(serializedEvents).not.toContain('sealedForensicPayloadRefs');
  });

  it('keeps CogSec previews scoped to the operator-selected logical session', async () => {
    const sourceChannelId = 'discord:guild:room';
    const oldLogicalSessionId = sourceChannelId;
    const dirtyMessageId = store.append({
      channelId: oldLogicalSessionId,
      role: 'user',
      content: 'DIRTY_OLD_LOGICAL_SESSION_TEXT',
      timestamp: 1,
      authorName: 'Vega',
    });
    const config = makeConfig({ dataDir: dir });
    const sessionManager = new SessionManager(store, config);
    const reset = sessionManager.resetSourceChannelSession({
      sourceChannelId,
      actor: 'operator:garden',
      reason: 'cut a fresh lane before CogSec cleanup',
      mode: 'break_glass_quarantine',
    });
    store.append({
      channelId: reset.newLogicalSessionId,
      role: 'user',
      content: 'clean active lane text',
      timestamp: 2,
      originChannelId: sourceChannelId,
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager,
      eventBus: new EventBus(),
      config,
    });

    const preview = await service.previewCogSecRemediation({
      sourceChannelId,
      affectedMessageRanges: [{
        sourceChannelId,
        logicalSessionId: oldLogicalSessionId,
        messageIds: [dirtyMessageId],
      }],
      type: 'content_poisoning',
      severity: 'high',
      reason: 'operator selected old logical session row',
      actor: 'operator:garden',
    });

    expect(preview.draft.affectedLogicalSessionIds).toEqual([oldLogicalSessionId]);
    expect(preview.draft.affectedLogicalSessionIds).not.toContain(reset.newLogicalSessionId);
    expect(preview.counts.l0Rows).toBe(1);
    expect(preview.preview.l0Messages).toEqual([
      expect.objectContaining({
        logicalSessionId: oldLogicalSessionId,
        messageId: dirtyMessageId,
      }),
    ]);
    expect(JSON.stringify(preview)).not.toContain('DIRTY_OLD_LOGICAL_SESSION_TEXT');
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
            staticPrefixTemplate: '<runtime_self>Historical runtime self layer</runtime_self>',
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
            providerObservability: {
              routeKind: 'configured_litellm_proxy',
              requestedProvider: 'openrouter',
              requestedModel: 'openrouter/test-model',
              backendProvider: 'litellm',
              backendModel: 'openrouter/test-model',
              backendApi: 'openai-responses',
              backendBaseUrl: 'http://127.0.0.1:4000',
              promptCaching: {
                configured: false,
                engaged: false,
              },
              systemRole: {
                transport: 'openai_developer',
                supportsSystemRole: true,
                supportsDeveloperRole: true,
                usesOutOfBandSystemPrompt: false,
              },
              providerWireMessages: [
                { role: 'developer', source: 'system_prompt', content: 'Final system prompt' },
                { role: 'user', source: 'message', content: 'hello' },
                { role: 'assistant', source: 'message', content: 'world' },
              ],
            },
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
              skipped: [{ toolName: 'notify', source: 'autoload', reason: 'not_needed_for_turn' }],
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
          skipped: [{ toolName: 'notify', reason: 'not_needed_for_turn' }],
        },
      },
      sessionContext: {
        compactionPromptText: 'Compaction prompt snapshot',
      },
    });
    expect(result.turns[0]?.promptLoom).toMatchObject({
      historicalSnapshot: {
        label: 'Persisted turn snapshot; not current prompt generator state.',
        removedPromptLayerIds: ['runtime_self'],
      },
      providerPayload: {
        finalSystemPrompt: 'Final system prompt',
        providerMessages: [
          { role: 'developer', source: 'system_prompt', content: 'Final system prompt' },
          { role: 'user', source: 'message', content: 'hello' },
          { role: 'assistant', source: 'message', content: 'world' },
        ],
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
      },
      memoryCapture: {
        input: {
          currentTurnInput: null,
          renderedChatOutput: 'world',
        },
        output: {
          extractedMemoryIds: [],
        },
      },
    });
  });

  it('drops sibling API session continuity entries from merged context', () => {
    const continuityStore = new UserContinuityStore(join(dir, 'continuity'));
    continuityStore.append('canonical-contact-1', {
      channelId: 'api:principal-a:session-b',
      role: 'assistant',
      content: 'This should stay in session-b.',
      authorId: 'companion',
      authorName: 'Whisper',
      timestamp: 1_700_000_000_000,
      channelVisibility: 'private',
    });

    const continuityPort = createUserContinuityPort(continuityStore);
    expect(continuityPort.getMerged({
      canonicalUserId: 'canonical-contact-1',
      limit: 10,
      fallbackUserIds: [],
      channelId: 'api:principal-a:session-a',
    })).toEqual([]);
  });

  it('drops continuity entries whose stored provenance no longer matches the entry payload', () => {
    const continuityStore = new UserContinuityStore(join(dir, 'continuity'));
    continuityStore.append('canonical-contact-1', {
      channelId: 'discord:dm',
      role: 'user',
      content: 'Real message',
      authorId: 'canonical-contact-1',
      authorName: 'User',
      timestamp: 1_700_000_000_000,
      channelVisibility: 'private',
    });

    const [entry] = continuityStore.getRecent('canonical-contact-1', 10);
    expect(entry).toBeDefined();
    entry!.metadata = JSON.stringify({
      continuity: {
        kind: 'continuity',
        continuityUserId: 'canonical-contact-1',
        sourceChannelId: 'discord:other-dm',
        sourceVisibility: 'private',
        sourceRole: 'user',
        recordedAt: 1_700_000_000_000,
      },
    });

    const continuityPort = createUserContinuityPort(continuityStore);
    expect(continuityPort.getMerged({
      canonicalUserId: 'canonical-contact-1',
      limit: 10,
      fallbackUserIds: [],
      channelId: 'api:principal-a:session-a',
    })).toEqual([]);
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

  it('returns explicit message ontology views for operator inspection', () => {
    const channelId = 'api:ontology-session';
    const systemNoteId = store.append({
      channelId,
      role: 'system',
      content: 'Injected policy note',
      timestamp: 1_700_000_300_000,
    });
    const mirrorId = store.append({
      channelId,
      role: 'system',
      content: 'Cross-channel carryover',
      originChannelId: 'discord:dm',
      metadata: JSON.stringify({
        type: 'mirror',
        sourceChannelId: 'discord:dm',
        sourceRole: 'assistant',
        sourceAuthorName: 'Remote companion',
      }),
      timestamp: 1_700_000_300_010,
    });
    const toolObservation = normalizeToolObservation({
      toolName: 'contact_lookup',
      content: 'Matched one contact',
    });
    const toolId = store.append({
      channelId,
      role: 'tool',
      content: toolObservation.content,
      metadata: buildToolObservationMetadata(undefined, toolObservation.metadata),
      timestamp: 1_700_000_300_020,
    });
    const userId = store.append({
      channelId,
      role: 'user',
      content: 'hello there',
      timestamp: 1_700_000_300_030,
    });
    const assistantId = store.append({
      channelId,
      role: 'assistant',
      content: 'general kenobi',
      timestamp: 1_700_000_300_040,
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const result = service.getSessionMessages(channelId);

    expect(result.messageOntologyViews).toEqual([
      {
        sessionEntryId: systemNoteId,
        transportRole: 'system',
        promptRole: 'custom',
        semanticType: 'systemNote',
        messageClass: 'systemNote',
        promptVisibility: 'operator_only',
        displayLabel: 'System note',
      },
      {
        sessionEntryId: mirrorId,
        transportRole: 'system',
        promptRole: 'custom',
        semanticType: 'mirror',
        messageClass: 'mirror',
        promptVisibility: 'operator_only',
        displayLabel: 'Mirror note',
      },
      {
        sessionEntryId: toolId,
        transportRole: 'tool',
        promptRole: 'toolResult',
        semanticType: 'toolResult',
        messageClass: null,
        promptVisibility: 'prompt_visible',
        displayLabel: 'Tool result',
      },
      {
        sessionEntryId: userId,
        transportRole: 'user',
        promptRole: 'user',
        semanticType: 'outwardSpeech',
        messageClass: 'outwardSpeech',
        promptVisibility: 'prompt_visible',
        displayLabel: 'Outward speech',
      },
      {
        sessionEntryId: assistantId,
        transportRole: 'assistant',
        promptRole: 'assistant',
        semanticType: 'outwardSpeech',
        messageClass: 'outwardSpeech',
        promptVisibility: 'prompt_visible',
        displayLabel: 'Outward speech',
      },
    ]);
  });

  it('classifies reflection musings with the canonical musing message class', () => {
    const channelId = 'internal:reflection:musing';
    const assistantId = store.append({
      channelId,
      role: 'assistant',
      content: 'a soft outward reflection',
      timestamp: 1_700_000_300_100,
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const result = service.getSessionMessages(channelId);
    expect(result.messageOntologyViews).toContainEqual({
      sessionEntryId: assistantId,
      transportRole: 'assistant',
      promptRole: 'assistant',
      semanticType: 'outwardSpeech',
      messageClass: 'musing',
      promptVisibility: 'prompt_visible',
      displayLabel: 'Outward speech',
    });
  });

  it('lists and reads distinct sessions for the same logical channel', async () => {
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

    const listed = (await service.listSessions()).channels.filter(channel => channel.channelId === channelId);
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

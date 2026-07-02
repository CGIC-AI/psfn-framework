import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { EventBus } from '../../shared/event-bus.js';
import { AdminServer } from './server.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import {
  buildSettingsContractData,
} from '../../system/config/settings-contract.js';
import {
  createDefaultCompositionalPolicyConfig,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import { createDefaultGroupMemorySettings } from '../../system/config/group-memory-config.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import type { Episode, EpisodeArc } from '../../shared/contracts/episodic-memory.js';
import { EPISODIC_CONTRACT_VERSION } from '../../shared/contracts/episodic-memory.js';
import type {
  AdminEpisodicMemoryService,
  AdminGroupMemoryChannelDiagnostics,
  AdminGroupMemoryService,
  AdminMemoryService,
  AdminSettingsData,
  AdminSettingsService,
  AdminShardFoldReviewService,
} from './services/types.js';

const ADMIN_TOKEN = 'postgres-cutover-smoke-token';
const CUTOVER_CHANNEL_ID = 'discord:postgres-cutover';
const CUTOVER_SESSION_ID = 'session:postgres-cutover';
const CUTOVER_MEMORY_ID = 'memory-postgres-cutover';
const CUTOVER_EPISODE_ID = 'episode-postgres-cutover';
const CUTOVER_THREAD_ID = 'thread-postgres-cutover';
const CUTOVER_SHARD_ID = 'shard-postgres-review';
const NOW = Date.parse('2026-06-29T12:00:00.000Z');
const ISO_NOW = new Date(NOW).toISOString();

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate smoke-test port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function parseOkJson<T>(response: HttpResponse, label: string): T {
  expect(response.status, `${label} should be reachable`).toBe(200);
  expect(response.headers['content-type'], `${label} should return JSON`).toContain('application/json');
  return JSON.parse(response.body) as T;
}

function makeMemory(): PurrMemory {
  return {
    id: CUTOVER_MEMORY_ID,
    text: 'Postgres cutover smoke memory is visible through Garden search.',
    type: 'semantic',
    importance: 0.91,
    confidence: 0.94,
    emotionalValence: 0.2,
    salience: 0.88,
    sourceRef: `source:sleeptime|session:${CUTOVER_SESSION_ID}`,
    sourceType: 'reflection',
    provenance: {
      channelId: CUTOVER_CHANNEL_ID,
      sessionId: CUTOVER_SESSION_ID,
      mode: 'memory.sleeptime.plan',
      actor: 'companion',
    },
    extractedAt: NOW - 5_000,
    lastAccessed: NOW,
    accessCount: 3,
    tags: ['postgres', 'garden', 'sleeptime'],
    scopeRef: {
      kind: 'conversation',
      id: CUTOVER_CHANNEL_ID,
      label: 'Postgres cutover',
    },
    scopeTags: ['conversation:postgres-cutover'],
    provenanceRefs: ['sleeptime_action:postgres-cutover'],
    retentionClass: 'durable',
    sensitivity: 'personal',
  };
}

const cutoverEpisode: Episode = {
  schemaVersion: EPISODIC_CONTRACT_VERSION,
  id: CUTOVER_EPISODE_ID,
  title: 'Garden verified Postgres memory cutover',
  landmark: 'The operator could inspect cutover memory, L0.1 state, and maintenance diagnostics.',
  startedAt: '2026-06-29T11:45:00.000Z',
  endedAt: '2026-06-29T11:55:00.000Z',
  threadId: CUTOVER_THREAD_ID,
  channelId: CUTOVER_CHANNEL_ID,
  participantContactIds: ['contact-operator'],
  salience: {
    score: 0.87,
    novelty: 0.6,
    emotionalIntensity: 0.25,
  },
  affect: {
    labels: ['focused'],
    valence: 0.2,
    arousal: 0.35,
  },
  themes: ['postgres', 'garden', 'cutover'],
  spanRefs: [{
    spanId: 'span-postgres-cutover',
    channelId: CUTOVER_CHANNEL_ID,
    threadId: CUTOVER_THREAD_ID,
    sessionId: CUTOVER_SESSION_ID,
    startedAt: '2026-06-29T11:45:00.000Z',
    endedAt: '2026-06-29T11:55:00.000Z',
  }],
  artifactRefs: [],
  provenanceRefs: [{
    kind: 'l0_span',
    refId: 'span-postgres-cutover',
    note: 'Smoke fixture proves L0.1 provenance is exposed.',
  }],
  meaning: {
    text: 'The cutover felt grounded because the operator could inspect every persistence surface.',
    recordedAt: ISO_NOW,
    source: 'companion_dream_pass',
  },
  createdAt: ISO_NOW,
  updatedAt: ISO_NOW,
};

const relatedArc: EpisodeArc = {
  schemaVersion: EPISODIC_CONTRACT_VERSION,
  id: 'arc-postgres-cutover',
  sourceEpisodeId: CUTOVER_EPISODE_ID,
  targetEpisodeId: CUTOVER_EPISODE_ID,
  arcKind: 'same_theme',
  salience: 0.7,
  confidence: 0.9,
  themes: ['postgres'],
  spanRefs: cutoverEpisode.spanRefs,
  artifactRefs: [],
  provenanceRefs: [{
    kind: 'operator_note',
    refId: 'postgres-cutover-smoke',
  }],
  createdAt: ISO_NOW,
  updatedAt: ISO_NOW,
};

function makeMemoryService(memory: PurrMemory): AdminMemoryService {
  const privacySummary = {
    activeMemoryCount: 1,
    matchingMemoryCount: 1,
    pageMemoryCount: 1,
    highSensitivityCount: 0,
    consentGatedCount: 0,
    contactLinkedCount: 0,
    scopedCount: 1,
    sensitivityCounts: { personal: 1 },
  };

  return {
    listMemories: async () => ({
      memories: [memory],
      contactsById: new Map(),
      privacySummary,
      pagination: {
        limit: 50,
        offset: 0,
        total: 1,
        hasPrevious: false,
        hasNext: false,
      },
    }),
    getMemoryDetail: async id => (id === memory.id
      ? {
        memory,
        scopeAssignments: [{
          kind: 'project',
          id: 'postgres-cutover',
          label: 'Postgres cutover',
          canonicalTag: 'project:postgres-cutover',
          evidence: [{
            source: 'scope_ref',
            confidence: 1,
            detail: 'Fixture scope proves Garden memory detail exposes scope evidence.',
          }],
        }],
        scopeRepair: {
          needsRepair: false,
          suggestedScopeTags: [],
          notes: [],
        },
      }
      : null),
    listManagedScopes: async () => ({
      scopes: [{
        kind: 'project',
        id: 'postgres-cutover',
        label: 'Postgres cutover',
        canonicalTag: 'project:postgres-cutover',
        memoryCount: 1,
        needsRepairCount: 0,
      }],
    }),
    getManagedScopeDetail: async () => null,
    searchMemories: async query => ({
      query,
      results: query.includes('cutover') ? [memory] : [],
      contactsById: new Map(),
      privacySummary,
    }),
    supersedeMemory: async () => ({ ok: true }),
    updateMemoryScope: async () => ({
      ok: true,
      memory,
      scopeAssignments: [],
    }),
    linkMemories: async () => ({ ok: true }),
    unlinkMemories: async () => ({ ok: true }),
    getMemoryLinks: async () => [],
    bulkDelete: async ids => ({ ok: true, count: ids.length }),
    bulkUpdate: async ids => ({ ok: true, count: ids.length }),
    getBodyElevationStatus: () => ({ elevated: false, ttlMs: 900_000 }),
    elevateBodyAccess: () => ({ elevated: true, expiresAt: Date.now() + 900_000, ttlMs: 900_000 }),
    dropBodyElevation: () => ({ elevated: false, ttlMs: 900_000 }),
    revealMemory: async () => null,
  };
}

function makeEpisodicMemoryService(): AdminEpisodicMemoryService {
  return {
    listEpisodes: async () => ({
      episodes: [cutoverEpisode],
      pagination: {
        limit: 50,
        offset: 0,
        total: 1,
        hasPrevious: false,
        hasNext: false,
      },
      filters: {
        threadId: CUTOVER_THREAD_ID,
      },
    }),
    getEpisodeDetail: async id => (id === CUTOVER_EPISODE_ID
      ? {
        episode: cutoverEpisode,
        relatedArcs: [{
          arc: relatedArc,
          direction: 'outgoing',
          relatedEpisode: cutoverEpisode,
        }],
        threadEpisodes: [cutoverEpisode],
        episodeId: CUTOVER_EPISODE_ID,
        spanRefs: cutoverEpisode.spanRefs,
        artifactRefs: cutoverEpisode.artifactRefs,
        provenanceRefs: cutoverEpisode.provenanceRefs,
      }
      : null),
    getEpisodeProvenance: async id => (id === CUTOVER_EPISODE_ID
      ? {
        episodeId: CUTOVER_EPISODE_ID,
        spanRefs: cutoverEpisode.spanRefs,
        artifactRefs: cutoverEpisode.artifactRefs,
        provenanceRefs: cutoverEpisode.provenanceRefs,
      }
      : null),
    listEpisodeArcs: async id => (id === CUTOVER_EPISODE_ID
      ? {
        episodeId: CUTOVER_EPISODE_ID,
        relatedArcs: [{
          arc: relatedArc,
          direction: 'outgoing',
          relatedEpisode: cutoverEpisode,
        }],
      }
      : null),
    listThreads: async () => ({
      threads: [{
        threadId: CUTOVER_THREAD_ID,
        episodeCount: 1,
        arcCount: 1,
        startedAt: cutoverEpisode.startedAt,
        endedAt: cutoverEpisode.endedAt,
        topThemes: ['postgres', 'garden'],
        salienceScore: 0.87,
        latestEpisodeId: CUTOVER_EPISODE_ID,
        latestEpisodeTitle: cutoverEpisode.title,
      }],
    }),
    getThreadDetail: async threadId => (threadId === CUTOVER_THREAD_ID
      ? {
        thread: {
          threadId: CUTOVER_THREAD_ID,
          episodeCount: 1,
          arcCount: 1,
          startedAt: cutoverEpisode.startedAt,
          endedAt: cutoverEpisode.endedAt,
          topThemes: ['postgres', 'garden'],
          salienceScore: 0.87,
          latestEpisodeId: CUTOVER_EPISODE_ID,
          latestEpisodeTitle: cutoverEpisode.title,
        },
        episodes: [cutoverEpisode],
        arcs: [relatedArc],
        relatedArcs: [{
          arc: relatedArc,
          direction: 'outgoing',
          relatedEpisode: cutoverEpisode,
        }],
      }
      : null),
  };
}

function makeGroupMemoryDiagnostics(): AdminGroupMemoryChannelDiagnostics {
  const settings = createDefaultGroupMemorySettings();
  return {
    channelId: CUTOVER_CHANNEL_ID,
    sessionId: CUTOVER_SESSION_ID,
    channelType: 'discord',
    messageCount: 42,
    lastActivityAt: NOW,
    resolvedConfig: settings,
    classification: {
      mode: 'group',
      reason: 'manual_group',
      topology: {
        kind: 'group_channel',
        source: 'manual',
      },
      configuredMemoryMode: 'group',
      configuredMemoryModeSource: 'channel',
      manualOverrideSource: 'channel',
      recentParticipantCount: 2,
      recentParticipantContactIds: ['contact-operator', 'contact-companion'],
      recentParticipants: [{
        stableId: 'operator',
        contactId: 'contact-operator',
        authorId: 'operator',
        authorName: 'Operator',
        entryIds: [40, 41],
        lastSeenAt: NOW,
        source: 'contact',
      }],
      participantWindow: {
        requestedMessageLimit: 75,
        requestedTimeWindowMs: 21_600_000,
        newestTimestamp: NOW,
        cutoffTimestamp: NOW - 21_600_000,
        scannedEntryCount: 42,
        eligibleEntryCount: 42,
        oldestEntryId: 1,
        newestEntryId: 42,
      },
    },
    watermark: {
      schemaVersion: 1,
      channelId: CUTOVER_CHANNEL_ID,
      policyVersion: 'garden-postgres-cutover-smoke',
      coveredUpToMessageId: 37,
      updatedAt: NOW,
      status: 'active',
      processedSpanCount: 3,
      skippedSpanCount: 0,
      failureCount: 0,
    },
    range: {
      headMessageId: 42,
      watermarkLagMessageIds: 5,
      plannedChunkCount: 1,
      hasDeferredBacklog: false,
      firstChunk: {
        spanStartMessageId: 38,
        spanEndMessageId: 42,
        contextStartMessageId: 36,
        contextEndMessageId: 42,
        newEntryCount: 5,
        overlapEntryCount: 2,
        estimatedTokens: 840,
      },
    },
    salience: {
      telemetry: {
        messagesConsidered: 5,
        candidateSpanCount: 1,
        selectedSpanCount: 1,
        rejectedLowSignalCount: 0,
      },
      candidateSpans: [{
        startMessageId: 38,
        endMessageId: 42,
        contextStartMessageId: 36,
        contextEndMessageId: 42,
        sourceMessageIds: [39, 41],
        newSourceMessageIds: [41],
        contextMessageIds: [36, 37, 38, 39, 40, 41, 42],
        score: 0.91,
        reasons: ['companion_mention', 'durable_plan'],
        contributingAuthorIds: ['operator'],
        contributingContactIds: ['contact-operator'],
      }],
    },
    lastExtraction: {
      channelId: CUTOVER_CHANNEL_ID,
      count: 1,
      triggerReason: 'operator_backfill',
      parsedCount: 2,
      acceptedCount: 1,
      rejectedCount: 1,
      writeCount: 1,
      deduplicatedCount: 0,
      supersededCount: 0,
      rejectionBreakdown: { low_signal: 1 },
      ambiguousSpeakerSkippedCount: 0,
      ambiguousSpeakerSkipReasons: {},
      writeCapSkips: [],
      compositionalMode: 'legacy',
      chunkCount: 1,
      mergedFactCount: 1,
      crossChunkDeduplicatedCount: 0,
      boundaryFactCount: 0,
    },
    coverage: {
      channelMemoryCount: 1,
      activeMemoryCount: 1,
      highSensitivityMemoryCount: 0,
      perContact: [{
        contactId: 'contact-operator',
        displayName: 'Operator',
        recentMessageCount: 4,
        sourceMemoryCount: 1,
        subjectMemoryCount: 1,
        routedMemoryCount: 1,
        totalAttributedMemoryCount: 1,
        profileStatus: 'profile_ready',
        profileSourceMemoryCount: 1,
        profileUpdatedAt: NOW,
      }],
    },
    privacy: {
      rawTranscriptTextIncluded: false,
      memoryTextIncluded: false,
    },
  };
}

function makeGroupMemoryService(): AdminGroupMemoryService {
  const diagnostics = makeGroupMemoryDiagnostics();
  return {
    listGroupMemoryDiagnostics: async () => ({
      channels: [diagnostics],
      reasonCounts: {
        manual_group: 1,
      },
    }),
    getGroupMemoryChannelDiagnostics: async channelId => (
      channelId === CUTOVER_CHANNEL_ID ? diagnostics : null
    ),
    runGroupMemoryBackfill: async () => ({
      ok: true,
      channelId: CUTOVER_CHANNEL_ID,
      mode: 'dry_run',
      processedChunks: 1,
      writeCount: 0,
      skippedCount: 0,
      errors: [],
    }),
  };
}

function makeSettingsService(): AdminSettingsService {
  const groupMemory = createDefaultGroupMemorySettings();
  const settingsData: AdminSettingsData = {
    config: {
      sessionHistoryBudgetPct: 35,
      memoryRetrievalBudgetPct: 20,
      memoryExtractionTelemetryEnabled: true,
      memoryRetrievalTelemetryEnabled: true,
      groupMemory,
      sessionRestartBehavior: 'reuse_latest_session',
      embeddingProvider: 'api',
    },
    env: {
      salienceFloor: 0.2,
      maintenanceIntervalMs: 300_000,
      discordToken: '[not set]',
      apiKey: '[set]',
      adminToken: '[set]',
      openrouterApiKey: '[not set]',
      litellmBaseUrl: '[not set]',
      litellmApiKey: '[not set]',
      importProcessingLocalApiKey: '[not set]',
      telegramBotToken: '[not set]',
    },
    editors: {
      models: {
        modelRegistry: {
          version: 1,
          updatedAt: ISO_NOW,
          providers: [],
          slots: [],
        },
      },
      providers: {
        version: 1,
        providers: [],
      },
      channels: {},
      skills: {
        version: 1,
        managedSkills: [],
        disabledSkills: [],
      },
      scheduler: {
        tickIntervalMs: 60_000,
        salienceDecayIntervalMs: 300_000,
        episodicProcessing: {
          enabled: true,
          startLocalTime: '22:00',
          endLocalTime: '07:00',
          timeZone: 'America/New_York',
          inactivityThresholdMinutes: 45,
        },
      },
      trustPolicy: {
        version: 1,
        rules: [],
      },
      capabilities: {
        version: 1,
        tier: 'apprentice',
        customTokens: [],
      },
      chargePolicy: {
        version: 1,
        fatigue: {
          enabled: false,
        },
      },
      backup: {
        version: 1,
        hmac: {
          enabled: false,
        },
      },
    },
    voiceProviders: {
      stt: [],
      tts: [],
    },
    status: {
      status: 'healthy',
      detail: 'Persisted settings match the live Garden runtime.',
      divergences: [],
    },
  };

  return {
    getSettingsData: async () => settingsData,
    getSettingsContractData: () => buildSettingsContractData(),
    updateSettings: () => ({ ok: true, message: 'Settings updated' }),
    getSubConfigJson: key => (key === 'scheduler'
      ? JSON.stringify(settingsData.editors.scheduler, null, 2)
      : null),
    saveSubConfigJson: () => ({ ok: true, message: 'config saved' }),
  };
}

function makeShardFoldReviewService(): AdminShardFoldReviewService {
  const review = {
    shardId: CUTOVER_SHARD_ID,
    channelId: CUTOVER_CHANNEL_ID,
    task: 'Review Postgres cutover maintenance candidate',
    validationPath: `/api/admin/shards/${CUTOVER_SHARD_ID}`,
    reviewState: 'pending',
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    pendingMemoryCount: 1,
    pendingArtifactCount: 0,
    blockingReasons: ['operator_review_required'],
    emotionalOrRelational: false,
  };
  return {
    listShardFoldReviews: async () => ({
      reviews: [review],
    }),
    getShardFoldReview: async shardId => (shardId === CUTOVER_SHARD_ID
      ? {
        ...review,
        memoryItems: [{
          reviewState: 'pending',
          text: 'Postgres cutover maintenance candidate needs review.',
        }],
        artifactItems: [],
      } as never
      : null),
    resolveShardFoldReview: async () => ({
      ok: true,
      review: {
        ...review,
        reviewState: 'approved',
      } as never,
    }),
  };
}

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'cutover-chat-model',
    primaryProvider: 'test',
    extractionModel: 'cutover-memory-model',
    extractionProvider: 'test',
    primaryMaxTokens: 1024,
    extractionMaxTokens: 512,
    characterCardPath: '/tmp/psfn-cutover-character.json',
    dataDir: '/tmp/psfn-cutover-data',
    databasePath: '/tmp/psfn-cutover-data/legacy-placeholder.db',
    persistenceBackend: 'postgres',
    postgresDatabaseUrl: 'postgres://postgres:postgres@127.0.0.1:5432/psfn_cutover_smoke',
    extractionInterval: 60_000,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 16_384,
    extractionThresholdPct: 75,
    compactionThresholdPct: 85,
    modelRoster: {},
    compositionalPolicy: createDefaultCompositionalPolicyConfig(),
    groupMemory: createDefaultGroupMemorySettings(),
  };
}

function makeServices(): GardenAdminDomainServices {
  const memory = makeMemory();
  return {
    dashboard: {
      getDashboardData: async () => ({
        stats: {
          memoryTotal: 1,
          memoryByType: { semantic: 1 },
          avgSalience: memory.salience,
          sessionCount: 1,
          schedulerTasks: 1,
          activeShards: 1,
          sessionUsage: {
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            llmCalls: 0,
            toolCalls: 0,
            lastTtftMs: null,
            averageTtftMs: null,
            activeSessionContextPressure: {
              sessionId: CUTOVER_SESSION_ID,
              utilizationPct: 0,
              hasTelemetry: false,
            },
            estimatedCostUsd: 0,
            costWindows: {
              selected: 'today',
              byWindow: {
                today: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
                week: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
                month: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
              },
            },
          },
          toolStatus: [],
          recentAnalysisWorkbenchTraces: [],
        },
      }),
    },
    images: {
      listGeneratedImages: async () => ({ roots: [], images: [] }),
      getGeneratedImageBlob: async () => null,
      updateGeneratedImage: async () => { throw new Error('not used in smoke'); },
      listReferencePhotos: async () => ({ roots: [], photos: [] } as never),
      addReferencePhoto: async () => { throw new Error('not used in smoke'); },
      updateReferencePhoto: async () => { throw new Error('not used in smoke'); },
      deleteReferencePhoto: async () => undefined,
      setDefaultReferencePhoto: async () => { throw new Error('not used in smoke'); },
      getReferencePhotoBlob: async () => null,
    },
    auditHistory: {
      appendGardenEntry: input => ({
        id: 'garden-audit-smoke',
        timestamp: input.timestamp ?? NOW,
        source: 'garden',
        sourceRecordId: 'garden:smoke',
        actionType: input.actionType,
        decision: input.decision,
        narrative: input.narrative,
        ...(input.details ? { details: input.details } : {}),
        ...(input.actor ? { actor: input.actor } : {}),
      }),
      getAuditHistory: async () => ({
        entries: [],
        filters: {
          actionType: 'all',
          decision: 'all',
          timeRange: '24h',
          source: 'all',
          query: '',
          limit: 100,
          offset: 0,
        },
        pagination: {
          limit: 100,
          offset: 0,
          total: 0,
          hasPrevious: false,
          hasNext: false,
        },
        summaries: {
          garden: { available: true, count: 0 },
          gateway: { available: false, count: 0 },
          charge: { available: false, count: 0 },
        },
      }),
    },
    charges: null,
    modelUsage: null,
    observerEvalSidecar: null,
    actionPipe: null,
    shards: makeShardFoldReviewService(),
    adaptiveTools: null,
    wiki: null,
    episodicMemory: makeEpisodicMemoryService(),
    groupMemory: makeGroupMemoryService(),
    memory: makeMemoryService(memory),
    sessions: {
      listSessions: async () => ({
        channels: [{
          sessionId: CUTOVER_SESSION_ID,
          channelId: CUTOVER_CHANNEL_ID,
          messageCount: 42,
          lastActivityAt: NOW,
        }],
      }),
      getSessionMessages: () => ({
        sessionId: CUTOVER_SESSION_ID,
        channelId: CUTOVER_CHANNEL_ID,
        messages: [],
        pagination: {
          limit: 100,
          beforeId: null,
          nextBeforeId: null,
          hasMoreOlder: false,
          totalMessages: 0,
          returnedMessages: 0,
        },
        messageOntologyViews: [],
        roleEnvelopePreviews: [],
        compactionAuditViews: [],
        turns: [],
      }),
    },
    contacts: {
      listContacts: async () => ({
        contacts: [],
        profileMap: new Map(),
        relatedChannelMap: new Map(),
        socialGraphMap: new Map(),
        verifications: [],
        mutationAudits: [],
        mutationAuditQuery: {},
      }),
      getContactDetail: async () => null,
      updateContact: async () => ({ ok: true, message: 'not used' }),
      createContact: async () => ({ ok: true, message: 'not used' }),
      deleteContact: async () => ({ ok: true, message: 'not used' }),
      mergeContacts: async () => ({ ok: true, message: 'not used' }),
      unlinkChannelIdentity: async () => ({ ok: true, message: 'not used' }),
      deleteConversationChannel: async () => ({ ok: true, message: 'not used' }),
    },
    settings: makeSettingsService(),
    identity: {
      getIdentityData: () => ({
        card: {
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: {
            name: 'Cutover Smoke',
            description: 'Test companion',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
          },
        },
        config: makeConfig(),
        version: 1,
        history: [],
        intakeReview: null,
      }),
      importIdentityCard: async () => ({ ok: true, message: 'not used' }),
      stageIdentityIntake: () => ({ ok: true, message: 'not used', review: null }),
      commitIdentityIntake: async () => ({ ok: true, message: 'not used', review: null }),
      rollbackIdentityCard: () => ({ ok: true, message: 'not used' }),
      previewIdentityCardDiff: () => { throw new Error('not used in smoke'); },
      updateIdentityField: () => ({ ok: true, message: 'not used' }),
      applyOnboardingAction: async () => ({ ok: true, message: 'not used', onboardingRequired: false }),
    },
    prompts: {
      listPrompts: () => ({
        layers: [],
        staticPrompts: [],
        runtimeBlocks: [],
        runtimeLayerCoverage: { ok: true, entries: [] },
        runtimeMacroHints: [],
      }),
      getFoundationSnapshot: () => null,
      saveFoundationSections: () => ({ ok: true, message: 'not used' }),
      getConstitutionSnapshot: () => ({
        immutableBlocks: [],
        companionLayer: null,
        mutableLayers: [],
        preview: {
          text: '',
          hash: '',
          staticPrefix: '',
          dynamicSuffix: '',
        },
      }),
      saveConstitutionMutableLayers: () => ({ ok: true, message: 'not used' }),
      getNorthStarSnapshot: () => null,
      saveNorthStarItems: () => ({ ok: true, message: 'not used' }),
      saveRuntimePromptBlocks: () => ({ ok: true, message: 'not used', updated: [] }),
      getPromptDetail: () => null,
      getStaticPromptDetail: () => null,
      createPromptLayer: () => ({ ok: true, message: 'not used' }),
      updatePromptLayer: () => ({ ok: true, message: 'not used' }),
      updatePromptRegistry: () => ({ ok: true, message: 'not used' }),
      togglePromptLayer: () => ({ ok: true, message: 'not used' }),
      rollbackPromptLayer: () => ({ ok: true, message: 'not used' }),
      rollbackPromptRegistry: () => ({ ok: true, message: 'not used' }),
      previewPromptLayerDiff: () => null,
      resolvePromptLayerMetadata: () => ({ metadata: {} }),
      reorderPromptLayers: () => ({ ok: true, message: 'not used' }),
    },
    scheduler: {
      listTasks: () => [],
      getFullData: () => ({
        tasks: [{
          id: 'memory-sleeptime-maintenance',
          name: 'Sleeptime memory maintenance',
          type: 'every',
          intervalMs: 300_000,
          state: 'idle',
          cadence: {
            kind: 'hourly',
            minute: 15,
            timezone: 'local',
          },
        }],
        reflections: [{
          id: 'daily-review',
          name: 'Daily Reflection',
          prompt: 'Daily private review.',
          intervalMs: 86_400_000,
          cadence: {
            kind: 'daily',
            hour: 22,
            minute: 0,
            timezone: 'local',
          },
          enabled: true,
          sendToDiscord: false,
          internalStateInput: true,
          mode: 'deliberation',
        }, {
          id: 'weekly-review',
          name: 'Weekly Reflection',
          prompt: 'Weekly private review.',
          intervalMs: 604_800_000,
          enabled: true,
          sendToDiscord: false,
          internalStateInput: true,
          mode: 'deliberation',
        }],
      }),
    },
    skills: null,
    confirmations: null,
    values: {
      list: () => [],
    },
    modelDiscovery: null,
    chatBootstrap: {
      buildBootstrap: async () => { throw new Error('not used in smoke'); },
      updateSelection: async () => { throw new Error('not used in smoke'); },
      buildModelRoomBootstrap: async () => { throw new Error('not used in smoke'); },
    },
  };
}

describe('Garden/admin Postgres memory cutover smoke', () => {
  let server: AdminServer | undefined;
  let port = 0;

  beforeEach(async () => {
    port = await getFreePort();
    server = new AdminServer({
      port,
      token: ADMIN_TOKEN,
      allowInsecureWithoutToken: false,
      eventBus: new EventBus(),
      config: makeConfig(),
      services: makeServices(),
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('reaches memory, L0.1, maintenance diagnostics/review, scheduler, and settings surfaces', async () => {
    const memoryList = parseOkJson<{ memories: Array<{ id: string }>; privacySummary: { activeMemoryCount: number } }>(
      await request(port, 'GET', '/api/admin/memory?limit=10'),
      'Garden memory list',
    );
    expect(memoryList.memories).toEqual([
      expect.objectContaining({ id: CUTOVER_MEMORY_ID }),
    ]);
    expect(memoryList.privacySummary.activeMemoryCount).toBe(1);

    const memorySearch = parseOkJson<{ query: string; results: Array<{ id: string; tags: string[] }> }>(
      await request(port, 'GET', '/api/admin/memory/search?q=cutover'),
      'Garden memory search',
    );
    expect(memorySearch.query).toBe('cutover');
    expect(memorySearch.results).toEqual([
      expect.objectContaining({
        id: CUTOVER_MEMORY_ID,
        tags: expect.arrayContaining(['postgres', 'sleeptime']),
      }),
    ]);

    const episodes = parseOkJson<{ episodes: Array<{ id: string; threadId?: string; provenanceRefs: unknown[] }> }>(
      await request(port, 'GET', `/api/admin/episodic-memory/episodes?threadId=${CUTOVER_THREAD_ID}`),
      'Garden L0.1 episode list',
    );
    expect(episodes.episodes).toEqual([
      expect.objectContaining({
        id: CUTOVER_EPISODE_ID,
        threadId: CUTOVER_THREAD_ID,
        provenanceRefs: expect.arrayContaining([
          expect.objectContaining({ kind: 'l0_span' }),
        ]),
      }),
    ]);

    const episodeDetail = parseOkJson<{ episode: { id: string }; relatedArcs: unknown[]; spanRefs: unknown[] }>(
      await request(port, 'GET', `/api/admin/episodic-memory/episodes/${CUTOVER_EPISODE_ID}`),
      'Garden L0.1 episode detail',
    );
    expect(episodeDetail.episode.id).toBe(CUTOVER_EPISODE_ID);
    expect(episodeDetail.relatedArcs).toHaveLength(1);
    expect(episodeDetail.spanRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: CUTOVER_SESSION_ID }),
    ]));

    const groupDiagnostics = parseOkJson<{
      channels: Array<{
        channelId: string;
        range: { plannedChunkCount: number; watermarkLagMessageIds: number };
        salience: { candidateSpans: unknown[] } | null;
        privacy: { rawTranscriptTextIncluded: boolean; memoryTextIncluded: boolean };
      }>;
      reasonCounts: Record<string, number>;
    }>(
      await request(port, 'GET', '/api/admin/group-memory'),
      'Garden group-memory diagnostics list',
    );
    expect(groupDiagnostics.reasonCounts.manual_group).toBe(1);
    expect(groupDiagnostics.channels).toEqual([
      expect.objectContaining({
        channelId: CUTOVER_CHANNEL_ID,
        range: expect.objectContaining({
          plannedChunkCount: 1,
          watermarkLagMessageIds: 5,
        }),
        privacy: {
          rawTranscriptTextIncluded: false,
          memoryTextIncluded: false,
        },
      }),
    ]);
    expect(groupDiagnostics.channels[0]?.salience?.candidateSpans).toHaveLength(1);

    const channelDiagnostics = parseOkJson<{
      channelId: string;
      lastExtraction: { triggerReason: string; writeCount: number } | null;
      coverage: { perContact: Array<{ contactId: string; profileStatus: string }> };
    }>(
      await request(port, 'GET', `/api/admin/group-memory/${encodeURIComponent(CUTOVER_CHANNEL_ID)}`),
      'Garden group-memory channel diagnostics',
    );
    expect(channelDiagnostics.channelId).toBe(CUTOVER_CHANNEL_ID);
    expect(channelDiagnostics.lastExtraction).toEqual(expect.objectContaining({
      triggerReason: 'operator_backfill',
      writeCount: 1,
    }));
    expect(channelDiagnostics.coverage.perContact).toEqual([
      expect.objectContaining({
        contactId: 'contact-operator',
        profileStatus: 'profile_ready',
      }),
    ]);

    const shardReviews = parseOkJson<{ reviews: Array<{ shardId: string; pendingMemoryCount: number }> }>(
      await request(port, 'GET', '/api/admin/shards'),
      'Garden shard review list',
    );
    expect(shardReviews.reviews).toEqual([
      expect.objectContaining({
        shardId: CUTOVER_SHARD_ID,
        pendingMemoryCount: 1,
      }),
    ]);

    const scheduler = parseOkJson<{
      tasks: Array<{ id: string; cadence?: { kind: string } }>;
      reflections: Array<{ id: string; enabled: boolean; mode?: string }>;
    }>(
      await request(port, 'GET', '/api/admin/scheduler'),
      'Garden scheduler maintenance surface',
    );
    expect(scheduler.tasks).toEqual([
      expect.objectContaining({
        id: 'memory-sleeptime-maintenance',
        cadence: expect.objectContaining({ kind: 'hourly' }),
      }),
    ]);
    expect(scheduler.reflections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'daily-review', enabled: true, mode: 'deliberation' }),
      expect.objectContaining({ id: 'weekly-review', enabled: true, mode: 'deliberation' }),
    ]));

    const settings = parseOkJson<AdminSettingsData>(
      await request(port, 'GET', '/api/admin/settings'),
      'Garden settings data',
    );
    expect(settings.editors.scheduler.episodicProcessing).toMatchObject({
      enabled: true,
      startLocalTime: '22:00',
      endLocalTime: '07:00',
      inactivityThresholdMinutes: 45,
    });
    expect(settings.config.memoryRetrievalBudgetPct).toBe(20);
    expect(settings.config.memoryRetrievalTelemetryEnabled).toBe(true);
    expect(settings.config).not.toHaveProperty('databasePath');
    expect(settings.config).not.toHaveProperty('persistenceBackend');
    expect(JSON.stringify(settings.config).toLowerCase()).not.toContain('sqlite');

    const schema = parseOkJson<ReturnType<typeof buildSettingsContractData>>(
      await request(port, 'GET', '/api/admin/settings/schema'),
      'Garden settings schema',
    );
    expect(schema.fields.databasePath).toBeUndefined();
    expect(schema.fields.persistenceBackend).toBeUndefined();
    const sqliteRuntimeFields = Object.values(schema.fields)
      .filter(field => field.enumValues?.includes('sqlite'));
    expect(sqliteRuntimeFields, 'SQLite must not be exposed as normal Garden runtime config').toEqual([]);
  });
});

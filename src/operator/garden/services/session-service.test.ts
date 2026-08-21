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
import { createFilesystemSessionArchivePort } from '../../../persistence/journals/journal/port.js';
import { createInMemoryTranscriptProjection } from '../../../test-support/in-memory-transcript-projection.js';
import { createTurnId } from '../../../core/turns/id.js';
import { CogSecEventStore } from '../../../core/cogsec/events.js';
import { CogSecForensicArchive } from '../../../core/cogsec/forensic-archive.js';
import {
  createSessionIntegrityIncidentObserver,
  sessionIntegrityCaseId,
} from '../../../core/cogsec/session-integrity-incident.js';
import {
  resolveCogSecEventsPath,
  resolveCogSecForensicArchiveDir,
  resolveConfiguredCompanionDataDir,
} from '../../../persistence/layout.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import {
  AdminSessionDataService,
  AdminSessionNotFoundError,
  AdminSessionTurnNotFoundError,
} from './session-service.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import {
  buildSubsystemOutputRef,
  buildTurnSubsystemProjectionRef,
} from '../../../shared/contracts/subsystem-output-refs.js';

function makeTurnRecord(channelId: string, turnId: string): TurnRecord {
  return {
    schemaVersion: 1,
    turnId,
    requestId: `req-${turnId}`,
    channelId,
    channelType: 'api',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_050,
    status: 'completed',
    userMessage: {
      role: 'user',
      content: 'hi',
      timestamp: 1_700_000_000_010,
      authorId: 'user-1',
      authorName: 'User',
    },
    assistantMessage: {
      role: 'assistant',
      content: 'hello',
      timestamp: 1_700_000_000_025,
    },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: {
      model: 'test-model',
    },
  };
}

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
    cogSecPersonaConformance: {
      enabled: true,
      baseline: {
        stableIdentityText: 'The companion keeps the clean response that remains after remediation.',
        expectedVoiceAnchors: ['clean response remains'],
        expectedValueAnchors: ['clean response remains'],
        expectedRefusalAnchors: ['clean response remains'],
        expectedRelationshipAnchors: ['clean response remains'],
        anomalyPatterns: {
          assistantGenericness: ['\\bthe\\s+companion\\s+is\\s+now\\s+an?\\s+(?:ai\\s+)?assistant\\b'],
          personaMutation: ['\\bfrom\\s+now\\s+on\\b'],
          attackMechanics: ['\\bignore\\s+previous\\s+instructions\\b'],
          invisibleText: ['[\\u200B-\\u200F]'],
        },
      },
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

  it('lists bounded session rows without loading contacts or changing payload size with contact count', async () => {
    store.append({
      channelId: 'api:bounded-list',
      role: 'user',
      content: 'hello',
      timestamp: 1_700_000_000_001,
      authorId: 'user-1',
    });

    const makeContact = (index: number): Contact => ({
      id: `contact-${index}`,
      displayName: `Contact ${index}`,
      trustLevel: 'regular',
      relationshipType: 'acquaintance',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      notes: `private-${index}`,
    });
    const emptyListAll = vi.fn(async () => [] as Contact[]);
    const largeListAll = vi.fn(async () => Array.from({ length: 1_000 }, (_, index) => makeContact(index)));
    const createService = (listAll: typeof emptyListAll | typeof largeListAll) => new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      contactStore: { listAll } as unknown as ContactStorePort,
    });

    const emptyContactsPayload = await createService(emptyListAll).listSessions();
    const largeContactsPayload = await createService(largeListAll).listSessions();

    expect(emptyListAll).not.toHaveBeenCalled();
    expect(largeListAll).not.toHaveBeenCalled();
    expect(Buffer.byteLength(JSON.stringify(largeContactsPayload)))
      .toBe(Buffer.byteLength(JSON.stringify(emptyContactsPayload)));
    expect(largeContactsPayload.channels).toEqual([{
      sessionId: 'api:bounded-list',
      channelId: 'api:bounded-list',
      messageCount: 1,
      lastActivityAt: 1_700_000_000_001,
    }]);
  });

  it('hides the authenticated testing-harness evidence room from ordinary session surfaces', async () => {
    store.append({
      channelId: 'api:testing-harness',
      role: 'user',
      content: 'exact shakedown evidence',
      timestamp: 1_700_000_000_001,
      metadata: JSON.stringify({
        testingHarness: {
          schemaVersion: 1,
          kind: 'testing_harness',
          runId: 'run-a',
          manifestId: 'manifest-a',
        },
      }),
    });
    store.append({
      channelId: 'api:real-companion-activity',
      role: 'user',
      content: 'genuine conversation',
      timestamp: 1_700_000_000_002,
    });
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    await expect(service.listSessions()).resolves.toEqual({
      channels: [expect.objectContaining({ channelId: 'api:real-companion-activity' })],
    });
    await expect(service.listSessionRoutes()).resolves.toEqual({
      channels: [expect.objectContaining({ channelId: 'api:real-companion-activity' })],
      routes: [],
    });
  });

  it('lists session routes without recursively issuing a session-list request', async () => {
    store.append({
      channelId: 'api:route-list',
      role: 'user',
      content: 'hello',
      timestamp: 1_700_000_000_002,
    });
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });
    const listSessions = vi.spyOn(service, 'listSessions');

    const result = await service.listSessionRoutes();

    expect(listSessions).not.toHaveBeenCalled();
    expect(result.channels).toEqual([{
      sessionId: 'api:route-list',
      channelId: 'api:route-list',
      messageCount: 1,
      lastActivityAt: 1_700_000_000_002,
    }]);
  });

  it('resolves linked contact display detail only for the selected session without exposing private fields', async () => {
    const sessionId = 'api:selected-detail';
    store.append({
      channelId: sessionId,
      role: 'user',
      content: 'hello',
      timestamp: 1_700_000_000_003,
      authorId: 'user-42',
    });
    const linkedContact: Contact = {
      id: 'contact-42',
      displayName: 'Selected Person',
      trustLevel: 'trusted',
      relationshipType: 'friend',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-02T00:00:00.000Z',
      notes: 'private operator notes must not cross this endpoint',
      channels: [{
        channel: 'api',
        userId: 'user-42',
        privacyLevel: 'private',
        linkedAt: '2026-01-01T00:00:00.000Z',
      }],
    };
    const listAll = vi.fn(async () => [linkedContact]);
    const getByChannelIdentity = vi.fn(async () => linkedContact);
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      contactStore: { listAll, getByChannelIdentity } as unknown as ContactStorePort,
    });

    const detail = await service.getSessionDetail(sessionId);

    expect(listAll).toHaveBeenCalledOnce();
    expect(getByChannelIdentity).toHaveBeenCalledWith('api', 'user-42');
    expect(detail).toEqual({
      channel: {
        sessionId,
        channelId: sessionId,
        messageCount: 1,
        lastActivityAt: 1_700_000_000_003,
        linkedContactId: 'contact-42',
        linkedContactName: 'Selected Person',
      },
    });
    expect(JSON.stringify(detail)).not.toContain('private operator notes');
    expect(JSON.stringify(detail)).not.toContain('trustLevel');
    expect(JSON.stringify(detail)).not.toContain('privacyLevel');
  });

  it('returns newest message page by default and older pages by beforeId cursor', async () => {
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
    const beforeSpy = vi.spyOn(store, 'getEntriesBeforeAsync');
    const rangeSpy = vi.spyOn(store, 'getEntriesInRange');

    const firstPage = await service.getSessionMessages(channelId);
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

    const secondPage = await service.getSessionMessages(channelId, {
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
    expect(beforeSpy).toHaveBeenLastCalledWith(
      channelId,
      firstPage.pagination.nextBeforeId,
      101,
    );
    expect(rangeSpy).not.toHaveBeenCalled();

    const terminalPage = await service.getSessionMessages(channelId, {
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
    expect(beforeSpy).toHaveBeenCalledTimes(2);
    expect(rangeSpy).not.toHaveBeenCalled();
  });

  it('serves messages-only older pages through bounded archive reads without full replay', async () => {
    const channelId = 'api:bounded-older-page';
    for (let index = 1; index <= 250; index += 1) {
      store.append({
        channelId,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `Message ${index}`,
        timestamp: 1_700_000_000_000 + index,
      });
    }

    const archivePort = createFilesystemSessionArchivePort();
    const boundedReadSpy = vi.spyOn(archivePort, 'readJournalEntriesBeforeAsync');
    const fullReadSpy = vi.spyOn(archivePort, 'readJournalFile');
    const reloadedStore = new SessionStore(dir, { sessionArchivePort: archivePort });
    boundedReadSpy.mockClear();
    fullReadSpy.mockClear();
    const compactionSpy = vi.spyOn(reloadedStore, 'getCompactionSummaries');
    const rangeSpy = vi.spyOn(reloadedStore, 'getEntriesInRange');
    const service = new AdminSessionDataService({
      sessionStore: reloadedStore,
      sessionManager: new SessionManager(reloadedStore, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const page = await service.getSessionMessages(channelId, {
      limit: 100,
      beforeId: 151,
      messagesOnly: true,
    });

    expect(page.messages).toHaveLength(100);
    expect(page.messages[0]?.content).toBe('Message 51');
    expect(page.messages[99]?.content).toBe('Message 150');
    expect(page.pagination).toMatchObject({
      beforeId: 151,
      nextBeforeId: page.messages[0]?.id,
      hasMoreOlder: true,
      totalMessages: 250,
      returnedMessages: 100,
    });
    expect(boundedReadSpy).toHaveBeenCalledWith(expect.anything(), {
      beforeId: 151,
      messageLimit: 101,
      includeBoundaryEntry: true,
    });
    expect(fullReadSpy).not.toHaveBeenCalled();
    expect(compactionSpy).not.toHaveBeenCalled();
    expect(rangeSpy).not.toHaveBeenCalled();
  });

  it('searches session messages scoped to the requested session only', async () => {
    const searchDir = mkdtempSync(join(tmpdir(), 'admin-session-search-'));
    const searchStore = new SessionStore(searchDir, {
      transcriptProjection: createInMemoryTranscriptProjection(),
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

  it('skips turn snapshots, compaction audits, and role-envelope previews in messagesOnly mode', async () => {
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

    const full = await service.getSessionMessages(channelId);
    expect(full.compactionAuditViews.length).toBeGreaterThan(0);

    const light = await service.getSessionMessages(channelId, { messagesOnly: true });
    expect(light.messages).toHaveLength(2);
    expect(light.pagination.totalMessages).toBe(2);
    expect(light.turns).toEqual([]);
    expect(light.compactionAuditViews).toEqual([]);
    expect(light.roleEnvelopePreviews).toEqual([]);
  });

  it('drops turns and previews but keeps compaction audits when includeTurns is false', async () => {
    const channelId = 'api:include-turns';
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
    void store.appendTurnRecord(makeTurnRecord(channelId, createTurnId()));

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const full = await service.getSessionMessages(channelId);
    expect(full.turns.length).toBeGreaterThan(0);
    expect(full.compactionAuditViews.length).toBeGreaterThan(0);

    const lean = await service.getSessionMessages(channelId, { includeTurns: false });
    expect(lean.messages).toHaveLength(2);
    expect(lean.turns).toEqual([]);
    expect(lean.roleEnvelopePreviews).toEqual([]);
    // Compaction summaries survive so the session browser keeps its banner.
    expect(lean.compactionAuditViews.length).toBeGreaterThan(0);
  });

  it('serves a single turn via getSessionTurnDetail and fails closed for unknown turns', async () => {
    const channelId = 'api:turn-detail';
    store.append({ channelId, role: 'user', content: 'hi', timestamp: 1_700_000_000_001 });
    store.append({ channelId, role: 'assistant', content: 'hello', timestamp: 1_700_000_000_002 });
    const turnId = createTurnId();
    const otherTurnId = createTurnId();
    void store.appendTurnRecord(makeTurnRecord(channelId, otherTurnId));
    void store.appendTurnRecord(makeTurnRecord(channelId, turnId));

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });

    const detail = await service.getSessionTurnDetail(channelId, turnId);
    expect(detail.sessionId).toBe(channelId);
    expect(detail.channelId).toBe(channelId);
    expect(detail.turn.record.turnId).toBe(turnId);

    await expect(service.getSessionTurnDetail(channelId, 'turn-does-not-exist'))
      .rejects.toThrow(AdminSessionTurnNotFoundError);
    await expect(service.getSessionTurnDetail(channelId, '   '))
      .rejects.toThrow(AdminSessionTurnNotFoundError);
  });

  it('resolves referenced subsystem outputs through the lazy turn-detail seam', async () => {
    const channelId = 'api:turn-subsystem-outputs';
    const turnId = createTurnId();
    const record = makeTurnRecord(channelId, turnId);
    const binding = {
      logicalSessionId: channelId,
      sourceChannelId: channelId,
      sourceTurnId: turnId,
      sourceRequestId: record.requestId,
    };
    record.extractedMemoryIds = [buildTurnSubsystemProjectionRef('memory', binding)];
    record.concernDeltaRefs = [buildTurnSubsystemProjectionRef('concern', binding)];
    record.contactDeltaRefs = [buildTurnSubsystemProjectionRef('contact', binding)];
    store.append({ channelId, role: 'user', content: 'hi', timestamp: 1_700_000_000_001 });
    void store.appendTurnRecord(record);

    const memory: PurrMemory = {
      id: 'memory-output-1',
      text: 'Resolved from the memory store.',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.7,
      sourceRef: `turn:${turnId}`,
      extractedAt: 1_700_000_000_050,
      lastAccessed: 1_700_000_000_050,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
    };
    const contact: Contact = {
      id: 'contact-output-1',
      displayName: 'Resolved Contact',
      trustLevel: 'regular',
      relationshipType: 'friend',
      firstSeen: '2026-07-01T00:00:00.000Z',
      lastSeen: '2026-07-16T12:00:00.000Z',
      notes: 'Must stay out of the Loom output projection.',
    };
    const getSubsystemOutputProjection = vi.fn(async () => ({
      status: 'applied' as const,
      outputRefs: [
        buildSubsystemOutputRef('memory', memory.id),
        buildSubsystemOutputRef('concern', 'concern-output-1'),
        buildSubsystemOutputRef('contact', contact.id),
      ],
    }));
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      memoryStore: {
        getById: vi.fn(async id => id === memory.id ? memory : undefined),
      } as unknown as MemoryStorePort,
      concernStore: {
        getById: vi.fn(async id => id === 'concern-output-1'
          ? {
              id,
              text: 'Resolved from the concern store.',
              priority: 'medium',
              source: 'appraisal',
              status: 'candidate',
              createdAt: '2026-07-16T12:00:00.000Z',
              expiresAt: '2026-07-23T12:00:00.000Z',
              salience: 0.6,
              sensitivity: 'personal',
              owner: 'companion',
              evidenceRefs: [],
              resolutionEvidenceRefs: [],
            }
          : null),
      } as unknown as ConcernStorePort,
      contactStore: {
        getById: vi.fn(async id => id === contact.id ? contact : undefined),
      } as unknown as ContactStorePort,
      subsystemOutputRefStore: {
        getSubsystemOutputProjection,
      },
    });

    const detail = await service.getSessionTurnDetail(channelId, turnId);
    expect(detail.turn.promptLoom?.subsystemOutputs.memoryWrites[0]?.value?.text)
      .toBe('Resolved from the memory store.');
    expect(detail.turn.promptLoom?.subsystemOutputs.concernDeltas[0]?.value?.text)
      .toBe('Resolved from the concern store.');
    expect(detail.turn.promptLoom?.subsystemOutputs.contactDeltas[0]?.value)
      .toEqual(expect.objectContaining({ id: contact.id }));
    expect(detail.turn.promptLoom?.subsystemOutputs.contactDeltas[0]?.value)
      .not.toHaveProperty('notes');
    expect(detail.turn.promptLoom?.subsystemOutputs.contactDeltas[0]?.value)
      .not.toHaveProperty('displayName');

    getSubsystemOutputProjection.mockResolvedValue({ status: 'applied', outputRefs: [] });
    const appliedEmpty = await service.getSessionTurnDetail(channelId, turnId);
    expect(appliedEmpty.turn.promptLoom?.subsystemOutputs).toMatchObject({
      projectionStatus: 'applied',
      memoryWrites: [],
      concernDeltas: [],
      contactDeltas: [],
    });

    getSubsystemOutputProjection.mockResolvedValue({ status: 'pending', outputRefs: [] });
    const pending = await service.getSessionTurnDetail(channelId, turnId);
    expect(pending.turn.promptLoom?.subsystemOutputs.projectionStatus).toBe('pending');

    getSubsystemOutputProjection.mockResolvedValue({ status: 'failed', outputRefs: [] });
    const failed = await service.getSessionTurnDetail(channelId, turnId);
    expect(failed.turn.promptLoom?.subsystemOutputs.projectionStatus).toBe('failed');

    getSubsystemOutputProjection.mockResolvedValue({ status: 'outcome_unknown', outputRefs: [] });
    const outcomeUnknown = await service.getSessionTurnDetail(channelId, turnId);
    expect(outcomeUnknown.turn.promptLoom?.subsystemOutputs.projectionStatus)
      .toBe('outcome_unknown');
  });

  it('fails closed when persisted projection handles are unwired or source-mismatched', async () => {
    const channelId = 'api:turn-subsystem-output-failure';
    const turnId = createTurnId();
    const record = makeTurnRecord(channelId, turnId);
    const binding = {
      logicalSessionId: channelId,
      sourceChannelId: channelId,
      sourceTurnId: turnId,
      sourceRequestId: record.requestId,
    };
    record.extractedMemoryIds = [buildTurnSubsystemProjectionRef('memory', binding)];
    record.concernDeltaRefs = [buildTurnSubsystemProjectionRef('concern', binding)];
    record.contactDeltaRefs = [buildTurnSubsystemProjectionRef('contact', binding)];
    store.append({ channelId, role: 'user', content: 'hi', timestamp: 1_700_000_000_001 });
    void store.appendTurnRecord(record);

    const unwired = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
    });
    await expect(unwired.getSessionTurnDetail(channelId, turnId)).rejects.toThrow(
      'projection store is not configured',
    );

    const mismatchedTurnId = createTurnId();
    const mismatchedRecord = makeTurnRecord(channelId, mismatchedTurnId);
    mismatchedRecord.extractedMemoryIds = [buildTurnSubsystemProjectionRef('memory', {
      logicalSessionId: channelId,
      sourceChannelId: channelId,
      sourceTurnId: mismatchedTurnId,
      sourceRequestId: 'wrong-request',
    })];
    mismatchedRecord.concernDeltaRefs = [buildTurnSubsystemProjectionRef('concern', {
      logicalSessionId: channelId,
      sourceChannelId: channelId,
      sourceTurnId: mismatchedTurnId,
      sourceRequestId: mismatchedRecord.requestId,
    })];
    mismatchedRecord.contactDeltaRefs = [buildTurnSubsystemProjectionRef('contact', {
      logicalSessionId: channelId,
      sourceChannelId: channelId,
      sourceTurnId: mismatchedTurnId,
      sourceRequestId: mismatchedRecord.requestId,
    })];
    void store.appendTurnRecord(mismatchedRecord);
    const mismatched = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      subsystemOutputRefStore: {
        getSubsystemOutputProjection: vi.fn(async () => ({
          status: 'applied' as const,
          outputRefs: [],
        })),
      },
    });
    await expect(mismatched.getSessionTurnDetail(channelId, mismatchedTurnId)).rejects.toThrow(
      'Invalid Loom subsystem projection ref',
    );
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
    expect(applied.operatorEvent.personaConformance).toMatchObject({
      status: 'pass',
      failureCount: 0,
      warningCount: 0,
    });

    const events = await service.listCogSecEvents();
    const serializedEvents = JSON.stringify(events);
    expect(events.events[0]?.caseId).toBe(applied.event.caseId);
    expect(serializedEvents).not.toContain(dirtyText);
    expect(serializedEvents).not.toContain('cogsec-forensic://');
    expect(serializedEvents).not.toContain('sealedForensicPayloadRefs');
  });

  it('applies an exact open session-integrity incident and removes it from operator attention', async () => {
    const channelId = 'api:historical-integrity-incident';
    const affectedId = store.append({
      channelId,
      role: 'user',
      content: 'historical row selected by structural integrity evidence',
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
    const config = makeConfig({ dataDir: dir });
    const eventsPath = resolveCogSecEventsPath(resolveConfiguredCompanionDataDir(config));
    createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(eventsPath),
    }).recordIntegrityFailure({
      channelId,
      failedEntryCount: 1,
      firstFailedEntryId: affectedId,
      lastFailedEntryId: affectedId,
      contiguousRunCount: 1,
      detectedAtMs: Date.now(),
    });
    const caseId = sessionIntegrityCaseId(channelId);
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, config),
      eventBus: new EventBus(),
      config,
    });
    const exactInput = {
      caseId,
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      affectedMessageRanges: [{
        sourceChannelId: channelId,
        logicalSessionId: channelId,
        startEntryId: affectedId,
        endEntryId: affectedId,
      }],
      type: 'session_integrity' as const,
      severity: 'high' as const,
      reason: 'review and remediate the exact recorded integrity range',
      cutEpoch: false,
    };

    await expect(service.applyCogSecRemediation({
      ...exactInput,
      severity: 'critical',
    })).rejects.toThrow(/must exactly match incident/u);
    expect(new CogSecEventStore(eventsPath).getEvent(caseId)?.status).toBe('open');

    const applied = await service.applyCogSecRemediation(exactInput);
    expect(applied.event).toMatchObject({ caseId, type: 'session_integrity', status: 'applied' });
    const listed = await service.listCogSecEvents();
    expect(listed.events).toHaveLength(1);
    expect(listed.events.filter(event => (
      event.type === 'session_integrity' && event.status === 'open'
    ))).toHaveLength(0);
  });

  it('resolves structural transport message provenance to one surgical L0 tombstone range', async () => {
    const channelId = 'discord:room:post-escalation';
    const sourceMessageId = 'transport-message-77';
    const targetId = store.append({
      channelId,
      role: 'user',
      content: 'confirmed bad stream fragment',
      timestamp: 1,
      discordMessageId: sourceMessageId,
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'assistant response shares the inbound turn provenance',
      timestamp: 2,
      discordMessageId: sourceMessageId,
    });
    store.append({
      channelId,
      role: 'user',
      content: 'neighboring message stays intact',
      timestamp: 3,
      discordMessageId: 'transport-message-78',
    });
    const config = makeConfig({ dataDir: dir });
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, config),
      eventBus: new EventBus(),
      config,
    });

    const input = {
      sourceChannelId: channelId,
      affectedMessageRanges: [{
        sourceChannelId: channelId,
        sourceMessageIds: [sourceMessageId],
      }],
      type: 'intake_firewall' as const,
      severity: 'high' as const,
      reason: 'post-escalation confirmed the structurally identified message',
    };
    const preview = await service.previewCogSecRemediation(input);

    expect(preview.draft.affectedMessageRanges).toEqual([{
      sourceChannelId: channelId,
      logicalSessionId: channelId,
      messageIds: [targetId],
      sourceMessageIds: [sourceMessageId],
    }]);
    expect(preview.counts.l0Rows).toBe(1);

    const applied = await service.applyCogSecRemediation(input);
    expect(applied.tombstones).toHaveLength(1);
    expect(applied.tombstones[0]?.tombstonedL0RowCount).toBe(1);
    const remainingContent = store.getRecent(channelId, 10).map(entry => entry.content);
    expect(remainingContent).not.toContain('confirmed bad stream fragment');
    expect(remainingContent).toContain('neighboring message stays intact');
    expect(remainingContent).toContain('assistant response shares the inbound turn provenance');
    expect(remainingContent.some(content => content.startsWith('[CogSec redaction:'))).toBe(true);

    await expect(service.previewCogSecRemediation({
      sourceChannelId: channelId,
      sourceMessageIds: ['unknown-transport-message'],
      type: 'intake_firewall',
      severity: 'high',
      reason: 'must not widen an unresolved structural range',
    })).rejects.toThrow(/did not resolve to a stored session entry/);
  });

  it('refuses unconfigured CogSec conformance before mutating remediation state', async () => {
    const channelId = 'api:cogsec-unconfigured';
    const dirtyText = 'DIRTY_UNCONFIGURED_COGSEC_TEXT';
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
    const config = makeConfig({
      dataDir: dir,
      cogSecPersonaConformance: undefined,
    });
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, config),
      eventBus: new EventBus(),
      config,
    });

    await expect(service.applyCogSecRemediation({
      sourceChannelId: channelId,
      messageIds: [dirtyMessageId],
      type: 'persona_poisoning',
      severity: 'high',
      reason: 'must fail before mutation',
      cutEpoch: false,
    })).rejects.toThrow('CogSec persona conformance is not configured');

    expect(store.getRecent(channelId, 5).map(entry => entry.content)).toContain(dirtyText);
    expect(resolveConfiguredCompanionDataDir(config)).toBe(dir);
    expect(new CogSecEventStore(resolveCogSecEventsPath(dir)).listEvents()).toEqual([]);
  });

  it('reports a failed Garden remediation when the clean context still contains persona drift', async () => {
    const channelId = 'api:cogsec-persona-drift';
    const dirtyMessageId = store.append({
      channelId,
      role: 'user',
      content: 'selected contaminated source row',
      timestamp: 1,
      authorName: 'Operator',
    });
    store.append({
      channelId,
      role: 'assistant',
      content: 'clean response remains, but the companion is now an AI assistant.',
      timestamp: 2,
      authorName: 'Companion',
    });
    const config = makeConfig({ dataDir: dir });
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, config),
      eventBus: new EventBus(),
      config,
    });

    const applied = await service.applyCogSecRemediation({
      sourceChannelId: channelId,
      messageIds: [dirtyMessageId],
      type: 'persona_poisoning',
      severity: 'high',
      reason: 'verify remaining prompt-visible context',
      cutEpoch: false,
    });

    expect(applied.revocation.failures).toHaveLength(1);
    expect(applied.regeneration.failures).toEqual([]);
    expect(applied.ok).toBe(false);
    expect(applied.message).toContain('2 follow-up items');
    expect(applied.operatorEvent).toMatchObject({
      status: 'failed',
      personaConformance: {
        status: 'fail',
        failureCount: 1,
      },
    });
  });

  it('keeps CogSec previews scoped to the operator-selected logical session', async () => {
    const sourceChannelId = 'discord:guild:room';
    const oldLogicalSessionId = sourceChannelId;
    const dirtyMessageId = store.append({
      channelId: oldLogicalSessionId,
      role: 'user',
      content: 'DIRTY_OLD_LOGICAL_SESSION_TEXT',
      timestamp: 1,
      authorName: 'Morgan',
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

  it('surfaces a session-integrity incident recorded after the service was constructed (bead g59z)', async () => {
    const config = makeConfig({ dataDir: dir });
    const channelId = 'api:integrity-after-boot';

    // Garden builds this service once per process (local-admin-contract →
    // agent/main). The operator case that matters is an HMAC failure detected
    // while the process is already running, so construct the service FIRST and
    // record the incident afterwards.
    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, config),
      eventBus: new EventBus(),
      config,
    });
    expect((await service.listCogSecEvents()).events).toHaveLength(0);

    const eventsPath = resolveCogSecEventsPath(resolveConfiguredCompanionDataDir(config));
    const observer = createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(eventsPath),
    });
    observer.recordIntegrityFailure({
      channelId,
      failedEntryCount: 3,
      firstFailedEntryId: 4,
      lastFailedEntryId: 6,
      contiguousRunCount: 1,
      detectedAtMs: Date.now(),
    });

    // The badge (admin-ui/src/lib/nav/attention.ts) counts exactly this shape
    // off this route. A store cached at construction would still report zero.
    const listed = await service.listCogSecEvents();
    const openIntegrity = listed.events.filter(
      event => event.type === 'session_integrity' && event.status === 'open',
    );
    expect(openIntegrity).toHaveLength(1);
    expect(openIntegrity[0]).toMatchObject({
      caseId: sessionIntegrityCaseId(channelId),
      severity: 'high',
      sourceChannelId: channelId,
    });

    // A later read of the same broken session updates the one incident rather
    // than adding a second, and the refreshed range is visible immediately.
    observer.recordIntegrityFailure({
      channelId,
      failedEntryCount: 5,
      firstFailedEntryId: 4,
      lastFailedEntryId: 8,
      contiguousRunCount: 2,
      detectedAtMs: Date.now(),
    });
    const relisted = (await service.listCogSecEvents()).events
      .filter(event => event.type === 'session_integrity');
    expect(relisted).toHaveLength(1);
    expect(relisted[0]?.safeSummary).toContain('ids 4-8');
    expect(relisted[0]?.affectedRanges).toEqual([
      expect.objectContaining({ startEntryId: 4, endEntryId: 8 }),
    ]);
  });

  it('returns persisted turn observability without requiring live event-bus state', async () => {
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

    void store.appendTurnRecord({
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
              skipped: [{ toolName: 'notify', source: 'extended', reason: 'capability_denied' }],
              counts: {
                core: 1,
                extended: 0,
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

    const byId = new Map<string, PurrMemory>([
      [
        'mem-1',
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
        } as PurrMemory,
      ],
      [
        'mem-2',
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
        } as PurrMemory,
      ],
    ]);
    const memoryStore = {
      getById: async (id: string) => byId.get(id),
    } as unknown as MemoryStorePort;

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      memoryStore,
    });

    const result = await service.getSessionMessages(channelId);
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
          skipped: [{ toolName: 'notify', reason: 'capability_denied' }],
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

    const continuityPort = createUserContinuityPort(continuityStore, () => [], () => true);
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

    const continuityPort = createUserContinuityPort(continuityStore, () => [], () => true);
    expect(continuityPort.getMerged({
      canonicalUserId: 'canonical-contact-1',
      limit: 10,
      fallbackUserIds: [],
      channelId: 'api:principal-a:session-a',
    })).toEqual([]);
  });

  it('keeps continuity provenance while withholding origin-redacted content', async () => {
    const continuityStore = new UserContinuityStore(join(dir, 'continuity'));
    const continuitySecret = 'Cross-channel continuity note';
    const sourceEntryId = store.append({
      channelId: 'discord:dm',
      role: 'assistant',
      content: continuitySecret,
      authorId: 'scheduler',
      authorName: 'Scheduler',
      timestamp: 1_700_000_200_000,
      channelVisibility: 'private',
    });
    continuityStore.append('canonical-contact-1', {
      channelId: 'discord:dm',
      role: 'assistant',
      content: continuitySecret,
      authorId: 'scheduler',
      authorName: 'Scheduler',
      timestamp: 1_700_000_200_000,
      originChannelId: 'discord:dm',
      channelVisibility: 'private',
    }, sourceEntryId);

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
    void store.appendTurnRecord({
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
    const caseId = 'cogsec_20260719T000000Z_loom_continuity';
    const companionRoot = join(dir, 'companion-data');
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: 'discord:dm',
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({
      channelId: 'discord:dm',
      caseId,
      eventStore,
      forensicArchive,
      messageIds: [sourceEntryId],
    });

    const result = await service.getSessionMessages('api:session-1');
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.snapshot?.sessionContext?.continuityEntries[0]?.content)
      .toBe('[redacted: source entry removed from the session journal]');
    expect(JSON.stringify(result)).not.toContain(continuitySecret);
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

  it('surfaces role-envelope previews and promoted refs without exposing raw bodies', async () => {
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

    void store.appendTurnRecord({
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

    const result = await service.getSessionMessages(channelId);
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

  it('returns explicit message ontology views for operator inspection', async () => {
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

    const result = await service.getSessionMessages(channelId);

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

  it('classifies reflection musings with the canonical musing message class', async () => {
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

    const result = await service.getSessionMessages(channelId);
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
      await Promise.all(
        listed.map(async channel => [
          channel.sessionId,
          (await service.getSessionMessages(channel.sessionId)).messages[0]?.content ?? '',
        ] as const),
      ),
    );
    expect(new Set(contentBySessionId.values())).toEqual(new Set(['older session', 'newer session']));

    for (const channel of listed) {
      const details = await service.getSessionMessages(channel.sessionId);
      expect(details.sessionId).toBe(channel.sessionId);
      expect(details.channelId).toBe(channelId);
    }
  });
});

describe('subject-bound session projection (88u3)', () => {
  const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-session-subject-'));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fleetSessionContext(overrides: {
    contactId: string;
    companionId?: string;
    routeId?: string;
    subjectRelation?: FleetGardenRequestContext['subjectRelation'];
    role?: FleetGardenRequestContext['actor']['role'];
  }): FleetGardenRequestContext {
    const subjectRelation = overrides.subjectRelation ?? 'self_or_co_subject';
    const authorization = Object.freeze({
      action: 'sessions.read' as const,
      baseRole: 'member' as const,
      resource: Object.freeze({ scope: 'personal_workspace' as const, area: 'sessions' as const }),
      subjectRelation,
      requirements: Object.freeze({
        assurance: 'oauth' as const,
        confirmation: 'none' as const,
        approvals: Object.freeze([]),
      }),
      publicAccess: 'never' as const,
      recoveryAccess: 'forbidden' as const,
    });
    return Object.freeze({
      kind: 'fleet_principal' as const,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      decisionId: 'cccccccc-dddd-4ddd-8ddd-dddddddddddd',
      authorizationEventId: 'event-principal-a',
      resolvedAt: '2030-01-01T00:00:00.000Z',
      versions: Object.freeze({
        authorityGeneration: 1,
        globalAuthEpoch: 1,
        sessionAuthnVersion: 1,
        sessionAuthzVersion: 1,
        bindingVersion: 1,
        grantVersion: 1,
        policyVersion: 1,
      }),
      issuedAt: 1,
      expiresAt: 2,
      actor: Object.freeze({
        kind: 'fleet_principal' as const,
        principalId: 'principal-a',
        provider: 'discord' as const,
        providerSubjectId: 'provider-principal-a',
        contactId: overrides.contactId,
        contactBindingId: 'binding-principal-a',
        role: overrides.role ?? 'member',
        operatorGrantId: 'grant-principal-a',
        sessionRecordId: 'session-principal-a',
        sessionAssurance: 'oauth' as const,
      }),
      action: 'sessions.read' as const,
      resource: Object.freeze({
        routeId: overrides.routeId ?? 'GET /api/admin/sessions',
        scope: 'personal_workspace' as const,
        area: 'sessions' as const,
        companionId: overrides.companionId ?? COMPANION_ID,
        pathParams: Object.freeze({}),
        query: Object.freeze({}),
      }),
      subjectRelation,
      authorization,
    });
  }

  function makeContact(id: string, discordUserId: string): Contact {
    return {
      id,
      displayName: `Contact ${id}`,
      trustLevel: 'trusted',
      relationshipType: 'friend',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      channels: [{
        channel: 'discord',
        userId: discordUserId,
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      }],
    } as Contact;
  }

  function makeSubjectFixture() {
    // Stable attribution: each contact carries a persisted identity link for
    // their own DM channel. Fleet visibility must never key on who posted
    // last, so the fixture provides no last-author lookup path.
    const contactA = makeContact('contact-a', '1111');
    const contactB = makeContact('contact-b', '2222');
    const contactStore = {
      listAll: vi.fn(async () => [contactA, contactB]),
      getByChannelIdentity: vi.fn(async () => undefined),
    } as unknown as ContactStorePort;

    store.append({
      channelId: 'discord:dm:1111',
      role: 'user',
      content: 'private message from subject A',
      timestamp: 1_700_000_000_001,
      authorId: '1111',
    });
    store.append({
      channelId: 'discord:dm:2222',
      role: 'user',
      content: 'private message from subject B',
      timestamp: 1_700_000_000_002,
      authorId: '2222',
    });

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      contactStore,
      config: makeConfig({ dataDir: dir, companionId: createCompanionId(COMPANION_ID) }),
    });
    return { service, contactA, contactB };
  }

  it('lists only the sessions linked to the fleet subject contact', async () => {
    const { service } = makeSubjectFixture();

    const fleetList = await service.listSessions(fleetSessionContext({ contactId: 'contact-a' }));
    expect(fleetList.channels.map(channel => channel.channelId))
      .toEqual(['discord:dm:1111']);

    // Standalone operator context keeps the unpartitioned single-companion view.
    const standaloneList = await service.listSessions();
    expect(standaloneList.channels).toHaveLength(2);
  });

  it('surfaces another subject session as not found across every fleet read path', async () => {
    const { service } = makeSubjectFixture();
    const context = fleetSessionContext({ contactId: 'contact-a' });
    const foreignSessionId = 'discord:dm:2222';

    await expect(service.getSessionDetail(foreignSessionId, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
    await expect(service.getSessionMessages(foreignSessionId, {}, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
    await expect(service.getSessionMessagesForAdminRead(foreignSessionId, {}, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
    await expect(service.searchSessionMessages(foreignSessionId, 'private', 10, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
    await expect(service.getSessionTurnDetail(foreignSessionId, 'turn-1', context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
  });

  it('serves the subject own session transcript without leaking other subjects', async () => {
    const { service } = makeSubjectFixture();
    const context = fleetSessionContext({ contactId: 'contact-a' });

    const detail = await service.getSessionDetail('discord:dm:1111', context);
    expect(detail.channel.linkedContactId).toBe('contact-a');

    const messages = await service.getSessionMessages('discord:dm:1111', {}, context);
    expect(messages.messages.map(message => message.content))
      .toEqual(['private message from subject A']);
    expect(JSON.stringify(messages)).not.toContain('subject B');
  });

  it('does not let an owner role widen session visibility beyond the subject', async () => {
    const { service } = makeSubjectFixture();
    const owner = fleetSessionContext({ contactId: 'contact-a', role: 'owner' });

    const listed = await service.listSessions(owner);
    expect(listed.channels.map(channel => channel.channelId))
      .toEqual(['discord:dm:1111']);
    await expect(service.getSessionMessages('discord:dm:2222', {}, owner))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
  });

  it('fails closed when the request companion does not match the bound companion', async () => {
    const { service } = makeSubjectFixture();
    const crossCompanion = fleetSessionContext({
      contactId: 'contact-a',
      companionId: '22222222-2222-4222-8222-222222222222',
    });

    await expect(service.listSessions(crossCompanion))
      .rejects.toThrow(/companion/u);
    await expect(service.getSessionMessages('discord:dm:1111', {}, crossCompanion))
      .rejects.toThrow(/companion/u);
  });

  it('fails closed without an explicit request-local subject relation', async () => {
    const { service } = makeSubjectFixture();
    const wrongRelation = fleetSessionContext({
      contactId: 'contact-a',
      subjectRelation: 'current_companion',
    });

    await expect(service.listSessions(wrongRelation))
      .rejects.toThrow(/subject-bound session projection/u);
  });

  it('keeps unpartitioned session surfaces fail closed for fleet principals', async () => {
    const { service } = makeSubjectFixture();
    const context = fleetSessionContext({ contactId: 'contact-a' });

    await expect(service.listSessionRoutes(context))
      .rejects.toThrow(/subject-bound session projection/u);
    await expect(service.listCogSecEvents(context))
      .rejects.toThrow(/subject-bound session projection/u);
    await expect(service.resetSourceChannelSession({
      sourceChannelId: 'discord:dm:1111',
      reason: 'test',
    }, context)).rejects.toThrow(/subject-bound session projection/u);
    await expect(service.previewCogSecRemediation({
      sourceChannelId: 'discord:dm:1111',
      reason: 'test',
      type: 'prompt_injection',
      severity: 'high',
      messageIds: [1],
    }, context)).rejects.toThrow(/subject-bound session projection/u);
    await expect(service.applyCogSecRemediation({
      sourceChannelId: 'discord:dm:1111',
      reason: 'test',
      type: 'prompt_injection',
      severity: 'high',
      messageIds: [1],
    }, context)).rejects.toThrow(/subject-bound session projection/u);
  });

  it('keeps a multi-participant session invisible even when the subject posted last', async () => {
    const { service, contactA } = makeSubjectFixture();
    const roomChannelId = 'discord:room:9999';
    // Stable binding exists (persisted conversation channel), but the journal
    // carries TWO distinct author identities — attribution to one subject is
    // impossible and the last-entry author must not decide visibility.
    contactA.conversationChannels = [{
      channel: 'discord',
      channelId: roomChannelId,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
    }];
    store.append({
      channelId: roomChannelId,
      role: 'user',
      content: 'private room message from subject B',
      timestamp: 1_700_000_000_003,
      authorId: '2222',
    });
    store.append({
      channelId: roomChannelId,
      role: 'user',
      content: 'subject A posted last',
      timestamp: 1_700_000_000_004,
      authorId: '1111',
    });

    const context = fleetSessionContext({ contactId: 'contact-a' });
    const listed = await service.listSessions(context);
    expect(listed.channels.map(channel => channel.channelId)).toEqual(['discord:dm:1111']);
    await expect(service.getSessionMessages(roomChannelId, {}, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
    await expect(service.getSessionDetail(roomChannelId, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
  });

  it('keeps a stably bound session with an unattributed participant invisible', async () => {
    const { service, contactA } = makeSubjectFixture();
    const roomChannelId = 'discord:room:unattributed';
    contactA.conversationChannels = [{
      channel: 'discord',
      channelId: roomChannelId,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
    }];
    store.append({
      channelId: roomChannelId,
      role: 'user',
      content: 'participant identity was not captured',
      timestamp: 1_700_000_000_003,
    });

    const context = fleetSessionContext({ contactId: 'contact-a' });
    const listed = await service.listSessions(context);
    expect(listed.channels.map(channel => channel.channelId)).toEqual(['discord:dm:1111']);
    await expect(service.getSessionMessages(roomChannelId, {}, context))
      .rejects.toBeInstanceOf(AdminSessionNotFoundError);
  });

  it('forwards the request context on the cursor-page read path', async () => {
    const { service } = makeSubjectFixture();
    const context = fleetSessionContext({
      contactId: 'contact-a',
      routeId: 'GET /api/admin/sessions/:channelId',
    });

    const spy = vi.spyOn(service, 'getSessionMessages');
    await service.getSessionMessagesForAdminRead(
      'discord:dm:1111',
      { beforeId: 99, limit: 10 },
      context,
    );
    expect(spy).toHaveBeenCalledWith('discord:dm:1111', { beforeId: 99, limit: 10 }, context);
  });

  it('filters loom subsystem outputs and snapshot candidates to the viewer subject', async () => {
    const channelId = 'discord:dm:1111';
    const contactA = makeContact('contact-a', '1111');
    const contactB = makeContact('contact-b', '2222');
    const contactStore = {
      listAll: vi.fn(async () => [contactA, contactB]),
      getById: vi.fn(async (id: string) => (
        id === 'contact-a' ? contactA : id === 'contact-b' ? contactB : undefined
      )),
      getByChannelIdentity: vi.fn(async () => undefined),
    } as unknown as ContactStorePort;

    store.append({
      channelId,
      role: 'user',
      content: 'hello',
      timestamp: 1_700_000_000_001,
      authorId: '1111',
    });
    const turnId = createTurnId();
    const record = makeTurnRecord(channelId, turnId);
    const binding = {
      logicalSessionId: channelId,
      sourceChannelId: channelId,
      sourceTurnId: turnId,
      sourceRequestId: record.requestId,
    };
    record.extractedMemoryIds = [buildTurnSubsystemProjectionRef('memory', binding)];
    record.concernDeltaRefs = [buildTurnSubsystemProjectionRef('concern', binding)];
    record.contactDeltaRefs = [buildTurnSubsystemProjectionRef('contact', binding)];

    const makeMemory = (id: string, text: string): PurrMemory => ({
      id,
      text,
      type: 'semantic',
      importance: 0.7,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.6,
      sourceRef: `turn:${turnId}`,
      extractedAt: 1_700_000_000_050,
      lastAccessed: 1_700_000_000_050,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
    });
    const ownMemory = makeMemory('memory-own', 'about the viewer subject');
    const foreignMemory = makeMemory('memory-foreign', 'FOREIGN_SUBJECT_SECRET');
    record.observability = {
      stages: [],
      retrievals: [],
      snapshot: {
        turnId,
        requestId: record.requestId,
        channelId,
        capturedAt: 1_700_000_000_040,
        trustLevel: 'trusted',
        memory: {
          channelId,
          contactEmotionalMemories: [],
          semanticCandidates: [
            { ...ownMemory, similarity: 0.9 },
            { ...foreignMemory, similarity: 0.8 },
          ],
          lexicalCandidates: [],
          proactiveCandidates: [foreignMemory],
          versionPointer: 'test-memory-v1',
        },
      },
    };
    void store.appendTurnRecord(record);

    const baseClassification = {
      subjectClass: 'single_contact' as const,
      status: 'current' as const,
      classifierVersion: 1,
      memoryRevision: 1,
      evidenceDigest: 'a'.repeat(64),
      evidence: ['explicit_subject_contact' as const],
      reasonClass: 'explicit_subject_contact',
      classifiedAt: 1,
      updatedAt: 1,
    };
    const classifications = new Map([
      ['memory-own', {
        ...baseClassification,
        memoryId: 'memory-own',
        subjectContactIds: ['contact-a'],
      }],
      ['memory-foreign', {
        ...baseClassification,
        memoryId: 'memory-foreign',
        subjectContactIds: ['contact-b'],
      }],
    ]);
    const memoriesById = new Map([
      ['memory-own', ownMemory],
      ['memory-foreign', foreignMemory],
    ]);
    const memoryStore = {
      getById: vi.fn(async (id: string) => memoriesById.get(id)),
      getMemorySubjectClassification: vi.fn(async (id: string) => classifications.get(id)),
    } as unknown as MemoryStorePort;
    const makeConcern = (id: string, contactId?: string) => ({
      id,
      text: `Concern ${id}`,
      priority: 'medium',
      source: 'appraisal',
      status: 'candidate',
      createdAt: '2026-07-16T12:00:00.000Z',
      expiresAt: '2026-07-23T12:00:00.000Z',
      salience: 0.6,
      sensitivity: 'personal',
      owner: 'companion',
      evidenceRefs: [],
      resolutionEvidenceRefs: [],
      ...(contactId ? { contactId } : {}),
    });
    const concernsById = new Map([
      ['concern-own', makeConcern('concern-own', 'contact-a')],
      ['concern-unattributed', makeConcern('concern-unattributed')],
    ]);
    const concernStore = {
      getById: vi.fn(async (id: string) => concernsById.get(id) ?? null),
    } as unknown as ConcernStorePort;
    const getSubsystemOutputProjection = vi.fn(async () => ({
      status: 'applied' as const,
      outputRefs: [
        buildSubsystemOutputRef('memory', 'memory-own'),
        buildSubsystemOutputRef('memory', 'memory-foreign'),
        buildSubsystemOutputRef('concern', 'concern-own'),
        buildSubsystemOutputRef('concern', 'concern-unattributed'),
        buildSubsystemOutputRef('contact', 'contact-a'),
        buildSubsystemOutputRef('contact', 'contact-b'),
      ],
    }));

    const service = new AdminSessionDataService({
      sessionStore: store,
      sessionManager: new SessionManager(store, makeConfig({ dataDir: dir })),
      eventBus: new EventBus(),
      contactStore,
      memoryStore,
      concernStore,
      subsystemOutputRefStore: { getSubsystemOutputProjection },
      config: makeConfig({ dataDir: dir, companionId: createCompanionId(COMPANION_ID) }),
    });
    const context = fleetSessionContext({
      contactId: 'contact-a',
      routeId: 'GET /api/admin/sessions/:channelId/turns/:turnId',
    });

    const detail = await service.getSessionTurnDetail(channelId, turnId, context);
    const outputs = detail.turn.promptLoom?.subsystemOutputs;
    expect(outputs?.memoryWrites.map(entry => entry.value?.id ?? entry.ref))
      .toEqual(['memory-own']);
    expect(outputs?.concernDeltas.map(entry => entry.value?.id ?? entry.ref))
      .toEqual(['concern-own']);
    expect(outputs?.contactDeltas.map(entry => entry.value?.id ?? entry.ref))
      .toEqual(['contact-a']);
    expect(detail.turn.snapshot?.memory?.semanticCandidates.map(memory => memory.id))
      .toEqual(['memory-own']);
    expect(detail.turn.snapshot?.memory?.proactiveCandidates).toEqual([]);
    expect(detail.turn.record.observability?.snapshot?.memory?.semanticCandidates.map(memory => memory.id))
      .toEqual(['memory-own']);
    expect(detail.turn.record.observability?.snapshot?.memory?.proactiveCandidates).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('FOREIGN_SUBJECT_SECRET');

    // The standalone operator read stays unfiltered.
    const standalone = await service.getSessionTurnDetail(channelId, turnId);
    expect(standalone.turn.promptLoom?.subsystemOutputs.memoryWrites).toHaveLength(2);
    expect(standalone.turn.snapshot?.memory?.semanticCandidates).toHaveLength(2);
    expect(standalone.turn.record.observability?.snapshot?.memory?.semanticCandidates).toHaveLength(2);
  });
});

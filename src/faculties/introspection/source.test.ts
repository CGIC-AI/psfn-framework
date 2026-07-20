import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../core/session/manager.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { DEFAULT_INTROSPECTION_AUDIT_CONFIG } from '../../system/config/scheduler-config.js';
import { IntrospectionConsentStore } from './consent-store.js';
import { IntrospectionAuditRuntime } from './runtime.js';
import { createTurnRecordIntrospectionSource } from './source.js';

function makeConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
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
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: {
        model: 'test-model',
        provider: 'test',
        maxTokens: 16_384,
        contextWindow: 1_000,
      },
    },
  };
}

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const turnId = overrides.turnId ?? '019d2326-d9e1-701d-bcee-250d2cbb0e4e';
  const requestId = overrides.requestId ?? 'request-1';
  return {
    schemaVersion: 1,
    turnId,
    requestId,
    channelId: 'discord:public-room',
    channelType: 'discord',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_100,
    status: 'completed',
    auditPrivacy: {
      schemaVersion: 1,
      contentMode: 'verbatim_public',
      channelPrivacy: 'public',
      contentSensitivity: 'non_intimate',
      contentSensitivityActor: {
        kind: 'companion',
        turnId,
        requestId,
      },
      reason: 'explicit_public_non_dm',
    },
    userMessage: { role: 'user', content: 'Public question', timestamp: 1_700_000_000_000 },
    assistantMessage: { role: 'assistant', content: 'Public answer', timestamp: 1_700_000_000_100 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'model' },
    provenanceRefs: [],
    ...overrides,
  };
}

describe('turn-record introspection source', () => {
  it('selects only explicit public verbatim turns in exact consent channels', () => {
    const intimateSentinel = 'PRIVATE_INTIMATE_SENTINEL';
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [
        { sessionId: 'discord:public-room', sourceChannelId: 'discord:public-room' },
        { sessionId: 'discord:private-dm', sourceChannelId: 'discord:private-dm' },
      ],
      getRecentTurnRecords: (channelId) => channelId === 'discord:public-room'
        ? [
          record(),
          record({
            turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e5f',
            auditPrivacy: {
              schemaVersion: 1,
              contentMode: 'emotional_signal_only',
              channelPrivacy: 'public',
              contentSensitivity: 'intimate',
              reason: 'intimate_content',
            },
            userMessage: { role: 'user', content: intimateSentinel, timestamp: 1_700_000_000_000 },
          }),
        ]
        : [record({
          channelId: 'discord:private-dm',
          auditPrivacy: {
            schemaVersion: 1,
            contentMode: 'emotional_signal_only',
            channelPrivacy: 'private',
            contentSensitivity: 'intimate',
            reason: 'direct_message',
          },
          userMessage: { role: 'user', content: intimateSentinel, timestamp: 1_700_000_000_000 },
        })],
      isSessionRetiredOrQuarantined: () => false,
      isSourceTurnRecordEligible: () => true,
    });

    const candidates = source.listCandidates({
      allowedPublicChannelIds: ['discord:public-room'],
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    });

    expect(candidates).toHaveLength(1);
    expect(JSON.stringify(candidates)).not.toContain(intimateSentinel);
  });

  it('fails closed for legacy records without an audit privacy snapshot', () => {
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [{ sessionId: 'discord:public-room', sourceChannelId: 'discord:public-room' }],
      getRecentTurnRecords: () => [record({ auditPrivacy: undefined })],
      isSessionRetiredOrQuarantined: () => false,
      isSourceTurnRecordEligible: () => true,
    });
    expect(source.listCandidates({
      allowedPublicChannelIds: ['discord:public-room'],
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    })).toEqual([]);
  });

  it('reads routed turns from the source stream without widening consent to the logical session', () => {
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [{
        sessionId: 'session:logical-after-reset',
        sourceChannelId: 'discord:public-room',
      }],
      getRecentTurnRecords: (sourceChannelId) => sourceChannelId === 'discord:public-room'
        ? [record({ sessionId: 'session:logical-after-reset' })]
        : [],
      isSessionRetiredOrQuarantined: () => false,
      isSourceTurnRecordEligible: () => true,
    });
    const input = {
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    };

    expect(source.listCandidates({
      ...input,
      allowedPublicChannelIds: ['session:logical-after-reset'],
    })).toEqual([]);
    expect(source.listCandidates({
      ...input,
      allowedPublicChannelIds: ['discord:public-room'],
    })).toEqual([expect.objectContaining({
      channelId: 'discord:public-room',
      provenanceRefs: expect.arrayContaining(['session:session:logical-after-reset']),
    })]);
  });

  it.each(['break_glass_quarantine', 'fresh_split'] as const)(
    'excludes retired and ownerless source records after a %s route reload',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'introspection-route-reload-'));
      try {
        const sessionsDir = join(root, 'sessions');
        const config = makeConfig(root);
        const store = new SessionStore(sessionsDir);
        const manager = new SessionManager(store, config);
        const sourceChannelId = 'discord:guild:public-room';
        const oldPoisonedSentinel = 'OLD_POISONED_TRANSCRIPT_SENTINEL';
        const missingOwnerSentinel = 'MISSING_OWNER_TRANSCRIPT_SENTINEL';
        const freshSentinel = 'FRESH_ROUTED_TRANSCRIPT_SENTINEL';

        manager.recordUserMessage(sourceChannelId, 'old source owner', 'user-1', 'User', false);
        const oldTurn = record({
          turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e40',
          requestId: 'request-old',
          sessionId: sourceChannelId,
          channelId: sourceChannelId,
          userMessage: { role: 'user', content: oldPoisonedSentinel, timestamp: 1_700_000_000_000 },
          completedAt: 1_700_000_000_100,
        });
        void store.appendTurnRecord(oldTurn);

        const reset = manager.resetSourceChannelSession({
          sourceChannelId,
          actor: 'operator:test',
          reason: 'quarantine poisoned transcript',
          mode,
        });
        manager.recordUserMessage(sourceChannelId, 'fresh logical owner', 'user-1', 'User', false);
        const freshTurn = record({
          turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e41',
          requestId: 'request-fresh',
          sessionId: reset.newLogicalSessionId,
          channelId: sourceChannelId,
          userMessage: { role: 'user', content: freshSentinel, timestamp: 1_700_000_000_200 },
          completedAt: 1_700_000_000_300,
        });
        void store.appendTurnRecord(freshTurn);
        const missingOwnerTurn = record({
          turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e42',
          requestId: 'request-missing-owner',
          sessionId: 'session:missing-owner',
          channelId: sourceChannelId,
          userMessage: { role: 'user', content: missingOwnerSentinel, timestamp: 1_700_000_000_400 },
          completedAt: 1_700_000_000_500,
        });
        void store.appendTurnRecord(missingOwnerTurn);

        const reloadedStore = new SessionStore(sessionsDir);
        const reloadedManager = new SessionManager(reloadedStore, config);
        expect(reloadedStore.getRecentSourceTurnRecords(sourceChannelId, 10).map(entry => entry.turnId))
          .toEqual([oldTurn.turnId, freshTurn.turnId]);
        expect(reloadedStore.isSourceTurnRecordEligible(
          sourceChannelId,
          missingOwnerTurn.sessionId ?? sourceChannelId,
          missingOwnerTurn.turnId,
        )).toBe(false);

        const source = createTurnRecordIntrospectionSource({
          listRecentSessions: (limit, offset) => (
            reloadedManager.listRecentSessions(limit, offset).map(session => ({
              sessionId: session.sessionId,
              sourceChannelId: reloadedManager
                .getSessionRouteForLogicalSession(session.sessionId)?.sourceChannelId
                ?? session.channelId,
            }))
          ),
          getRecentTurnRecords: (channelId, limit, offset) => (
            reloadedStore.getRecentSourceTurnRecords(channelId, limit, offset)
          ),
          isSessionRetiredOrQuarantined: sessionId => (
            reloadedManager.isSessionRetiredOrQuarantined(sessionId)
          ),
          isSourceTurnRecordEligible: (channelId, ownerSessionId, turnId) => (
            reloadedStore.isSourceTurnRecordEligible(channelId, ownerSessionId, turnId)
          ),
        });
        const candidates = source.listCandidates({
          allowedPublicChannelIds: [sourceChannelId],
          recentSessionLimit: 10,
          recentTurnLimit: 10,
          maxSourceChars: 1_000,
        });

        expect(candidates.map(candidate => candidate.turnId)).toEqual([freshTurn.turnId]);
        expect(JSON.stringify(candidates)).not.toContain(oldPoisonedSentinel);
        expect(JSON.stringify(candidates)).not.toContain(missingOwnerSentinel);
        expect(JSON.stringify(candidates)).toContain(freshSentinel);
        const freshCandidate = candidates[0];
        expect(source.isCandidateStillEligible(freshCandidate)).toBe(true);

        const consentStore = new IntrospectionConsentStore(join(root, 'introspection-consent.jsonl'));
        consentStore.append({
          enabled: true,
          allowedPublicChannelIds: [sourceChannelId],
          actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
          reason: 'Enable the exact public source for the route-race regression.',
          createdAt: '2026-07-13T09:00:00.000Z',
        });
        let signalLookupStarted: (() => void) | undefined;
        const lookupStarted = new Promise<void>((resolve) => {
          signalLookupStarted = resolve;
        });
        let resolveLookup: ((value: boolean) => void) | undefined;
        const lookup = new Promise<boolean>((resolve) => {
          resolveLookup = resolve;
        });
        const estimateStableReply = vi.fn();
        const compareReplies = vi.fn();
        const reflect = vi.fn();
        const appendAuditDecision = vi.fn();
        const appendLandmark = vi.fn();
        const runtime = new IntrospectionAuditRuntime({
          config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
          consentStore,
          source,
          auditor: { estimateStableReply, compareReplies },
          reflector: { reflect },
          persistence: {
            hasAuditedSource: async () => {
              signalLookupStarted?.();
              return await lookup;
            },
            appendAuditDecision,
            appendLandmark,
          },
        });

        const running = runtime.runOnce();
        await lookupStarted;

        reloadedManager.resetSourceChannelSession({
          sourceChannelId,
          actor: 'operator:test',
          reason: 'retire the enumerated candidate during audit',
          mode,
        });
        resolveLookup?.(false);

        await expect(running).rejects.toThrow(/source.*no longer eligible/i);
        expect(source.isCandidateStillEligible(freshCandidate)).toBe(false);
        expect(estimateStableReply).not.toHaveBeenCalled();
        expect(compareReplies).not.toHaveBeenCalled();
        expect(reflect).not.toHaveBeenCalled();
        expect(appendAuditDecision).not.toHaveBeenCalled();
        expect(appendLandmark).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('advances a bounded cursor through older sessions and turns across repeated runs', () => {
    const sessions = [
      { sessionId: 'discord:newer-room', sourceChannelId: 'discord:newer-room' },
      { sessionId: 'discord:public-room', sourceChannelId: 'discord:public-room' },
    ];
    const turns = Array.from({ length: 5 }, (_, index) => record({
      turnId: `019d2326-d9e1-701d-bcee-250d2cbb0e${index + 1}e`,
      requestId: `request-${index + 1}`,
      completedAt: 1_700_000_000_100 + index,
    }));
    const source = createTurnRecordIntrospectionSource({
      listRecentSessions: (limit = 1, offset = 0) => sessions.slice(offset, offset + limit),
      getRecentTurnRecords: (channelId, limit, offset = 0) => {
        if (channelId !== 'discord:public-room') return [];
        const end = Math.max(0, turns.length - offset);
        return turns.slice(Math.max(0, end - limit), end);
      },
      isSessionRetiredOrQuarantined: () => false,
      isSourceTurnRecordEligible: () => true,
    });

    const input = {
      allowedPublicChannelIds: ['discord:public-room'],
      recentSessionLimit: 1,
      recentTurnLimit: 2,
      maxSourceChars: 1_000,
    };
    const candidates = Array.from({ length: 6 }, () => source.listCandidates(input)).flat();

    expect([...new Set(candidates.map(candidate => candidate.sourceRef))].sort()).toEqual(
      turns.map(turn => `turn:${turn.turnId}`).sort(),
    );
  });
});

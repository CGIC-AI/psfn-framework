import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../event-bus.js';
import { SessionManager } from '../../session/manager.js';
import { SessionStore } from '../../session/store.js';
import { createTurnId } from '../../turns/id.js';
import type { SubstrateConfig } from '../../types.js';
import { TurnSupportRuntime } from './turn-support-runtime.js';

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

describe('TurnSupportRuntime role-envelope projections', () => {
  let dir: string;
  let store: SessionStore;
  let sessionManager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-support-runtime-'));
    store = new SessionStore(dir);
    sessionManager = new SessionManager(store, makeConfig({ dataDir: dir }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildTurnRecord lifts promoted role-envelope refs from stored session previews', () => {
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    const channelId = 'api:runtime-role-envelope';
    const turnId = createTurnId();
    const requestId = 'runtime-role-envelope-turn';
    const timestamp = new Date('2026-03-17T14:00:00.000Z');

    const userSessionEntryId = sessionManager.recordUserMessage(
      channelId,
      'Please check in tomorrow if I disappear.',
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
      'Queued a gentle follow-up reminder for tomorrow.',
      undefined,
      undefined,
      undefined,
      {
        turnId,
        requestId,
        roleEnvelopePreview: {
          schemaVersion: 1,
          envelopeId: 'env_runtime_projection_1',
          internalRole: 'outreach_candidate',
          summary: 'Queued a gentle follow-up reminder for tomorrow.',
          sourceStage: 'post_turn_appraisal',
          promotionTarget: 'turn_record_summary',
          promotedRef: 'turn_record_summary:env_runtime_projection_1',
        },
      },
    );

    const record = runtime.buildTurnRecord({
      message: {
        id: requestId,
        channelId,
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Please check in tomorrow if I disappear.',
        timestamp,
      },
      turnId,
      requestId,
      startedAt: timestamp.getTime(),
      completedAt: timestamp.getTime() + 50,
      userSessionEntryId,
      assistantSessionEntryId,
      response: {
        content: 'Queued a gentle follow-up reminder for tomorrow.',
        channelId,
        metadata: {
          model: 'test-model',
          inputTokens: 42,
          outputTokens: 11,
          durationMs: 50,
        },
      },
      turnMessages: [],
      promptMode: 'default',
      promptText: 'System prompt',
      contextMessageCount: 2,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
    });

    expect(record.roleEnvelopeRefs).toEqual(['turn_record_summary:env_runtime_projection_1']);
  });
});

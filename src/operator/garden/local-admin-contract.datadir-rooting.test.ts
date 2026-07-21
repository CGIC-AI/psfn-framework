import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../shared/event-bus.js';
import { createInProcessGardenAdminContract } from './local-admin-contract.js';
import { createPromptStatePort } from '../../core/identity/prompt-state-port.js';
import { InMemoryMemoryStore } from '../../test-support/in-memory-memory-store.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { ShardManager } from '../../faculties/shards/manager.js';
import {
  resolveReflectionPolicyPath,
  resolveReflectionMetacognitionJournalPath,
} from '../../persistence/layout.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';

/**
 * Regression guard for psfn-framework-dnll.4: per-companion state files owned by
 * the Garden admin surface must resolve under companionDataDir, NOT the shared
 * system-data root (config.dataDir). On a multi-companion fleet the two roots
 * differ, so any file rooted at config.dataDir collides across companions.
 */

const testCard: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'RootingTestBot',
    description: 'dataDir-rooting regression character',
    personality: 'Calm',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['test'],
    creator: 'tester',
  },
};

describe('createInProcessGardenAdminContract per-companion dataDir rooting (dnll.4)', () => {
  let rootDir: string;
  let systemDataDir: string;
  let companionDataDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'dnll4-rooting-'));
    systemDataDir = join(rootDir, 'system-data');
    companionDataDir = join(rootDir, 'companion-data', 'companion-uuid');
    sessionsDir = join(companionDataDir, 'sessions');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    // The contract eagerly resolves the companion name from the character card.
    writeFileSync(
      join(companionDataDir, 'character.json'),
      `${JSON.stringify(testCard, null, 2)}\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildContract() {
    // Distinct roots: dataDir is the shared system-data root; companionDataDir
    // is this companion's private root — exactly the single-release fleet shape.
    const config: SubstrateConfig = {
      primaryModel: 'test-model',
      primaryProvider: 'test',
      extractionModel: 'test-extract',
      extractionProvider: 'test',
      discordToken: '',
      discordBotId: '123',
      companionId: 'companion-uuid',
      gatewaySessionIntegrityAuthToken: `v1.${'b'.repeat(64)}`,
      characterCardPath: join(companionDataDir, 'character.json'),
      dataDir: systemDataDir,
      companionDataDir,
      databasePath: '',
      sessionHistoryBudgetPct: 6,
      memoryRetrievalBudgetPct: 2,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 5,
      primaryMaxTokens: 16384,
      extractionMaxTokens: 8192,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
      },
    };

    const eventBus = new EventBus();
    const memoryStore = new InMemoryMemoryStore().asPort();
    const sessionStore = new SessionStore(sessionsDir);
    const sessionManager = new SessionManager(sessionStore, config, eventBus);
    const scheduler = new Scheduler(eventBus);
    scheduler.registerHeartbeat(() => {});
    const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProviderPort;
    const shardManager = new ShardManager({
      snapshotParentCapabilityGrant: () => ({
        tier: 'custom',
        customTokens: ['shard.spawn'],
        grantedTokens: ['shard.spawn'],
      }),
      eventBus,
      llmProvider: mockLlmProvider,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config,
      parentSystemPrompt: '',
    });

    return createInProcessGardenAdminContract({
      env: {},
      memoryStore,
      sessionStore,
      sessionManager,
      scheduler,
      shardManager,
      eventBus,
      characterCard: testCard,
      config,
      embeddingService: null,
      promptState: createPromptStatePort({}),
    });
  }

  it('roots the Garden reflection-policy under companionDataDir, not system-data', () => {
    const services = buildContract();
    const policyPath = (services.scheduler as unknown as {
      policyStore: { filePath: string };
    }).policyStore.filePath;

    expect(policyPath).toBe(resolveReflectionPolicyPath(companionDataDir));
    expect(policyPath.startsWith(companionDataDir)).toBe(true);
    expect(policyPath.startsWith(systemDataDir)).toBe(false);
    expect(policyPath).not.toBe(resolveReflectionPolicyPath(systemDataDir));
  });

  it('roots the scheduler reflection-metacognition journal under companionDataDir', () => {
    const services = buildContract();
    const journalPath = (services.scheduler as unknown as {
      reflectionMetacognitionJournal: { filePath: string };
    }).reflectionMetacognitionJournal.filePath;

    expect(journalPath).toBe(resolveReflectionMetacognitionJournalPath(companionDataDir));
    expect(journalPath.startsWith(companionDataDir)).toBe(true);
    expect(journalPath.startsWith(systemDataDir)).toBe(false);
  });

  it('writes garden-audit-history.jsonl under companionDataDir, not system-data', () => {
    const services = buildContract();
    services.auditHistory.appendGardenEntry({
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'dnll.4 rooting probe',
      actor: 'operator',
    });

    expect(existsSync(join(companionDataDir, 'garden-audit-history.jsonl'))).toBe(true);
    expect(existsSync(join(systemDataDir, 'garden-audit-history.jsonl'))).toBe(false);
  });
});

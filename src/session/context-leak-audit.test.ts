import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import { SessionStore } from './store.js';
import { SessionManager } from './manager.js';

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
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
    sessionMessageLimit: 64,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 2_000 },
    },
    ...overrides,
  };
}

describe('context leak audit (assembled context)', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-context-leak-audit-'));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('periodically verifies masked tool output never leaks into assembled context', async () => {
    const secretSentinel = 'sk-live-leak-audit-sentinel';
    const manager = new SessionManager(store, makeConfig({ observationMaskingWindow: 1 }));
    const channelId = 'dm:leak-audit';

    manager.recordUserMessage(channelId, 'Run diagnostics for the account.', 'u1', 'PrimaryUser');
    manager.recordSystemMessage(
      channelId,
      '[Intention Appraisal] Re-evaluate whether we still need to check this.',
      'system:intention',
      'Intention Appraisal',
    );
    manager.recordToolObservation(channelId, {
      toolName: 'diagnostic_dump',
      toolCallId: 'diag-1',
      content: `raw token: ${secretSentinel}`,
    });
    manager.recordAssistantMessage(channelId, 'Diagnostics captured.');
    manager.recordUserMessage(channelId, 'Summarize only what is safe.', 'u1', 'PrimaryUser');
    manager.recordAssistantMessage(channelId, 'Proceeding with sanitized summary.');

    for (let pass = 1; pass <= 3; pass += 1) {
      const context = await manager.buildContext(
        channelId,
        'System prompt',
        '[Retrieved memories]\nOnly include approved facts.',
      );
      const assembled = [context.systemPrompt, ...context.messages.map(message => message.content)].join('\n');

      expect(assembled).not.toContain(secretSentinel);
      expect(assembled).toContain(
        '[Tool result: diagnostic_dump] Captured 1 line of text output with credential-like values omitted.',
      );
      expect(context.manifest?.session.maskedEntryCount).toBeGreaterThan(0);
      expect(context.manifest?.session.intentionAppraisalArtifactCount).toBe(1);

      manager.recordAssistantMessage(channelId, `audit pass ${pass} complete`);
    }
  });
});

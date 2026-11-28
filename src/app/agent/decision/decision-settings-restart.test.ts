// psfn-framework-y7mjg: a Garden decisionBackend save does not reach the
// running decision runtime or the gateway's remote decision service, so the
// save response must say a restart is required — and that statement must be
// true of the real components: nothing changes until they are rebuilt from the
// saved owner file, and then the change applies.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewaySystemDataWriter } from '../../../boundary/gateway/system-data-writer.js';
import {
  createGatewayJevDecisionService,
  JevDecisionRefusedError,
} from '../../../boundary/gateway/jev-decision-service.js';
import { AdminSettingsDataService } from '../../../operator/garden/services/settings-service.js';
import type { DecisionsFetch } from '../../../primitives/llm/decision/jev-transport.js';
import {
  TUTORIAL_REQUEST_BODY,
  TUTORIAL_RESPONSE_BODY,
} from '../../../primitives/llm/decision/jev-transport.test-fixtures.js';
import type { DecisionQuestionSet } from '../../../primitives/llm/decision/types.js';
import { buildLLMWorkSpec } from '../../../primitives/llm/work-spec.js';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import { createDefaultDecisionBackendSettings } from '../../../system/config/decision-backend-config.js';
import {
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../../system/config/runtime-config-contracts.js';
import { loadModelsConfig } from '../../../system/config/models-config.js';
import { buildSettingsContractData } from '../../../system/config/settings-contract.js';
import { applySettings } from '../../../system/settings.js';
import { buildAgentDecisionRuntime } from './decision-runtime.js';

const OWNER_FILES = [
  'settings.json',
  'models.json',
  'providers.json',
  'trust-policy.json',
  'intake-policy.json',
  'scheduler.json',
  'capability-tier.json',
  'charge-policy.json',
  'backup.json',
  'skills.json',
  'mcp-servers.json',
  'automata-policy.json',
];
const COMPANION_ID = 'companion-restart-test';
const QUESTIONS = TUTORIAL_REQUEST_BODY.questions as unknown as DecisionQuestionSet;
const LOCAL_ANSWERS = {
  is_bug: { type: 'noul', noul: 0.5 },
  team: { type: 'choice', choice: 'frontend', probabilities: { payments: 0.2, frontend: 0.7, account: 0.1 }, confidence: 0.6 },
  urgency: { type: 'score', score: 1, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 }, confidence: 0.5 },
};

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function seedOwnerFiles(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-decision-restart-'));
  for (const ownerFile of OWNER_FILES) {
    const seed = ownerFile.replace(/\.json$/u, '.seed.json');
    writeFileSync(join(tempDir, ownerFile), readFileSync(join(process.cwd(), 'config', seed), 'utf8'), 'utf8');
  }
  return tempDir;
}

/** The startup config one process loads from the owner files in `root`. */
function loadProcessConfig(root: string): SubstrateConfig {
  const models = loadModelsConfig(root, { defaultContextWindow: 128_000 });
  const config = {
    primaryModel: models.primaryModel,
    primaryProvider: models.primaryProvider,
    extractionModel: models.extractionModel,
    extractionProvider: models.extractionProvider,
    primaryMaxTokens: models.primaryMaxTokens,
    extractionMaxTokens: models.extractionMaxTokens,
    dataDir: root,
    defaultContextWindow: 128_000,
    companionId: COMPANION_ID,
    modelRoster: models.modelRoster,
    modelCatalog: models.modelCatalog,
    modelRoleAssignments: models.modelRoleAssignments,
    modelRegistry: models.modelRegistry,
    openRouterApiBaseUrl: 'https://openrouter.test/api/v1',
    openRouterApiKeyRef: { source: 'env', envName: 'OPENROUTER_API_KEY' },
    credentialVault: { resolveOptional: () => 'sk-or-test-key' },
  } as unknown as SubstrateConfig;
  applySettings(config, createOwnerFileConfigStore({ dataDir: root, defaultContextWindow: 128_000 })
    .loadEffectiveRuntimeSettings());
  return config;
}

function okFetch() {
  return vi.fn<DecisionsFetch>(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(TUTORIAL_RESPONSE_BODY),
  }));
}

/** One companion: its agent decision runtime, its Garden, and the shared gateway. */
function startRuntime(root: string, fetch: DecisionsFetch) {
  const configStore = createOwnerFileConfigStore({ dataDir: root, defaultContextWindow: 128_000 });
  const gatewayConfig = loadProcessConfig(root);
  const agentConfig = loadProcessConfig(root);
  const jev = createGatewayJevDecisionService({ config: gatewayConfig, requireCompanionAttribution: false, fetch });
  const decisions = buildAgentDecisionRuntime({
    config: agentConfig,
    llmProvider: {
      complete: async () => ({
        content: JSON.stringify({ answers: LOCAL_ANSWERS }),
        toolCalls: [],
        model: 'local-test-model',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      }),
    } as never,
    // The llm.decide handler: the gateway attributes the call to the
    // authenticated companion and a refusal becomes a thrown error.
    gateway: { decide: async (params) => await jev.decide({ ...params, companionId: COMPANION_ID }) },
    companionDataDir: root,
  });
  // The agent hosts the Garden over a sanitized copy of its config, and owner
  // writes go through the gateway's system-data writer.
  const garden = new AdminSettingsDataService({
    config: sanitizeCoreSubstrateConfig({ ...agentConfig }) as SubstrateConfig,
    configStore,
    systemDataWriter: new GatewaySystemDataWriter({ configStore, systemDataDir: root }),
  });
  return { jev, decisions, garden };
}

const JEV_SETTINGS = {
  ...createDefaultDecisionBackendSettings(),
  mode: 'jev' as const,
};

const RERANK_REQUEST = {
  siteId: 'memory.rerank' as const,
  state: TUTORIAL_REQUEST_BODY.state,
  questions: QUESTIONS,
  workSpec: buildLLMWorkSpec({ purpose: 'decision', durable: false }),
};

describe('decisionBackend Garden save (psfn-framework-y7mjg)', () => {
  it('declares decisionBackend restart-required in the settings contract', () => {
    expect(buildSettingsContractData().fields.decisionBackend?.restartRequired).toBe(true);
    expect(buildSettingsContractData().fields.sessionMirrorEnabled?.restartRequired).toBeUndefined();
  });

  it('reports restart-required, and the running runtime keeps its startup backend until restart', async () => {
    const root = seedOwnerFiles();
    const fetch = okFetch();
    const running = startRuntime(root, fetch);
    expect((await running.garden.getSettingsData()).status.status).toBe('healthy');

    const saved = await running.garden.updateSettings(JSON.stringify({ decisionBackend: JEV_SETTINGS }));

    expect(saved.ok).toBe(true);
    expect(saved.message).toMatch(/restart/u);
    expect(saved.status).toMatchObject({
      status: 'degraded',
      divergences: [{ key: 'decisionBackend', state: 'restart_required' }],
    });
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).decisionBackend.mode).toBe('jev');
    // A later read still says so: the pending restart is not a one-shot toast.
    expect((await running.garden.getSettingsData()).status.divergences)
      .toEqual([expect.objectContaining({ key: 'decisionBackend', state: 'restart_required' })]);

    // The statement is true: neither process picked the save up.
    expect(running.decisions.effectiveMode('memory.rerank')).toBe('local');
    await expect(running.jev.decide({ ...RERANK_REQUEST, companionId: COMPANION_ID }))
      .rejects.toBeInstanceOf(JevDecisionRefusedError);
    await expect(running.decisions.decide(RERANK_REQUEST)).resolves.toMatchObject({ ok: true, backend: 'local' });
    expect(fetch).not.toHaveBeenCalled();

    // After the restart both processes load the saved owner file and apply it.
    const restarted = startRuntime(root, fetch);
    expect(restarted.decisions.effectiveMode('memory.rerank')).toBe('jev');
    await expect(restarted.decisions.decide(RERANK_REQUEST)).resolves.toMatchObject({ ok: true, backend: 'jev' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await restarted.garden.getSettingsData()).status).toMatchObject({ status: 'healthy', divergences: [] });
  });

  it('does not report restart-required when a save leaves decisionBackend unchanged', async () => {
    const root = seedOwnerFiles();
    const running = startRuntime(root, okFetch());
    const saved = await running.garden.updateSettings(JSON.stringify({ sessionMirrorEnabled: true }));
    expect(saved).toMatchObject({ ok: true, status: { status: 'healthy', divergences: [] } });
  });
});

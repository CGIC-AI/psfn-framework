import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { Context } from '@mariozechner/pi-ai';
import type { CanonicalModelRegistry, CompletionPurpose, ModelRegistryEntry, ModelSlot } from '../../shared/contracts/runtime.js';
import {
  deriveChildIcpConversationCostCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  createEnvCredentialVault,
  envCredential,
} from '../../boundary/custody/credential-vault.js';
import { FallbackRunner } from './fallback.js';
import { ModelCallPreemptedError } from './model-call-gate.js';
import { createEligibilityGate, EligibilityDeniedError } from '../../system/capabilities/eligibility.js';

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(),
  getModels: vi.fn(),
  getProviders: vi.fn(),
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: mocks.getModel,
  getModels: mocks.getModels,
  getProviders: mocks.getProviders,
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getEnvApiKey: mocks.getEnvApiKey,
}));

import {
  inferCallType,
  LegacyModelHintError,
  LLMClient,
  SensitiveImportRoutePolicyError,
} from './client.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from './work-spec.js';
import {
  CircuitOpenError,
  SlidingWindowCircuitBreaker,
} from '../../shared/resilience/circuit-breaker.js';
import { COMPANION_PRIVATE_BACKGROUND_TELEMETRY } from '../../shared/telemetry/model-usage.js';
import { createSubstrateStreamFn, resolveModel } from '../../core/agent/stream-adapter.js';
import { GatewayClient } from '../../boundary/gateway/client.js';
import { registerLLMMethods } from '../../boundary/gateway/methods/llm.js';
import type { ModelUsageEventInput } from '../../shared/telemetry/model-usage.js';
import type { IcpConversationCostAccountingPort } from '../../shared/telemetry/model-usage.js';
import type { GatewayRpcConnection } from '../../boundary/gateway/transport.js';
import type { GatewayMethodRuntime } from '../../boundary/gateway/methods/types.js';
import type { ChargePolicyConfig } from '../../shared/contracts/charge-policy.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
import {
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
  runWithChargedSurface,
} from '../../shared/telemetry/run-charge.js';

function makeModelChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 10,
      background: 10,
      maintenance: 10,
      subagent: 10,
      shard: 10,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 1,
      localImageGeneration: 0,
      paidImageGeneration: 1,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 1,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 1,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 1,
    },
    icpCostBreaker: { enabled: false },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-llm-client-test-'));
  tempDirs.push(dataDir);
  const config: SubstrateConfig = {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 4096,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: join(dataDir, 'test.db'),
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: {
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 128_000,
      },
      background: {
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 2048,
      },
    },
    ...overrides,
  };

  if (!config.modelRegistry) {
    config.modelRegistry = buildRegistryFromConfig(config);
  }

  return config;
}

const tempDirs: string[] = [];

// Mirrors client-prompt-cache's provider-facing affinity token: the mandatory
// companion scope, the canonical subject contact, the scope label and the
// inner (channel / request) id are length-prefixed, domain-separated and
// hashed before they reach provider adapters. Cross-companion / cross-contact
// tokens can never collide.
function providerCacheSessionId(
  companionId: string,
  inner: string,
  opts: { scope?: 'channel' | 'request'; contactId?: string } = {},
): string {
  const scope = opts.scope ?? 'channel';
  const contactId = opts.contactId ?? '';
  const material = [
    'psfnpc.v2',
    `companion:${companionId.length}:${companionId}`,
    `contact:${contactId.length}:${contactId}`,
    `scope:${scope}`,
    `inner:${inner.length}:${inner}`,
  ].join('\u0000');
  return `psfnpc-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

afterEach(() => {
  resetRunChargeRollingWindowForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('LLMClient ICP conversation cost admission', () => {
  const correlation: IcpConversationCorrelation = {
    conversationId: '33333333-3333-4333-8333-333333333333',
    rootInitiationId: '44444444-4444-4444-8444-444444444444',
    initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    peerContactId: 'contact-b',
    channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    turnId: 'turn-1',
    messageId: 'message-1',
    requestId: 'request-1',
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'reply',
    fatigueDecision: 'allow',
  };
  const policy = {
    enabled: true as const,
    warningThresholdUsd: 1,
    hardLimitUsd: 2,
    finalCloseoutReserveUsd: 1,
    pendingReservationStaleAfterMs: 60_000,
    includedCostPurposes: {
      conversation_turn: true,
      tool: true,
      summary: true,
      extraction: true,
      sidecar: true,
    },
  };

  function makeIcpConfig(): SubstrateConfig {
    const config = makeConfig({
      retryMaxAttempts: 0,
      retryBaseDelayMs: 0,
      chargePolicy: {
        ...makeModelChargePolicy(),
        icpCostBreaker: policy,
      },
    });
    for (const entry of config.modelRegistry?.models ?? []) {
      entry.cost = {
        inputPer1MUsd: 1,
        outputPer1MUsd: 2,
        currency: 'USD',
      };
    }
    return config;
  }

  function projection(projectedTotalCostUsd: number) {
    return {
      conversationId: correlation.conversationId,
      rootInitiationId: correlation.rootInitiationId,
      actualCostUsd: 0,
      pendingProjectedCostUsd: projectedTotalCostUsd,
      projectedTotalCostUsd,
      warningThresholdUsd: policy.warningThresholdUsd,
      hardLimitUsd: policy.hardLimitUsd,
      remainingToHardLimitUsd: Math.max(0, policy.hardLimitUsd - projectedTotalCostUsd),
      actualAttemptCount: 0,
      unknownCostAttemptCount: 0,
      pendingReservationCount: 1,
      staleReservationCount: 0,
      settledReservationCount: 0,
      attributedCompanionCount: 1,
      enforcementState: projectedTotalCostUsd > policy.warningThresholdUsd
        ? 'warning' as const
        : 'normal' as const,
    };
  }

  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();
    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('reserves each physical attempt before provider I/O and settles with canonical ICP metadata', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const onDecision = vi.fn();
    const reserveIcpConversationCost = vi.fn<
      IcpConversationCostAccountingPort['reserveIcpConversationCost']
    >(async input => {
      expect(mocks.streamSimple).not.toHaveBeenCalled();
      return {
        allowed: true,
        replayed: false,
        reason: 'below_warning',
        projectedRequestCostUsd: input.projectedCostUsd,
        projection: projection(input.projectedCostUsd),
      };
    });
    const accounting: IcpConversationCostAccountingPort = {
      reserveIcpConversationCost,
      getIcpConversationCostProjection: vi.fn(async () => projection(0)),
    };
    const client = new LLMClient(makeIcpConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
      icpConversationCostAccounting: accounting,
      onIcpConversationCostDecision: onDecision,
    });
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    });

    await expect(client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Continue' }],
      accounting: {
        logicalCallId: 'logical-icp-1',
        attempt: 7,
        retryOwner: 'caller',
      },
      correlation: {
        callType: 'chat',
        purpose: 'chat',
        icpCorrelation: correlation,
      },
    })).resolves.toMatchObject({ content: 'ok' });

    expect(reserveIcpConversationCost).toHaveBeenCalledWith(expect.objectContaining({
      logicalCallId: 'logical-icp-1',
      attempt: 7,
      correlation,
      policy,
      projectedCostUsd: expect.any(Number),
    }));
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'reserved',
      logicalCallId: 'logical-icp-1',
      attempt: 7,
    }));
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      logicalCallId: 'logical-icp-1',
      attempt: 7,
      attribution: expect.objectContaining({
        companionId: correlation.localCompanionId,
        conversationId: correlation.conversationId,
        rootInitiationId: correlation.rootInitiationId,
      }),
      metadata: expect.objectContaining({
        icpCost: {
          purpose: correlation.costPurpose,
          originStage: correlation.costOriginStage,
          fatigueDecision: correlation.fatigueDecision,
        },
      }),
    }));
  });

  it('does not let a routed endpoint synthetic zero override canonical model pricing', async () => {
    const config = makeIcpConfig();
    const primary = config.modelRegistry?.models.find(
      entry => entry.identity.model === 'z-ai/glm-5',
    );
    if (!primary) throw new Error('Expected the primary test model');
    primary.identity.source.baseUrl = 'http://loopback.test/v1';
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const accounting: IcpConversationCostAccountingPort = {
      reserveIcpConversationCost: vi.fn(async input => ({
        allowed: true,
        replayed: false,
        reason: 'below_warning',
        projectedRequestCostUsd: input.projectedCostUsd,
        projection: projection(input.projectedCostUsd),
      })),
      getIcpConversationCostProjection: vi.fn(async () => projection(0)),
    };
    const client = new LLMClient(config, {
      usageRecorder,
      icpConversationCostAccounting: accounting,
    });
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    });

    await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Continue' }],
      correlation: { callType: 'chat', icpCorrelation: correlation },
    });

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      providerCost: {},
      estimatedCost: expect.objectContaining({ total: 0.000014 }),
      effectiveCost: expect.objectContaining({ total: 0.000014 }),
      costSource: 'estimate',
      metadata: expect.objectContaining({ syntheticRoutedEndpointCostIgnored: true }),
    }));
  });

  it('suppresses provider I/O when the canonical hard breaker denies the attempt', async () => {
    const reserveIcpConversationCost = vi.fn<
      IcpConversationCostAccountingPort['reserveIcpConversationCost']
    >(async input => ({
      allowed: false,
      replayed: false,
      reason: 'hard_limit_exceeded',
      projectedRequestCostUsd: input.projectedCostUsd,
      projection: {
        ...projection(2),
        enforcementState: 'hard_stop',
      },
    }));
    const client = new LLMClient(makeIcpConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      icpConversationCostAccounting: {
        reserveIcpConversationCost,
        getIcpConversationCostProjection: vi.fn(async () => projection(2)),
      },
    });

    await expect(client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Continue' }],
      correlation: {
        callType: 'chat',
        purpose: 'chat',
        icpCorrelation: correlation,
      },
    })).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event: { reason: 'hard_limit_exceeded' },
    });
    expect(mocks.streamSimple).not.toHaveBeenCalled();
  });

  it.each<{
    costPurpose: IcpConversationCorrelation['costPurpose'];
    costOriginStage: IcpConversationCorrelation['costOriginStage'];
    completionPurpose: CompletionPurpose;
  }>([
    { costPurpose: 'summary', costOriginStage: 'post_turn', completionPurpose: 'summary' },
    { costPurpose: 'extraction', costOriginStage: 'post_turn', completionPurpose: 'extraction' },
    { costPurpose: 'sidecar', costOriginStage: 'post_turn', completionPurpose: 'background' },
    { costPurpose: 'tool', costOriginStage: 'reply', completionPurpose: 'reasoning' },
  ])('reserves and hard-suppresses $costPurpose descendants in the parent conversation', async ({
    costPurpose,
    costOriginStage,
    completionPurpose,
  }) => {
    const child = deriveChildIcpConversationCostCorrelation(correlation, {
      requestId: `${correlation.requestId}:${costPurpose}`,
      costPurpose,
      costOriginStage,
    });
    const reserveIcpConversationCost = vi.fn<
      IcpConversationCostAccountingPort['reserveIcpConversationCost']
    >(async input => ({
      allowed: false,
      replayed: false,
      reason: 'hard_limit_exceeded',
      projectedRequestCostUsd: input.projectedCostUsd,
      projection: {
        ...projection(2),
        enforcementState: 'hard_stop',
      },
    }));
    const client = new LLMClient(makeIcpConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      icpConversationCostAccounting: {
        reserveIcpConversationCost,
        getIcpConversationCostProjection: vi.fn(async () => projection(2)),
      },
    });

    await expect(client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Run descendant work' }],
      correlation: {
        requestId: child.requestId,
        turnId: child.turnId,
        channelId: child.channelId,
        callType: costPurpose === 'tool' ? 'tool' : 'background',
        originType: costPurpose === 'tool' ? 'tool' : 'background',
        originStage: `test.${costPurpose}`,
        icpCorrelation: child,
      },
    }, completionPurpose, { disableRetry: true })).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event: { reason: 'hard_limit_exceeded' },
    });

    expect(reserveIcpConversationCost).toHaveBeenCalledWith(expect.objectContaining({
      correlation: expect.objectContaining({
        conversationId: correlation.conversationId,
        rootInitiationId: correlation.rootInitiationId,
        localCompanionId: correlation.localCompanionId,
        peerCompanionId: correlation.peerCompanionId,
        peerContactId: correlation.peerContactId,
        requestId: child.requestId,
        costPurpose,
        costOriginStage,
      }),
    }));
    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it('includes cache-write exposure in near-hard admission before completion provider I/O', async () => {
    const config = makeIcpConfig();
    if (!config.modelRegistry) throw new Error('test model registry missing');
    config.modelRegistry.promptCaching = {
      enabled: true,
      retention: 'short',
      scope: 'channel',
    };
    for (const entry of config.modelRegistry.models) {
      entry.cost = {
        inputPer1MUsd: 0,
        outputPer1MUsd: 0,
        cacheReadPer1MUsd: 0,
        cacheWritePer1MUsd: 1_000,
        currency: 'USD',
      };
    }
    const child = deriveChildIcpConversationCostCorrelation(correlation, {
      requestId: `${correlation.requestId}:cache-write-summary`,
      costPurpose: 'summary',
      costOriginStage: 'post_turn',
    });
    const reserveIcpConversationCost = vi.fn<
      IcpConversationCostAccountingPort['reserveIcpConversationCost']
    >(async input => ({
      allowed: false,
      replayed: false,
      reason: 'hard_limit_exceeded',
      projectedRequestCostUsd: input.projectedCostUsd,
      projection: {
        ...projection(2),
        enforcementState: 'hard_stop',
      },
    }));
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      icpConversationCostAccounting: {
        reserveIcpConversationCost,
        getIcpConversationCostProjection: vi.fn(async () => projection(2)),
      },
    });

    await expect(client.complete({
      systemPrompt: 'Cacheable system prompt',
      messages: [{ role: 'user', content: 'Summarize this near-hard conversation' }],
      correlation: {
        requestId: child.requestId,
        turnId: child.turnId,
        channelId: child.channelId,
        callType: 'summary',
        originType: 'summary',
        originStage: 'test.cache-write-summary',
        icpCorrelation: child,
      },
    }, 'summary', { disableRetry: true })).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event: { reason: 'hard_limit_exceeded' },
    });

    expect(reserveIcpConversationCost).toHaveBeenCalledWith(expect.objectContaining({
      projectedCostUsd: expect.any(Number),
      correlation: child,
    }));
    expect(reserveIcpConversationCost.mock.calls[0]?.[0].projectedCostUsd).toBeGreaterThan(0);
    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });
});

function buildRegistryFromConfig(config: SubstrateConfig): CanonicalModelRegistry {
  const chat = config.modelRoster.chat ?? {
    model: config.primaryModel,
    provider: config.primaryProvider,
    maxTokens: config.primaryMaxTokens,
    contextWindow: config.defaultContextWindow,
  };
  const background = config.modelRoster.background ?? {
    model: config.extractionModel,
    provider: config.extractionProvider,
    maxTokens: config.extractionMaxTokens,
    contextWindow: config.defaultContextWindow,
  };
  const reasoning = config.modelRoster.reasoning ?? chat;
  const longContext = config.modelRoster.longContext ?? config.modelRoster.context ?? chat;
  const extraction: ModelSlot = {
    model: config.extractionModel,
    provider: config.extractionProvider,
    maxTokens: config.extractionMaxTokens,
    contextWindow: config.defaultContextWindow,
  };

  const createEntry = (
    id: string,
    rank: number,
    slot: ModelSlot,
    purposes: ModelRegistryEntry['purposes'],
  ): ModelRegistryEntry => ({
    id,
    rank,
    identity: {
      provider: slot.provider,
      model: slot.model,
      source: { type: slot.provider },
    },
    purposes,
    capabilities: {
      maxOutputTokens: slot.maxTokens,
      ...(slot.contextWindow !== undefined ? { contextWindow: slot.contextWindow } : {}),
    },
    tuning: {
      maxOutputTokens: slot.maxTokens,
      ...(slot.contextWindow !== undefined ? { contextWindow: slot.contextWindow } : {}),
    },
  });

  return {
    schemaVersion: 1,
    models: [
      createEntry('chat', 10, chat, [
        { purpose: 'chat', primary: true },
        { purpose: 'summary', primary: true },
        { purpose: 'moa', primary: true },
      ]),
      createEntry('background', 20, background, [
        { purpose: 'background', primary: true },
      ]),
      createEntry('extraction', 30, extraction, [
        { purpose: 'memory', primary: true },
        { purpose: 'extraction', primary: true },
        { purpose: 'import_processing', primary: true },
      ]),
      createEntry('reasoning', 40, reasoning, [
        { purpose: 'reasoning', primary: true },
      ]),
      createEntry('long-context', 50, longContext, [
        { purpose: 'longContext', primary: true },
      ]),
      createEntry('vision', 60, chat, [
        { purpose: 'vision', primary: true },
      ]),
    ],
  };
}

describe('LLMClient import-processing routing policy', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockImplementation(() => [
      {
        id: 'z-ai/glm-5',
        provider: 'openrouter',
        name: 'z-ai/glm-5',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16384,
      },
      {
        id: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        name: 'deepseek/deepseek-v3.2',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('throws an auditable strict-policy error when import route is not OpenRouter ZDR', async () => {
    const config = makeConfig({
      importProcessingRouteMode: 'background',
      importProcessingStrictPolicy: true,
    });
    const client = new LLMClient(config);

    await expect(client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Process import batch' }],
      },
      'import_processing',
      { disableRetry: true },
    )).rejects.toBeInstanceOf(SensitiveImportRoutePolicyError);

    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it('passes OpenRouter ZDR and provider order options for import-processing requests', async () => {
    const config = makeConfig({
      importProcessingRouteMode: 'openrouter_zdr',
      openRouterProviderOrder: ['parasail', 'openai'],
    });
    const client = new LLMClient(config);

    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      model: 'openrouter:background/model',
      usage: { input: 11, output: 7 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Process import batch' }],
      },
      'import_processing',
      { disableRetry: true },
    );

    expect(response.content).toBe('ok');
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);

    const requestOptions = mocks.completeSimple.mock.calls[0][2] as Record<string, unknown>;
    expect(requestOptions.maxTokens).toBe(2048);
    expect(requestOptions.zdr).toBe(true);
    expect(requestOptions.provider).toEqual({ order: ['parasail', 'openai'] });
  });

  it('keeps local import-processing endpoint routes distinct from LiteLLM proxy routing', async () => {
    const previousApiKey = process.env.IMPORT_PROCESSING_LOCAL_API_KEY;
    process.env.IMPORT_PROCESSING_LOCAL_API_KEY = 'local-endpoint-key';

    try {
      const config = makeConfig({
        importProcessingRouteMode: 'local_endpoint',
        importProcessingLocalEndpointUrl: 'http://localhost:11434/v1',
        importProcessingLocalModel: 'qwen2.5-coder:14b',
      });
      const client = new LLMClient(config, {
        litellmBaseUrl: 'http://litellm.test/v1',
      });

      mocks.completeSimple.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        model: 'qwen2.5-coder:14b',
        usage: { input: 11, output: 7 },
        stopReason: 'stop',
      });

      const response = await client.complete(
        {
          systemPrompt: 'System',
          messages: [{ role: 'user', content: 'Process import batch locally' }],
        },
        'import_processing',
        { disableRetry: true },
      );

      expect(response.content).toBe('ok');
      expect(mocks.completeSimple).toHaveBeenCalledTimes(1);

      const model = mocks.completeSimple.mock.calls[0][0] as {
        baseUrl: string;
        provider: string;
        name: string;
      };
      const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };

      expect(model.baseUrl).toBe('http://localhost:11434/v1');
      expect(model.provider).toBe('local_endpoint');
      expect(model.name).toBe('qwen2.5-coder:14b (via local endpoint)');
      expect(requestOptions.apiKey).toBe('local-endpoint-key');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.IMPORT_PROCESSING_LOCAL_API_KEY;
      } else {
        process.env.IMPORT_PROCESSING_LOCAL_API_KEY = previousApiKey;
      }
    }
  });
});

describe('LLMClient provider observability', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoning: true,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockImplementation((provider: string) => [
      {
        id: 'z-ai/glm-5',
        provider,
        name: 'z-ai/glm-5',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
        reasoning: true,
      },
    ]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('attaches provider observability and reasoning to streaming responses', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    mocks.streamSimple.mockImplementation(async function* () {
      yield { type: 'thinking_delta', delta: 'trace' };
      yield { type: 'text_delta', delta: 'hello' };
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 7 },
          content: [{ type: 'text', text: 'hello' }],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
    }, { onFirstOutput });

    expect(response.reasoning).toBe('trace');
    expect(response.providerObservability).toMatchObject({
      routeKind: 'registered_model',
      requestedProvider: 'openrouter',
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_developer',
      },
      providerWireMessages: [
        { role: 'developer', source: 'system_prompt', content: 'System prompt' },
        { role: 'user', source: 'message', content: 'Hi' },
      ],
    });
    expect(onFirstOutput).toHaveBeenCalledTimes(1);
    expect(onFirstOutput).toHaveBeenCalledWith({
      kind: 'thinking',
      monotonicAtMs: expect.any(Number),
      timestampMs: expect.any(Number),
    });
  });

  it('records toolcall_start before delayed arguments and ignores later output events', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const partial = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'memory_lookup',
          arguments: {},
        },
      ],
    };
    mocks.streamSimple.mockImplementation(async function* () {
      nowMs = 2_000;
      yield { type: 'toolcall_start', contentIndex: 0, partial };
      nowMs = 9_000;
      yield { type: 'toolcall_start', contentIndex: 0, partial };
      yield {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"query":"hello"}',
        partial,
      };
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'call-1',
          name: 'memory_lookup',
          arguments: { query: 'hello' },
        },
        partial,
      };
      yield { type: 'text_delta', contentIndex: 1, delta: 'after tool', partial };
      yield { type: 'thinking_delta', contentIndex: 2, delta: 'after text', partial };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 7 },
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'memory_lookup',
              arguments: { query: 'hello' },
            },
            { type: 'text', text: 'after tool' },
            { type: 'thinking', thinking: 'after text' },
          ],
        },
      };
    });

    try {
      await client.stream({
        systemPrompt: 'System prompt',
        messages: [{ role: 'user', content: 'Look it up' }],
      }, { onFirstOutput });

      expect(onFirstOutput).toHaveBeenCalledTimes(1);
      expect(onFirstOutput).toHaveBeenCalledWith({
        kind: 'tool',
        monotonicAtMs: expect.any(Number),
        timestampMs: 2_000,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('records toolcall_start when a tool finishes with empty arguments', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    const partial = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-empty',
          name: 'memory_list',
          arguments: {},
        },
      ],
    };
    mocks.streamSimple.mockImplementation(async function* () {
      yield { type: 'toolcall_start', contentIndex: 0, partial };
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'call-empty',
          name: 'memory_list',
          arguments: {},
        },
        partial,
      };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 1 },
          content: [
            {
              type: 'toolCall',
              id: 'call-empty',
              name: 'memory_list',
              arguments: {},
            },
          ],
        },
      };
    });

    await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'List memories' }],
    }, { onFirstOutput });

    expect(onFirstOutput).toHaveBeenCalledTimes(1);
    expect(onFirstOutput).toHaveBeenCalledWith({
      kind: 'tool',
      monotonicAtMs: expect.any(Number),
      timestampMs: expect.any(Number),
    });
  });

  it('waits for a later tool identity when toolcall_start contains a placeholder', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const toolBlock = {
      type: 'toolCall',
      id: '',
      name: '',
      arguments: {},
    };
    const partial = { role: 'assistant', content: [toolBlock] };
    mocks.streamSimple.mockImplementation(async function* () {
      nowMs = 2_000;
      yield { type: 'toolcall_start', contentIndex: 0, partial };

      nowMs = 6_000;
      toolBlock.id = 'call-late';
      toolBlock.name = 'memory_lookup';
      yield { type: 'toolcall_delta', contentIndex: 0, delta: '', partial };

      nowMs = 9_000;
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: toolBlock,
        partial,
      };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 1 },
          content: [toolBlock],
        },
      };
    });

    try {
      await client.stream({
        systemPrompt: 'System prompt',
        messages: [{ role: 'user', content: 'Look it up' }],
      }, { onFirstOutput });

      expect(onFirstOutput).toHaveBeenCalledTimes(1);
      expect(onFirstOutput).toHaveBeenCalledWith({
        kind: 'tool',
        monotonicAtMs: expect.any(Number),
        timestampMs: 6_000,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('ignores a toolcall placeholder that never exposes a valid identity', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    const partial = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: '',
          name: '',
          arguments: {},
        },
      ],
    };
    mocks.streamSimple.mockImplementation(async function* () {
      yield { type: 'toolcall_start', contentIndex: 0, partial };
      yield { type: 'toolcall_delta', contentIndex: 0, delta: '', partial };
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 1 },
          content: [{ type: 'text', text: 'terminal content' }],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
    }, { onFirstOutput });

    expect(response.content).toBe('terminal content');
    expect(onFirstOutput).not.toHaveBeenCalled();
  });

  it('does not fabricate first output from a terminal-only completion event', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 7 },
          content: [{ type: 'text', text: 'terminal content' }],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
    }, { onFirstOutput });

    expect(response.content).toBe('terminal content');
    expect(onFirstOutput).not.toHaveBeenCalled();
  });

  it('attaches provider observability and reasoning to completion responses', async () => {
    const client = new LLMClient(makeConfig());
    mocks.completeSimple.mockResolvedValue({
      model: 'z-ai/glm-5',
      usage: { input: 13, output: 5 },
      stopReason: 'stop',
      content: [
        { type: 'thinking', thinking: 'chain' },
        { type: 'text', text: 'done' },
      ],
    });

    const response = await client.complete({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'summary', { disableRetry: true });

    expect(response.reasoning).toBe('chain');
    expect(response.providerObservability).toMatchObject({
      routeKind: 'registered_model',
      requestedProvider: 'openrouter',
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_developer',
      },
      providerWireMessages: [
        { role: 'developer', source: 'system_prompt', content: 'System prompt' },
        { role: 'user', source: 'message', content: 'Hi' },
      ],
    });
  });

  it('moves system context into provider system prompt observability instead of chat history', async () => {
    const client = new LLMClient(makeConfig());
    mocks.completeSimple.mockResolvedValue({
      model: 'z-ai/glm-5',
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
      content: [{ type: 'text', text: 'done' }],
    });

    const response = await client.complete({
      systemPrompt: 'System prompt',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'system', content: '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.' },
        { role: 'assistant', content: 'I can keep that in mind.' },
      ],
    }, 'summary', { disableRetry: true });

    expect(response.providerObservability).toMatchObject({
      providerWireMessages: [
        {
          role: 'developer',
          source: 'system_prompt',
          content: [
            'System prompt',
            '<session_context>',
            '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
            '</session_context>',
          ].join('\n\n'),
        },
        { role: 'user', source: 'message', content: 'Hi' },
        { role: 'assistant', source: 'message', content: expect.stringContaining('I can keep that in mind.') },
      ],
    });
    expect(response.providerObservability?.providerWireMessages.some(message => message.role === 'assistant'
      && message.content.includes('Queue a private follow-up reminder.'))).toBe(false);
  });

  it('preserves structured assistant and tool-result history when streaming through the transport path', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 17, output: 9 },
          content: [{ type: 'text', text: 'continued' }],
        },
      };
    });

    await client.stream({
      systemPrompt: 'System prompt',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'trace' },
            { type: 'text', text: 'hello' },
          ],
          api: 'openai-completions',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 11,
            output: 7,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 18,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 1000,
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup',
          content: [{ type: 'text', text: 'done' }],
          isError: false,
          timestamp: 1001,
        } as any,
        { role: 'user', content: 'continue' } as any,
      ],
    });

    const piContext = mocks.streamSimple.mock.calls[0]?.[1] as { messages: any[] };
    expect(piContext.messages[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'trace',
        },
        {
          type: 'text',
          text: 'hello',
        },
      ],
    });
    expect(piContext.messages[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'lookup',
      isError: false,
      content: [
        {
          type: 'text',
          text: 'done',
        },
      ],
    });
    expect(piContext.messages[2]).toMatchObject({
      role: 'user',
      content: 'continue',
    });
  });

  it('prefers final done-message tool call arguments over streamed toolcall_end payloads', async () => {
    const client = new LLMClient(makeConfig());
    const onFirstOutput = vi.fn();
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'toolcall_end',
        toolCall: {
          id: 'call-1',
          name: 'memory_write',
          arguments: {
            text: ': 561-09-3458\n+name: Marilyn Mack\nitemsOneDigit:  {',
          },
        },
      };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 17, output: 9 },
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'memory_write',
              arguments: {
                text: 'matrix-secret-2026-04-10T05-02-16-083Z',
                type: 'semantic',
                sensitivity: 'personal',
              },
            },
          ],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Store the secret' }],
    }, { onFirstOutput });

    expect(response.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'memory_write',
        input: {
          text: 'matrix-secret-2026-04-10T05-02-16-083Z',
          type: 'semantic',
          sensitivity: 'personal',
        },
      },
    ]);
    expect(onFirstOutput).toHaveBeenCalledWith({
      kind: 'tool',
      monotonicAtMs: expect.any(Number),
      timestampMs: expect.any(Number),
    });
  });

  it('drops duplicate streamed tool calls when the final done message contains only one tool call', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'toolcall_end',
        toolCall: {
          id: 'call-2',
          name: 'values_update',
          arguments: {
            version: 9,
            value: 'matrix-value-updated-1',
            context: 'live shakedown revision',
          },
        },
      };
      yield {
        type: 'toolcall_end',
        toolCall: {
          id: 'call-3',
          name: 'values_update',
          arguments: {
            version: 9,
            value: 'matrix-value-updated-1',
            context: 'live shakedown revision',
          },
        },
      };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 20, output: 11 },
          content: [
            {
              type: 'toolCall',
              id: 'call-2',
              name: 'values_update',
              arguments: {
                version: 9,
                value: 'matrix-value-updated-1',
                context: 'live shakedown revision',
              },
            },
          ],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Update the values journal' }],
    });

    expect(response.toolCalls).toEqual([
      {
        id: 'call-2',
        name: 'values_update',
        input: {
          version: 9,
          value: 'matrix-value-updated-1',
          context: 'live shakedown revision',
        },
      },
    ]);
  });
});

// mihm: a GLM upstream intermittently emits a tool call whose streamed arguments are a
// literal empty object; dispatching it fails validation for required-property tools (or,
// worse, silently defaults an optional action). The client re-runs the whole completion
// (bounded) when the result carries a corrupt-empty tool call against a required schema,
// and fails closed by returning the last response as-is once retries are exhausted.
describe('LLMClient empty-tool-args completion retry (mihm)', () => {
  const requiredActionTool = {
    name: 'journal',
    description: 'journal tool',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' } },
      required: ['action'],
    },
  };
  const optionalActionTool = {
    name: 'session',
    description: 'session tool',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' } },
    },
  };

  function doneWithToolCall(name: string, args: Record<string, unknown>) {
    return {
      type: 'done',
      reason: 'toolUse',
      message: {
        model: 'z-ai/glm-5',
        usage: { input: 17, output: 9 },
        content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
      },
    };
  }

  function streamYielding(...events: Array<Record<string, unknown>>) {
    return async function* () {
      for (const event of events) {
        yield event;
      }
    };
  }

  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoning: true,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockImplementation((provider: string) => [
      {
        id: 'z-ai/glm-5',
        provider,
        name: 'z-ai/glm-5',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
        reasoning: true,
      },
    ]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('retries and returns the recovered result when a later attempt yields valid args', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });

    mocks.streamSimple
      .mockImplementationOnce(streamYielding(doneWithToolCall('journal', {})))
      .mockImplementation(streamYielding(doneWithToolCall('journal', { action: 'list' })));

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'journal please' }],
      tools: [requiredActionTool],
    });

    expect(mocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(response.toolCalls).toEqual([
      { id: 'call-journal', name: 'journal', input: { action: 'list' } },
    ]);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ emptyArgsRetries: 1 }),
    }));
  });

  it('fails closed after exhausting retries: returns the corrupt-empty response as-is', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });

    mocks.streamSimple.mockImplementation(streamYielding(doneWithToolCall('journal', {})));

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'journal please' }],
      tools: [requiredActionTool],
    });

    // 1 initial attempt + 2 bounded retries, then the corrupt tool call is returned intact
    // so downstream AJV validation surfaces the error (never fabricated/dropped/defaulted).
    expect(mocks.streamSimple).toHaveBeenCalledTimes(3);
    expect(response.toolCalls).toEqual([
      { id: 'call-journal', name: 'journal', input: {} },
    ]);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ emptyArgsRetries: 2 }),
    }));
  });

  it('does not hide additional physical attempts when the caller owns retry sequencing', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });

    mocks.streamSimple.mockImplementation(streamYielding(doneWithToolCall('journal', {})));

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'journal please' }],
      tools: [requiredActionTool],
      accounting: {
        logicalCallId: 'llm:caller-owned-empty-tool-args',
        attempt: 4,
        retryOwner: 'caller',
      },
    });

    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(response.toolCalls).toEqual([
      { id: 'call-journal', name: 'journal', input: {} },
    ]);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      logicalCallId: 'llm:caller-owned-empty-tool-args',
      attempt: 4,
      metadata: expect.objectContaining({ emptyArgsRetries: 0 }),
    }));
  });

  it('does not retry when the tool schema accepts empty arguments', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });

    mocks.streamSimple.mockImplementation(streamYielding(doneWithToolCall('session', {})));

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'session status' }],
      tools: [optionalActionTool],
    });

    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(response.toolCalls).toEqual([
      { id: 'call-session', name: 'session', input: {} },
    ]);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ emptyArgsRetries: 0 }),
    }));
  });

  it('does not retry a tool call that already carries valid non-empty args', async () => {
    const client = new LLMClient(makeConfig());

    mocks.streamSimple.mockImplementation(streamYielding(doneWithToolCall('journal', { action: 'list' })));

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'journal please' }],
      tools: [requiredActionTool],
    });

    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(response.toolCalls).toEqual([
      { id: 'call-journal', name: 'journal', input: { action: 'list' } },
    ]);
  });

  it('does not retry args that pi-ai 0.73 repaired into a valid non-empty object', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });

    mocks.streamSimple.mockImplementation(streamYielding(doneWithToolCall('journal', {
      action: 'write',
      note: 'line one\nline two with invalid \\q escape',
    })));

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'journal please' }],
      tools: [requiredActionTool],
    });

    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(response.toolCalls).toEqual([
      {
        id: 'call-journal',
        name: 'journal',
        input: { action: 'write', note: 'line one\nline two with invalid \\q escape' },
      },
    ]);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ emptyArgsRetries: 0 }),
    }));
  });
});

describe('LLMClient prompt caching', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoning: true,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('routes prompt-cached completions through openai-responses and exposes engaged observability', async () => {
    const client = new LLMClient(makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'summary-cache',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'summary/cached',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
              supportsPromptCaching: true,
              promptCacheStrategy: 'openai_responses',
            },
            tuning: {
              maxOutputTokens: 4096,
              promptCacheRetention: 'long',
              promptCacheScope: 'channel',
            },
          },
        ],
      },
    }), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'cached ok' }],
      model: 'summary/cached',
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System prompt',
        messages: [{ role: 'user', content: 'Hi' }],
        correlation: {
          companionId: 'companion-cache-1',
          requestId: 'req-cache-1',
          channelId: 'discord:cache-channel',
          callType: 'summary',
          originType: 'summary',
          originStage: 'agent.summary',
          purpose: 'summary',
        },
      },
      'summary',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; api: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { cacheRetention?: string; sessionId?: string };
    expect(model.id).toBe('openrouter/summary/cached');
    expect(model.api).toBe('openai-responses');
    expect(requestOptions).toMatchObject({
      cacheRetention: 'long',
      sessionId: providerCacheSessionId('companion-cache-1', 'discord:cache-channel'),
    });
    expect(response.providerObservability).toMatchObject({
      backendApi: 'openai-responses',
      promptCaching: {
        configured: true,
        engaged: true,
        strategy: 'openai_responses',
        retention: 'long',
        scope: 'channel',
        sessionId: providerCacheSessionId('companion-cache-1', 'discord:cache-channel'),
      },
    });
  });

  it('fails closed on cache engagement when a channel-scoped cache key cannot be derived', async () => {
    const client = new LLMClient(makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'summary-cache',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'summary/cached',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
              supportsPromptCaching: true,
              promptCacheStrategy: 'openai_responses',
            },
            tuning: {
              maxOutputTokens: 4096,
              promptCacheRetention: 'long',
              promptCacheScope: 'channel',
            },
          },
        ],
      },
    }), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'cached ok' }],
      model: 'summary/cached',
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System prompt',
        messages: [{ role: 'user', content: 'Hi' }],
        correlation: {
          companionId: 'companion-cache-2',
          requestId: 'req-cache-2',
          callType: 'summary',
          originType: 'summary',
          originStage: 'agent.summary',
          purpose: 'summary',
        },
      },
      'summary',
      { disableRetry: true },
    );

    const model = mocks.completeSimple.mock.calls[0][0] as { api: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { cacheRetention?: string; sessionId?: string };
    expect(model.api).toBe('openai-responses');
    expect(requestOptions.cacheRetention).toBeUndefined();
    expect(requestOptions.sessionId).toBeUndefined();
    expect(response.providerObservability).toMatchObject({
      promptCaching: {
        configured: true,
        engaged: false,
        strategy: 'openai_responses',
        retention: 'long',
        scope: 'channel',
        reason: 'missing_channel_id',
      },
    });
  });
});

describe('LLMClient model-agnostic prompt caching (E2.4)', () => {
  const STATIC_TEXT = 'STATIC IDENTITY.';
  const SESSION_TEXT = 'SESSION NOTES.';
  const VOLATILE_TEXT = 'TURN CONTEXT.';
  const SYSTEM_PROMPT = [STATIC_TEXT, SESSION_TEXT, VOLATILE_TEXT].join('\n\n');
  const STATIC_PREFIX = STATIC_TEXT;
  const SESSION_STABLE_PREFIX = `${STATIC_TEXT}\n\n${SESSION_TEXT}`;

  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  function makeRegistry(model: string): CanonicalModelRegistry {
    return {
      schemaVersion: 1,
      promptCaching: { enabled: true, retention: 'short', scope: 'channel' },
      models: [
        {
          id: 'summary-primary',
          rank: 10,
          identity: {
            provider: 'openrouter',
            model,
            source: { type: 'openrouter' },
          },
          purposes: [{ purpose: 'summary', primary: true }],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
      ],
    };
  }

  function makeBoundaries() {
    const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    return {
      staticPrefixChars: STATIC_PREFIX.length,
      staticPrefixHash: hash(STATIC_PREFIX),
      sessionStablePrefixChars: SESSION_STABLE_PREFIX.length,
      sessionStablePrefixHash: hash(SESSION_STABLE_PREFIX),
    };
  }

  async function runComplete(model: string, options: { boundaries?: boolean; enabled?: boolean } = {}) {
    const registry = makeRegistry(model);
    if (options.enabled === false) {
      delete (registry as { promptCaching?: unknown }).promptCaching;
    }
    const client = new LLMClient(makeConfig({ modelRegistry: registry }), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      model,
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
    });
    const response = await client.complete(
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: 'Hi' }],
        ...(options.boundaries === false ? {} : { promptCacheBoundaries: makeBoundaries() }),
        correlation: {
          companionId: 'companion-e24-1',
          requestId: 'req-e24-1',
          channelId: 'discord:e24-channel',
          callType: 'summary',
          originType: 'summary',
          originStage: 'agent.summary',
          purpose: 'summary',
        },
      },
      'summary',
      { disableRetry: true },
    );
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as {
      cacheRetention?: string;
      sessionId?: string;
      onPayload?: (payload: unknown, model: unknown) => unknown;
    };
    return { response, requestOptions };
  }

  it('applies cache_control passthrough for OpenRouter anthropic targets at the plan boundaries (AC2)', async () => {
    const { response, requestOptions } = await runComplete('anthropic/claude-sonnet-4.5');

    expect(requestOptions.cacheRetention).toBe('short');
    expect(requestOptions.sessionId).toBe(providerCacheSessionId('companion-e24-1', 'discord:e24-channel'));
    expect(typeof requestOptions.onPayload).toBe('function');

    // Exercise the transformer against the completions payload shape pi-ai builds.
    const payload = {
      model: 'openrouter/anthropic/claude-sonnet-4.5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Hi' },
      ],
    };
    const transformed = await requestOptions.onPayload!(payload, { provider: 'openrouter' }) as typeof payload;
    expect(transformed.messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: STATIC_PREFIX, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `\n\n${SESSION_TEXT}`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `\n\n${VOLATILE_TEXT}` },
      ],
    });
    expect(transformed.messages[1]).toEqual({ role: 'user', content: 'Hi' });

    expect(response.providerObservability).toMatchObject({
      promptCaching: {
        configured: true,
        engaged: true,
        mechanism: 'openrouter_cache_control_passthrough',
        retention: 'short',
        scope: 'channel',
        sessionId: providerCacheSessionId('companion-e24-1', 'discord:e24-channel'),
        boundaries: {
          staticPrefixChars: STATIC_PREFIX.length,
          sessionStablePrefixChars: SESSION_STABLE_PREFIX.length,
        },
        appliedBreakpoints: 2,
      },
    });
  });

  it('sends only supported passthrough params for open models — no payload transformer (AC2)', async () => {
    const { response, requestOptions } = await runComplete('z-ai/glm-5');

    expect(requestOptions.cacheRetention).toBe('short');
    expect(requestOptions.sessionId).toBe(providerCacheSessionId('companion-e24-1', 'discord:e24-channel'));
    // Wire capture (bead hgw3-80f6) always attaches a pass-through onPayload, but
    // with no cache transformer chained it leaves the payload byte-identical.
    expect(typeof requestOptions.onPayload).toBe('function');
    const openPayload = { model: 'z-ai/glm-5', messages: [{ role: 'user', content: 'Hi' }] };
    expect(await requestOptions.onPayload!(openPayload, { provider: 'openrouter' })).toBeUndefined();
    expect(response.providerObservability).toMatchObject({
      promptCaching: {
        configured: true,
        engaged: true,
        mechanism: 'implicit_prefix',
        retention: 'short',
        scope: 'channel',
      },
    });
  });

  it('keeps the wire byte-identical when the flag is off (default)', async () => {
    const { response, requestOptions } = await runComplete('anthropic/claude-sonnet-4.5', { enabled: false });

    expect(requestOptions.cacheRetention).toBeUndefined();
    expect(requestOptions.sessionId).toBeUndefined();
    // Wire capture (bead hgw3-80f6) attaches a pass-through onPayload even with
    // the cache flag off; it captures without altering the byte-identical wire.
    expect(typeof requestOptions.onPayload).toBe('function');
    const flagOffPayload = { model: 'x', messages: [{ role: 'user', content: 'Hi' }] };
    expect(await requestOptions.onPayload!(flagOffPayload, { provider: 'openrouter' })).toBeUndefined();
    expect(response.providerObservability).toMatchObject({
      promptCaching: {
        configured: false,
        engaged: false,
      },
    });
  });

  it('captures the true wire body (tools counted once) onto providerObservability (bead hgw3-80f6)', async () => {
    const model = 'anthropic/claude-sonnet-4.5';
    const client = new LLMClient(makeConfig({ modelRegistry: makeRegistry(model) }), 'http://litellm.test/v1');
    const wireBody = {
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'search', input_schema: { type: 'object' } },
        { name: 'recall', input_schema: { type: 'object' } },
      ],
    };
    mocks.completeSimple.mockImplementation(async (_model: unknown, _ctx: unknown, opts: {
      onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
    }) => {
      // pi-ai invokes onPayload with the outbound body just before sending.
      await opts.onPayload?.(wireBody, { id: model, api: 'anthropic-messages' });
      return { content: [{ type: 'text', text: 'ok' }], model, usage: { input: 9, output: 4 }, stopReason: 'stop' };
    });
    const response = await client.complete(
      { systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'Hi' }] },
      'summary',
      { disableRetry: true },
    );
    const captured = response.providerObservability?.capturedWirePayload;
    expect(captured).toBeDefined();
    expect(captured?.toolCount).toBe(2);
    expect(captured?.byteLength).toBe(Buffer.byteLength(JSON.stringify(wireBody), 'utf8'));
    expect(JSON.stringify(captured?.body)).toBe(JSON.stringify(wireBody));
  });

  it('skips breakpoints (but keeps retention) when no boundaries accompany the request', async () => {
    const { response, requestOptions } = await runComplete('anthropic/claude-sonnet-4.5', { boundaries: false });

    expect(requestOptions.cacheRetention).toBe('short');
    // No boundaries → no cache transformer chained; wire capture (bead hgw3-80f6)
    // still attaches a pass-through onPayload that leaves the payload unchanged.
    expect(typeof requestOptions.onPayload).toBe('function');
    const noBoundaryPayload = { model: 'x', messages: [{ role: 'user', content: 'Hi' }] };
    expect(await requestOptions.onPayload!(noBoundaryPayload, { provider: 'openrouter' })).toBeUndefined();
    expect(response.providerObservability).toMatchObject({
      promptCaching: {
        configured: true,
        engaged: true,
        mechanism: 'openrouter_cache_control_passthrough',
      },
    });
    const promptCaching = (response.providerObservability as { promptCaching: Record<string, unknown> }).promptCaching;
    expect(promptCaching.boundaries).toBeUndefined();
    expect(promptCaching.appliedBreakpoints).toBeUndefined();
  });
});
describe('LLMClient completion model hints', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('prioritizes explicit model hints for completion routing', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'hinted response' }],
      model: 'anthropic/claude-3.7-sonnet',
      usage: { input: 18, output: 9 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: { model: 'anthropic/claude-3.7-sonnet' },
      },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string };
    expect(model.id).toBe('openrouter/anthropic/claude-3.7-sonnet');
  });

  it('honors max-token model hints even without explicit model overrides', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'token cap response' }],
      model: 'z-ai/glm-5',
      usage: { input: 10, output: 7 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: { maxTokens: 77 },
      },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(77);
  });

  it('caps hinted-model output at the registry entry maxOutputTokens', async () => {
    const config = makeConfig();
    config.modelRegistry!.models.push({
      id: 'claude-opus-3',
      rank: 200,
      identity: {
        provider: 'anthropic',
        model: 'anthropic/claude-3-opus-20240229',
        source: { type: 'litellm' },
      },
      purposes: [{ purpose: 'moa', primary: false }],
      capabilities: { maxOutputTokens: 4096, contextWindow: 200_000 },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'capped response' }],
      model: 'anthropic/claude-3-opus-20240229',
      usage: { input: 12, output: 4 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: '',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: {
          provider: 'anthropic',
          model: 'anthropic/claude-3-opus-20240229',
          pin: true,
        },
      },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(4096);
  });

  it('fails closed when modelHint.model references a legacy slot key', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'should not run' }],
      model: 'z-ai/glm-5',
      usage: { input: 5, output: 2 },
      stopReason: 'stop',
    });

    await expect(client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: { model: 'chat' },
      },
    )).rejects.toBeInstanceOf(LegacyModelHintError);

    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it('uses provider-configured LiteLLM routing when runtime options do not override it', async () => {
    process.env.CUSTOM_LITELLM_KEY = 'provider-key';
    const client = new LLMClient(makeConfig({
      litellmBaseUrl: 'http://provider-config.test/v1',
      litellmApiKeyRef: envCredential('CUSTOM_LITELLM_KEY'),
    }));
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider-config response' }],
      model: 'z-ai/glm-5',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'chat',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { baseUrl: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };
    expect(model.baseUrl).toBe('http://provider-config.test/v1');
    expect(requestOptions.apiKey).toBe('provider-key');
    delete process.env.CUSTOM_LITELLM_KEY;
  });

  it('uses the credential vault for provider-configured LiteLLM routing', async () => {
    const client = new LLMClient(makeConfig({
      litellmBaseUrl: 'http://provider-config.test/v1',
      litellmApiKeyRef: envCredential('CUSTOM_LITELLM_KEY'),
      credentialVault: createEnvCredentialVault({
        CUSTOM_LITELLM_KEY: 'vault-provider-key',
      }),
    }));
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider-config response' }],
      model: 'z-ai/glm-5',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'chat',
      { disableRetry: true },
    );

    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };
    expect(requestOptions.apiKey).toBe('vault-provider-key');
  });

  it('normalizes openrouter model ids for LiteLLM-backed routing', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider-config response' }],
      model: 'openrouter/z-ai/glm-5',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'summary',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string };
    expect(model.id).toBe('openrouter/z-ai/glm-5');
  });

  it('preserves OpenRouter model ids for direct OpenRouter endpoint routing', async () => {
    const client = new LLMClient(makeConfig({
      openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
      credentialVault: createEnvCredentialVault({
        OPENROUTER_API_KEY: 'vault-openrouter-key',
      }),
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chat-direct-openrouter',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'moonshotai/kimi-k2.6',
              source: {
                type: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
              },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 262_144,
            },
            tuning: {
              maxOutputTokens: 8192,
              contextWindow: 262_144,
            },
          },
        ],
      },
    }));
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'direct openrouter response' }],
      model: 'moonshotai/kimi-k2.6',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'summary',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; baseUrl: string; provider: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };
    expect(model.id).toBe('moonshotai/kimi-k2.6');
    expect(model.provider).toBe('openrouter');
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(requestOptions.apiKey).toBe('vault-openrouter-key');
  });

  it('pins explicit model hints to a single candidate when requested', () => {
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        models: [
          ...baseRegistry.models,
          {
            id: 'chat-fallback',
            rank: 500,
            identity: {
              provider: 'openrouter',
              model: 'moonshotai/kimi-k2.5',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
          },
        ],
      },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');

    const candidates = (client as any).resolveCandidates('chat', {
      model: 'moonshotai/kimi-k2.5',
      provider: 'openrouter',
      pin: true,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
      }),
    ]);
  });
});

describe('LLMClient model knob plumbing', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('applies configured registry tuning knobs to stream request options (smoke)', async () => {
    const config = makeConfig();
    const registry = config.modelRegistry!;
    config.modelRegistry = {
      ...registry,
      models: registry.models.map((entry) => (
        entry.id === 'chat'
          ? {
            ...entry,
            tuning: {
              ...(entry.tuning ?? {}),
              maxOutputTokens: 1337,
              contextWindow: 222_000,
              thinkingEnabled: true,
              thinkingEffort: 'high',
              temperature: 0.42,
              topP: 0.88,
              topK: 24,
              frequencyPenalty: -0.15,
              repetitionPenalty: 1.07,
            },
          }
          : entry
      )),
    };
    const client = new LLMClient(config, 'http://litellm.test/v1');

    mocks.streamSimple.mockImplementation(() => (async function* streamOk() {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 9, output: 5 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    })());

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response.content).toBe('ok');
    const requestOptions = mocks.streamSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(requestOptions).toMatchObject({
      maxTokens: 1337,
      contextWindow: 222_000,
      reasoning: 'high',
      temperature: 0.42,
      topP: 0.88,
      topK: 24,
      frequencyPenalty: -0.15,
      repetitionPenalty: 1.07,
    });
  });

  it('filters unsupported sampling knobs for non-passthrough providers deterministically', async () => {
    const config = makeConfig();
    const registry = config.modelRegistry!;
    config.modelRegistry = {
      ...registry,
      models: registry.models.map((entry) => (
        entry.id === 'chat'
          ? {
            ...entry,
            identity: {
              ...entry.identity,
              provider: 'anthropic',
              model: 'claude-sonnet-4-5',
              source: { type: 'anthropic' },
            },
            tuning: {
              ...(entry.tuning ?? {}),
              maxOutputTokens: 1024,
              thinkingEnabled: true,
              thinkingEffort: 'medium',
              temperature: 0.31,
              topP: 0.9,
              topK: 40,
              frequencyPenalty: 0.2,
              repetitionPenalty: 1.1,
            },
          }
          : entry
      )),
    };
    mocks.getProviders.mockReturnValue(['openrouter', 'anthropic']);
    mocks.getModels.mockImplementation((provider: string) => (
      provider === 'anthropic'
        ? [{
          id: 'claude-sonnet-4-5',
          provider: 'anthropic',
          name: 'claude-sonnet-4-5',
          api: 'anthropic-messages',
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        }]
        : []
    ));

    const client = new LLMClient(config);

    mocks.streamSimple.mockImplementation(() => (async function* streamOk() {
      yield {
        type: 'done',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input: 7, output: 4 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    })());

    await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const requestOptions = mocks.streamSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(requestOptions.maxTokens).toBe(1024);
    expect(requestOptions.temperature).toBe(0.31);
    expect(requestOptions.reasoning).toBe('medium');
    expect(requestOptions).not.toHaveProperty('topP');
    expect(requestOptions).not.toHaveProperty('topK');
    expect(requestOptions).not.toHaveProperty('frequencyPenalty');
    expect(requestOptions).not.toHaveProperty('repetitionPenalty');
  });

  it('maps model-hint thinking disable to no reasoning option even when effort is set', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'z-ai/glm-5',
      usage: { input: 5, output: 3 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: {
          thinkingEnabled: false,
          thinkingEffort: 'high',
          maxTokens: 99,
        },
      },
    );

    const requestOptions = mocks.completeSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(requestOptions.maxTokens).toBe(99);
    expect(requestOptions).not.toHaveProperty('reasoning');
  });
});

describe('LLMClient context routing', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('routes legacy context completions to longContext primary before fallbacks', async () => {
    const client = new LLMClient(makeConfig({
      modelRoster: {
        chat: {
          model: 'chat-model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
        background: {
          model: 'background-model',
          provider: 'openrouter',
          maxTokens: 2048,
          contextWindow: 64_000,
        },
        longContext: {
          model: 'long-context-model',
          provider: 'openrouter',
          maxTokens: 8192,
          contextWindow: 256_000,
        },
      },
    }), 'http://litellm.test/v1');

    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'context response' }],
      model: 'long-context-model',
      usage: { input: 14, output: 7 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Use long context' }],
      },
      'context',
      { disableRetry: true },
    );

    expect(response.content).toBe('context response');
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { id: string };
    expect(model.id).toBe('long-context-model');
  });
});

describe('LLMClient eligibility gate', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('denies background completions when required capability token is missing', async () => {
    const gate = createEligibilityGate(() => ({
      getTier: () => 'custom',
      getGrantedTokens: () => new Set(),
      has: () => false,
    }));
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      eligibilityGate: gate,
    });

    await expect(client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Process memories' }],
      },
      'background',
      { disableRetry: true },
    )).rejects.toBeInstanceOf(EligibilityDeniedError);

    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });
});

describe('LLMClient correlation metadata', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('infers stable call types from purpose and channel', () => {
    expect(inferCallType('chat')).toBe('chat');
    expect(inferCallType('reasoning')).toBe('tool');
    expect(inferCallType('summary')).toBe('summary');
    expect(inferCallType('memory')).toBe('memory');
    expect(inferCallType('extraction')).toBe('memory');
    expect(inferCallType('context')).toBe('background');
    expect(inferCallType('background', 'internal:heartbeat')).toBe('scheduled');
    expect(inferCallType('background', 'discord:general')).toBe('background');
  });

  it('passes normalized correlation metadata to fallback execution', async () => {
    const runSpy = vi.spyOn(FallbackRunner.prototype, 'run');
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      model: 'z-ai/glm-5',
      usage: { input: 2, output: 1 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
        correlation: {
          turnId: 'turn-1',
          requestId: 'req-1',
          channelId: 'internal:heartbeat',
          callType: 'scheduled',
          originType: 'scheduled',
          originStage: 'health.check',
          toolCallId: 'tool-call-1',
          purpose: 'health.check',
        },
      },
      'background',
      { disableRetry: true },
    );

    const correlation = runSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(correlation).toMatchObject({
      turnId: 'turn-1',
      requestId: 'req-1',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      originType: 'scheduled',
      originStage: 'health.check',
      toolCallId: 'tool-call-1',
      purpose: 'health.check',
    });

    runSpy.mockRestore();
  });

  it('routes memory completions through the dedicated memory-purpose candidate', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chat',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'chat/model',
              source: { type: 'openrouter' },
            },
            purposes: [
              { purpose: 'chat', primary: true },
              { purpose: 'summary', primary: true },
              { purpose: 'moa', primary: true },
            ],
            capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 4096 },
          },
          {
            id: 'background',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 2048 },
          },
          {
            id: 'memory',
            rank: 15,
            identity: {
              provider: 'openrouter',
              model: 'memory/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'memory', primary: true }],
            capabilities: { maxOutputTokens: 1536, contextWindow: 96_000 },
            tuning: { maxOutputTokens: 1536, contextWindow: 96_000 },
          },
          {
            id: 'extraction',
            rank: 30,
            identity: {
              provider: 'openrouter',
              model: 'extract/model',
              source: { type: 'openrouter' },
            },
            purposes: [
              { purpose: 'extraction', primary: true },
              { purpose: 'import_processing', primary: true },
            ],
            capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 1024 },
          },
          {
            id: 'reasoning',
            rank: 40,
            identity: {
              provider: 'openrouter',
              model: 'reason/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'reasoning', primary: true }],
            capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 2048 },
          },
          {
            id: 'long-context',
            rank: 50,
            identity: {
              provider: 'openrouter',
              model: 'long/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'longContext', primary: true }],
            capabilities: { maxOutputTokens: 4096, contextWindow: 256_000 },
            tuning: { maxOutputTokens: 4096, contextWindow: 256_000 },
          },
          {
            id: 'vision',
            rank: 60,
            identity: {
              provider: 'openrouter',
              model: 'vision/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 4096 },
          },
        ],
      },
    });
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'memory ok' }],
      model: 'openrouter:memory/model',
      usage: { input: 8, output: 5 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Refresh context' }],
        correlation: {
          channelId: 'internal:heartbeat',
        },
      },
      'memory',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string };
    expect(model.id).toBe('openrouter/memory/model');
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(1536);

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      attribution: expect.objectContaining({
        purpose: 'memory',
        service: 'memory',
        process: 'memory',
      }),
      inputTokens: 8,
      outputTokens: 5,
    }));
  });

  it('preserves image input when a background completion is hinted through litellm to a vision-capable routed model', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'background',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 1024 },
          },
          {
            id: 'vision',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openrouter/google/gemini-3-flash-preview',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 1_048_576,
              supportsVision: true,
            },
            tuning: { maxOutputTokens: 4096 },
          },
        ],
      },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'cat' }],
      model: 'openrouter/google/gemini-3-flash-preview',
      usage: { input: 12, output: 3 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', data: 'YmFzZTY0', mimeType: 'image/jpeg' },
          ],
        }] as any,
        modelHint: {
          model: 'openrouter/google/gemini-3-flash-preview',
          provider: 'litellm',
          maxTokens: 4096,
        },
      } as any,
      'background',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; input: string[] };
    expect(model.id).toBe('openrouter/google/gemini-3-flash-preview');
    expect(model.input).toContain('image');
  });

  it('routes vision completions through the configured vision-purpose candidate', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'background',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 1024 },
          },
          {
            id: 'vision',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'vision/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 1_048_576,
              supportsVision: true,
            },
            tuning: { maxOutputTokens: 4096 },
          },
        ],
      },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'visible image summary' }],
      model: 'openrouter/vision/model',
      usage: { input: 12, output: 3 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Describe this image.' }],
      },
      'vision',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; input: string[] };
    expect(model.id).toBe('openrouter/vision/model');
    expect(model.input).toContain('image');
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(1024);
  });
});

describe('LLMClient model budget gates and usage metering', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('cost-accounts companion-private calls without persisting source correlation', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'private result' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 25, output: 5, cost: 0.123 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Private background work' }],
      },
      'background',
      {
        disableRetry: true,
        correlation: {
          ...COMPANION_PRIVATE_BACKGROUND_TELEMETRY,
          turnId: 'source-turn',
          requestId: 'source-request',
          channelId: 'source-channel',
        },
      },
    );

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    const event = usageRecorder.recordUsageEvent.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      telemetryVisibility: 'companion_private',
      inputTokens: 25,
      outputTokens: 5,
      providerCostUsd: 0.123,
    });
    expect(event?.logicalCallId).not.toContain('source-request');
    expect(event).not.toHaveProperty('turnId');
    expect(event).not.toHaveProperty('requestId');
    expect(event).not.toHaveProperty('channelId');
  });

  it('uses propagated logical identity and disables nested retries when the caller owns retry sequencing', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 3, retryBaseDelayMs: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.streamSimple.mockImplementation(async function* () {
      throw new Error('503 provider unavailable');
    });

    await expect(client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Stream this' }],
      modelHint: {
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        pin: true,
      },
      accounting: {
        logicalCallId: 'llm:caller-operation',
        attempt: 7,
        retryOwner: 'caller',
      },
    })).rejects.toThrow('503 provider unavailable');

    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      logicalCallId: 'llm:caller-operation',
      attempt: 7,
      status: 'failure',
    }));
  });

  it('records adapter fallback attempts under one logical call through the production gateway stack', async () => {
    const config = makeConfig({
      litellmBaseUrl: 'http://litellm.test/v1',
      retryMaxAttempts: 0,
      retryBaseDelayMs: 0,
    });
    const baseRegistry = config.modelRegistry!;
    config.modelRegistry = {
      ...baseRegistry,
      models: [
        ...baseRegistry.models,
        {
          id: 'chat-fallback',
          rank: 20,
          identity: {
            provider: 'openrouter',
            model: 'moonshotai/kimi-k2.5',
            source: { type: 'openrouter' },
          },
          purposes: [{ purpose: 'chat', primary: false }],
          capabilities: { maxOutputTokens: 2_048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2_048, contextWindow: 128_000 },
        },
      ],
    };
    const usageEvents: ModelUsageEventInput[] = [];
    const gatewayLlmClient = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder: {
        async recordUsageEvent(event) {
          usageEvents.push(event);
        },
      },
    });

    let providerAttempt = 0;
    mocks.streamSimple.mockImplementation(async function* (_model: unknown) {
      providerAttempt += 1;
      if (providerAttempt === 1) {
        throw new Error('403 primary unavailable');
      }
      yield {
        type: 'done',
        message: {
          model: 'moonshotai/kimi-k2.5',
          usage: { input: 7, output: 4, totalTokens: 11 },
          content: [{ type: 'text', text: 'Recovered on fallback.' }],
        },
        reason: 'stop',
      };
    });

    let receiveFromGateway: ((message: unknown) => void) | undefined;
    const serverRpc = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient(async request => {
        receiveFromGateway?.(request);
      }),
    );
    const connection: GatewayRpcConnection = Object.assign(new EventEmitter(), {
      send(message: unknown): boolean {
        void serverRpc.receiveAndSend(message);
        return true;
      },
      onMessage(handler: (message: unknown) => void): void {
        receiveFromGateway = handler;
      },
      destroy(): void {},
      get destroyed(): boolean {
        return false;
      },
    });
    const gatewayClient = new GatewayClient(connection, 2, { keepaliveIntervalMs: 60_000 });
    const runtime: GatewayMethodRuntime = {
      target: serverRpc,
      llmProvider: gatewayLlmClient,
      embeddingService: {
        dims: 2,
        async embed() {
          return new Float32Array([0, 0]);
        },
        async embedBatch() {
          return [];
        },
      },
      modelDiscovery: { getAvailableModels: vi.fn(async () => []), invalidateCache: vi.fn() },
      discordAdapter: {
        id: 'test',
        outbound: {
          textChunkLimit: 2_000,
          async sendText() {},
        },
      },
      policyConfig: { workspacePath: process.cwd() },
      workspacePath: process.cwd(),
      sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test' } },
      approvalBoundary: {
        listPendingConfirmations: () => [],
        listConfirmationHistory: () => [],
        resolveConfirmation: async () => ({
          id: 'noop',
          status: 'not_found',
          message: 'noop',
          executed: false,
        }),
        gate: options => options.handler,
      },
      notifyRequester(method, params) {
        receiveFromGateway?.({ jsonrpc: '2.0', method, params });
      },
      listPendingConfirmations: () => [],
      listConfirmationHistory: () => [],
      resolveConfirmation: async () => ({
        id: 'noop',
        status: 'not_found',
        message: 'noop',
        executed: false,
      }),
      sendNtfy: async () => ({ status: 'debounced', topic: 'test' }),
      getRuntimeHealth: () => ({ checkedAt: 0, services: [] }),
      nextStreamRequestId: () => 'gateway-stream-1',
      audited: (_method, handler) => handler,
    };
    registerLLMMethods(runtime);

    try {
      const streamFn = createSubstrateStreamFn(config, { transport: gatewayClient });
      const context: Context = {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
      };
      const stream = await streamFn(resolveModel(config, 'chat'), context, {});
      for await (const _event of stream as AsyncIterable<unknown>) {
        // Drain the public stream to completion.
      }
    } finally {
      gatewayClient.destroy();
    }

    expect(mocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents).toMatchObject([
      {
        logicalCallId: expect.stringMatching(/^llm:/),
        attempt: 1,
        status: 'failure',
        provider: 'openrouter',
        model: 'z-ai/glm-5',
      },
      {
        logicalCallId: expect.stringMatching(/^llm:/),
        attempt: 2,
        status: 'success',
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
      },
    ]);
    expect(usageEvents[0]?.logicalCallId).toBe(usageEvents[1]?.logicalCallId);
  });

  it('keeps pi-ai 0.73 streaming usage buckets stable in provider cost telemetry', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ companionId: 'gateway-default' }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });

    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: {
            input: 176,
            output: 2,
            cacheRead: 7,
            cacheWrite: 11,
            totalTokens: 196,
            cost: 0.95,
            cost_details: { upstream_inference_cost: 19 },
          },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    });

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        companionId: 'companion-a',
        sessionId: 'session-openrouter-usage-1',
        turnId: 'turn-openrouter-usage-1',
        requestId: 'req-openrouter-usage-1',
        channelId: 'channel-openrouter-usage-1',
        channelType: 'api',
        callType: 'chat',
        conversationId: 'conversation-openrouter-usage-1',
        rootInitiationId: 'root-openrouter-usage-1',
      },
    });

    expect(response).toMatchObject({
      inputTokens: 176,
      outputTokens: 2,
      providerObservability: {
        routeKind: 'configured_litellm_proxy',
        backendBaseUrl: 'http://litellm.test/v1',
      },
      usageDetails: {
        input: 176,
        output: 2,
        cacheRead: 7,
        cacheWrite: 11,
        totalTokens: 196,
        cost: { total: 0.95 },
      },
    });
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 176,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      totalTokens: 196,
      attribution: expect.objectContaining({
        companionId: 'companion-a',
        sessionId: 'session-openrouter-usage-1',
        channelId: 'channel-openrouter-usage-1',
        channelType: 'api',
        callType: 'chat',
        conversationId: 'conversation-openrouter-usage-1',
        rootInitiationId: 'root-openrouter-usage-1',
      }),
      providerCostUsd: 0.95,
      costSource: 'provider',
      metadata: expect.objectContaining({
        routeKind: 'configured_litellm_proxy',
        backendProvider: 'litellm',
        backendBaseUrl: 'http://litellm.test/v1',
        providerCost: { total: 0.95, currency: 'USD' },
        rawUsage: expect.objectContaining({
          cost: 0.95,
          cost_details: { upstream_inference_cost: 19 },
        }),
      }),
    }));
  });

  it('persists the charged provider surface without caller-supplied correlation metadata', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ companionId: 'companion-a' }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 2, output: 1, totalTokens: 3 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    });

    await runWithChargeContext({
      chargePolicy: makeModelChargePolicy(),
      lane: 'interactive',
      runId: 'charged-root',
    }, async () => await runWithChargedSurface('externalModelConsult', {
      details: { source: 'sandbox_llm_query' },
    }, async () => {
      await client.stream({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello there' }],
        correlation: { callType: 'tool', purpose: 'repl.sandbox.llm_query' },
      });
    }));

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      attribution: expect.objectContaining({
        chargeLane: 'interactive',
        chargeSurface: 'externalModelConsult',
        chargeEventId: expect.any(String),
        chargeRunId: 'charged-root',
        chargeRootRunId: 'charged-root',
      }),
    }));
  });

  it('normalizes raw OpenRouter streaming usage without double-counting reasoning tokens or cache writes', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });

    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: {
            prompt_tokens: 194,
            completion_tokens: 2,
            completion_tokens_details: { reasoning_tokens: 1 },
            prompt_tokens_details: {
              cached_tokens: 18,
              cache_write_tokens: 11,
            },
            total_tokens: 196,
            cost: 0.95,
          },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    });

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
    });

    expect(response).toMatchObject({
      inputTokens: 176,
      outputTokens: 2,
      usageDetails: {
        input: 176,
        output: 2,
        cacheRead: 7,
        cacheWrite: 11,
        totalTokens: 196,
        cost: { total: 0.95 },
      },
    });
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 176,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      totalTokens: 196,
      providerCostUsd: 0.95,
    }));
  });

  it('normalizes OpenRouter completion usage accounting into provider cost telemetry', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });

    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: {
        prompt_tokens: 25,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        total_tokens: 30,
        cost: 0.123,
      },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
      { disableRetry: true },
    );

    expect(response).toMatchObject({
      inputTokens: 22,
      outputTokens: 5,
      usageDetails: {
        input: 22,
        output: 5,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { total: 0.123 },
      },
    });
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      callKind: 'completion',
      inputTokens: 22,
      outputTokens: 5,
      cacheReadTokens: 3,
      totalTokens: 30,
      providerCostUsd: 0.123,
      costSource: 'provider',
      metadata: expect.objectContaining({
        routeKind: 'configured_litellm_proxy',
        backendProvider: 'litellm',
        backendBaseUrl: 'http://litellm.test/v1',
      }),
    }));
  });

  it('records failed and successful fallback attempts under one logical call', async () => {
    const config = makeConfig({ retryMaxAttempts: 0 });
    config.modelRegistry = {
      schemaVersion: 1,
      models: [
        {
          id: 'requested-primary',
          rank: 10,
          identity: {
            provider: 'litellm',
            model: 'primary-model',
            source: { type: 'litellm' },
          },
          purposes: [{ purpose: 'background', primary: true }],
          capabilities: { maxOutputTokens: 1024, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 1024 },
          cost: {
            inputPer1MUsd: 2,
            outputPer1MUsd: 8,
            cacheReadPer1MUsd: 0.2,
            cacheWritePer1MUsd: 2.5,
            currency: 'USD',
          },
        },
        {
          id: 'routed-fallback',
          rank: 20,
          identity: {
            provider: 'openrouter',
            model: 'fallback-model',
            source: { type: 'openrouter' },
          },
          purposes: [{ purpose: 'background', primary: false }],
          capabilities: { maxOutputTokens: 1024, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 1024 },
          cost: {
            inputPer1MUsd: 1,
            outputPer1MUsd: 4,
            cacheReadPer1MUsd: 0.1,
            cacheWritePer1MUsd: 1.25,
            currency: 'USD',
          },
        },
      ],
    };
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.completeSimple
      .mockRejectedValueOnce(new Error('503 primary unavailable'))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        model: 'fallback-model',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 20,
          cost: { total: 0.25, currency: 'USD' },
        },
        stopReason: 'stop',
      });

    await client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Do the work' }],
      correlation: {
        requestId: 'request-fallback-accounting',
        callType: 'background',
      },
    }, 'background', { disableRetry: true });

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(2);
    const [failed, succeeded] = usageRecorder.recordUsageEvent.mock.calls.map(call => call[0]);
    expect(failed).toMatchObject({
      attempt: 1,
      status: 'failure',
      settlement: 'unknown',
      provider: 'litellm',
      model: 'primary-model',
      requestedProvider: 'litellm',
      requestedModel: 'primary-model',
      costSource: 'none',
    });
    expect(succeeded).toMatchObject({
      attempt: 2,
      status: 'success',
      settlement: 'complete',
      provider: 'openrouter',
      model: 'fallback-model',
      requestedProvider: 'litellm',
      requestedModel: 'primary-model',
      providerCost: { total: 0.25, currency: 'USD' },
      effectiveCost: { total: 0.25, currency: 'USD' },
      costSource: 'provider',
    });
    expect(failed.logicalCallId).toBe(succeeded.logicalCallId);
    expect(succeeded.estimatedCost).toEqual({
      input: 0.00001,
      output: 0.00002,
      cacheRead: 0.0000003,
      cacheWrite: 0.0000025,
      total: 0.0000328,
      currency: 'USD',
    });
  });

  it('settles a stream failure after emitted text as one partial attempt', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.streamSimple.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: 'partial provider output' };
      yield {
        type: 'error',
        error: { errorMessage: 'provider stream disconnected' },
      };
    });

    await expect(client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Stream this' }],
      correlation: {
        requestId: 'request-partial-stream',
        callType: 'chat',
      },
    })).rejects.toThrow('provider stream disconnected');

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    const event = usageRecorder.recordUsageEvent.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      attempt: 1,
      status: 'failure',
      settlement: 'partial',
      provider: 'openrouter',
      model: 'z-ai/glm-5',
      requestedProvider: 'openrouter',
      requestedModel: 'z-ai/glm-5',
      costSource: 'none',
      metadata: expect.objectContaining({
        partialOutputChars: 23,
      }),
    });
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.outputTokens).toBeGreaterThan(0);
    expect(event.totalTokens).toBe(
      event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens,
    );
  });

  it('records a completed provider response with malformed usage as failed unknown economics', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider returned content' }],
      model: 'z-ai/glm-5',
      usage: { bananas: 7 },
      stopReason: 'stop',
    });

    await expect(client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Complete this' }],
    }, 'background', { disableRetry: true })).rejects.toThrow('Unsupported provider usage shape');

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      status: 'failure',
      settlement: 'complete',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costSource: 'none',
      errorMessage: 'Unsupported provider usage shape',
      metadata: expect.objectContaining({
        malformedRawUsage: { bananas: 7 },
      }),
    }));
  });

  it('settles late gateway-captured provider cost into the durable attempt', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
      providerCostResolver: () => ({
        providerCost: { total: 0.42, currency: 'USD' },
        providerCostEvidence: {
          gatewayCapture: { total: 0.42, currency: 'USD' },
        },
      }),
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 20, output: 4, totalTokens: 24 },
      stopReason: 'stop',
    });

    await client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Complete this' }],
    }, 'background', { disableRetry: true });

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      providerCost: { total: 0.42, currency: 'USD' },
      effectiveCost: { total: 0.42, currency: 'USD' },
      providerCostUsd: 0.42,
      effectiveCostUsd: 0.42,
      costSource: 'provider',
    }));
  });

  it('quarantines contradictory response and gateway-captured cost from durable totals', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
      providerCostResolver: () => ({
        providerCost: { total: 0.42, currency: 'USD' },
        providerCostEvidence: {
          gatewayCapture: { total: 0.42, currency: 'USD' },
        },
      }),
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: {
        input: 20,
        output: 4,
        totalTokens: 24,
        cost: { total: 0.21, currency: 'USD' },
      },
      stopReason: 'stop',
    });

    await client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Complete this' }],
    }, 'background', { disableRetry: true });

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      settlement: 'partial',
      providerCost: {},
      effectiveCost: {},
      costSource: 'none',
      metadata: expect.objectContaining({
        providerCostEvidence: {
          responseUsage: { total: 0.21, currency: 'USD' },
          gatewayCapture: { total: 0.42, currency: 'USD' },
        },
        providerCostEvidenceConflict: { fields: ['total'] },
      }),
    }));
    const event = usageRecorder.recordUsageEvent.mock.calls[0]?.[0];
    expect(event.providerCostUsd).toBeUndefined();
    expect(event.effectiveCostUsd).toBeUndefined();
  });

  it('keeps malformed gateway cost evidence unresolved instead of estimating a complete attempt', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
      providerCostResolver: () => ({
        providerCostEvidence: {},
        providerCostEvidenceConflict: { fields: ['header.x-litellm-response-cost'] },
      }),
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 20, output: 4, totalTokens: 24 },
      stopReason: 'stop',
    });

    await client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Complete this' }],
    }, 'background', { disableRetry: true });

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      settlement: 'partial',
      providerCost: {},
      metadata: expect.objectContaining({
        providerCostEvidenceConflict: { fields: ['header.x-litellm-response-cost'] },
      }),
    }));
  });

  it('quarantines malformed direct-provider response cost instead of settling a complete estimate', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig({ retryMaxAttempts: 0 }), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: {
        input: 20,
        output: 4,
        totalTokens: 24,
        cost: { total: 'not-money', currency: 'USD' },
      },
      stopReason: 'stop',
    });

    await client.complete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Complete this' }],
    }, 'background', { disableRetry: true });

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      settlement: 'partial',
      providerCost: {},
      costSource: 'none',
      metadata: expect.objectContaining({
        rawUsage: expect.objectContaining({
          cost: { total: 'not-money', currency: 'USD' },
        }),
        providerCostEvidenceConflict: { fields: ['responseUsage.cost.total'] },
      }),
    }));
    const event = usageRecorder.recordUsageEvent.mock.calls[0]?.[0];
    expect(event.providerCostUsd).toBeUndefined();
    expect(event.effectiveCostUsd).toBeUndefined();
  });

  it('skips budget-blocked primary candidate and falls back to secondary chat candidate', async () => {
    const config = makeConfig();
    const baseRegistry = config.modelRegistry!;
    config.modelRegistry = {
      ...baseRegistry,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 0.001,
        monthlyUsdLimit: 1,
        currency: 'USD',
      },
      models: [
        ...baseRegistry.models.map((entry) => (
          entry.id === 'chat'
            ? {
              ...entry,
              cost: { inputPer1MUsd: 100, outputPer1MUsd: 100, currency: 'USD' },
            }
            : entry
        )),
        {
          id: 'chat-fallback',
          rank: 500,
          identity: {
            provider: 'openrouter',
            model: 'openai/gpt-4.1-mini',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: false },
          ],
          capabilities: {
            maxOutputTokens: 2048,
            contextWindow: 128_000,
          },
          tuning: {
            maxOutputTokens: 2048,
          },
          cost: {
            inputPer1MUsd: 0.01,
            outputPer1MUsd: 0.01,
            currency: 'USD',
          },
        },
      ],
    };
    const blockedEvents: Array<Record<string, unknown>> = [];
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      onBudgetBlocked: (event) => blockedEvents.push(event as unknown as Record<string, unknown>),
      usageBudgetQuery: {
        async getModelBudgetSpend() {
          return {
            dayKey: '2026-07-13',
            monthKey: '2026-07',
            dailyEstimatedCostUsd: 0,
            monthlyEstimatedCostUsd: 0,
            dailyUnknownCostAttempts: 0,
            monthlyUnknownCostAttempts: 0,
          };
        },
      },
    });

    mocks.streamSimple.mockImplementation((model: { id: string }) => (async function* streamOk() {
      yield {
        type: 'done',
        message: {
          model: model.id,
          usage: { input: 5, output: 3 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    })());

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-budget-1',
        requestId: 'req-budget-1',
        channelId: 'channel-budget-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });

    expect(response.content).toBe('ok');
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    const selectedModel = mocks.streamSimple.mock.calls[0]?.[0] as { id: string };
    expect(selectedModel.id).toBe('openrouter/openai/gpt-4.1-mini');
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({
      reason: 'daily_budget_exceeded',
      purpose: 'chat',
      provider: 'openrouter',
      model: 'z-ai/glm-5',
      service: 'chat',
      process: 'agent.turn.prompt',
      turnId: 'turn-budget-1',
      requestId: 'req-budget-1',
      channelId: 'channel-budget-1',
      callType: 'chat',
      originType: 'chat',
      originStage: 'agent.turn.prompt',
      budget: {
        dailyLimitUsd: 0.001,
        monthlyLimitUsd: 1,
        dayKey: expect.any(String),
        monthKey: expect.any(String),
        dailySpentUsd: expect.any(Number),
        monthlySpentUsd: expect.any(Number),
      },
      estimatedRequestCostUsd: expect.any(Number),
    });
    expect((blockedEvents[0].estimatedRequestCostUsd as number)).toBeGreaterThan(0);
  });

  it('stops all fallback candidates when canonical budget accounting is unavailable', async () => {
    const config = makeConfig();
    const baseRegistry = config.modelRegistry!;
    config.modelRegistry = {
      ...baseRegistry,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 10,
        monthlyUsdLimit: 100,
        currency: 'USD',
      },
      models: [
        ...baseRegistry.models,
        {
          id: 'chat-fallback-accounting-unavailable',
          rank: 500,
          identity: {
            provider: 'openrouter',
            model: 'openai/gpt-4.1-mini',
            source: { type: 'openrouter' },
          },
          purposes: [{ purpose: 'chat', primary: false }],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
          cost: { inputPer1MUsd: 0.01, outputPer1MUsd: 0.01, currency: 'USD' },
        },
      ],
    };
    const blockedEvents: Array<Record<string, unknown>> = [];
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      onBudgetBlocked: event => blockedEvents.push(event as unknown as Record<string, unknown>),
    });

    await expect(client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Do not call a provider' }],
    })).rejects.toThrow('accounting_unavailable');

    expect(mocks.streamSimple).not.toHaveBeenCalled();
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({ reason: 'accounting_unavailable' });
  });

  it('falls back to a secondary chat candidate when the primary stream returns no text', async () => {
    const config = makeConfig({
      primaryModel: 'ChatGPTN',
      primaryProvider: 'litellm',
      modelRoster: {
        chat: { model: 'ChatGPTN', provider: 'litellm', maxTokens: 4096, contextWindow: 128_000 },
        background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chatgptn-primary',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'ChatGPTN',
              source: { type: 'litellm' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
          {
            id: 'openai-nano-fallback',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openai/gpt-5.4-nano',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 2048,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 2048,
            },
          },
        ],
      },
    });
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
    });

    mocks.streamSimple.mockImplementation((model: { id: string }) => (async function* streamByModel() {
      if (model.id === 'ChatGPTN') {
        yield {
          type: 'done',
          message: {
            model: 'ChatGPTN',
            usage: { input: 10, output: 0 },
            content: [],
          },
          reason: 'stop',
        };
        return;
      }

      yield {
        type: 'done',
        message: {
          model: model.id,
          usage: { input: 8, output: 4 },
          content: [{ type: 'text', text: 'Recovered on nano.' }],
        },
        reason: 'stop',
      };
    })());

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-empty-primary-1',
        requestId: 'req-empty-primary-1',
        channelId: 'channel-empty-primary-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });

    expect(response.content).toBe('Recovered on nano.');
    expect(response.model).toBe('openrouter/openai/gpt-5.4-nano');
    expect(mocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(mocks.streamSimple.mock.calls.map(call => (call[0] as { id: string }).id)).toEqual([
      'ChatGPTN',
      'openrouter/openai/gpt-5.4-nano',
    ]);
  });

  it('fails over from unreachable ChatGPTN without retrying the same stream candidate', async () => {
    const config = makeConfig({
      primaryModel: 'ChatGPTN',
      primaryProvider: 'litellm',
      modelRoster: {
        chat: { model: 'ChatGPTN', provider: 'litellm', maxTokens: 4096, contextWindow: 128_000 },
        background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chatgptn-primary',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'ChatGPTN',
              source: { type: 'litellm' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
          {
            id: 'openai-nano-fallback',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openai/gpt-5.4-nano',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 2048,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 2048,
            },
          },
        ],
      },
    });
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
    });

    mocks.streamSimple.mockImplementation((model: { id: string }) => (async function* streamByModel() {
      if (model.id === 'ChatGPTN') {
        throw new Error(
          '500 litellm.InternalServerError: OpenAIException - Connection error. '
          + 'Cannot connect to host 192.168.1.43:8000 ssl:default',
        );
      }

      yield {
        type: 'done',
        message: {
          model: model.id,
          usage: { input: 8, output: 4 },
          content: [{ type: 'text', text: 'Recovered on nano.' }],
        },
        reason: 'stop',
      };
    })());

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-unreachable-primary-1',
        requestId: 'req-unreachable-primary-1',
        channelId: 'channel-unreachable-primary-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });
    const secondResponse = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Second hello' }],
      correlation: {
        turnId: 'turn-unreachable-primary-2',
        requestId: 'req-unreachable-primary-2',
        channelId: 'channel-unreachable-primary-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });

    expect(response.content).toBe('Recovered on nano.');
    expect(secondResponse.content).toBe('Recovered on nano.');
    expect(mocks.streamSimple.mock.calls.map(call => (call[0] as { id: string }).id)).toEqual([
      'ChatGPTN',
      'openrouter/openai/gpt-5.4-nano',
      'openrouter/openai/gpt-5.4-nano',
    ]);
  });

  it('falls back without streaming leading provider template artifacts from the primary model', async () => {
    const config = makeConfig({
      primaryModel: 'ChatGPTN',
      primaryProvider: 'litellm',
      modelRoster: {
        chat: { model: 'ChatGPTN', provider: 'litellm', maxTokens: 4096, contextWindow: 128_000 },
        background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chatgptn-primary',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'ChatGPTN',
              source: { type: 'litellm' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
          {
            id: 'openai-nano-fallback',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openai/gpt-5.4-nano',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 2048,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 2048,
            },
          },
        ],
      },
    });
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
    });

    mocks.streamSimple.mockImplementation((model: { id: string }) => (async function* streamByModel() {
      if (model.id === 'ChatGPTN') {
        yield { type: 'text_delta', delta: '<｜begin' };
        yield { type: 'text_delta', delta: "▁of▁sentence｜># Lyra's Response\n\nYeah, I remember." };
        return;
      }

      yield { type: 'text_delta', delta: 'Recovered on nano.' };
      yield {
        type: 'done',
        message: {
          model: model.id,
          usage: { input: 8, output: 4 },
          content: [{ type: 'text', text: 'Recovered on nano.' }],
        },
        reason: 'stop',
      };
    })());

    const streamedText: string[] = [];
    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-artifact-primary-1',
        requestId: 'req-artifact-primary-1',
        channelId: 'channel-artifact-primary-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    }, {
      onText: (delta) => streamedText.push(delta),
    });

    expect(response.content).toBe('Recovered on nano.');
    expect(response.model).toBe('openrouter/openai/gpt-5.4-nano');
    expect(streamedText.join('')).toBe('Recovered on nano.');
    expect(streamedText.join('')).not.toContain('begin▁of▁sentence');
    expect(mocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(mocks.streamSimple.mock.calls.map(call => (call[0] as { id: string }).id)).toEqual([
      'ChatGPTN',
      'openrouter/openai/gpt-5.4-nano',
    ]);
  });

  it('falls back on leading generated response headers even without a BOS token', async () => {
    const config = makeConfig({
      primaryModel: 'ChatGPTN',
      primaryProvider: 'litellm',
      modelRoster: {
        chat: { model: 'ChatGPTN', provider: 'litellm', maxTokens: 4096, contextWindow: 128_000 },
        background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chatgptn-primary',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'ChatGPTN',
              source: { type: 'litellm' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
          {
            id: 'openai-nano-fallback',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openai/gpt-5.4-nano',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 2048,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 2048,
            },
          },
        ],
      },
    });
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
    });

    mocks.streamSimple.mockImplementation((model: { id: string }) => (async function* streamByModel() {
      if (model.id === 'ChatGPTN') {
        yield { type: 'text_delta', delta: '# Lyra' };
        yield { type: 'text_delta', delta: "'s Response\n\nYeah, I remember." };
        return;
      }

      yield { type: 'text_delta', delta: 'Recovered on fallback.' };
      yield {
        type: 'done',
        message: {
          model: model.id,
          usage: { input: 8, output: 4 },
          content: [{ type: 'text', text: 'Recovered on fallback.' }],
        },
        reason: 'stop',
      };
    })());

    const streamedText: string[] = [];
    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-header-artifact-primary-1',
        requestId: 'req-header-artifact-primary-1',
        channelId: 'channel-header-artifact-primary-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    }, {
      onText: (delta) => streamedText.push(delta),
    });

    expect(response.content).toBe('Recovered on fallback.');
    expect(streamedText.join('')).toBe('Recovered on fallback.');
    expect(streamedText.join('')).not.toContain("Lyra's Response");
    expect(mocks.streamSimple).toHaveBeenCalledTimes(2);
  });

  it('allows normal Markdown headings once they are not response-header artifacts', async () => {
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
    });
    const content = '# Garden plan\nBring snacks.';

    mocks.streamSimple.mockImplementation(async function* streamHeading() {
      yield { type: 'text_delta', delta: '# Garden' };
      yield { type: 'text_delta', delta: ' plan\n' };
      yield { type: 'text_delta', delta: 'Bring snacks.' };
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 8, output: 4 },
          content: [{ type: 'text', text: content }],
        },
        reason: 'stop',
      };
    });

    const streamedText: string[] = [];
    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Make a quick plan' }],
    }, {
      onText: (delta) => streamedText.push(delta),
    });

    expect(response.content).toBe(content);
    expect(streamedText.join('')).toBe(content);
  });

  it('records successful completion only through the canonical usage recorder', async () => {
    const config = makeConfig();
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 13, output: 7 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
      { disableRetry: true },
    );

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v3.2',
      attribution: expect.objectContaining({
        purpose: 'background',
        service: 'background',
      }),
      inputTokens: 13,
      outputTokens: 7,
    }));
  });

  it('skips preflight token estimation when model budget policy is disabled', async () => {
    const config = makeConfig();
    const baseRegistry = config.modelRegistry!;
    config.modelRegistry = {
      ...baseRegistry,
      budgetPolicy: {
        enabled: false,
        dailyUsdLimit: 1,
        monthlyUsdLimit: 10,
        currency: 'USD',
      },
    };
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });
    const estimateSpy = vi.spyOn(client as any, 'estimateBudgetInputTokens');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 13, output: 7 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
      { disableRetry: true },
    );

    expect(estimateSpy).not.toHaveBeenCalled();
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 13,
      outputTokens: 7,
    }));
  });

  it('routes completion through injected transport without calling direct provider transport', async () => {
    const config = makeConfig();
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: 'gateway-result',
        model: 'z-ai/glm-5',
        inputTokens: 9,
        outputTokens: 4,
        stopReason: 'stop',
        toolCalls: [],
      })),
    };
    const client = new LLMClient(config, { transport: transport as any });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
    );

    expect(mocks.completeSimple).not.toHaveBeenCalled();
    expect(transport.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'deepseek/deepseek-v3.2',
          provider: 'openrouter',
          pin: true,
          maxTokens: 2048,
        }),
      }),
      'background',
      { signal: expect.any(AbortSignal) },
    );
    expect(response).toMatchObject({
      content: 'gateway-result',
      model: 'z-ai/glm-5',
      inputTokens: 9,
      outputTokens: 4,
    });
  });

  it('caps vision completion output tokens before routing through injected transport', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'background',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 2048 },
          },
          {
            id: 'vision',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'vision/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: {
              maxOutputTokens: 262_142,
              contextWindow: 262_144,
              supportsVision: true,
            },
            tuning: { maxOutputTokens: 262_142 },
          },
        ],
      },
    });
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: 'gateway-vision-result',
        model: 'vision/model',
        inputTokens: 1200,
        outputTokens: 8,
        stopReason: 'stop',
        toolCalls: [],
      })),
    };
    const client = new LLMClient(config, { transport: transport as any });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Describe this image' }],
      },
      'vision',
    );

    expect(mocks.completeSimple).not.toHaveBeenCalled();
    expect(transport.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'vision/model',
          provider: 'openrouter',
          pin: true,
          maxTokens: 1024,
        }),
      }),
      'vision',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('routes streaming through injected transport without calling direct provider transport', async () => {
    const config = makeConfig();
    const callbacks = {
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const transport = {
      stream: vi.fn(async () => ({
        content: 'gateway-stream-result',
        model: 'z-ai/glm-5',
        inputTokens: 11,
        outputTokens: 6,
        stopReason: 'stop',
        toolCalls: [],
      })),
      complete: vi.fn(),
    };
    const client = new LLMClient(config, { transport: transport as any });

    const response = await client.stream(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Stream this reply' }],
        accounting: {
          logicalCallId: 'llm:transport-caller',
          attempt: 5,
          retryOwner: 'caller',
        },
      },
      callbacks,
    );

    expect(mocks.streamSimple).not.toHaveBeenCalled();
    expect(transport.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'z-ai/glm-5',
          provider: 'openrouter',
          pin: true,
          maxTokens: 4096,
        }),
        accounting: {
          logicalCallId: 'llm:transport-caller',
          attempt: 5,
          retryOwner: 'caller',
        },
      }),
      callbacks,
      { signal: expect.any(AbortSignal) },
    );
    expect(callbacks.onDone).toHaveBeenCalledWith(expect.objectContaining({
      content: 'gateway-stream-result',
      model: 'z-ai/glm-5',
    }));
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      content: 'gateway-stream-result',
      model: 'z-ai/glm-5',
      inputTokens: 11,
      outputTokens: 6,
    });
  });

  it('short-circuits retryable injected transport completions and recovers after cooldown', async () => {
    let now = 1_000;
    const circuitBreaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 30_000,
      now: () => now,
    });
    const circuitKey = 'llm.complete::openrouter::deepseek/deepseek-v3.2::registered_model';
    const transport = {
      stream: vi.fn(),
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('503 service unavailable'))
        .mockRejectedValueOnce(new Error('503 service unavailable'))
        .mockResolvedValue({
          content: 'gateway-recovered',
          model: 'deepseek/deepseek-v3.2',
          inputTokens: 9,
          outputTokens: 4,
          stopReason: 'stop',
          toolCalls: [],
        }),
    };
    const client = new LLMClient(makeConfig(), {
      transport: transport as any,
      circuitBreaker,
    });
    const transitionSpy = vi.spyOn(client as any, 'logCircuitBreakerTransition');
    const request = () => client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
    );

    await expect(request()).rejects.toThrow('503 service unavailable');
    now += 1_000;
    await expect(request()).rejects.toThrow('503 service unavailable');
    now += 1_000;
    await expect(request()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(transport.complete).toHaveBeenCalledTimes(2);
    expect(circuitBreaker.snapshot(circuitKey).state).toBe('open');

    now += 30_001;
    await expect(request()).resolves.toMatchObject({
      content: 'gateway-recovered',
      model: 'deepseek/deepseek-v3.2',
      inputTokens: 9,
      outputTokens: 4,
    });

    expect(transport.complete).toHaveBeenCalledTimes(3);
    expect(circuitBreaker.snapshot(circuitKey).state).toBe('closed');
    expect(transitionSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: 'llm.complete',
      key: circuitKey,
      to: 'open',
      reason: 'failure_threshold',
    }));
    expect(transitionSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: 'llm.complete',
      key: circuitKey,
      to: 'half_open',
      reason: 'cooldown_elapsed',
    }));
    expect(transitionSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: 'llm.complete',
      key: circuitKey,
      to: 'closed',
      reason: 'half_open_success',
    }));
  });

  it('short-circuits retryable injected transport streams after the threshold', async () => {
    const circuitBreaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 30_000,
    });
    const callbacks = {
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const transport = {
      stream: vi.fn().mockRejectedValue(new Error('fetch failed')),
      complete: vi.fn(),
    };
    const client = new LLMClient(makeConfig(), {
      transport: transport as any,
      circuitBreaker,
    });
    const request = () => client.stream(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Stream this reply' }],
      },
      callbacks,
    );

    await expect(request()).rejects.toThrow('fetch failed');
    await expect(request()).rejects.toBeInstanceOf(CircuitOpenError);

    expect(transport.stream).toHaveBeenCalledTimes(1);
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledTimes(2);
    expect(callbacks.onError.mock.calls[1]?.[0]).toBeInstanceOf(CircuitOpenError);
  });

  it('does not count non-retryable injected transport configuration failures as outages', async () => {
    const circuitBreaker = new SlidingWindowCircuitBreaker({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 30_000,
    });
    const circuitKey = 'llm.complete::openrouter::deepseek/deepseek-v3.2::registered_model';
    const transport = {
      stream: vi.fn(),
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('Gateway provider config is not wired on the gateway'))
        .mockResolvedValue({
          content: 'gateway-after-config-failure',
          model: 'deepseek/deepseek-v3.2',
          inputTokens: 7,
          outputTokens: 3,
          stopReason: 'stop',
          toolCalls: [],
        }),
    };
    const client = new LLMClient(makeConfig(), {
      transport: transport as any,
      circuitBreaker,
    });
    const transitionSpy = vi.spyOn(client as any, 'logCircuitBreakerTransition');
    const request = () => client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
    );

    await expect(request()).rejects.toThrow('Gateway provider config is not wired on the gateway');
    expect(circuitBreaker.snapshot(circuitKey).state).toBe('closed');

    await expect(request()).resolves.toMatchObject({
      content: 'gateway-after-config-failure',
      model: 'deepseek/deepseek-v3.2',
    });

    expect(transport.complete).toHaveBeenCalledTimes(2);
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('preempts an in-flight background completion for a foreground stream on a constrained route (mmo9.5.1)', async () => {
    // mmo9.5.1: a foreground chat acquire on a constrained (shared) route now
    // PREEMPTS an in-flight preemptable background completion rather than
    // queueing behind it, and the preempt reaches the transport via a composed
    // abort signal (the streaming path carries the same gate-owned signal).
    const config = makeConfig();
    const order: string[] = [];
    const backgroundStarted = createDeferred<void>();
    const foregroundRelease = createDeferred<{
      content: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      toolCalls: [];
    }>();
    let backgroundSignal: AbortSignal | undefined;
    let foregroundSignal: AbortSignal | undefined;
    const transport = {
      stream: vi.fn(async (
        context: { correlation?: { requestId?: string } },
        _callbacks: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        foregroundSignal = options?.signal;
        order.push(`stream:${context.correlation?.requestId ?? 'unknown'}`);
        return await foregroundRelease.promise;
      }),
      complete: vi.fn(async (
        context: { correlation?: { requestId?: string } },
        purpose: string,
        options?: { signal?: AbortSignal },
      ) => {
        order.push(`complete:${purpose}:${context.correlation?.requestId ?? 'unknown'}`);
        if (context.correlation?.requestId === 'bg-1') {
          backgroundSignal = options?.signal;
          backgroundStarted.resolve();
          // Honor the gate preempt signal exactly like a real transport.
          return await new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) { reject(signal.reason); return; }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return {
          content: `${purpose}-result`,
          model: 'deepseek/deepseek-v3.2',
          inputTokens: 4,
          outputTokens: 2,
          stopReason: 'stop',
          toolCalls: [],
        };
      }),
    };
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      transport: transport as any,
    });

    const backgroundOnePromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Background 1' }],
        correlation: {
          requestId: 'bg-1',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    ).then(() => null).catch((error: unknown) => error);
    await backgroundStarted.promise;

    const backgroundTwoPromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Background 2' }],
        correlation: {
          requestId: 'bg-2',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );
    const foregroundPromise = client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Foreground chat' }],
      correlation: {
        requestId: 'chat-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });

    // Foreground preempts the in-flight background immediately; it does NOT wait
    // for bg-1 to finish.
    await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));

    // The preempted background call is aborted through the composed transport
    // signal and rejects with the typed preemption error.
    const backgroundOneOutcome = await backgroundOnePromise;
    expect(backgroundOneOutcome).toBeInstanceOf(ModelCallPreemptedError);
    expect(backgroundSignal?.aborted).toBe(true);
    // The streaming path received the gate-owned preempt signal (mmo9.8 needs it).
    expect(foregroundSignal).toBeInstanceOf(AbortSignal);

    foregroundRelease.resolve({
      content: 'foreground-result',
      model: 'z-ai/glm-5',
      inputTokens: 5,
      outputTokens: 3,
      stopReason: 'stop',
      toolCalls: [],
    });

    await expect(foregroundPromise).resolves.toMatchObject({
      content: 'foreground-result',
      model: 'z-ai/glm-5',
    });

    // The parked bg-2 runs once the foreground releases the slot.
    await expect(backgroundTwoPromise).resolves.toMatchObject({
      content: 'background-result',
      model: 'deepseek/deepseek-v3.2',
    });

    expect(order).toEqual([
      'complete:background:bg-1',
      'stream:chat-1',
      'complete:background:bg-2',
    ]);
  });

  it('aborts the in-flight stream transport when EITHER the caller cancellation OR the gate preempt signal fires (mmo9.5.1 + mmo9.6.1 merge)', async () => {
    // Merge-resolution coverage: the stream path composes
    // composeTransportSignal(options.signal, preemptSignal), so the SAME
    // transport signal must tear down the in-flight provider stream whether the
    // abort originates from a caller/barge-in cancellation (mmo9.6.1) or a
    // gate-owned preempt (mmo9.5.1). A naive merge that picked either side alone
    // would silently drop one source; this proves both survive independently.
    const config = makeConfig();

    // The model-call gate hands each acquire a preempt signal it owns; a real
    // foreground stream is never a preemption victim, so drive the preempt
    // signal deterministically through a controllable gate while the rest of the
    // stream path (composition + transport dispatch) runs for real.
    const runCase = async (source: 'caller' | 'preempt') => {
      const callerController = new AbortController();
      const preemptController = new AbortController();
      let transportSignal: AbortSignal | undefined;
      const release = createDeferred<{
        content: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        stopReason: string;
        toolCalls: [];
      }>();
      const transport = {
        stream: vi.fn(async (
          _context: unknown,
          _callbacks: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          transportSignal = options?.signal;
          return await release.promise;
        }),
        complete: vi.fn(),
      };
      const client = new LLMClient(config, { transport: transport as any });
      // Replace the gate with a minimal stand-in that yields a preempt signal we
      // control, mirroring ModelCallGate.run granting a slot and calling
      // execute(slot.preemptController.signal).
      (client as unknown as { modelCallGate: unknown }).modelCallGate = {
        run: async (
          _request: unknown,
          execute: (preemptSignal: AbortSignal) => Promise<unknown>,
        ) => await execute(preemptController.signal),
      };

      const streamPromise = client.stream(
        { systemPrompt: 'System', messages: [{ role: 'user', content: 'stream this' }] },
        { onError: () => {} },
        // The caller signal is only supplied for the caller case, so each source
        // is proven to abort the transport INDEPENDENTLY of the other.
        source === 'caller' ? { signal: callerController.signal } : undefined,
      ).catch((error: unknown) => error);

      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
      expect(transportSignal).toBeInstanceOf(AbortSignal);
      expect(transportSignal?.aborted).toBe(false);

      if (source === 'caller') {
        callerController.abort(new Error('barge-in'));
      } else {
        preemptController.abort(new Error('gate-preempt'));
      }

      // Either source tears down the composed transport signal handed to the
      // in-flight provider stream.
      expect(transportSignal?.aborted).toBe(true);

      release.resolve({
        content: 'stream-result',
        model: 'z-ai/glm-5',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
        toolCalls: [],
      });
      await streamPromise;
    };

    await runCase('caller');
    await runCase('preempt');
  });

  it('does not serialize direct registered-model calls when no shared route is in play', async () => {
    const config = makeConfig();
    const secondStarted = createDeferred<void>();
    const firstRelease = createDeferred<{
      content: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      toolCalls: [];
    }>();
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async (context: { correlation?: { requestId?: string } }) => {
        if (context.correlation?.requestId === 'direct-1') {
          return await firstRelease.promise;
        }
        secondStarted.resolve();
        return {
          content: 'direct-2-result',
          model: 'deepseek/deepseek-v3.2',
          inputTokens: 2,
          outputTokens: 1,
          stopReason: 'stop',
          toolCalls: [],
        };
      }),
    };
    const client = new LLMClient(config, { transport: transport as any });

    const firstPromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Direct 1' }],
        correlation: {
          requestId: 'direct-1',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );
    await vi.waitFor(() => expect(transport.complete).toHaveBeenCalledTimes(1));

    const secondPromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Direct 2' }],
        correlation: {
          requestId: 'direct-2',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );

    await expect(secondStarted.promise).resolves.toBeUndefined();
    firstRelease.resolve({
      content: 'direct-1-result',
      model: 'deepseek/deepseek-v3.2',
      inputTokens: 2,
      outputTokens: 1,
      stopReason: 'stop',
      toolCalls: [],
    });

    await expect(firstPromise).resolves.toMatchObject({ content: 'direct-1-result' });
    await expect(secondPromise).resolves.toMatchObject({ content: 'direct-2-result' });
    expect(transport.complete).toHaveBeenCalledTimes(2);
  });
});

describe('LLMClient autonomous spend accounting (mmo9.7.3)', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockImplementation((provider: string) => [
      'z-ai/glm-5',
      'deepseek/deepseek-v3.2',
    ].map(id => ({
      id,
      provider,
      name: id,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    })));
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('records the gate-resolved runtime lane class and actual model in attribution', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'extracted' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 20, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Extract' }],
      },
      'extraction',
      {
        disableRetry: true,
        correlation: {
          companionId: 'companion-x',
          callType: 'background',
          originStage: 'memory.extraction',
        },
      },
    );

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.stringContaining('deepseek'),
      attribution: expect.objectContaining({
        companionId: 'companion-x',
        runtimeLaneClass: 'maintenance_reflection',
        originStage: 'memory.extraction',
      }),
    }));
  });

  it('attributes the declared work-spec lane across the provider seam (psfn-framework-d8vq.2: spec.lane in == lane out)', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), { usageRecorder });
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'extracted' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 20, output: 6 },
      stopReason: 'stop',
    });

    const spec = buildLLMWorkSpec({
      purpose: 'extraction',
      durable: true,
      correlation: {
        companionId: 'companion-x',
        callType: 'background',
        originStage: 'memory.extraction',
      },
    });
    expect(spec.lane).toBe('maintenance_reflection');

    // The serving-side provider (the gateway's LLMClient) receives the work spec
    // exactly as the RPC handler forwards it and must attribute the declared lane.
    await completeWithWorkSpec(
      client,
      { systemPrompt: 'System', messages: [{ role: 'user', content: 'Extract' }] },
      spec,
    );

    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledTimes(1);
    const attribution = usageRecorder.recordUsageEvent.mock.calls[0]?.[0]?.attribution;
    expect(attribution?.runtimeLaneClass).toBe(spec.lane);
  });

  it('fails closed when a declared autonomous (work-spec) call has no usageRecorder', async () => {
    const client = new LLMClient(makeConfig());
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'should never run' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 5, output: 2 },
      stopReason: 'stop',
    });

    const spec = buildLLMWorkSpec({
      purpose: 'extraction',
      durable: true,
      correlation: { callType: 'background', originStage: 'memory.extraction' },
    });
    expect(spec.lane).toBe('maintenance_reflection');

    await expect(completeWithWorkSpec(
      client,
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Extract' }],
      },
      spec,
    )).rejects.toThrow(/unaccounted autonomous spend/);

    // The provider is never touched: unaccountable autonomous spend never runs.
    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it('leaves the interactive chat path runnable without a usageRecorder', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 8, output: 3 },
          content: [{ type: 'text', text: 'hello' }],
        },
        reason: 'stop',
      };
    });

    await expect(client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hi' }],
    })).resolves.toMatchObject({ content: 'hello' });
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
  });
});

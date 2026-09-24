import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultDecisionBackendSettings,
  type DecisionBackendSettings,
} from '../../system/config/decision-backend-config.js';
import type { DecisionsFetch } from '../../primitives/llm/decision/jev-transport.js';
import {
  TUTORIAL_REQUEST_BODY,
  TUTORIAL_RESPONSE_BODY,
} from '../../primitives/llm/decision/jev-transport.test-fixtures.js';
import type { DecisionQuestionSet } from '../../primitives/llm/decision/types.js';
import type { ModelUsageEventInput } from '../../shared/telemetry/model-usage.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  createGatewayJevDecisionService,
  JevDecisionRefusedError,
  type GatewayJevDecisionServiceOptions,
} from './jev-decision-service.js';

const QUESTIONS = TUTORIAL_REQUEST_BODY.questions as unknown as DecisionQuestionSet;

function settings(mode: DecisionBackendSettings['mode'], sites: DecisionBackendSettings['sites'] = {}) {
  return { ...createDefaultDecisionBackendSettings(), mode, sites };
}

function makeConfig(overrides: Partial<SubstrateConfig> = {}): GatewayJevDecisionServiceOptions['config'] {
  return {
    decisionBackend: settings('jev'),
    openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
    openRouterApiKeyRef: { source: 'env', envName: 'OPENROUTER_API_KEY' } as SubstrateConfig['openRouterApiKeyRef'],
    credentialVault: { resolveOptional: () => 'sk-or-test-key' } as unknown as SubstrateConfig['credentialVault'],
    ...overrides,
  };
}

function okFetch(status = 200, body: unknown = TUTORIAL_RESPONSE_BODY) {
  return vi.fn<DecisionsFetch>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }));
}

function service(config = makeConfig(), fetch = okFetch()) {
  const usage: ModelUsageEventInput[] = [];
  let clock = 1_000;
  const svc = createGatewayJevDecisionService({
    config,
    fetch,
    usageRecorder: { recordUsageEvent: async (event) => { usage.push(event); } },
    now: () => (clock += 10),
  });
  return { svc, fetch, usage };
}

const INPUT = {
  siteId: 'room.ambiguity' as const,
  state: TUTORIAL_REQUEST_BODY.state,
  questions: QUESTIONS,
  companionId: 'companion-test',
};

describe('createGatewayJevDecisionService', () => {
  it.each([
    ['the block is absent', makeConfig({ decisionBackend: undefined }), INPUT, 'decision_backend_not_configured'],
    ['the site resolves to local', makeConfig({ decisionBackend: settings('local') }), INPUT, 'site_mode_local'],
    ['a per-site override is local', makeConfig({
      decisionBackend: settings('jev', { 'room.ambiguity': { mode: 'local' } }),
    }), INPUT, 'site_mode_local'],
    ['the site is companion-private', makeConfig(), { ...INPUT, siteId: 'scheduler.free_time' as const },
      'companion_private_site'],
    ['the call is companion-private', makeConfig(), { ...INPUT, telemetryVisibility: 'companion_private' as const },
      'companion_private_call'],
    ['no OpenRouter key resolves', makeConfig({
      credentialVault: { resolveOptional: () => undefined } as unknown as SubstrateConfig['credentialVault'],
    }), INPUT, 'openrouter_credentials_unavailable'],
    ['no OpenRouter base URL is configured', makeConfig({ openRouterApiBaseUrl: undefined }), INPUT,
      'openrouter_credentials_unavailable'],
  ])('refuses before any network call when %s', async (_label, config, input, reasonCode) => {
    const { svc, fetch } = service(config);
    await expect(svc.decide(input)).rejects.toMatchObject({ reasonCode });
    await expect(svc.decide(input)).rejects.toBeInstanceOf(JevDecisionRefusedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('calls the Decisions endpoint on the OpenRouter origin and records provider cost', async () => {
    const { svc, fetch, usage } = service();
    const outcome = await svc.decide(INPUT);

    expect(outcome).toMatchObject({ ok: true, backend: 'jev', model: 'typesafe/jev-1.13-20260917' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      status: 'success',
      callKind: 'completion',
      provider: 'openrouter',
      model: 'typesafe/jev-1.13-20260917',
      requestedModel: 'typesafe/jev-1.13',
      inputTokens: 476,
      outputTokens: 70,
      providerCostUsd: 0.000019992,
      costSource: 'provider',
      attribution: { companionId: 'companion-test', purpose: 'decision', originStage: 'decision:room.ambiguity' },
      metadata: { siteId: 'room.ambiguity', questionCount: 3 },
    });
    expect(JSON.stringify(usage[0])).not.toContain('checkout page');
  });

  it('records a failed call without the provider error body', async () => {
    const { svc, usage } = service(makeConfig(), okFetch(502, { error: { message: 'echo: checkout page' } }));
    const outcome = await svc.decide(INPUT);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(usage[0]).toMatchObject({ status: 'failure', errorCode: 'http_502', costSource: 'none' });
    expect(JSON.stringify(usage[0])).not.toContain('checkout page');
  });

  it('pauses remote calls after a rate limit', async () => {
    const { svc, fetch } = service(makeConfig(), okFetch(429, { error: { code: 429 } }));
    await expect(svc.decide(INPUT)).resolves.toMatchObject({ ok: false });
    await expect(svc.decide(INPUT)).resolves.toMatchObject({ ok: false, reason: 'error', latencyMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the request at the configured timeout', async () => {
    const hanging = vi.fn<DecisionsFetch>((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const config = makeConfig({
      decisionBackend: { ...settings('jev'), jev: { ...settings('jev').jev, timeoutMs: 50 } },
    });
    const { svc } = service(config, hanging);
    await expect(svc.decide(INPUT)).resolves.toMatchObject({ ok: false, reason: 'aborted' });
  });
});

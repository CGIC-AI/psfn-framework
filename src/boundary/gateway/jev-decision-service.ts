// Gateway-owned Jev decision service (epic 4lf3r).
//
// The OpenRouter key never leaves the gateway, so every Jev request is made
// here: agents reach it through the `llm.decide` RPC, and gateway-side sites
// (the L2 intake signal) call it directly. The service re-checks the owner
// policy on every call and refuses — before any network call — when the site
// resolves to local, when the site or the call is companion-private, when a
// fleet call carries no owning companion (its usage could not be ledgered), or
// when no OpenRouter key/base URL is configured. With the setting absent or `local`
// this service never touches the network.
//
// Backoff reuses the model fallback cooldowns: a 429/529 pauses remote calls
// for the rate-limit cooldown and a network failure for the connectivity
// cooldown; while paused, calls fail fast and the caller answers locally.

import { randomUUID } from 'node:crypto';
import { DEFAULT_CONNECTIVITY_COOLDOWN_MS, DEFAULT_RATE_LIMIT_COOLDOWN_MS } from '../../primitives/llm/fallback.js';
import { resolveConfiguredProviderCredential } from '../../primitives/llm/provider-runtime.js';
import {
  requestJevDecision,
  type DecisionsFetch,
  type JevTransportResult,
} from '../../primitives/llm/decision/jev-transport.js';
import { decisionSitePrivacy } from '../../primitives/llm/decision/sites.js';
import type { DecisionOutcome, DecisionQuestionSet } from '../../primitives/llm/decision/types.js';
import {
  resolveDecisionSiteMode,
  type DecisionSiteId,
} from '../../system/config/decision-backend-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { TelemetryVisibility } from '../../shared/contracts/runtime.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('jev-decision-service');

/** Thrown when policy forbids a remote decision; the caller answers locally. */
export class JevDecisionRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Remote decision refused: ${reasonCode}`);
    this.name = 'JevDecisionRefusedError';
  }
}

interface JevDecisionInput {
  siteId: DecisionSiteId;
  state: Readonly<Record<string, unknown>>;
  questions: DecisionQuestionSet;
  companionId?: string;
  telemetryVisibility?: TelemetryVisibility;
}

export interface GatewayJevDecisionService {
  decide(input: JevDecisionInput, signal?: AbortSignal): Promise<DecisionOutcome>;
}

type JevServiceConfig = Pick<
  SubstrateConfig,
  | 'decisionBackend'
  | 'openRouterApiBaseUrl'
  | 'openRouterApiKeyRef'
  | 'credentialVault'
  | 'providerRegistry'
  | 'modelRegistry'
>;

export interface GatewayJevDecisionServiceOptions {
  config: JevServiceConfig;
  /**
   * Fleet gateways ledger every paid call to its owning companion; a call with
   * no companion attribution is refused before any network request.
   */
  requireCompanionAttribution: boolean;
  usageRecorder?: ModelUsageRecorder;
  fetch?: DecisionsFetch;
  now?: () => number;
}

const DECISIONS_PATH = '/api/alpha/decisions';

function resolveFetch(fetch: DecisionsFetch | undefined): DecisionsFetch {
  if (fetch) return fetch;
  return globalThis.fetch as unknown as DecisionsFetch;
}

export function createGatewayJevDecisionService(
  options: GatewayJevDecisionServiceOptions,
): GatewayJevDecisionService {
  const now = options.now ?? Date.now;
  const fetch = resolveFetch(options.fetch);
  let pausedUntilMs = 0;

  function assertRemoteAllowed(input: JevDecisionInput): NonNullable<JevServiceConfig['decisionBackend']> {
    const settings = options.config.decisionBackend;
    if (!settings) throw new JevDecisionRefusedError('decision_backend_not_configured');
    if (decisionSitePrivacy(input.siteId) === 'companion_private') {
      throw new JevDecisionRefusedError('companion_private_site');
    }
    if (input.telemetryVisibility === 'companion_private') {
      throw new JevDecisionRefusedError('companion_private_call');
    }
    if (resolveDecisionSiteMode(settings, input.siteId) === 'local') {
      throw new JevDecisionRefusedError('site_mode_local');
    }
    if (options.requireCompanionAttribution && !input.companionId?.trim()) {
      throw new JevDecisionRefusedError('missing_companion_attribution');
    }
    return settings;
  }

  async function recordUsage(
    input: JevDecisionInput,
    requestedModel: string,
    startedAtMs: number,
    result: JevTransportResult,
  ): Promise<void> {
    if (!options.usageRecorder) return;
    const completedAtMs = now();
    const outcome = result.outcome;
    try {
      await options.usageRecorder.recordUsageEvent({
        logicalCallId: `decision:${randomUUID()}`,
        attempt: 1,
        startedAtMs,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        status: outcome.ok ? 'success' : 'failure',
        callKind: 'completion',
        telemetryVisibility: 'operator_visible',
        attribution: {
          ...(input.companionId ? { companionId: input.companionId } : {}),
          callType: 'background',
          purpose: 'decision',
          originType: 'background',
          originStage: `decision:${input.siteId}`,
          service: 'decision',
          process: 'jev',
        },
        provider: 'openrouter',
        model: outcome.ok && outcome.model ? outcome.model : requestedModel,
        requestedProvider: 'openrouter',
        requestedModel,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        ...(outcome.ok && outcome.costUsd !== undefined
          ? { providerCostUsd: outcome.costUsd, costSource: 'provider' as const }
          : { costSource: 'none' as const }),
        ...(outcome.ok ? {} : {
          errorCode: result.httpStatus !== undefined ? `http_${result.httpStatus}` : outcome.reason,
        }),
        metadata: { siteId: input.siteId, questionCount: Object.keys(input.questions).length },
      });
    } catch (error) {
      log.warn('Failed to record Jev decision usage', {
        siteId: input.siteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async decide(input, signal) {
      const settings = assertRemoteAllowed(input);
      const startedAtMs = now();
      if (startedAtMs < pausedUntilMs) {
        return { ok: false, reason: 'error', backend: 'jev', latencyMs: 0 };
      }
      const apiKey = resolveConfiguredProviderCredential('openrouter', options.config);
      const apiBaseUrl = options.config.openRouterApiBaseUrl?.trim();
      if (!apiKey || !apiBaseUrl) throw new JevDecisionRefusedError('openrouter_credentials_unavailable');

      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      const timer = setTimeout(() => controller.abort(), settings.jev.timeoutMs);
      let result: JevTransportResult;
      try {
        result = await requestJevDecision(
          {
            endpointUrl: new URL(DECISIONS_PATH, apiBaseUrl).toString(),
            apiKey,
            model: settings.jev.model,
            expectedSnapshot: settings.jev.expectedSnapshot,
          },
          { state: input.state, questions: input.questions },
          { fetch, signal: controller.signal, now },
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
      }

      const status = result.httpStatus;
      if (status === 429 || status === 529) {
        pausedUntilMs = now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
      } else if (!result.outcome.ok && result.outcome.reason === 'error' && status === undefined) {
        pausedUntilMs = now() + DEFAULT_CONNECTIVITY_COOLDOWN_MS;
      }
      if (!result.outcome.ok) {
        log.warn('Jev decision failed; the caller answers locally', {
          siteId: input.siteId,
          reason: result.outcome.reason,
          ...(status !== undefined ? { httpStatus: status } : {}),
        });
      }
      await recordUsage(input, settings.jev.model, startedAtMs, result);
      return result.outcome;
    },
  };
}

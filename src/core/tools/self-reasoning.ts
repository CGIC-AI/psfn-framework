import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { CorrelationMetadata, ModelThinkingEffort } from '../../shared/contracts/runtime.js';
import { MODEL_THINKING_EFFORT_VALUES } from '../../shared/contracts/runtime.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { isModelThinkingEffort } from '../../system/config/reasoning-effort-config.js';
import {
  REASONING_OVERRIDE_SCOPES,
  type ReasoningOverrideScope,
} from '../agent/reasoning-effort/overrides.js';
import type { ReasoningEffortRuntime } from '../agent/reasoning-effort/runtime.js';
import { textResult, textResultWithError } from './results.js';

export const SELF_REASONING_ACTIONS = ['reasoning_read', 'reasoning_set', 'reasoning_clear'] as const;
export type SelfReasoningAction = (typeof SELF_REASONING_ACTIONS)[number];

export interface SelfReasoningParams {
  action: SelfReasoningAction;
  level?: ModelThinkingEffort;
  scope?: ReasoningOverrideScope;
}

export type SelfReasoningPort = Pick<
  ReasoningEffortRuntime,
  'boundCandidate' | 'reasoningSupport' | 'decide' | 'setOverride' | 'clearOverride'
>;

const SCOPE_GUIDANCE: Record<ReasoningOverrideScope, string> = {
  turn: 'the rest of this turn',
  session: 'this conversation or own-time session until changed',
  lane: 'every call on this lane until changed',
};

function parseScope(value: unknown): ReasoningOverrideScope {
  if (typeof value !== 'string' || !(REASONING_OVERRIDE_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`scope must be one of: ${REASONING_OVERRIDE_SCOPES.join(', ')}`);
  }
  return value as ReasoningOverrideScope;
}

function assertParams(params: unknown, action: SelfReasoningAction, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(params)) throw new Error(`self_status ${action} params must be an object`);
  assertNoUnknownKeys(params, ['action', ...allowed], `self_status ${action} params`);
  return params;
}

function describe(port: SelfReasoningPort, context: Partial<CorrelationMetadata> | undefined): Record<string, unknown> {
  const candidate = port.boundCandidate(context);
  if (!candidate) return { status: 'unavailable', reason: 'no model is bound to this turn' };
  const support = port.reasoningSupport(candidate);
  const decision = port.decide(candidate, context);
  return {
    model: `${candidate.provider}/${candidate.model}`,
    canReason: support.reasoning && support.levels.length > 0,
    supportedLevels: [...support.levels],
    ...(decision
      ? {
          lane: decision.lane,
          level: decision.effective ?? null,
          requested: decision.requested,
          source: decision.source,
          ...(decision.overrideScope ? { chosenFor: decision.overrideScope } : {}),
        }
      : { lane: null, level: null, note: 'this channel has no reasoning lane; the slot tuning applies' }),
    scopes: SCOPE_GUIDANCE,
  };
}

/**
 * The companion reads and chooses its own reasoning effort. The choice is
 * bounded only by what the bound model supports; there is no operator cap.
 */
export function executeSelfReasoningAction(input: {
  port: SelfReasoningPort;
  params: SelfReasoningParams;
}): AgentToolResult<{ isError?: boolean }> {
  const context = getRequestContext();
  const { action } = input.params;
  try {
    if (action === 'reasoning_read') {
      assertParams(input.params, action, []);
      return textResult(JSON.stringify({ action, ...describe(input.port, context) }, null, 2));
    }
    const candidate = input.port.boundCandidate(context);
    if (!candidate) {
      return textResultWithError(`self_status ${action} failed: no model is bound to this turn.`, true);
    }
    if (action === 'reasoning_clear') {
      const params = assertParams(input.params, action, ['scope']);
      const scope = parseScope(params.scope);
      const change = input.port.clearOverride(scope, candidate, context);
      return textResult(JSON.stringify({
        action,
        cleared: change !== null,
        ...describe(input.port, context),
      }, null, 2));
    }
    const params = assertParams(input.params, action, ['level', 'scope']);
    const rawLevel = typeof params.level === 'string' ? params.level.trim().toLowerCase() : params.level;
    if (!isModelThinkingEffort(rawLevel)) {
      throw new Error(`level must be one of: ${MODEL_THINKING_EFFORT_VALUES.join(', ')}`);
    }
    const scope = parseScope(params.scope);
    const result = input.port.setOverride({ level: rawLevel, scope }, candidate, context);
    if (!result.ok) {
      const detail = {
        model_cannot_reason: 'the bound model cannot reason, so no effort reaches it',
        level_unsupported: `the bound model accepts only: ${result.supportedLevels.join(', ')}`,
        no_lane: 'this channel has no reasoning lane',
        no_turn: 'there is no current turn to scope this to',
        no_session: 'there is no current session to scope this to',
      }[result.reason];
      return textResultWithError(`self_status reasoning_set refused: ${detail}.`, true);
    }
    return textResult(JSON.stringify({
      action,
      lane: result.change.lane,
      level: result.decision.effective ?? null,
      previousLevel: result.change.previousLevel,
      scope,
      lasts: SCOPE_GUIDANCE[scope],
      supportedLevels: [...result.change.supportedLevels],
    }, null, 2));
  } catch (error) {
    return textResultWithError(
      `self_status ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

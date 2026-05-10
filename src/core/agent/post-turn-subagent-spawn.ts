import {
  POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
  type PostTurnActionHandlerResult,
  type PostTurnActionRuntime,
  type PostTurnSubagentSpawnPayload,
  type PostTurnSubagentSpawnPolicy,
  type PostTurnSubagentSpawnQueuedStatus,
  type PostTurnSubagentSpawnResultStatus,
} from './post-turn-action-runtime.js';
import {
  normalizeBoundedSubagentLaunchRequest,
  type SubagentExecutionPort,
} from './substrate-agent/bounded-subagent-contract.js';
import { RUNTIME_LANE_CLASSES } from './worker-lanes.js';
import { isRecord } from '../../shared/utils/types.js';

export interface RegisterPostTurnSubagentSpawnRuntimeOptions {
  postTurnActions: PostTurnActionRuntime;
  subagentExecutionPort: SubagentExecutionPort;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.floor(value);
}

function requirePostTurnSubagentSpawnPolicy(payload: Record<string, unknown>): PostTurnSubagentSpawnPolicy {
  const policy = payload.policy;
  if (!isRecord(policy)) {
    throw new Error('Post-turn subagent spawn requires explicit policy.');
  }
  if (policy.mode !== 'post_turn_action_pipe' || policy.allow !== true) {
    throw new Error('Post-turn subagent spawn policy must allow mode=post_turn_action_pipe.');
  }
  if (!isRecord(policy.budget)) {
    throw new Error('Post-turn subagent spawn policy requires a budget.');
  }
  const budgetMaxTurns = normalizePositiveInteger(policy.budget.maxTurns);
  if (budgetMaxTurns === undefined) {
    throw new Error('Post-turn subagent spawn budget.maxTurns must be a positive integer.');
  }
  return {
    mode: 'post_turn_action_pipe',
    allow: true,
    budget: {
      maxTurns: budgetMaxTurns,
    },
  };
}

export function normalizePostTurnSubagentSpawnPayload(
  payload: Record<string, unknown>,
): PostTurnSubagentSpawnPayload {
  const policy = requirePostTurnSubagentSpawnPolicy(payload);
  if (!isRecord(payload.request)) {
    throw new Error('Post-turn subagent spawn requires request payload.');
  }

  const requestedMaxTurns = Object.hasOwn(payload.request, 'maxTurns')
    ? normalizePositiveInteger(payload.request.maxTurns)
    : undefined;
  if (Object.hasOwn(payload.request, 'maxTurns') && requestedMaxTurns === undefined) {
    throw new Error('Post-turn subagent spawn request.maxTurns must be a positive integer.');
  }
  const maxTurns = requestedMaxTurns ?? policy.budget.maxTurns;
  if (maxTurns > policy.budget.maxTurns) {
    throw new Error('Post-turn subagent spawn request exceeds policy budget.maxTurns.');
  }

  const request = normalizeBoundedSubagentLaunchRequest({
    ...payload.request,
    maxTurns,
  });
  return {
    request,
    policy,
  };
}

function summarizeSubagentSpawnResult(
  summary: Awaited<ReturnType<SubagentExecutionPort['executeSubagent']>>,
): PostTurnSubagentSpawnResultStatus {
  return {
    subagentId: summary.subagentId,
    name: summary.name,
    lifecycleState: summary.lifecycleState,
    health: summary.health,
    stateReason: summary.stateReason,
    ...(summary.failureReason ? { failureReason: summary.failureReason } : {}),
    model: summary.model,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    durationMs: summary.durationMs,
    turns: summary.turns,
  };
}

export function resolvePostTurnSubagentSpawnQueuedStatus(
  payload: Record<string, unknown>,
): PostTurnSubagentSpawnQueuedStatus | undefined {
  if (!isRecord(payload.policy)) {
    return undefined;
  }
  const request = isRecord(payload.request) ? payload.request : {};
  const budget = isRecord(payload.policy.budget) ? payload.policy.budget : {};
  const requestName = typeof request.name === 'string' && request.name.trim()
    ? request.name.trim()
    : undefined;
  const policyMode = typeof payload.policy.mode === 'string' && payload.policy.mode.trim()
    ? payload.policy.mode.trim()
    : undefined;
  const budgetMaxTurns = normalizePositiveInteger(budget.maxTurns);
  const requestedMaxTurns = normalizePositiveInteger(request.maxTurns);
  return {
    ...(requestName ? { requestName } : {}),
    ...(policyMode ? { policyMode } : {}),
    policyAllowed: payload.policy.allow === true,
    ...(budgetMaxTurns !== undefined ? { budgetMaxTurns } : {}),
    ...(requestedMaxTurns !== undefined ? { requestedMaxTurns } : {}),
  };
}

export function registerPostTurnSubagentSpawnRuntime(
  input: RegisterPostTurnSubagentSpawnRuntimeOptions,
): () => void {
  return input.postTurnActions.registerHandler(
    POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
    async (action): Promise<PostTurnActionHandlerResult> => {
      const normalized = normalizePostTurnSubagentSpawnPayload(action.payload);
      const summary = await input.subagentExecutionPort.executeSubagent(normalized.request);
      const subagentSpawn = summarizeSubagentSpawnResult(summary);
      return {
        detail: `subagent ${subagentSpawn.name} completed with ${subagentSpawn.lifecycleState}/${subagentSpawn.health}`,
        subagentSpawn,
      };
    },
    {
      executionMode: 'background',
      runtimeClass: RUNTIME_LANE_CLASSES.backgroundContinuation,
    },
  );
}

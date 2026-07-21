import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { MemoryProvider } from '../../core/agent/contracts.js';
import { textResultWithError } from '../../core/tools/results.js';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { MemoryType } from '../memory/types.js';
import { normalizeMemoryTypeValue } from '../memory/types.js';
import {
  isEmotionalOrRelationalShardMemory,
  parseShardMemoryTags,
  resolveStagedShardMemoryOutputs,
  type StagedShardMemoryOutput,
} from '../shards/output-review.js';
import type { ShardFoldReviewRecordInput } from '../shards/fold-review.js';
import type { ShardResultLineageEnvelope } from '../shards/result-lineage.js';

/**
 * c7d — subagent memory-write governance (charter 6.11, Law 37).
 *
 * Bounded-ness and write-trust are different axes: the toolset a subagent
 * resolves from the deployment tier never implies canonical write trust.
 * Writes are opt-in per spawn; procedural/task-scoped writes pass through
 * provenance-stamped; emotional/relational/boundary (or undeterminable)
 * writes from non-elevated subagents stage as shard fold-review candidates
 * instead of writing directly; deletion is never available.
 */

/** Opt-in spawn capability token that enables governed subagent memory writes. */
export const SUBAGENT_MEMORY_WRITE_CAPABILITY = 'memory.write';
/** Provenance tag stamped onto every staged subagent memory candidate. */
export const SUBAGENT_ORIGIN_PROVENANCE_TAG = 'subagent_origin';
/** blockedCorePromotionReason recorded on staged subagent candidates. */
export const SUBAGENT_MEMORY_STAGED_REASON = 'subagent_restricted_memory_requires_fold_review';

// Same internal param the memory tool already reads to build sourceRef /
// provenance for non-core writers (see extractInternalSource in memory/tools.ts).
const INTERNAL_SOURCE_PARAM = '__psfnShardSource';

const READ_ACTIONS: ReadonlySet<string> = new Set([
  'search',
  'shared_background',
  'census',
  'exists',
  'timeline',
]);
// Delete-class canonical mutations: never available from a subagent context,
// at any tier or elevation (redact/restore are delete adjacency: redaction
// soft-deletes the source, restore resurrects a soft-deleted memory).
const DELETE_CLASS_ACTIONS: ReadonlySet<string> = new Set(['redact', 'delete', 'restore']);

/** Memory classes where core remains authoritative (mirrors shard fold-back, charter 6.13). */
const RESTRICTED_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  'emotional',
  'relational',
  'boundary',
]);
const BOUNDARY_TAG_HINT = /boundary|consent/;
const RESTRICTED_CONTENT_HINTS: readonly RegExp[] = [
  /\bchildhood\b/iu,
  /\bupbringing\b/iu,
  /\b(?:grew|growing)\s+up\b/iu,
  /\b(?:as|when)\s+(?:i|you|they|he|she|the\s+operator|the\s+partner)\s+(?:was|were)\s+(?:an?\s+)?(?:child|kid|teenager)\b/iu,
  /\b(?:trauma|traumatic|abuse|grief|grieving|bereavement|heartbreak)\b/iu,
];

export interface SubagentMemoryWriteElevation {
  reason: string;
}

export type SubagentMemoryWritePolicy =
  | { mode: 'none' }
  | { mode: 'governed' }
  | { mode: 'elevated'; reason: string };

export interface SubagentFoldReviewPort {
  recordPendingMemoryCandidates(
    input: ShardFoldReviewRecordInput & { outputs: readonly StagedShardMemoryOutput[] },
  ): Promise<unknown>;
}

export interface SubagentMemoryAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface SubagentMemoryGovernanceContext {
  subagentId: string;
  subagentName: string;
  channelId: string;
  task: string;
  policy: SubagentMemoryWritePolicy;
  /**
   * Lazily resolved so a lineage failure denies the individual mutation
   * (fail closed) instead of failing read-only runs that never write.
   */
  resolveLineage: () => ShardResultLineageEnvelope;
  foldReview: SubagentFoldReviewPort | null;
  auditTrail: SubagentMemoryAuditTrail | null;
}

/**
 * Write-tier ceiling for a spawn, independent of the deployment capability
 * tier. Default is no write access; the `memory.write` capability token opts
 * into governed writes; an explicit elevation (validated non-empty reason)
 * grants direct restricted-class writes and must be audit-trailed by the
 * caller at spawn time.
 */
export function resolveSubagentMemoryWritePolicy(input: {
  capabilities: readonly string[];
  memoryWriteElevation?: SubagentMemoryWriteElevation;
}): SubagentMemoryWritePolicy {
  if (input.memoryWriteElevation) {
    const reason = input.memoryWriteElevation.reason.trim();
    if (!reason) {
      throw new Error('Subagent memory-write elevation requires a non-empty reason.');
    }
    return { mode: 'elevated', reason };
  }
  return input.capabilities.includes(SUBAGENT_MEMORY_WRITE_CAPABILITY)
    ? { mode: 'governed' }
    : { mode: 'none' };
}

/**
 * Restricted classes reuse the canonical memory taxonomy plus the shard
 * fold-back classifier — no new classifier. An undeterminable type is the
 * restricted class (fail closed).
 */
export function isRestrictedSubagentMemoryCandidate(
  type: MemoryType | undefined,
  tags: readonly string[],
  text = '',
): boolean {
  if (!type) return true;
  if (RESTRICTED_MEMORY_TYPES.has(type)) return true;
  if (isEmotionalOrRelationalShardMemory(type, tags)) return true;
  if (tags.some(tag => BOUNDARY_TAG_HINT.test(tag))) return true;
  return RESTRICTED_CONTENT_HINTS.some(pattern => pattern.test(text));
}

/**
 * Explicit allow-list facade over the MemoryProvider contract. The live
 * provider instance behind the interface may expose write/delete surfaces
 * beyond the contract; a subagent loop only ever receives these read
 * methods — any method not forwarded here does not exist on the facade.
 */
export function createSubagentMemoryProviderFacade(provider: MemoryProvider): MemoryProvider {
  const facade: MemoryProvider = {
    retrieve: provider.retrieve.bind(provider),
  };
  if (provider.createTurnRetrievalQueryEmbedding) {
    facade.createTurnRetrievalQueryEmbedding = provider.createTurnRetrievalQueryEmbedding.bind(provider);
  }
  if (provider.getActiveMemoryContext) {
    facade.getActiveMemoryContext = provider.getActiveMemoryContext.bind(provider);
  }
  if (provider.refreshActiveMemoryContext) {
    facade.refreshActiveMemoryContext = provider.refreshActiveMemoryContext.bind(provider);
  }
  if (provider.captureTurnMemorySnapshot) {
    facade.captureTurnMemorySnapshot = provider.captureTurnMemorySnapshot.bind(provider);
  }
  return facade;
}

/**
 * Wraps the canonical `memory` tool for injection into a subagent loop.
 * Method-by-method policy (an unhandled action is a denied action):
 * - reads (search/shared_background/census/exists/timeline): pass through
 * - write: denied without opt-in; governed → procedural/task classes pass
 *   through provenance-stamped, restricted classes stage as fold-review
 *   candidates; elevated → direct stamped write, audit-trailed
 * - import: same policy; a batch containing any restricted record stages
 *   atomically (no partial import)
 * - patch: elevated only
 * - redact/delete/restore: denied at every tier and elevation
 * - unknown action: denied
 */
export function createGovernedSubagentMemoryTool(
  tool: AgentTool<any>,
  context: SubagentMemoryGovernanceContext,
): AgentTool<any> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const action = resolveAction(params);
      if (action !== null && READ_ACTIONS.has(action)) {
        return tool.execute(toolCallId, params as Parameters<typeof tool.execute>[1], signal);
      }
      return executeGovernedMutation(tool, context, toolCallId, action, params, signal);
    },
  };
}

function resolveAction(params: unknown): string | null {
  if (!isRecord(params)) return null;
  if (typeof params.action !== 'string') return null;
  const normalized = params.action.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function denyMutation(
  tool: AgentTool<any>,
  context: SubagentMemoryGovernanceContext,
  toolCallId: string,
  action: string | null,
  reason: string,
  message: string,
): AgentToolResult<{ isError?: boolean }> {
  context.auditTrail?.append('subagent.memory.mutation.denied', {
    subagentId: context.subagentId,
    subagentName: context.subagentName,
    toolName: tool.name,
    toolCallId,
    action: action ?? 'unknown',
    policyMode: context.policy.mode,
    reason,
  });
  return textResultWithError(message, true, {
    errorClass: 'policy_blocked',
    retryHint: 'do_not_retry',
  });
}

async function executeGovernedMutation(
  tool: AgentTool<any>,
  context: SubagentMemoryGovernanceContext,
  toolCallId: string,
  action: string | null,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<any>> {
  if (action === null) {
    return denyMutation(tool, context, toolCallId, action, 'unknown_action',
      'Error: unrecognized memory action from a subagent context is denied (fail closed).');
  }
  if (DELETE_CLASS_ACTIONS.has(action)) {
    return denyMutation(tool, context, toolCallId, action, 'delete_never_available',
      `Error: memory ${action} is never available from a subagent context, at any tier or elevation (charter 6.11).`);
  }
  if (action !== 'write' && action !== 'import' && action !== 'patch') {
    return denyMutation(tool, context, toolCallId, action, 'unsupported_action',
      `Error: memory action "${action}" is not available from a subagent context (fail closed).`);
  }
  if (context.policy.mode === 'none') {
    return denyMutation(tool, context, toolCallId, action, 'memory_write_not_granted',
      'Error: subagent memory writes are opt-in. Spawn the subagent with the "memory.write" capability '
      + '(or an explicit audited memory-write elevation) to enable them.');
  }
  if (action === 'patch') {
    if (context.policy.mode !== 'elevated') {
      return denyMutation(tool, context, toolCallId, action, 'patch_requires_elevation',
        'Error: memory patch mutates canonical memory and requires an explicit per-spawn '
        + 'memory-write elevation from a subagent context.');
    }
    return executeStampedMutation(tool, context, toolCallId, action, params, signal);
  }
  if (context.policy.mode === 'elevated') {
    return executeStampedMutation(tool, context, toolCallId, action, params, signal);
  }
  if (!isRecord(params)) {
    return denyMutation(tool, context, toolCallId, action, 'invalid_params',
      'Error: memory mutation parameters must be an object.');
  }

  if (action === 'write') {
    const type = normalizeMemoryTypeValue(params.type);
    const tags = parseShardMemoryTags(params.tags);
    const text = typeof params.text === 'string' ? params.text : '';
    if (!isRestrictedSubagentMemoryCandidate(type, tags, text)) {
      return executeStampedMutation(tool, context, toolCallId, action, params, signal);
    }
    return stageForFoldReview(tool, context, toolCallId, action, params);
  }

  const records = Array.isArray(params.records) ? params.records : null;
  if (!records || records.length === 0) {
    return denyMutation(tool, context, toolCallId, action, 'invalid_import_batch',
      'Error: records must be a non-empty array');
  }
  const classified = records.map(classifyImportRecord);
  if (classified.some(record => !record.valid)) {
    return denyMutation(tool, context, toolCallId, action, 'invalid_import_record',
      'Error: every import record from a subagent context must declare non-empty text and a '
      + 'valid memory type (fail closed).');
  }
  if (classified.every(record => !record.restricted)) {
    return executeStampedMutation(tool, context, toolCallId, action, params, signal);
  }
  // Any restricted record stages the entire batch (atomic; no partial import).
  return stageForFoldReview(tool, context, toolCallId, action, params);
}

function classifyImportRecord(record: unknown): { valid: boolean; restricted: boolean } {
  if (!isRecord(record)) return { valid: false, restricted: true };
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const type = normalizeMemoryTypeValue(record.type);
  if (!text || !type) return { valid: false, restricted: true };
  return {
    valid: true,
    restricted: isRestrictedSubagentMemoryCandidate(type, parseShardMemoryTags(record.tags), text),
  };
}

async function executeStampedMutation(
  tool: AgentTool<any>,
  context: SubagentMemoryGovernanceContext,
  toolCallId: string,
  action: string,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<any>> {
  const stamped = isRecord(params)
    ? { ...params, [INTERNAL_SOURCE_PARAM]: `subagent:${context.subagentId}` }
    : params;
  context.auditTrail?.append(
    context.policy.mode === 'elevated'
      ? 'subagent.memory.mutation.elevated'
      : 'subagent.memory.write.direct',
    {
      subagentId: context.subagentId,
      subagentName: context.subagentName,
      toolName: tool.name,
      toolCallId,
      action,
      ...(context.policy.mode === 'elevated' ? { elevationReason: context.policy.reason } : {}),
    },
  );
  return tool.execute(toolCallId, stamped as Parameters<typeof tool.execute>[1], signal);
}

async function stageForFoldReview(
  tool: AgentTool<any>,
  context: SubagentMemoryGovernanceContext,
  toolCallId: string,
  action: string,
  params: unknown,
): Promise<AgentToolResult<any>> {
  if (!context.foldReview) {
    return denyMutation(tool, context, toolCallId, action, 'fold_review_unavailable',
      'Error: restricted-class memory candidates require the fold-review queue, which is not '
      + 'wired for this runtime. Nothing was written (fail closed).');
  }
  let lineage: ShardResultLineageEnvelope;
  try {
    lineage = context.resolveLineage();
  } catch (error) {
    return denyMutation(tool, context, toolCallId, action, 'lineage_unavailable',
      `Error: could not resolve subagent lineage for fold review: ${toErrorMessage(error)}. `
      + 'Nothing was written (fail closed).');
  }
  const stagedOutputs = resolveStagedShardMemoryOutputs(
    { channelId: context.channelId, task: context.task, lineage },
    tool.name,
    toolCallId,
    params,
    { blockedCorePromotionReason: SUBAGENT_MEMORY_STAGED_REASON },
  );
  if (stagedOutputs.length === 0) {
    // Covers the undeterminable-type restricted class: never a direct write,
    // and never a silently dropped candidate.
    return denyMutation(tool, context, toolCallId, action, 'restricted_candidate_invalid',
      'Error: restricted-class memory candidate could not be staged (memory type undetermined '
      + 'or text empty). Nothing was written (fail closed).');
  }
  const originTags = [SUBAGENT_ORIGIN_PROVENANCE_TAG, `subagent:${context.subagentId}`];
  for (const output of stagedOutputs) {
    output.provenanceTags.push(...originTags);
    output.provenance.workerKind = 'subagent';
    output.provenance.subagentId = context.subagentId;
    output.provenance.tags.push(...originTags);
  }
  try {
    await context.foldReview.recordPendingMemoryCandidates({
      shardId: context.subagentId,
      channelId: context.channelId,
      task: context.task,
      lineage,
      timestamp: Date.now(),
      outputs: stagedOutputs,
    });
  } catch (error) {
    return denyMutation(tool, context, toolCallId, action, 'fold_review_record_failed',
      `Error: staging restricted-class memory candidates failed: ${toErrorMessage(error)}. `
      + 'Nothing was written (fail closed).');
  }
  context.auditTrail?.append('subagent.memory.write.staged', {
    subagentId: context.subagentId,
    subagentName: context.subagentName,
    toolName: tool.name,
    toolCallId,
    action,
    stagedCandidateCount: stagedOutputs.length,
    blockedCorePromotionReason: SUBAGENT_MEMORY_STAGED_REASON,
  });
  const label = action === 'import' ? 'Memory import' : 'Memory write';
  return {
    content: [{
      type: 'text',
      text: `${label} staged: ${stagedOutputs.length} candidate(s) pending fold review. `
        + 'Emotional, relational, and boundary memory from a subagent context is never written '
        + 'directly; core reviews and promotes staged candidates.',
    }],
    details: {
      mutationWorkflow: 'fold_review_only',
      reviewState: 'pending',
      blockedCorePromotion: true,
      blockedCorePromotionReason: SUBAGENT_MEMORY_STAGED_REASON,
      pendingTaggedOutputCount: stagedOutputs.length,
    },
  };
}

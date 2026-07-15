import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import type {
  ShardSessionMemorySyncDecision,
  ShardSessionMemorySyncEnvelope,
} from '../../boundary/gateway/policy.js';
import { textResultWithError } from '../../core/tools/results.js';
import type { ShardFoldReviewController } from './fold-review.js';
import {
  computeShardMergeReviewBlockingReasons,
  createEmptyShardMergeReview,
  resolveStagedShardMemoryOutputs,
} from './output-review.js';
import {
  SHARD_SYNC_MEMORY_TARGET,
  SHARD_SYNC_POLICY_VERSION,
  type ShardContextPackHelper,
} from './context-pack.js';
import type { ShardRuntimeRecord } from './types.js';

const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';

export interface ShardAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface ShardToolSyncHelperDeps {
  auditTrail?: ShardAuditTrail | null;
  foldReviewController?: ShardFoldReviewController | null;
  contextPackHelper: ShardContextPackHelper;
}

export class ShardToolSyncHelper {
  constructor(private readonly deps: ShardToolSyncHelperDeps) {}

  wrapShardTool(
    tool: AgentTool<any>,
    shardId: string,
    memoryReviewContext: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  ): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        const memoryOperation = this.resolveShardToolSyncOperation(tool.name, params);
        if (memoryOperation === 'memory_write' || memoryOperation === 'memory_import_batch') {
          return this.quarantineShardMemoryMutation(
            memoryOperation,
            tool.name,
            toolCallId,
            params,
            memoryReviewContext,
          );
        }
        this.enforceShardToolSyncPolicy(tool.name, params, shardId, toolCallId);
        const scopedParams = this.applyShardSourceParams(tool.name, params, shardId);
        // scopedParams has extra shard-source fields; tool.execute expects Static<TSchema>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return tool.execute(toolCallId, scopedParams as any, signal);
      },
    };
  }

  private async quarantineShardMemoryMutation(
    operation: 'memory_write' | 'memory_import_batch',
    toolName: string,
    toolCallId: string,
    params: unknown,
    memoryReviewContext: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  ): Promise<AgentToolResult<any>> {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      const message = operation === 'memory_import_batch'
        ? 'Error: records must be a non-empty array'
        : 'Error: memory write must contain valid text and type';
      return textResultWithError(message, true);
    }

    const input = params as Record<string, unknown>;
    const rawRecords = input.records;
    if (
      operation === 'memory_import_batch'
      && (!Array.isArray(rawRecords) || rawRecords.length === 0)
    ) {
      return textResultWithError('Error: records must be a non-empty array', true);
    }

    const directPromotionDecision = this.evaluateShardMemoryPromotionPolicy(
      memoryReviewContext.lineage.shardId,
      toolCallId,
      operation,
    );
    const stagedOutputs = resolveStagedShardMemoryOutputs(
      memoryReviewContext,
      toolName,
      toolCallId,
      params,
      {
        blockedCorePromotionReason: directPromotionDecision.reason,
      },
    );
    if (stagedOutputs.length === 0) {
      const message = operation === 'memory_import_batch'
        ? 'Error: memory import batch must contain valid records'
        : 'Error: memory write must contain valid text and type';
      return textResultWithError(message, true);
    }

    const reviewTimestamp = Date.now();
    const mergeReview = createEmptyShardMergeReview(memoryReviewContext.lineage.shardId, reviewTimestamp);
    const blockingReasons = computeShardMergeReviewBlockingReasons({
      ...memoryReviewContext,
      taggedOutputs: stagedOutputs,
      mergeReview,
    });
    this.deps.auditTrail?.append(
      operation === 'memory_import_batch'
        ? 'shard.memory.import.quarantined'
        : 'shard.memory.write.quarantined',
      {
        shardId: memoryReviewContext.lineage.shardId,
        toolName,
        toolCallId,
        pendingTaggedOutputCount: stagedOutputs.length,
        blockedCorePromotionReason: directPromotionDecision.reason,
        blockingReasons,
      },
    );
    if (this.deps.foldReviewController) {
      await this.deps.foldReviewController.recordPendingMemoryCandidates({
        shardId: memoryReviewContext.lineage.shardId,
        channelId: memoryReviewContext.channelId,
        task: memoryReviewContext.task,
        lineage: memoryReviewContext.lineage,
        timestamp: reviewTimestamp,
        outputs: stagedOutputs,
      });
    }

    const summary = operation === 'memory_import_batch'
      ? `Memory import quarantined: ${stagedOutputs.length} record(s) staged as pending fold review.`
      : `Memory write quarantined: ${stagedOutputs.length} candidate(s) staged as pending fold review.`;
    return {
      content: [{ type: 'text', text: summary }],
      details: {
        mutationWorkflow: 'fold_review_only',
        reviewState: 'pending',
        blockedCorePromotion: true,
        blockedCorePromotionReason: directPromotionDecision.reason,
        directPromotionDecision,
        pendingTaggedOutputCount: stagedOutputs.length,
        blockingReasons,
        foldReview: {
          required: true,
          status: 'pending',
          validationPath: mergeReview.validationPath,
          lastUpdatedAt: reviewTimestamp,
          pendingTaggedOutputCount: stagedOutputs.length,
          blockingReasons,
          outputs: stagedOutputs,
        },
      },
    };
  }

  private evaluateShardMemoryPromotionPolicy(
    shardId: string,
    toolCallId: string,
    operation: 'memory_write' | 'memory_import_batch',
  ): ShardSessionMemorySyncDecision {
    const decision = this.deps.contextPackHelper.evaluateSyncPolicy({
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation,
      shardId,
      sourceId: `shard:${shardId}`,
      targetId: SHARD_SYNC_MEMORY_TARGET,
      idempotencyKey: this.deps.contextPackHelper.buildSyncIdempotencyKey([
        'shard_tool_sync',
        shardId,
        toolCallId,
        operation,
      ]),
      requestedAt: Date.now(),
    });
    if (decision.allowed) {
      throw new Error(
        `Shard session/memory sync unexpectedly allowed for ${operation} (${decision.reason}).`,
      );
    }
    return decision;
  }

  private enforceShardToolSyncPolicy(
    toolName: string,
    params: unknown,
    shardId: string,
    toolCallId: string,
  ): void {
    const operation = this.resolveShardToolSyncOperation(toolName, params);
    if (!operation) {
      return;
    }

    const envelope: ShardSessionMemorySyncEnvelope = {
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation,
      shardId,
      sourceId: `shard:${shardId}`,
      targetId: SHARD_SYNC_MEMORY_TARGET,
      idempotencyKey: this.deps.contextPackHelper.buildSyncIdempotencyKey([
        'shard_tool_sync',
        shardId,
        toolCallId,
        operation,
      ]),
      requestedAt: Date.now(),
    };
    const decision = this.deps.contextPackHelper.evaluateSyncPolicy(envelope);
    if (!decision.allowed) {
      throw new Error(
        `Shard session/memory sync denied for ${toolName} (${decision.reason}).`,
      );
    }
  }

  private resolveShardToolSyncOperation(
    toolName: string,
    params: unknown,
  ): ShardSessionMemorySyncEnvelope['operation'] | null {
    if (toolName === 'memory') {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return null;
      }
      const paramRecord = params as Record<string, unknown>;
      const action = typeof paramRecord.action === 'string'
        ? paramRecord.action.trim().toLowerCase()
        : '';
      if (action === 'write') return 'memory_write';
      if (action === 'import') return 'memory_import_batch';
      if (
        action === 'patch'
        || action === 'redact'
        || action === 'delete'
        || action === 'restore'
      ) {
        return 'memory_redact';
      }
      return null;
    }
    if (
      toolName !== 'memory_write'
      && toolName !== 'memory_import_batch'
      && toolName !== 'memory_redact'
    ) {
      return null;
    }
    return toolName;
  }

  private applyShardSourceParams(
    toolName: string,
    params: unknown,
    shardId: string,
  ): unknown {
    if (toolName === 'memory') {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return params;
      }
      const paramRecord = params as Record<string, unknown>;
      const action = typeof paramRecord.action === 'string'
        ? paramRecord.action.trim().toLowerCase()
        : '';
      if (action !== 'write') {
        return params;
      }
      return {
        ...(params as Record<string, unknown>),
        [INTERNAL_SHARD_SOURCE_PARAM]: `shard:${shardId}`,
      };
    }
    if (
      toolName !== 'memory_write'
      && toolName !== 'memory_import_batch'
      && toolName !== 'memory_redact'
    ) {
      return params;
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return params;
    }

    return {
      ...(params as Record<string, unknown>),
      [INTERNAL_SHARD_SOURCE_PARAM]: `shard:${shardId}`,
    };
  }
}

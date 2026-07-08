export const COMPLETION_HANDOFF_SCHEMA_VERSION = 1;
export const COMPLETION_HANDOFF_METADATA_TYPE = 'completion_handoff';

export type CompletionHandoffSource =
  | 'subagent'
  | 'shard'
  | 'post_turn_action'
  | 'background_continuation'
  | 'scheduled_loop';

export type CompletionHandoffStatus =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'partial'
  | 'interrupted';

export interface CompletionHandoffRef {
  kind: string;
  ref: string;
  label?: string;
  policy?: string;
}

export interface CompletionHandoffBlocker {
  reason: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CompletionHandoffOrigin {
  originatingTaskId?: string;
  originatingBeadId?: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  requestId?: string;
  turnId?: string;
}

export interface CompletionHandoffInput {
  source: CompletionHandoffSource;
  taskId: string;
  taskLabel?: string;
  subagentId?: string;
  shardId?: string;
  status: CompletionHandoffStatus;
  resultSummary?: string;
  artifactRefs?: readonly CompletionHandoffRef[];
  outputRefs?: readonly CompletionHandoffRef[];
  validationPerformed?: readonly string[];
  blocker?: CompletionHandoffBlocker;
  partialResult: boolean;
  recommendedNextAction: string;
  origin?: CompletionHandoffOrigin;
  dedupeKey?: string;
  createdAt?: number;
}

export interface CompletionHandoffRecord {
  schemaVersion: typeof COMPLETION_HANDOFF_SCHEMA_VERSION;
  handoffId: string;
  dedupeKey: string;
  source: CompletionHandoffSource;
  task: {
    id: string;
    label?: string;
    subagentId?: string;
    shardId?: string;
  };
  origin: CompletionHandoffOrigin;
  status: CompletionHandoffStatus;
  result: {
    summary: string;
    partial: boolean;
  };
  refs: {
    artifacts: CompletionHandoffRef[];
    outputs: CompletionHandoffRef[];
  };
  validation: {
    performed: string[];
  };
  blocker?: CompletionHandoffBlocker;
  recommendedNextAction: string;
  privacy: {
    visibility: 'internal_companion_context';
    partnerNotification: 'policy_gated_companion_authored';
    rawWorkerCompletionForPartner: 'not_allowed';
  };
  createdAt: number;
}

export interface CompletionHandoffEmission {
  emitted: boolean;
  handoff: CompletionHandoffRecord;
  targetChannelId?: string;
  /** True when a compact companion-facing notice was buffered for the next turn. */
  noticeBuffered?: boolean;
  duplicate?: boolean;
  error?: string;
}

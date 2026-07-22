export const COMPLETION_HANDOFF_SCHEMA_VERSION = 1;
export const COMPLETION_HANDOFF_METADATA_TYPE = 'completion_handoff';

export const COMPLETION_HANDOFF_SOURCE_VALUES = [
  'subagent',
  'shard',
  'post_turn_action',
  'background_continuation',
  'scheduled_loop',
] as const;

export type CompletionHandoffSource = typeof COMPLETION_HANDOFF_SOURCE_VALUES[number];

export const COMPLETION_HANDOFF_STATUS_VALUES = [
  'started',
  'progress',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'folded_back',
  'partial',
  'interrupted',
] as const;

export type CompletionHandoffStatus = typeof COMPLETION_HANDOFF_STATUS_VALUES[number];

export type CompletionHandoffDelivery =
  | {
      status: 'delivered';
    }
  | {
      status: 'failed';
      error: string;
    };

export function isCompletionHandoffSource(value: unknown): value is CompletionHandoffSource {
  return typeof value === 'string'
    && COMPLETION_HANDOFF_SOURCE_VALUES.some(candidate => candidate === value);
}

export function isCompletionHandoffStatus(value: unknown): value is CompletionHandoffStatus {
  return typeof value === 'string'
    && COMPLETION_HANDOFF_STATUS_VALUES.some(candidate => candidate === value);
}

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
  logicalSessionId?: string;
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
    partnerNotification: 'companion_mediated_only';
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
  /** How the internal notice reached the parent companion, when allowlisted. */
  noticeDelivery?: 'active_nudge' | 'buffered';
  duplicate?: boolean;
  error?: string;
}

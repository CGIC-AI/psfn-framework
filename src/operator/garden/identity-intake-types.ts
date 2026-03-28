export type IdentityIntakeItemStatus = 'pending' | 'committed' | 'rejected' | 'failed';
export type IdentityIntakeStageStatus = 'pending' | 'partially_committed' | 'committed' | 'rejected';
export type IdentityIntakeSourceKind = 'card' | 'chat' | 'lorebook' | 'memory';

export interface IdentityIntakeSourceSummary {
  kind: IdentityIntakeSourceKind;
  path: string;
  itemCount: number;
  note?: string;
}

export interface IdentityIntakeCardMutationRow {
  field: string;
  previous: string;
  next: string;
  changed: boolean;
}

export interface IdentityIntakeCardMutation {
  sourcePath: string;
  containerFormat: string;
  spec: string;
  warnings: string[];
  status: IdentityIntakeItemStatus;
  rows: IdentityIntakeCardMutationRow[];
}

export interface IdentityIntakeChatChunk {
  id: string;
  index: number;
  startMessage: number;
  endMessage: number;
  messageCount: number;
  estimatedTokens: number;
  status: IdentityIntakeItemStatus;
  error?: string;
}

export interface IdentityIntakeChatProposal {
  channelId: string;
  totalMessages: number;
  chunkTargetTokens: number;
  chunks: IdentityIntakeChatChunk[];
}

export interface IdentityIntakeMemoryItem {
  id: string;
  source: 'lorebook' | 'memory';
  textPreview: string;
  type: string;
  importance: number;
  salience: number;
  criticality?: number;
  mergeDecision: 'create' | 'merge';
  mergeTargetId?: string;
  existingSalience?: number;
  proposedSalience?: number;
  provenanceRefs?: string[];
  relationshipTypeHint?: string;
  relationshipUpdatePlanned?: string;
  relationshipUpdateApplied?: string;
  status: IdentityIntakeItemStatus;
  error?: string;
}

export interface IdentityIntakeReviewState {
  stageId: string;
  createdAt: number;
  updatedAt: number;
  status: IdentityIntakeStageStatus;
  sources: IdentityIntakeSourceSummary[];
  cardMutation?: IdentityIntakeCardMutation;
  chatProposal?: IdentityIntakeChatProposal;
  memoryItems: IdentityIntakeMemoryItem[];
}

export interface IdentityIntakeFlash {
  kind: 'success' | 'error';
  message: string;
}

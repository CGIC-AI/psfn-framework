import type {
  ConcernCandidateExtractionContext as MemoryConcernCandidateExtractionContext,
} from '../../faculties/memory/extraction/types.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import type {
  ActiveConcernEvidenceRef,
  ActiveConcernPriority,
  ActiveConcernVAD,
} from '../../shared/contracts/intention-contracts.js';
import type { SessionEntry } from '../session/types.js';

export type IntentionConcernCandidateExtractionContext = MemoryConcernCandidateExtractionContext;
export type ConcernCandidateSource = 'memory_extraction';
export type ConcernCandidateFollowUpHint = 'internal_only' | 'possible_follow_up';

export interface ConcernCandidateMessageContext {
  id: number;
  role: SessionEntry['role'];
  content: string;
  authorId?: string;
  authorName?: string;
  timestamp?: number;
}

export interface ConcernCandidateMemoryContext {
  id: string;
  type: PurrMemory['type'];
  text: string;
  importance: number;
  confidence: number;
  salience: number;
  sourceRef: string;
}

export interface ConcernCandidate {
  id: string;
  dedupeKey: string;
  source: ConcernCandidateSource;
  title: string;
  summary: string;
  priorityHint: ActiveConcernPriority;
  followUpHint: ConcernCandidateFollowUpHint;
  channelId: string;
  triggerReason: IntentionConcernCandidateExtractionContext['triggerReason'];
  sourceRef: string;
  sourceMessageIds: number[];
  conversationContext: ConcernCandidateMessageContext[];
  relatedMemoryContext: ConcernCandidateMemoryContext[];
  evidenceRefs: ActiveConcernEvidenceRef[];
  createdAt: string;
  contactId?: string;
  turnId?: string;
  dueAt?: string;
  formationVAD?: ActiveConcernVAD;
  /** Durable candidate concern backing this review item. */
  durableConcernId?: string;
}

import type { GroupMemorySettings } from '../../../../system/config/group-memory-config.js';
import type { EventMap } from '../../../../shared/event-bus.js';
import type {
  GroupMemoryClassificationMode,
  GroupMemoryClassificationReason,
  GroupMemoryModeSource,
  GroupMemoryParticipantWindow,
  GroupMemoryRecentParticipant,
  GroupMemoryTopologyResolution,
} from '../../../../faculties/memory/extraction/group-classifier.js';
import type {
  GroupMemoryRangeChunk,
  GroupMemoryWatermarkRecord,
} from '../../../../faculties/memory/extraction/group-ranges.js';
import type {
  GroupMemorySalienceReason,
  GroupMemorySalienceTelemetry,
} from '../../../../faculties/memory/extraction/group-salience.js';
import type {
  GroupMemoryBackfillInput,
  GroupMemoryBackfillResult,
} from '../../../../faculties/memory/extraction/group-backfill.js';

export interface AdminGroupMemoryClassificationView {
  mode: GroupMemoryClassificationMode;
  reason: GroupMemoryClassificationReason;
  topology: GroupMemoryTopologyResolution;
  configuredMemoryMode: GroupMemorySettings['memoryMode'];
  configuredMemoryModeSource: GroupMemoryModeSource;
  manualOverrideSource?: GroupMemoryModeSource;
  recentParticipantCount: number;
  recentParticipantContactIds: string[];
  recentParticipants: GroupMemoryRecentParticipant[];
  participantWindow: GroupMemoryParticipantWindow;
}

export interface AdminGroupMemoryRangeView {
  headMessageId: number | null;
  watermarkLagMessageIds: number;
  plannedChunkCount: number;
  hasDeferredBacklog: boolean;
  deferredAfterMessageId?: number;
  firstChunk?: Pick<
    GroupMemoryRangeChunk,
    | 'spanStartMessageId'
    | 'spanEndMessageId'
    | 'contextStartMessageId'
    | 'contextEndMessageId'
    | 'newEntryCount'
    | 'overlapEntryCount'
    | 'estimatedTokens'
  >;
}

export interface AdminGroupMemoryCandidateSpanView {
  startMessageId: number;
  endMessageId: number;
  contextStartMessageId: number;
  contextEndMessageId: number;
  sourceMessageIds: number[];
  newSourceMessageIds: number[];
  contextMessageIds: number[];
  score: number;
  reasons: GroupMemorySalienceReason[];
  contributingAuthorIds: string[];
  contributingContactIds: string[];
}

export interface AdminGroupMemorySalienceView {
  telemetry: GroupMemorySalienceTelemetry;
  candidateSpans: AdminGroupMemoryCandidateSpanView[];
}

export type AdminGroupMemoryExtractionTelemetry = EventMap['memory.extraction.end'];

export type AdminGroupMemoryContactProfileStatus =
  | 'profile_ready'
  | 'profile_missing'
  | 'insufficient_source_memories'
  | 'no_activity';

export interface AdminGroupMemoryContactCoverage {
  contactId: string;
  displayName?: string;
  recentMessageCount: number;
  sourceMemoryCount: number;
  subjectMemoryCount: number;
  routedMemoryCount: number;
  totalAttributedMemoryCount: number;
  profileStatus: AdminGroupMemoryContactProfileStatus;
  profileSourceMemoryCount?: number;
  profileUpdatedAt?: number;
  skipReason?: string;
}

export interface AdminGroupMemoryCoverageView {
  channelMemoryCount: number;
  activeMemoryCount: number;
  highSensitivityMemoryCount: number;
  perContact: AdminGroupMemoryContactCoverage[];
}

export interface AdminGroupMemoryChannelDiagnostics {
  channelId: string;
  sessionId?: string;
  channelType: string | null;
  messageCount: number;
  lastActivityAt?: number;
  resolvedConfig: GroupMemorySettings;
  classification: AdminGroupMemoryClassificationView;
  watermark: GroupMemoryWatermarkRecord;
  range: AdminGroupMemoryRangeView;
  salience: AdminGroupMemorySalienceView | null;
  lastExtraction: AdminGroupMemoryExtractionTelemetry | null;
  coverage: AdminGroupMemoryCoverageView;
  privacy: {
    rawTranscriptTextIncluded: false;
    memoryTextIncluded: false;
  };
}

export interface AdminGroupMemoryDiagnosticsListData {
  channels: AdminGroupMemoryChannelDiagnostics[];
  reasonCounts: Record<string, number>;
}

export interface AdminGroupMemoryService {
  listGroupMemoryDiagnostics(): Promise<AdminGroupMemoryDiagnosticsListData>;
  getGroupMemoryChannelDiagnostics(channelId: string): Promise<AdminGroupMemoryChannelDiagnostics | null>;
  runGroupMemoryBackfill(
    channelId: string,
    input: GroupMemoryBackfillInput,
  ): Promise<GroupMemoryBackfillResult>;
}

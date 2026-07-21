import type { ChannelType } from './channel-types.js';

export const ACTIVE_CONCERN_PRIORITIES = ['high', 'medium', 'low'] as const;
export type ActiveConcernPriority = typeof ACTIVE_CONCERN_PRIORITIES[number];

export const ACTIVE_CONCERN_SOURCES = ['appraisal', 'agent', 'heartbeat'] as const;
export type ActiveConcernSource = typeof ACTIVE_CONCERN_SOURCES[number];

export const ACTIVE_CONCERN_STATUSES = [
  'candidate',
  'active',
  'watching',
  'deferred',
  'blocked',
  'resolved',
  'dismissed',
  'suppressed',
] as const;
export type ActiveConcernStatus = typeof ACTIVE_CONCERN_STATUSES[number];

export const ACTIVE_CONCERN_TERMINAL_STATUSES = ['resolved', 'dismissed', 'suppressed'] as const;
export type ActiveConcernTerminalStatus = typeof ACTIVE_CONCERN_TERMINAL_STATUSES[number];

export const ACTIVE_CONCERN_SENSITIVITIES = [
  'public',
  'personal',
  'intimate',
  'confidential',
  'redacted',
] as const;
export type ActiveConcernSensitivity = typeof ACTIVE_CONCERN_SENSITIVITIES[number];

export const ACTIVE_CONCERN_OWNERS = ['companion', 'operator', 'system'] as const;
export type ActiveConcernOwner = typeof ACTIVE_CONCERN_OWNERS[number];

export const ACTIVE_CONCERN_EVIDENCE_KINDS = [
  'message',
  'turn',
  'appraisal',
  'audit_landmark',
  'operator',
  'runtime',
  'redacted',
] as const;
export type ActiveConcernEvidenceKind = typeof ACTIVE_CONCERN_EVIDENCE_KINDS[number];

export interface ActiveConcernEvidenceRef {
  kind: ActiveConcernEvidenceKind;
  ref: string;
  sensitivity?: ActiveConcernSensitivity;
  redacted?: boolean;
  hash?: string;
}

export interface ActiveConcernVAD {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface ActiveConcern {
  id: string;
  text: string;
  priority: ActiveConcernPriority;
  source: ActiveConcernSource;
  status: ActiveConcernStatus;
  createdAt: string;
  expiresAt: string;
  salience: number;
  sensitivity: ActiveConcernSensitivity;
  owner: ActiveConcernOwner;
  evidenceRefs: ActiveConcernEvidenceRef[];
  resolutionEvidenceRefs: ActiveConcernEvidenceRef[];
  resolvedAt?: string;
  resolutionOutcome?: string;
  contactId?: string;
  formationVAD?: ActiveConcernVAD;
  /**
   * VAD captured at the moment the concern resolved — the symmetric counterpart
   * to formationVAD. Snapshotted from the live internal emotional state by the
   * resolving path (decision or grooming). Absent on concerns that resolved
   * before this capture existed or when no current VAD was available (never
   * fabricated — charter 8.3).
   */
  resolutionVAD?: ActiveConcernVAD;
  /** Stable identity for one active-to-terminal lifecycle generation. */
  resolutionGenerationId?: string;
  lastReviewedAt?: string;
  nextReviewAt?: string;
  mergedFromIds?: string[];
  splitFromId?: string;
  /** Originating ICP root preserved across durable concern review/restart. */
  originIcpRootInitiationId?: string;
  /** Bounded, validated review input retained only while status=candidate. */
  candidateReviewSnapshot?: unknown;
}

export type PendingFollowUpPriority = 'low' | 'medium' | 'high';
export type PendingFollowUpTiming = 'immediate' | 'soon' | 'scheduled';
export type PendingFollowUpWakeCondition =
  | 'next_user_turn'
  | 'background_recheck'
  | 'sustained_negative_mood';

export interface PendingFollowUp {
  id: string;
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  createdAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: PendingFollowUpWakeCondition[];
  activatedAt?: string;
  activationReason?: string;
  dampenedAt?: string;
  dampeningReason?: string;
  /** Originating ICP root preserved across durable resurface/restart. */
  originIcpRootInitiationId?: string;
  /**
   * Live internal VAD snapshotted when the follow-up was formed (bead vw3w.3;
   * parity with ActiveConcern.formationVAD). Absent when no trusted emotion
   * telemetry was available — never fabricated.
   */
  formationVAD?: ActiveConcernVAD;
  /**
   * Live internal VAD snapshotted when the follow-up was completed (activated /
   * dequeued). The retained formation→completion pair is the follow-up's
   * emotional arc; a relief delta is `completionVAD − formationVAD`. Absent when
   * no trusted emotion telemetry was available at completion.
   */
  completionVAD?: ActiveConcernVAD;
}

export const CARE_REMINDER_KINDS = ['important_date', 'self_reminder'] as const;
export type CareReminderKind = typeof CARE_REMINDER_KINDS[number];

export const CARE_REMINDER_CLASSIFICATIONS = [
  'birthday',
  'anniversary',
  'important_date',
  'check_in',
  'self_note',
] as const;
export type CareReminderClassification = typeof CARE_REMINDER_CLASSIFICATIONS[number];

export const CARE_REMINDER_SCHEDULES = ['one_time', 'annual'] as const;
export type CareReminderSchedule = typeof CARE_REMINDER_SCHEDULES[number];

export const CARE_REMINDER_STATUSES = ['active', 'completed', 'dismissed'] as const;
export type CareReminderStatus = typeof CARE_REMINDER_STATUSES[number];

export const CARE_REMINDER_PROVENANCE_SOURCES = ['companion_appraisal', 'operator'] as const;
export type CareReminderProvenanceSource = typeof CARE_REMINDER_PROVENANCE_SOURCES[number];

export interface CareReminder {
  id: string;
  kind: CareReminderKind;
  classification: CareReminderClassification;
  title: string;
  content: string;
  schedule: CareReminderSchedule;
  status: CareReminderStatus;
  dueAt: string;
  createdAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  provenanceSource: CareReminderProvenanceSource;
  provenanceReason: string;
  contactId?: string;
  sourceMessageId?: string;
  lastActivatedAt?: string;
  activationCount: number;
  completedAt?: string;
}

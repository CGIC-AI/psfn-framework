import type { LLMProviderPort } from '../../agent/contracts.js';
import type { EmotionalSnapshot } from '../../contacts/store/emotional-baseline.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type { EmotionTelemetryValidation } from '../../emotion/telemetry-validation.js';
import type { InternalState } from '../../self-model/state.js';
import type { PendingFollowUpWakeCondition } from '../pending-follow-ups.js';
import type { ProactiveQuietHoursConfig } from '../proactive-time-gate.js';
import type {
  ChannelType,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { ActiveConcernStatus, ActiveConcernVAD } from '../concerns.js';
import type { SocialDesireOrientation } from '../social-desire.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';

export const DEFAULT_APPRAISAL_FREQUENCY = 3;
export const DEFAULT_EMOTIONAL_SHIFT_THRESHOLD = 0.35;
export const DEFAULT_RECENT_MESSAGE_COUNT = 12;
export const DEFAULT_MAX_MESSAGE_CHARS = 400;
export const DEFAULT_MAX_CONCERN_COUNT = 8;
export const DEFAULT_MAX_DECISIONS = 4;
export const DEFAULT_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_FOLLOW_UP_PENDING_DELAY_MS = 5 * 60 * 1_000;

export const DEFAULT_SYSTEM_PROMPT = [
  'Given the current emotional state and conversation, decide if autonomous follow-up actions are needed.',
  'Consider unresolved concerns, emotional needs, scheduled commitments, and relationship maintenance.',
  'Most turns should return noop unless concrete action is warranted.',
  'Return JSON only, no markdown, with shape:',
  '{"decisions":[{"type":"followUp|concern|schedule|reminder|noop","priority":"low|medium|high","reason":"string","timing":"immediate|soon|scheduled|none","dueAt":number?,"followUp":{"content":"string","channelId":"string?","channelType":"string?","contextSummary":"string?","pendingFollowUpId":"string?","concernIds":["string"]?,"wakeConditions":["next_user_turn"|"background_recheck"|"sustained_negative_mood"]?,"delivery":"internal|external?"},"concern":{"title":"string","summary":"string?","dueAt":number?,"priority":"low|medium|high?","status":"active|watching|deferred|blocked|resolved|dismissed|suppressed?"},"schedule":{"templateId":"string"},"reminder":{"kind":"important_date|self_reminder","classification":"birthday|anniversary|important_date|check_in|self_note","title":"string","content":"string","schedule":"one_time|annual","channelId":"string?","channelType":"string?"}}]}',
  'For followUp decisions, include followUp.content as a brief internal Whisper note to self, not a Participant-facing message.',
  'Set followUp.delivery to "external" ONLY when you genuinely decide to reach out to the Partner now: followUp.content then becomes the actual message you send, written in your own voice. External delivery is policy-gated (primary private channel only, rate-limited) and may be blocked. Default is "internal".',
  'If the Participant asked for a future reminder/check-in ("tomorrow", a weekday, a calendar date, or any later time), set dueAt to the earliest intended send time as epoch milliseconds in the supplied timezone. Do not use external delivery before that dueAt.',
  'When a followUp is based on supplied activeConcerns, include the exact activeConcerns ids in followUp.concernIds.',
  'Use followUp.contextSummary for the key situation to preserve if the follow-up may need to wait and be resurfaced later.',
  'Use followUp.wakeConditions only when the follow-up should stay pending until a later state cue. next_user_turn waits for the next external Participant turn, background_recheck waits for an internal/background appraisal turn, and sustained_negative_mood waits for continued notably negative mood or motivation signals.',
  'When resurfacing or refining an already pending follow-up, reuse followUp.pendingFollowUpId instead of inventing a duplicate.',
  'Use reminder decisions for durable care reminders or important dates that must survive quiet periods and restart, not for one-shot follow-ups.',
  'Write Whisper notes in first person, in the companion\'s own private voice, grounded in the supplied persona context.',
  'Whisper notes should capture what she is noticing or intends to do next, not simulate a sent message to the Participant.',
  'Never set authorId or authorName for followUp decisions. Runtime labels them as internal Whisper notes to self.',
  'For schedule decisions, include schedule.templateId and use only "daily-review" or "weekly-review"; prefer daily-review for near-term emotion, goal, experience, and care checks, and weekly-review for values/north-star review.',
  'For concern decisions, include concern.title and/or concern.summary.',
  'For reminder decisions, include reminder.title, reminder.content, reminder.kind, reminder.classification, and reminder.schedule.',
].join('\n');

export const INTENTION_FOLLOW_UP_ACTION_KIND = 'intention.follow_up';
export const INTENTION_FOLLOW_UP_AUTHOR_ID = 'system:intention';
export const INTENTION_FOLLOW_UP_AUTHOR_NAME = 'Whisper';
export const INTENTION_REMINDER_ACTION_KIND = 'intention.reminder';
export const INTENTION_OUTBOUND_MESSAGE_ACTION_KIND = 'intention.outbound_message';

export type IntentionDecisionType = 'followUp' | 'concern' | 'schedule' | 'reminder' | 'noop';
export type IntentionDecisionPriority = 'low' | 'medium' | 'high';
export type IntentionDecisionTiming = 'immediate' | 'soon' | 'scheduled' | 'none';
export type AppraisalTrigger = 'frequency' | 'emotional_shift' | 'concern_due' | 'motivation';

export interface IntentionAppraisalMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
}

export interface ActiveConcernSnapshot {
  id?: string;
  title?: string;
  summary?: string;
  status?: ActiveConcernStatus;
  dueAt?: number;
  resolvedAt?: number;
  priority?: IntentionDecisionPriority | number;
  /**
   * Emotional-arc snapshots carried into the resolved-concern prompt block
   * (vw3w.2). Populated only for recently-resolved concerns; each is present
   * only when it was actually captured (no fabrication, charter 8.4).
   */
  formationVAD?: ActiveConcernVAD;
  resolutionVAD?: ActiveConcernVAD;
}

export interface ActiveCareReminderSnapshot {
  id?: string;
  kind?: 'important_date' | 'self_reminder';
  classification?: 'birthday' | 'anniversary' | 'important_date' | 'check_in' | 'self_note';
  title?: string;
  content?: string;
  schedule?: 'one_time' | 'annual';
  dueAt?: number;
  provenanceSource?: 'companion_appraisal' | 'operator';
}

export interface ConversationTrajectorySnapshot {
  unresolvedTopics?: string[];
  summary?: string;
  turnsSinceUserReply?: number;
}

export interface IntentionFollowUpDecision {
  content: string;
  channelId?: string;
  channelType?: ChannelType;
  authorId?: string;
  authorName?: string;
  contextSummary?: string;
  wakeConditions?: PendingFollowUpWakeCondition[];
  pendingFollowUpId?: string;
  concernIds?: string[];
  requiresActiveConcern?: boolean;
  /** 'internal' (default) keeps the whisper-to-self path; 'external' requests policy-gated outbound delivery. */
  delivery?: 'internal' | 'external';
  /** Runtime-only proof that the durable scheduled-work lane owns this decision. */
  scheduledPromptId?: string;
}

export interface IntentionConcernDecision {
  title?: string;
  summary?: string;
  dueAt?: number;
  priority?: IntentionDecisionPriority;
  status?: Exclude<ActiveConcernStatus, 'candidate'>;
}

export interface IntentionScheduleDecision {
  templateId: string;
}

export interface IntentionReminderDecision {
  kind: 'important_date' | 'self_reminder';
  classification: 'birthday' | 'anniversary' | 'important_date' | 'check_in' | 'self_note';
  title: string;
  content: string;
  schedule: 'one_time' | 'annual';
  channelId?: string;
  channelType?: ChannelType;
  reminderId?: string;
}

export interface IntentionActionDecision {
  type: IntentionDecisionType;
  priority: IntentionDecisionPriority;
  reason: string;
  timing: IntentionDecisionTiming;
  dueAt?: number;
  followUp?: IntentionFollowUpDecision;
  concern?: IntentionConcernDecision;
  schedule?: IntentionScheduleDecision;
  reminder?: IntentionReminderDecision;
}

export interface IntentionAppraisalInput {
  sessionId: string;
  /** Typed parent conversation lineage for post-turn appraisal model spend. */
  icpCorrelation?: IcpConversationCorrelation;
  internalState?: InternalState | null;
  currentEmotion?: EmotionStateSnapshot | null;
  recentMessages: readonly IntentionAppraisalMessage[];
  activeConcerns?: readonly ActiveConcernSnapshot[];
  activeCareReminders?: readonly ActiveCareReminderSnapshot[];
  recentlyResolvedConcerns?: readonly ActiveConcernSnapshot[];
  contactEmotionalSnapshot?: EmotionalSnapshot | null;
  conversationTrajectory?: ConversationTrajectorySnapshot;
  triggerOverride?: 'motivation';
  motivationSignals?: readonly string[];
  now?: number;
}

export interface IntentionAppraisalConfig {
  llmProvider: LLMProviderPort;
  appraisalFrequency?: number;
  emotionalShiftThreshold?: number;
  dueSoonWindowMs?: number;
  recentMessageCount?: number;
  maxMessageChars?: number;
  maxConcernCount?: number;
  maxDecisions?: number;
  systemPrompt?: string;
  characterName?: string;
  characterPromptVariablesProvider?: () => Record<string, string>;
  onEvaluationError?: (error: unknown, context: { sessionId: string; trigger: AppraisalTrigger }) => void;
}

export interface IntentionFollowUpActionPayload {
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  content: string;
  pendingFollowUpId?: string;
  originIcpRootInitiationId?: string;
}

/**
 * Consented social-desire provenance (bead oth4.2). Presence alone grants
 * nothing: the outbound gate verifies the consentId against the live
 * single-use consent ledger and the desire record before accepting it, so a
 * fabricated block always fails closed.
 */
export interface IntentionOutboundSocialDesireProvenance {
  /** Desire record id (contactId — desires coalesce one-per-contact). */
  contactId: string;
  /** Single-use consent minted by the companion's consent moment. */
  consentId: string;
  orientation: SocialDesireOrientation;
}

/**
 * Runtime-stamped provenance for an explicit external appraisal decision.
 * The appraisal prompt makes this an exact-message, first-person companion
 * authorship decision; raw/internal appraisal output never receives this mark.
 */
export interface IntentionOutboundAppraisalFollowUpProvenance {
  /** Original concern lookup scope used when the appraisal was evaluated. */
  channelId: string;
  canonicalContactKey?: string;
}

interface IntentionOutboundMessageActionBase {
  channelId: string;
  channelType: ChannelType;
  content: string;
  reason?: string;
  /** Preserve an originating ICP root so peer-derived intentions cannot recurse. */
  originIcpRootInitiationId?: string;
}

interface IntentionOutboundLiveThreadProvenance {
  pendingFollowUpId?: string;
  concernIds?: string[];
  requiresActiveConcern?: boolean;
}

/** An explicit external appraisal decision is one independent initiator. */
interface IntentionOutboundAppraisalInitiator extends IntentionOutboundLiveThreadProvenance {
  appraisalFollowUp: IntentionOutboundAppraisalFollowUpProvenance;
  socialDesire?: never;
  personalProjectId?: never;
}

/** Social desire is independently authorized by its own exact-action ledger. */
interface IntentionOutboundSocialDesireInitiator {
  socialDesire: IntentionOutboundSocialDesireProvenance;
  appraisalFollowUp?: never;
  pendingFollowUpId?: never;
  concernIds?: never;
  requiresActiveConcern?: never;
  personalProjectId?: never;
}

/** A live-thread weighted thought carries only its independently accepted thread source. */
interface IntentionOutboundWeightedThoughtLiveThreadInitiator
  extends IntentionOutboundLiveThreadProvenance {
  appraisalFollowUp?: never;
  socialDesire?: never;
  personalProjectId?: never;
}

/** A personal-project weighted thought carries no unrelated live-thread source. */
interface IntentionOutboundPersonalProjectInitiator {
  appraisalFollowUp?: never;
  socialDesire?: never;
  pendingFollowUpId?: never;
  concernIds?: never;
  requiresActiveConcern?: never;
  /**
   * Live personal-project provenance (hrmrq.85): the outbound gate re-verifies
   * the project against the personal-project library at dispatch and fails
   * closed when it is missing, unwired, or no longer resumable.
   */
  personalProjectId: string;
}

/**
 * Mutually exclusive proactive initiators. Each source proves its own exact
 * action and cannot borrow another source's consent or liveness record.
 */
export type IntentionOutboundMessageActionPayload = IntentionOutboundMessageActionBase & (
  | IntentionOutboundAppraisalInitiator
  | IntentionOutboundSocialDesireInitiator
  | IntentionOutboundWeightedThoughtLiveThreadInitiator
  | IntentionOutboundPersonalProjectInitiator
);

export interface IntentionReminderActionPayload {
  reminderId: string;
}

export interface IntentionDecisionActionContext {
  message: Pick<SubstrateMessage, 'id' | 'channelId' | 'channelType' | 'routing'>;
  fallbackAuthorId?: string;
  fallbackAuthorName?: string;
}

export interface IntentionDecisionActionOptions {
  surfacePendingFollowUpsImmediately?: boolean;
  now?: number;
  minimumOutboundRunAt?: number;
  proactiveOutboundQuietHours?: ProactiveQuietHoursConfig | null;
  /** Original contact/session scope for live concern revalidation at dispatch. */
  appraisalConcernScope?: IntentionOutboundAppraisalFollowUpProvenance;
}

export interface SessionAppraisalState {
  turnsSinceLastAppraisal: number;
  lastEmotion: EmotionStateSnapshot | null;
}

export interface NormalizedIntentionAppraisalInput {
  sessionId: string;
  icpCorrelation: IcpConversationCorrelation | null;
  internalState: InternalState | null;
  currentEmotion: EmotionStateSnapshot | null;
  currentEmotionTelemetry: EmotionTelemetryValidation | null;
  recentMessages: IntentionAppraisalMessage[];
  activeConcerns: ActiveConcernSnapshot[];
  activeCareReminders: ActiveCareReminderSnapshot[];
  recentlyResolvedConcerns: ActiveConcernSnapshot[];
  contactEmotionalSnapshot: EmotionalSnapshot | null;
  conversationTrajectory: ConversationTrajectorySnapshot | null;
  triggerOverride: 'motivation' | null;
  motivationSignals: string[];
  now: number;
}

export interface AppraisalPersonaContext {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  messageExample?: string;
  postHistoryInstructions?: string;
  visualDescription?: string;
}

export interface ParsedDecisionResponse {
  decisions: IntentionActionDecision[];
}

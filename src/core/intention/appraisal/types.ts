import type { LLMProviderPort } from '../../agent/contracts.js';
import type { EmotionalSnapshot } from '../../contacts/store/emotional-baseline.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type { InternalState } from '../../self-model/state.js';
import type { PendingFollowUpWakeCondition } from '../pending-follow-ups.js';
import type {
  ChannelType,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';

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
  '{"decisions":[{"type":"followUp|concern|schedule|reminder|noop","priority":"low|medium|high","reason":"string","timing":"immediate|soon|scheduled|none","dueAt":number?,"followUp":{"content":"string","channelId":"string?","channelType":"string?","contextSummary":"string?","pendingFollowUpId":"string?","wakeConditions":["next_user_turn"|"background_recheck"|"sustained_negative_mood"]?,"delivery":"internal|external?"},"concern":{"title":"string","summary":"string?","dueAt":number?,"priority":"low|medium|high?","status":"open|pending|resolved?"},"schedule":{"templateId":"string","sendToDiscordOverride":boolean?},"reminder":{"kind":"important_date|self_reminder","classification":"birthday|anniversary|important_date|check_in|self_note","title":"string","content":"string","schedule":"one_time|annual","channelId":"string?","channelType":"string?"}}]}',
  'For followUp decisions, include followUp.content as a brief internal Whisper note to self, not a user-facing message.',
  'Set followUp.delivery to "external" ONLY when you genuinely decide to reach out to the primary partner now: followUp.content then becomes the actual message you send, written in your own voice. External delivery is policy-gated (primary private channel only, rate-limited) and may be blocked. Default is "internal".',
  'Use followUp.contextSummary for the key situation to preserve if the follow-up may need to wait and be resurfaced later.',
  'Use followUp.wakeConditions only when the follow-up should stay pending until a later state cue. next_user_turn waits for the next external user turn, background_recheck waits for an internal/background appraisal turn, and sustained_negative_mood waits for continued notably negative mood or motivation signals.',
  'When resurfacing or refining an already pending follow-up, reuse followUp.pendingFollowUpId instead of inventing a duplicate.',
  'Use reminder decisions for durable care reminders or important dates that must survive quiet periods and restart, not for one-shot follow-ups.',
  'Write Whisper notes in first person, in the companion\'s own private voice, grounded in the supplied persona context.',
  'Whisper notes should capture what she is noticing or intends to do next, not simulate a sent message to the user.',
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
  status?: string;
  dueAt?: number;
  resolvedAt?: number;
  priority?: IntentionDecisionPriority | number;
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
  /** 'internal' (default) keeps the whisper-to-self path; 'external' requests policy-gated outbound delivery. */
  delivery?: 'internal' | 'external';
}

export interface IntentionConcernDecision {
  title?: string;
  summary?: string;
  dueAt?: number;
  priority?: IntentionDecisionPriority;
  status?: 'open' | 'pending' | 'resolved';
}

export interface IntentionScheduleDecision {
  templateId: string;
  sendToDiscordOverride?: boolean;
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
}

export interface IntentionOutboundMessageActionPayload {
  channelId: string;
  channelType: ChannelType;
  content: string;
  reason?: string;
  pendingFollowUpId?: string;
}

export interface IntentionReminderActionPayload {
  reminderId: string;
}

export interface IntentionDecisionActionContext {
  message: Pick<SubstrateMessage, 'id' | 'channelId' | 'channelType'>;
  fallbackAuthorId?: string;
  fallbackAuthorName?: string;
}

export interface IntentionDecisionActionOptions {
  surfacePendingFollowUpsImmediately?: boolean;
}

export interface SessionAppraisalState {
  turnsSinceLastAppraisal: number;
  lastEmotion: EmotionStateSnapshot | null;
}

export interface NormalizedIntentionAppraisalInput {
  sessionId: string;
  internalState: InternalState | null;
  currentEmotion: EmotionStateSnapshot | null;
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

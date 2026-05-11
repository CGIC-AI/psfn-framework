import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { withCapabilityRequirement, type CapabilityRequirement } from '../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';
import {
  CARE_REMINDER_CLASSIFICATIONS,
  CARE_REMINDER_KINDS,
  CARE_REMINDER_SCHEDULES,
  type CareReminder,
  type CareReminderClassification,
  type CareReminderKind,
  type CareReminderSchedule,
  type CareReminderStore,
} from '../intention/care-reminders.js';
import {
  PENDING_FOLLOW_UP_PRIORITIES,
  PENDING_FOLLOW_UP_TIMINGS,
  PENDING_FOLLOW_UP_WAKE_CONDITIONS,
  type PendingFollowUp,
  type PendingFollowUpPriority,
  type PendingFollowUpTiming,
  type PendingFollowUpWakeCondition,
} from '../intention/pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../intention/pending-follow-up-store-port.js';
import type { ChannelType, PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isBusyTurnError } from '../../system/lifecycle/turn-contention.js';
import type { Scheduler } from './scheduler.js';
import {
  resolveConsolidatedReflectionTemplateId,
  type HeartbeatPolicy,
  type HeartbeatPolicyStore,
  type ReflectionDeliberationConfig,
  type ReflectionTemplate,
} from './heartbeat-policy.js';
import type { MemoryWriter } from '../../faculties/memory/writer.js';

const DEFAULT_LIST_LIMIT = 32;
const MAX_LIST_LIMIT = 200;
const MAX_SCHEDULED_TASKS = 50;

const SCHEDULE_TOOL_ACTIONS = [
  'list',
  'create_follow_up',
  'activate_follow_up',
  'create_reminder',
  'trigger_reminder',
  'list_templates',
  'update_template',
  'run_template',
  'schedule_prompt',
] as const;

type ScheduleToolActionName = (typeof SCHEDULE_TOOL_ACTIONS)[number];
type ScheduleToolAction =
  | 'list'
  | 'create_follow_up'
  | 'activate_follow_up'
  | 'create_reminder'
  | 'trigger_reminder'
  | 'list_templates'
  | 'update_template'
  | 'run_template'
  | 'schedule_prompt';

interface ScheduleTaskAgentLoop {
  handleMessage(message: {
    id: string;
    channelId: string;
    channelType: ChannelType;
    authorId: string;
    authorName: string;
    content: string;
    timestamp: Date;
  }): Promise<{ content: string }>;
  waitForIdle?(): Promise<void>;
}

interface HeartbeatRunTemplateResult {
  templateId: string;
  templateName: string;
  reflection: string;
  silent?: boolean;
  queued?: boolean;
  deferredAction?: PostTurnActionCandidate;
}

interface ScheduleToolParams {
  action?: ScheduleToolActionName;
  limit?: number;
  contact_id?: string;
  include_activated?: boolean;
  include_completed?: boolean;
  include_dismissed?: boolean;
  content?: string;
  priority?: PendingFollowUpPriority;
  timing?: PendingFollowUpTiming;
  channel_id?: string;
  channel_type?: ChannelType;
  due_at?: string;
  source_message_id?: string;
  context_summary?: string;
  wake_conditions?: PendingFollowUpWakeCondition[];
  follow_up_id?: string;
  activation_reason?: string;
  title?: string;
  kind?: CareReminderKind;
  classification?: CareReminderClassification;
  reminder_schedule?: CareReminderSchedule;
  reason?: string;
  reminder_id?: string;
  template_id?: string;
  send_to_discord?: boolean;
  defer_if_busy?: boolean;
  name?: string;
  prompt?: string;
  delay_minutes?: number;
  id?: string;
  interval_ms?: number;
  enabled?: boolean;
  internal_state_input?: boolean;
  mode?: 'standard' | 'deliberation';
  deliberation?: ReflectionDeliberationConfig;
}

export interface ScheduleToolOptions {
  scheduler: Scheduler;
  agentLoop: ScheduleTaskAgentLoop;
  sender: MessageSender;
  heartbeatPolicyStore: HeartbeatPolicyStore;
  syncReflectionTasks: () => void;
  runTemplate: (
    templateId: string,
    options?: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean },
  ) => Promise<HeartbeatRunTemplateResult>;
  heartbeatChannelId?: string;
  memoryWriter?: Pick<MemoryWriter, 'write'>;
  pendingFollowUpStore?: Pick<
    PendingFollowUpStorePort,
    'enqueue' | 'list' | 'dequeue'
  > | null;
  careReminderStore?: Pick<
    CareReminderStore,
    'create' | 'list' | 'markTriggered'
  > | null;
}

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function formatDeliberation(config?: ReflectionDeliberationConfig): string {
  if (!config) return 'default';
  const parts: string[] = [];
  if (config.maxRounds !== undefined) parts.push(`rounds=${config.maxRounds}`);
  if (config.maxTotalTokens !== undefined) parts.push(`tokens=${config.maxTotalTokens}`);
  if (config.maxWallTimeMs !== undefined) parts.push(`wall=${config.maxWallTimeMs}ms`);
  if (config.voices !== undefined && config.voices.length > 0) {
    parts.push(`voices=${config.voices.join('+')}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'default';
}

function cloneDeliberation(config: ReflectionDeliberationConfig | undefined): ReflectionDeliberationConfig | undefined {
  if (!config) return undefined;
  return {
    ...(config.maxRounds !== undefined ? { maxRounds: config.maxRounds } : {}),
    ...(config.maxTotalTokens !== undefined ? { maxTotalTokens: config.maxTotalTokens } : {}),
    ...(config.maxWallTimeMs !== undefined ? { maxWallTimeMs: config.maxWallTimeMs } : {}),
    ...(config.voices !== undefined ? { voices: [...config.voices] } : {}),
    ...(config.inputUsdPerMillionTokens !== undefined
      ? { inputUsdPerMillionTokens: config.inputUsdPerMillionTokens }
      : {}),
    ...(config.outputUsdPerMillionTokens !== undefined
      ? { outputUsdPerMillionTokens: config.outputUsdPerMillionTokens }
      : {}),
  };
}

function cloneTemplate(template: ReflectionTemplate): ReflectionTemplate {
  return {
    ...template,
    ...(template.cadence !== undefined ? { cadence: { ...template.cadence } } : {}),
    ...(template.deliberation !== undefined
      ? { deliberation: cloneDeliberation(template.deliberation) }
      : {}),
  };
}

function clonePolicy(policy: HeartbeatPolicy): HeartbeatPolicy {
  return {
    ...policy,
    templates: policy.templates.map(template => cloneTemplate(template)),
  };
}

function normalizeAction(value: unknown): ScheduleToolAction {
  if (value === undefined) return 'list';
  if (typeof value !== 'string') {
    throw new Error(`action must be one of: ${SCHEDULE_TOOL_ACTIONS.join(', ')}`);
  }
  const normalized = value.trim();
  switch (normalized) {
    case 'list':
    case 'create_follow_up':
    case 'activate_follow_up':
    case 'create_reminder':
    case 'trigger_reminder':
    case 'list_templates':
    case 'update_template':
    case 'run_template':
    case 'schedule_prompt':
      return normalized;
  }
  throw new Error(`action must be one of: ${SCHEDULE_TOOL_ACTIONS.join(', ')}`);
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeIsoTimestamp(value: unknown, fieldName: string): string {
  const normalized = normalizeNonEmptyString(value, fieldName);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeOptionalIsoTimestamp(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeIsoTimestamp(value, fieldName);
}

function normalizeChannelType(value: unknown, fieldName: string): ChannelType {
  switch (value) {
    case 'terminal':
    case 'api':
    case 'discord':
    case 'telegram':
    case 'psfn-amica':
      return value;
    default:
      throw new Error(`${fieldName} must be a supported channel type`);
  }
}

function normalizeListLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  const normalized = Math.floor(value);
  if (normalized < 1) return 1;
  return Math.min(normalized, MAX_LIST_LIMIT);
}

function normalizePriority(value: unknown): PendingFollowUpPriority {
  if (value === undefined) return 'medium';
  if (typeof value === 'string' && PENDING_FOLLOW_UP_PRIORITIES.includes(value as PendingFollowUpPriority)) {
    return value as PendingFollowUpPriority;
  }
  throw new Error(`priority must be one of: ${PENDING_FOLLOW_UP_PRIORITIES.join(', ')}`);
}

function normalizeTiming(value: unknown, dueAt: string | undefined): PendingFollowUpTiming {
  if (value === undefined) {
    return dueAt ? 'scheduled' : 'soon';
  }
  if (typeof value === 'string' && PENDING_FOLLOW_UP_TIMINGS.includes(value as PendingFollowUpTiming)) {
    return value as PendingFollowUpTiming;
  }
  throw new Error(`timing must be one of: ${PENDING_FOLLOW_UP_TIMINGS.join(', ')}`);
}

function normalizeWakeConditions(value: unknown): PendingFollowUpWakeCondition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`wake_conditions must be an array when provided`);
  }
  const normalized = [...new Set(
    value.filter((condition): condition is PendingFollowUpWakeCondition => (
      typeof condition === 'string'
      && PENDING_FOLLOW_UP_WAKE_CONDITIONS.includes(condition as PendingFollowUpWakeCondition)
    )),
  )];
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

function normalizeReminderKind(value: unknown): CareReminderKind {
  if (value === undefined) return 'self_reminder';
  if (typeof value === 'string' && CARE_REMINDER_KINDS.includes(value as CareReminderKind)) {
    return value as CareReminderKind;
  }
  throw new Error(`kind must be one of: ${CARE_REMINDER_KINDS.join(', ')}`);
}

function normalizeReminderClassification(value: unknown): CareReminderClassification {
  if (value === undefined) return 'self_note';
  if (typeof value === 'string' && CARE_REMINDER_CLASSIFICATIONS.includes(value as CareReminderClassification)) {
    return value as CareReminderClassification;
  }
  throw new Error(`classification must be one of: ${CARE_REMINDER_CLASSIFICATIONS.join(', ')}`);
}

function normalizeReminderSchedule(value: unknown): CareReminderSchedule {
  if (value === undefined) return 'one_time';
  if (typeof value === 'string' && CARE_REMINDER_SCHEDULES.includes(value as CareReminderSchedule)) {
    return value as CareReminderSchedule;
  }
  throw new Error(`reminder_schedule must be one of: ${CARE_REMINDER_SCHEDULES.join(', ')}`);
}

function mapPlannedTask(task: ReturnType<Scheduler['listTasks']>[number]) {
  const runAt = typeof task.runAt === 'number' && Number.isFinite(task.runAt)
    ? new Date(task.runAt).toISOString()
    : null;
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    state: task.state,
    runAt,
    intervalMs: task.intervalMs,
  };
}

function buildCareReminderCheckpointSummary(reminder: CareReminder): string {
  return `${reminder.title} (${reminder.classification}) due ${reminder.dueAt}`;
}

function buildCareReminderWakeReturnSummary(reminder: CareReminder): string {
  return `Return to ${reminder.channelType}:${reminder.channelId} for ${reminder.kind} reminder "${reminder.title}".`;
}

function buildPendingFollowUpCheckpointSummary(followUp: PendingFollowUp): string {
  const due = followUp.dueAt ? ` due ${followUp.dueAt}` : '';
  return `${followUp.priority} ${followUp.timing} follow-up${due}: ${followUp.content}`;
}

function buildPendingFollowUpWakeReturnSummary(followUp: PendingFollowUp): string {
  return `Resume in ${followUp.channelType}:${followUp.channelId} and surface follow-up "${followUp.content}".`;
}

function mapReminder(reminder: CareReminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    content: reminder.content,
    kind: reminder.kind,
    classification: reminder.classification,
    schedule: reminder.schedule,
    status: reminder.status,
    dueAt: reminder.dueAt,
    contactId: reminder.contactId ?? null,
    provenanceSource: reminder.provenanceSource,
    provenanceReason: reminder.provenanceReason,
    checkpointSummary: buildCareReminderCheckpointSummary(reminder),
    wakeReturnSummary: buildCareReminderWakeReturnSummary(reminder),
    activationCount: reminder.activationCount,
  };
}

function mapFollowUp(followUp: PendingFollowUp) {
  return {
    id: followUp.id,
    content: followUp.content,
    priority: followUp.priority,
    timing: followUp.timing,
    createdAt: followUp.createdAt,
    dueAt: followUp.dueAt ?? null,
    channelId: followUp.channelId,
    channelType: followUp.channelType,
    contactId: followUp.contactId ?? null,
    sourceMessageId: followUp.sourceMessageId ?? null,
    contextSummary: followUp.contextSummary ?? null,
    checkpointSummary: buildPendingFollowUpCheckpointSummary(followUp),
    wakeReturnSummary: buildPendingFollowUpWakeReturnSummary(followUp),
    wakeConditions: followUp.wakeConditions ?? [],
    activatedAt: followUp.activatedAt ?? null,
    activationReason: followUp.activationReason ?? null,
  };
}

function resolveScheduleRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : 'list';
  switch (action) {
    case '':
    case 'list':
    case 'list_templates':
      return 'identity.read';
    case 'create_follow_up':
    case 'activate_follow_up':
    case 'create_reminder':
    case 'trigger_reminder':
    case 'update_template':
    case 'run_template':
    case 'schedule_prompt':
      return 'identity.write.runtime';
    default:
      return ['identity.read', 'identity.write.runtime'];
  }
}

export function createScheduleTool(options: ScheduleToolOptions): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'schedule',
    label: 'schedule',
    description:
      'Manage time-based continuity through one schedule surface. ' +
      'Use action=list|create_follow_up|activate_follow_up|create_reminder|trigger_reminder|' +
      'list_templates|update_template|run_template|schedule_prompt.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union(
        SCHEDULE_TOOL_ACTIONS.map(action => Type.Literal(action)),
        { description: 'Schedule action. Defaults to list.' },
      )),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_LIST_LIMIT,
        description: 'Maximum number of reminders/follow-ups to return for action=list.',
      })),
      contact_id: Type.Optional(Type.String({ minLength: 1, description: 'Optional contact scope for continuity items.' })),
      include_activated: Type.Optional(Type.Boolean({ description: 'Include already activated follow-ups in action=list.' })),
      include_completed: Type.Optional(Type.Boolean({ description: 'Include completed reminders in action=list.' })),
      include_dismissed: Type.Optional(Type.Boolean({ description: 'Include dismissed reminders in action=list.' })),
      content: Type.Optional(Type.String({ minLength: 1, description: 'Follow-up or reminder content.' })),
      priority: Type.Optional(Type.Union(
        PENDING_FOLLOW_UP_PRIORITIES.map(priority => Type.Literal(priority)),
        { description: 'Follow-up priority. Defaults to medium.' },
      )),
      timing: Type.Optional(Type.Union(
        PENDING_FOLLOW_UP_TIMINGS.map(timing => Type.Literal(timing)),
        { description: 'Follow-up timing. Defaults to scheduled when due_at is set, otherwise soon.' },
      )),
      channel_id: Type.Optional(Type.String({ minLength: 1, description: 'Destination channel id for reminder/follow-up continuity.' })),
      channel_type: Type.Optional(Type.Union(
        [
          Type.Literal('terminal'),
          Type.Literal('api'),
          Type.Literal('discord'),
          Type.Literal('telegram'),
          Type.Literal('psfn-amica'),
        ],
        { description: 'Destination channel type for reminder/follow-up continuity.' },
      )),
      due_at: Type.Optional(Type.String({ minLength: 1, description: 'ISO timestamp for reminder/follow-up activation.' })),
      source_message_id: Type.Optional(Type.String({ minLength: 1, description: 'Optional source message id for provenance-safe continuity.' })),
      context_summary: Type.Optional(Type.String({ minLength: 1, description: 'Optional preserved situation summary for follow-ups.' })),
      wake_conditions: Type.Optional(Type.Array(
        Type.Union(PENDING_FOLLOW_UP_WAKE_CONDITIONS.map(condition => Type.Literal(condition))),
        { description: 'Optional follow-up wake conditions.' },
      )),
      follow_up_id: Type.Optional(Type.String({ minLength: 1, description: 'Pending follow-up id for action=activate_follow_up.' })),
      activation_reason: Type.Optional(Type.String({ minLength: 1, description: 'Optional activation reason for action=activate_follow_up.' })),
      title: Type.Optional(Type.String({ minLength: 1, description: 'Reminder title for action=create_reminder.' })),
      kind: Type.Optional(Type.Union(
        CARE_REMINDER_KINDS.map(kind => Type.Literal(kind)),
        { description: 'Reminder kind. Defaults to self_reminder.' },
      )),
      classification: Type.Optional(Type.Union(
        CARE_REMINDER_CLASSIFICATIONS.map(classification => Type.Literal(classification)),
        { description: 'Reminder classification. Defaults to self_note.' },
      )),
      reminder_schedule: Type.Optional(Type.Union(
        CARE_REMINDER_SCHEDULES.map(schedule => Type.Literal(schedule)),
        { description: 'Reminder cadence. Defaults to one_time.' },
      )),
      reason: Type.Optional(Type.String({ minLength: 1, description: 'Optional provenance or policy update reason.' })),
      reminder_id: Type.Optional(Type.String({ minLength: 1, description: 'Reminder id for action=trigger_reminder.' })),
      template_id: Type.Optional(Type.String({ minLength: 1, description: 'Heartbeat template id for template actions.' })),
      send_to_discord: Type.Optional(Type.Boolean({ description: 'Optional send override for action=run_template or action=update_template.' })),
      defer_if_busy: Type.Optional(Type.Boolean({ description: 'Whether manual template runs should defer while busy. Defaults to true.' })),
      name: Type.Optional(Type.String({ minLength: 1, description: 'Scheduled prompt name for action=schedule_prompt.' })),
      prompt: Type.Optional(Type.String({ minLength: 1, description: 'Scheduled prompt body.' })),
      delay_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 10080, description: 'Delay before a scheduled prompt fires.' })),
      id: Type.Optional(Type.String({ minLength: 1, description: 'Template id when action=update_template adds a new template.' })),
      interval_ms: Type.Optional(Type.Number({ description: 'Template interval in ms for action=update_template.' })),
      enabled: Type.Optional(Type.Boolean({ description: 'Template enabled state for action=update_template.' })),
      internal_state_input: Type.Optional(Type.Boolean({ description: 'Template internal-state prompt toggle for action=update_template.' })),
      mode: Type.Optional(Type.Union([
        Type.Literal('standard'),
        Type.Literal('deliberation'),
      ], { description: 'Template execution mode for action=update_template.' })),
      deliberation: Type.Optional(Type.Object({
        maxRounds: Type.Optional(Type.Number()),
        maxTotalTokens: Type.Optional(Type.Number()),
        maxWallTimeMs: Type.Optional(Type.Number()),
        voices: Type.Optional(Type.Array(
          Type.Union([Type.Literal('reasoning'), Type.Literal('background')]),
        )),
        inputUsdPerMillionTokens: Type.Optional(Type.Number()),
        outputUsdPerMillionTokens: Type.Optional(Type.Number()),
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ScheduleToolParams = {},
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: ScheduleToolAction;
      try {
        action = normalizeAction(params.action);
      } catch (error) {
        return textResultWithError(`schedule failed: ${errorMessage(error)}`, true);
      }

      try {
        switch (action) {
          case 'list': {
            const limit = normalizeListLimit(params.limit);
            const contactId = normalizeOptionalString(params.contact_id);
            const reminders = options.careReminderStore
              ? options.careReminderStore.list({
                ...(contactId ? { contactId } : {}),
                includeCompleted: params.include_completed === true,
                includeDismissed: params.include_dismissed === true,
                limit,
              }).map(mapReminder)
              : [];
            const followUps = options.pendingFollowUpStore
              ? (await options.pendingFollowUpStore.list({
                ...(contactId ? { contactId } : {}),
                includeActivated: params.include_activated === true,
                limit,
              })).map(mapFollowUp)
              : [];
            const plannedTasks = options.scheduler.listTasks()
              .filter(task => task.id.startsWith('planned:'))
              .map(mapPlannedTask);
            const templates = options.heartbeatPolicyStore.load().templates.map(template => ({
              id: template.id,
              name: template.name,
              enabled: template.enabled,
              intervalMs: template.intervalMs,
              sendToDiscord: template.sendToDiscord,
              internalStateInput: template.internalStateInput ?? false,
              mode: template.mode ?? 'standard',
            }));

            return textResult(JSON.stringify({
              action: 'list',
              counts: {
                reminders: reminders.length,
                followUps: followUps.length,
                plannedTasks: plannedTasks.length,
                templates: templates.length,
              },
              reminders,
              followUps,
              plannedTasks,
              templates,
            }, null, 2));
          }

          case 'create_follow_up': {
            if (!options.pendingFollowUpStore) {
              throw new Error('Pending follow-up store is unavailable');
            }
            const dueAt = normalizeOptionalIsoTimestamp(params.due_at, 'due_at');
            const created = await options.pendingFollowUpStore.enqueue({
              content: normalizeNonEmptyString(params.content, 'content'),
              priority: normalizePriority(params.priority),
              timing: normalizeTiming(params.timing, dueAt),
              channelId: normalizeNonEmptyString(params.channel_id, 'channel_id'),
              channelType: normalizeChannelType(params.channel_type, 'channel_type'),
              authorId: 'system:intention',
              authorName: 'Whisper',
              ...(dueAt ? { dueAt } : {}),
              ...(normalizeOptionalString(params.contact_id) ? { contactId: normalizeOptionalString(params.contact_id) } : {}),
              ...(normalizeOptionalString(params.source_message_id)
                ? { sourceMessageId: normalizeOptionalString(params.source_message_id) }
                : {}),
              ...(normalizeOptionalString(params.context_summary)
                ? { contextSummary: normalizeOptionalString(params.context_summary) }
                : {}),
              ...(normalizeWakeConditions(params.wake_conditions)
                ? { wakeConditions: normalizeWakeConditions(params.wake_conditions) }
                : {}),
            });
            return textResult(JSON.stringify({
              action: 'create_follow_up',
              followUp: mapFollowUp(created),
            }, null, 2));
          }

          case 'activate_follow_up': {
            if (!options.pendingFollowUpStore) {
              throw new Error('Pending follow-up store is unavailable');
            }
            const followUpId = normalizeNonEmptyString(params.follow_up_id, 'follow_up_id');
            const activationReason = normalizeOptionalString(params.activation_reason);
            const activated = await options.pendingFollowUpStore.dequeue(
              followUpId,
              activationReason ? { activationReason } : {},
            );
            if (!activated) {
              return textResultWithError(
                `No pending follow-up found for id: ${followUpId}`,
                true,
              );
            }
            return textResult(JSON.stringify({
              action: 'activate_follow_up',
              followUp: mapFollowUp(activated),
            }, null, 2));
          }

          case 'create_reminder': {
            if (!options.careReminderStore) {
              throw new Error('Care reminder store is unavailable');
            }
            const created = options.careReminderStore.create({
              kind: normalizeReminderKind(params.kind),
              classification: normalizeReminderClassification(params.classification),
              title: normalizeNonEmptyString(params.title, 'title'),
              content: normalizeNonEmptyString(params.content, 'content'),
              schedule: normalizeReminderSchedule(params.reminder_schedule),
              dueAt: normalizeIsoTimestamp(params.due_at, 'due_at'),
              channelId: normalizeNonEmptyString(params.channel_id, 'channel_id'),
              channelType: normalizeChannelType(params.channel_type, 'channel_type'),
              authorId: 'system:intention',
              authorName: 'Whisper',
              provenanceSource: 'companion_appraisal',
              provenanceReason: normalizeOptionalString(params.reason)
                ?? 'Created via schedule tool action=create_reminder.',
              ...(normalizeOptionalString(params.contact_id) ? { contactId: normalizeOptionalString(params.contact_id) } : {}),
              ...(normalizeOptionalString(params.source_message_id)
                ? { sourceMessageId: normalizeOptionalString(params.source_message_id) }
                : {}),
            });
            return textResult(JSON.stringify({
              action: 'create_reminder',
              reminder: mapReminder(created),
            }, null, 2));
          }

          case 'trigger_reminder': {
            if (!options.careReminderStore) {
              throw new Error('Care reminder store is unavailable');
            }
            const reminderId = normalizeNonEmptyString(params.reminder_id, 'reminder_id');
            const triggered = options.careReminderStore.markTriggered(reminderId);
            if (!triggered) {
              return textResultWithError(`No active reminder found for id: ${reminderId}`, true);
            }
            return textResult(JSON.stringify({
              action: 'trigger_reminder',
              reminder: mapReminder(triggered),
            }, null, 2));
          }

          case 'list_templates': {
            const policy = options.heartbeatPolicyStore.load();
            const lines = [
              `Reflection Schedule Policy (v${policy.version}, updated ${policy.updatedAt} by ${policy.updatedBy})`,
              `Templates: ${policy.templates.length}`,
              '',
            ];

            for (const template of policy.templates) {
              lines.push(`[${template.enabled ? 'ON' : 'OFF'}] ${template.id} - "${template.name}"`);
              lines.push(`  Interval: ${formatMs(template.intervalMs)}`);
              lines.push(`  Discord: ${template.sendToDiscord ? 'yes' : 'no'}`);
              lines.push(`  Mode: ${template.mode ?? 'standard'}`);
              if (template.mode === 'deliberation') {
                lines.push(`  Deliberation: ${formatDeliberation(template.deliberation)}`);
              }
              lines.push(
                `  Prompt: ${template.prompt.slice(0, 120)}${template.prompt.length > 120 ? '...' : ''}`,
              );
              lines.push('');
            }

            return textResult(lines.join('\n'));
          }

          case 'update_template': {
            const policy = options.heartbeatPolicyStore.load();
            const policyBefore = clonePolicy(policy);

            if (params.id) {
              const id = normalizeNonEmptyString(params.id, 'id');
              const name = normalizeNonEmptyString(params.name, 'name');
              const prompt = normalizeNonEmptyString(params.prompt, 'prompt');
              if (params.interval_ms === undefined) {
                return textResultWithError('interval_ms is required when adding a reflection template', true);
              }
              if (policy.templates.length >= options.heartbeatPolicyStore.maxTemplates) {
                return textResultWithError(`Max ${options.heartbeatPolicyStore.maxTemplates} templates allowed`, true);
              }
              if (policy.templates.some(template => template.id === id)) {
                return textResultWithError(`Template "${id}" already exists`, true);
              }

              const newTemplate: ReflectionTemplate = {
                id,
                name,
                prompt,
                intervalMs: params.interval_ms,
                enabled: params.enabled ?? true,
                sendToDiscord: params.send_to_discord ?? false,
                ...(params.internal_state_input !== undefined
                  ? { internalStateInput: params.internal_state_input }
                  : {}),
                mode: params.mode ?? 'standard',
                ...(params.deliberation ? { deliberation: cloneDeliberation(params.deliberation) } : {}),
              };
              const errors = options.heartbeatPolicyStore.validateNew(newTemplate);
              if (errors.length > 0) {
                return textResultWithError(
                  'Validation errors:\n' + errors.map(error => `  ${error.field}: ${error.message}`).join('\n'),
                  true,
                );
              }

              policy.templates.push(newTemplate);
              policy.version++;
              policy.updatedAt = new Date().toISOString();
              policy.updatedBy = 'agent';
              options.heartbeatPolicyStore.save(policy);
              try {
                options.syncReflectionTasks();
              } catch (error) {
                options.heartbeatPolicyStore.save(policyBefore);
                throw error;
              }

              return textResult(`Added reflection template "${id}" (${formatMs(params.interval_ms)} interval)`);
            }

            const requestedTemplateId = normalizeNonEmptyString(params.template_id, 'template_id');
            const templateId = resolveConsolidatedReflectionTemplateId(requestedTemplateId);
            const template = policy.templates.find(candidate => candidate.id === templateId);
            if (!template) {
              return textResultWithError(`Template "${requestedTemplateId}" not found`, true);
            }

            const updates: Record<string, unknown> = {};
            if (params.name !== undefined) updates.name = params.name;
            if (params.prompt !== undefined) updates.prompt = params.prompt;
            if (params.interval_ms !== undefined) updates.intervalMs = params.interval_ms;
            if (params.internal_state_input !== undefined) updates.internalStateInput = params.internal_state_input;
            if (params.mode !== undefined) updates.mode = params.mode;
            if (params.deliberation !== undefined) updates.deliberation = params.deliberation;
            if (Object.keys(updates).length > 0) {
              const errors = options.heartbeatPolicyStore.validateUpdate(updates);
              if (errors.length > 0) {
                return textResultWithError(
                  'Validation errors:\n' + errors.map(error => `  ${error.field}: ${error.message}`).join('\n'),
                  true,
                );
              }
            }

            if (params.name !== undefined) template.name = params.name;
            if (params.prompt !== undefined) template.prompt = params.prompt;
            if (params.interval_ms !== undefined) template.intervalMs = params.interval_ms;
            if (params.enabled !== undefined) template.enabled = params.enabled;
            if (params.send_to_discord !== undefined) template.sendToDiscord = params.send_to_discord;
            if (params.internal_state_input !== undefined) template.internalStateInput = params.internal_state_input;
            if (params.mode !== undefined) template.mode = params.mode;
            if (params.deliberation !== undefined) template.deliberation = cloneDeliberation(params.deliberation);

            policy.version++;
            policy.updatedAt = new Date().toISOString();
            policy.updatedBy = 'agent';
            options.heartbeatPolicyStore.save(policy);
            try {
              options.syncReflectionTasks();
            } catch (error) {
              options.heartbeatPolicyStore.save(policyBefore);
              throw error;
            }

            return textResult(
              `Updated reflection template "${template.id}" - `
              + `${template.enabled ? 'enabled' : 'disabled'}, `
              + `${formatMs(template.intervalMs)} interval, mode=${template.mode ?? 'standard'}`,
            );
          }

          case 'run_template': {
            const requestedTemplateId = normalizeNonEmptyString(params.template_id, 'template_id');
            const templateId = resolveConsolidatedReflectionTemplateId(requestedTemplateId);
            const policy = options.heartbeatPolicyStore.load();
            if (!policy.templates.some(template => template.id === templateId)) {
              return textResultWithError(`Template "${requestedTemplateId}" not found`, true);
            }

            const result = await options.runTemplate(requestedTemplateId, {
              ...(params.send_to_discord !== undefined
                ? { sendToDiscordOverride: params.send_to_discord }
                : {}),
              deferIfBusy: params.defer_if_busy ?? true,
            });
            if (result.queued) {
              const queueDetail = result.deferredAction ? 'for post-turn execution.' : 'on the deferred reflection queue.';
              return {
                content: [{
                  type: 'text',
                  text: `Queued manual reflection run "${result.templateName}" (${result.templateId}) ${queueDetail}`,
                }],
                details: {
                  ...(result.deferredAction ? { deferredAction: result.deferredAction } : {}),
                },
              };
            }

            const reflection = result.reflection.trim();
            return textResult(
              `Triggered reflection template "${result.templateName}" (${result.templateId}).\n\n`
              + (reflection || '[empty reflection output]'),
            );
          }

          case 'schedule_prompt': {
            const name = normalizeNonEmptyString(params.name, 'name');
            const prompt = normalizeNonEmptyString(params.prompt, 'prompt');
            const delayMinutes = typeof params.delay_minutes === 'number' ? params.delay_minutes : Number.NaN;
            if (!Number.isFinite(delayMinutes) || delayMinutes < 1 || delayMinutes > 10080) {
              return textResultWithError('delay_minutes must be between 1 and 10080 (7 days)', true);
            }
            if (prompt.length < 10) {
              return textResultWithError('prompt must be at least 10 characters', true);
            }

            const allTasks = options.scheduler.listTasks();
            if (allTasks.length >= MAX_SCHEDULED_TASKS) {
              return textResultWithError(`Max ${MAX_SCHEDULED_TASKS} total tasks allowed`, true);
            }

            const taskId = `planned:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const runAt = Date.now() + delayMinutes * 60_000;

            options.scheduler.register({
              id: taskId,
              name,
              type: 'one-shot',
              intervalMs: 0,
              runAt,
              handler: async () => {
                const runPlannedPrompt = async (): Promise<void> => {
                  const response = await options.agentLoop.handleMessage({
                    id: `planned-${Date.now()}`,
                    channelId: `internal:planned:${taskId}`,
                    channelType: 'terminal',
                    authorId: 'scheduler',
                    authorName: name,
                    content: prompt,
                    timestamp: new Date(),
                  });

                  if (options.heartbeatChannelId) {
                    await options.sender.send(options.heartbeatChannelId, response.content);
                  }
                };

                try {
                  await runPlannedPrompt();
                } catch (error) {
                  if (!isBusyTurnError(error)) {
                    throw error;
                  }
                  if (typeof options.agentLoop.waitForIdle !== 'function') {
                    throw error;
                  }
                  await options.agentLoop.waitForIdle();
                  await runPlannedPrompt();
                }
              },
              state: 'idle',
            });

            const fireAt = new Date(runAt).toISOString();
            return textResult(`Scheduled "${name}" to fire at ${fireAt} (in ${delayMinutes}m)`);
          }
        }
      } catch (error) {
        return textResultWithError(`schedule failed for action=${action}: ${errorMessage(error)}`, true);
      }
    },
  };

  return tagToolWithReversibility(withCapabilityRequirement(tool, resolveScheduleRequirement), 'irreversible');
}

import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import type {
  ClarificationSelection,
  ClarifyDeliverParams,
  ClarifyDeliverResult,
  NotifyNtfyParams,
  NotifyNtfyResult,
  OperatorAlertResult,
  PendingClarification,
} from '../../boundary/gateway/protocol.js';
import type { WirableTool } from '../agent/tool-wiring-validator.js';
import type {
  ExternalCommunicationChannel,
  ExternalCommunicationRateLimiter,
} from '../../system/capabilities/safeguards.js';
import { withCapabilityRequirement } from '../../system/capabilities/requirements.js';
import {
  resolveOptionalEnvCredential,
  type CredentialVaultPort,
} from '../../boundary/custody/credential-vault.js';
import type { NotificationPort } from '../../boundary/gateway/notification-port.js';
import {
  normalizeNotificationSenderMetadata,
  type NotificationSenderMetadata,
} from '../../boundary/gateway/notification-sender.js';
import { textResult, textResultWithError } from './results.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import {
  COMPANION_NOTIFY_TARGET_KIND,
  executeCompanionNotify,
} from './notify-companion-handoff.js';
import { executeCompanionCandidateConsider } from './notify-companion-candidate.js';

const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_APPROVAL_REQUEST_PRIORITY = 4;
const CLARIFY_MIN_CHOICES = 2;
const CLARIFY_MAX_CHOICES = 5;
/**
 * Upper bound the interactive channel waits for the person to answer a
 * clarification before reporting a structured no-answer. The clarify tool call
 * blocks the emitting turn for this window, so it is bounded rather than
 * open-ended.
 */
const CLARIFY_DELIVERY_TIMEOUT_MS = 120_000;
const CLARIFY_MAX_QUESTION_LENGTH = 1_000;
const CLARIFY_MAX_CHOICE_LENGTH = 200;
const COMPANION_NOTIFY_BRIEF_SENDER = Object.freeze({
  kind: 'companion',
  provenance: 'companion.notify.brief',
} satisfies NotificationSenderMetadata);
const SYSTEM_APPROVAL_REQUEST_SENDER = Object.freeze({
  kind: 'system',
  provenance: 'system.approval.request',
} satisfies NotificationSenderMetadata);

export type { NotificationPort } from '../../boundary/gateway/notification-port.js';

export type NotifyAction = 'brief' | 'send' | 'approval_request' | 'clarify';
export type NotifyDeliveryChannel = 'discord' | 'email';
export type NotifyDelivery = 'ntfy' | NotifyDeliveryChannel;
export type NtfyNotifier = NotificationPort;

export type { PendingClarification, ClarificationSelection } from '../../boundary/gateway/protocol.js';

/**
 * Channel-agnostic delivery seam for a structured clarification.
 *
 * The channel layer (sibling work) implements this port to render the ordered
 * choices — Discord buttons, a Telegram numbered list, etc. — and reports back
 * whether the clarification is still pending an answer or already resolved with
 * a {@link ClarificationSelection}. Keeping the seam abstract lets the notify
 * tool remain channel-agnostic and fail closed when no interactive channel is
 * wired.
 */
export interface ClarificationDeliveryResult {
  readonly status: 'pending' | 'resolved';
  /** Channel-agnostic label for where the clarification was delivered (e.g. discord, telegram). */
  readonly channel: string;
  /** The delivery destination within that channel. */
  readonly target: string;
  /** Present only when the channel resolved the choice synchronously. */
  readonly selection?: ClarificationSelection;
}

export interface ClarificationDeliveryPort {
  deliver(clarification: PendingClarification): Promise<ClarificationDeliveryResult>;
}

export interface NotifyChannelSender {
  send(params: {
    channel: NotifyDeliveryChannel;
    target: string;
    message: string;
  }): Promise<void>;
}

export interface NotifyApprovalRequestInput {
  id: string;
  method: string;
  approvalAction: string;
  scope: string;
  reason: string;
  expiresAt?: number;
  reviewPath?: string;
}

export interface NotifyBriefRequest {
  action: 'brief';
  message: string;
  title?: string;
  priority?: number;
  topic?: string;
  budgetChannel?: ExternalCommunicationChannel;
}

export interface NotifySendRequest {
  action: 'send';
  message: string;
  deliveryChannel: NotifyDeliveryChannel | '';
  deliveryTarget: string;
}

export interface NotifyApprovalRequest {
  action: 'approval_request';
  request: NotifyApprovalRequestInput;
}

export interface NotifyClarifyRequest {
  action: 'clarify';
  question: string;
  choices: string[];
}

export type NotifyRequest =
  | NotifyBriefRequest
  | NotifySendRequest
  | NotifyApprovalRequest
  | NotifyClarifyRequest;

/** Structured outcome of a clarify dispatch, carried back into the turn. */
export interface ClarificationDispatchOutcome {
  id: string;
  status: 'pending' | 'resolved';
  channel: string;
  target: string;
  selectedChoice?: string;
  selectedIndex?: number;
}

interface NotifyBriefDispatchResult {
  readonly action: 'brief';
  readonly status: 'sent' | 'debounced';
  readonly delivery: 'ntfy';
  readonly target: string;
  readonly messageId?: string;
}

interface NotifySendDispatchResult {
  readonly action: 'send';
  readonly status: 'sent';
  readonly delivery: NotifyDeliveryChannel;
  readonly target: string;
}

interface NotifyApprovalRequestDispatchResult {
  readonly action: 'approval_request';
  readonly status: 'sent' | 'debounced';
  readonly delivery: NotifyDelivery;
  readonly target: string;
  readonly messageId?: string;
}

interface NotifyClarifyDispatchResult {
  readonly action: 'clarify';
  readonly status: 'sent';
  readonly clarification: ClarificationDispatchOutcome;
}

export type NotifyDispatchResult =
  | NotifyBriefDispatchResult
  | NotifySendDispatchResult
  | NotifyApprovalRequestDispatchResult
  | NotifyClarifyDispatchResult;

export interface NotifyDispatcher {
  dispatch(request: NotifyRequest): Promise<NotifyDispatchResult>;
}

export interface HttpNtfyNotifierOptions {
  baseUrl?: string;
  topic?: string;
  token?: string;
  timeoutMs?: number;
  debounceWindowMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface NotifyDispatcherOptions {
  briefNotifier: NtfyNotifier;
  channelSender?: NotifyChannelSender;
  operatorDiscordChannelId?: string;
  operatorNtfyTopic?: string;
  rateLimiter?: ExternalCommunicationRateLimiter;
  defaultBudgetChannel?: ExternalCommunicationChannel;
  /**
   * Channel seam that renders a structured clarification and reports its
   * pending/resolved state. Left unwired until an interactive channel provides
   * it (sibling channel-rendering work); clarify fails closed without it.
   */
  clarificationPort?: ClarificationDeliveryPort;
}

class HttpNtfyNotifier implements NotificationPort {
  private readonly baseUrl?: string;
  private readonly topic?: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly debounceWindowMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly recentAlerts = new Map<string, number>();

  constructor(options: HttpNtfyNotifierOptions) {
    this.baseUrl = options.baseUrl?.trim() || undefined;
    this.topic = options.topic?.trim() || undefined;
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NTFY_TIMEOUT_MS;
    this.debounceWindowMs = options.debounceWindowMs ?? DEFAULT_NTFY_DEBOUNCE_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async notify(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    if (!this.baseUrl || !this.topic) {
      throw new Error('ntfy is not configured (set NTFY_BASE_URL and NTFY_TOPIC)');
    }

    const sender = normalizeNotificationSenderMetadata(params.sender);

    const message = params.message.trim();
    if (!message) {
      throw new Error('message is required');
    }

    const topic = params.topic?.trim() || this.topic;
    const title = params.title?.trim();
    const priority = this.normalizePriority(params.priority);

    const fingerprint = JSON.stringify({
      sender,
      topic,
      title: title ?? '',
      priority,
      message,
    });
    if (this.isDebounced(fingerprint)) {
      return { status: 'debounced', topic };
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (title) {
      headers.Title = toHeaderByteString(title);
    }
    if (priority !== undefined) {
      headers.Priority = String(priority);
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: message,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`ntfy request failed: ${response.status} ${response.statusText}`);
    }

    const messageId = response.headers.get('x-message-id') ?? undefined;
    return { status: 'sent', topic, ...(messageId ? { messageId } : {}) };
  }

  private normalizePriority(priority: number | undefined): number | undefined {
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return undefined;
    }
    return Math.max(1, Math.min(5, Math.trunc(priority)));
  }

  private isDebounced(fingerprint: string): boolean {
    if (this.debounceWindowMs <= 0) {
      return false;
    }

    const now = this.now();
    const minTimestamp = now - this.debounceWindowMs;
    for (const [key, lastSeenAt] of this.recentAlerts) {
      if (lastSeenAt < minTimestamp) {
        this.recentAlerts.delete(key);
      }
    }

    const previous = this.recentAlerts.get(fingerprint);
    this.recentAlerts.set(fingerprint, now);
    return previous !== undefined && now - previous < this.debounceWindowMs;
  }
}

class DefaultNotifyDispatcher implements NotifyDispatcher {
  private readonly briefNotifier: NotificationPort;
  private readonly channelSender?: NotifyChannelSender;
  private readonly operatorDiscordChannelId?: string;
  private readonly operatorNtfyTopic?: string;
  private readonly rateLimiter?: ExternalCommunicationRateLimiter;
  private readonly defaultBudgetChannel: ExternalCommunicationChannel;
  private readonly clarificationPort?: ClarificationDeliveryPort;

  constructor(options: NotifyDispatcherOptions) {
    this.briefNotifier = options.briefNotifier;
    this.channelSender = options.channelSender;
    this.operatorDiscordChannelId = options.operatorDiscordChannelId?.trim() || undefined;
    this.operatorNtfyTopic = options.operatorNtfyTopic?.trim() || undefined;
    this.rateLimiter = options.rateLimiter;
    this.defaultBudgetChannel = options.defaultBudgetChannel ?? 'discord';
    this.clarificationPort = options.clarificationPort;
  }

  async dispatch(request: NotifyRequest): Promise<NotifyDispatchResult> {
    switch (request.action) {
      case 'brief':
        return await this.sendBrief(request);
      case 'send':
        return await this.sendOutbound(request);
      case 'approval_request':
        return await this.sendApprovalRequest(request.request);
      case 'clarify':
        return await this.requestClarification(request);
      default:
        throw new Error(`unsupported notify action: ${String((request as { action?: unknown }).action)}`);
    }
  }

  private async requestClarification(request: NotifyClarifyRequest): Promise<NotifyDispatchResult> {
    if (!this.clarificationPort) {
      throw new Error('clarify is not available: no interactive channel is wired to present choices');
    }

    const clarification = validateClarifyRequest(request);
    const result = await this.clarificationPort.deliver(clarification);

    // A selection may only plumb its chosen text back into the turn when the
    // channel reports `resolved` AND the selection verifies against the
    // runtime-owned choices. Deriving the spread solely from this verified
    // value closes the latent trap where a channel returning
    // `{ status: 'pending', selection }` could leak an unverified choice into
    // the turn: verification and the spread now share one gate (resolved +
    // verified), instead of verification being gated on status while the spread
    // fired on any truthy selection.
    const verifiedSelection = result.status === 'resolved'
      ? verifyResolvedClarificationSelection(clarification, result.selection)
      : undefined;

    return {
      action: 'clarify',
      status: 'sent',
      clarification: {
        id: clarification.id,
        status: result.status,
        channel: result.channel,
        target: result.target,
        ...(verifiedSelection
          ? {
              selectedChoice: verifiedSelection.selectedChoice,
              selectedIndex: verifiedSelection.selectedIndex,
            }
          : {}),
      },
    };
  }

  private async sendBrief(request: NotifyBriefRequest): Promise<NotifyDispatchResult> {
    const message = request.message.trim();
    if (!message) {
      throw new Error('message is required');
    }

    const topic = request.topic?.trim();
    const budgetChannel = request.budgetChannel ?? this.defaultBudgetChannel;
    this.enforceRateLimit(budgetChannel, topic || 'default-topic');

    const result = await this.briefNotifier.notify({
      sender: COMPANION_NOTIFY_BRIEF_SENDER,
      message,
      title: request.title?.trim(),
      priority: request.priority,
      topic,
    });

    return {
      action: 'brief',
      status: result.status,
      delivery: 'ntfy',
      target: result.topic,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  }

  private async sendOutbound(request: NotifySendRequest): Promise<NotifyDispatchResult> {
    const message = request.message.trim();
    if (!message) {
      throw new Error('message is required');
    }
    if (!request.deliveryChannel) {
      throw new Error('delivery_channel is required');
    }

    const target = request.deliveryTarget.trim();
    if (!target) {
      throw new Error('delivery_target is required');
    }
    if (target.startsWith('internal:')) {
      throw new Error('delivery_target must reference an external channel');
    }

    if (request.deliveryChannel === 'email') {
      throw new Error('email delivery is not wired');
    }
    if (!this.channelSender) {
      throw new Error(`${request.deliveryChannel} delivery is not wired`);
    }

    this.enforceRateLimit(request.deliveryChannel, target);
    await this.channelSender.send({
      channel: request.deliveryChannel,
      target,
      message,
    });

    return {
      action: 'send',
      status: 'sent',
      delivery: request.deliveryChannel,
      target,
    };
  }

  private async sendApprovalRequest(request: NotifyApprovalRequestInput): Promise<NotifyDispatchResult> {
    return await deliverApprovalRequestNotification({
      request,
      briefNotifier: this.briefNotifier,
      channelSender: this.channelSender,
      operatorDiscordChannelId: this.operatorDiscordChannelId,
      operatorNtfyTopic: this.operatorNtfyTopic,
      rateLimiter: this.rateLimiter,
      defaultBudgetChannel: this.defaultBudgetChannel,
    });
  }

  private enforceRateLimit(channel: ExternalCommunicationChannel, scope: string): void {
    if (!this.rateLimiter) {
      return;
    }

    const rate = this.rateLimiter.evaluate({ channel, scope });
    if (rate.allowed) {
      return;
    }

    const retrySeconds = Math.max(1, Math.ceil((rate.retryAfterMs ?? 0) / 1000));
    throw new Error(
      `rate limit for ${channel} reached: ${rate.used}/${rate.limit} in the last hour; retry in ${retrySeconds}s`,
    );
  }
}

function toHeaderByteString(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  if (!normalized) return '';
  return Buffer.from(normalized, 'utf8').toString('latin1');
}

function buildContextBlockReason(): string | null {
  const requestContext = getRequestContext();
  const requestChannelId = typeof requestContext?.channelId === 'string'
    ? requestContext.channelId.trim()
    : '';
  const requestCallType = requestContext?.callType;
  if (!requestChannelId.startsWith('internal:') && requestCallType !== 'scheduled') {
    return null;
  }

  return requestCallType === 'scheduled'
    ? 'scheduled execution context'
    : `internal channel (${requestChannelId || 'unknown'})`;
}

function buildExternalSendContextBlockReason(): string | null {
  const requestContext = getRequestContext();
  if (!requestContext) {
    return 'unknown request context';
  }

  const requestChannelId = typeof requestContext.channelId === 'string'
    ? requestContext.channelId.trim()
    : '';
  if (requestContext.callType === 'scheduled') {
    return 'scheduled execution context';
  }
  if (requestChannelId.startsWith('internal:')) {
    return `internal channel (${requestChannelId})`;
  }
  if (!requestChannelId) {
    return 'unknown request channel';
  }
  if (requestContext.callType !== 'chat') {
    return `non-chat execution context (${requestContext.callType || 'unknown'})`;
  }
  if (requestContext.requesterProvenance !== 'human') {
    return requestContext.requesterProvenance
      ? `non-human requester provenance (${requestContext.requesterProvenance})`
      : 'unknown requester provenance';
  }
  if (requestContext.requestAudience !== 'external'
    && requestContext.requestAudience !== 'primary_contact') {
    return `unknown or non-external request audience (${requestContext.requestAudience || 'unknown'})`;
  }

  return null;
}

function buildNotifyToolRequest(params: NotifyToolParams): NotifyRequest {
  switch (params.action) {
    case 'brief':
      return {
        action: 'brief',
        message: (params.message as string | undefined) ?? '',
        title: params.title,
        priority: params.priority,
        topic: params.topic,
        budgetChannel: params.budget_channel,
      };
    case 'send':
      if (params.target_kind === COMPANION_NOTIFY_TARGET_KIND) {
        throw new Error('companion notify requests must use the companion handoff');
      }
      return {
        action: 'send',
        message: (params.message as string | undefined) ?? '',
        deliveryChannel: (params.delivery_channel as NotifyDeliveryChannel | undefined) ?? '',
        deliveryTarget: (params.delivery_target as string | undefined) ?? '',
      };
    case 'approval_request':
      return {
        action: 'approval_request',
        request: {
          id: (params.approval_id as string | undefined) ?? '',
          method: (params.approval_method as string | undefined) ?? '',
          approvalAction: (params.approval_action as string | undefined) ?? '',
          scope: (params.approval_scope as string | undefined) ?? '',
          reason: (params.approval_reason as string | undefined) ?? '',
          expiresAt: params.approval_expires_at,
          reviewPath: params.review_path,
        },
      };
    case 'clarify':
      return {
        action: 'clarify',
        question: (params.question as string | undefined) ?? '',
        choices: (params.choices as string[] | undefined) ?? [],
      };
    default:
      throw new Error(`unsupported notify action: ${String(params.action)}`);
  }
}

/**
 * Validate and normalize a clarify request, failing closed on any malformed
 * question or choice set. Returns the runtime-owned {@link PendingClarification}
 * (with a generated id) that the channel layer will present.
 */
export function validateClarifyRequest(request: NotifyClarifyRequest): PendingClarification {
  const question = request.question.trim();
  if (!question) {
    throw new Error('question is required');
  }
  if (question.length > CLARIFY_MAX_QUESTION_LENGTH) {
    throw new Error(`question must be at most ${CLARIFY_MAX_QUESTION_LENGTH} characters`);
  }

  if (!Array.isArray(request.choices)) {
    throw new Error('choices must be a list of options');
  }
  const choices = request.choices.map((choice) => (typeof choice === 'string' ? choice.trim() : ''));
  if (choices.some((choice) => !choice)) {
    throw new Error('every choice must be a non-empty string');
  }
  if (choices.length < CLARIFY_MIN_CHOICES) {
    throw new Error(`clarify needs at least ${CLARIFY_MIN_CHOICES} choices`);
  }
  if (choices.length > CLARIFY_MAX_CHOICES) {
    throw new Error(`clarify allows at most ${CLARIFY_MAX_CHOICES} choices`);
  }
  if (choices.some((choice) => choice.length > CLARIFY_MAX_CHOICE_LENGTH)) {
    throw new Error(`each choice must be at most ${CLARIFY_MAX_CHOICE_LENGTH} characters`);
  }
  const caseFoldedChoices = choices.map((choice) => choice.toLowerCase());
  if (new Set(caseFoldedChoices).size !== choices.length) {
    throw new Error('choices must be distinct');
  }

  return {
    id: randomUUID(),
    question,
    choices,
  };
}

/**
 * Verify a channel-reported clarification selection against the runtime-owned
 * {@link PendingClarification} before its text is allowed into the turn. Fails
 * closed (throws) on a missing selection, an id mismatch, an out-of-range index,
 * or a chosen text that does not exactly equal the delivered choice at that
 * index. Only ever called for a `resolved` delivery; the runtime never trusts a
 * selection the channel did not resolve.
 */
export function verifyResolvedClarificationSelection(
  clarification: PendingClarification,
  selection: ClarificationSelection | undefined,
): ClarificationSelection {
  if (!selection) {
    throw new Error('clarify resolution is missing the selected choice');
  }
  if (selection.clarificationId !== clarification.id) {
    throw new Error('clarify resolution references a different clarification');
  }
  if (
    !Number.isInteger(selection.selectedIndex)
    || selection.selectedIndex < 0
    || selection.selectedIndex >= clarification.choices.length
    || clarification.choices[selection.selectedIndex] !== selection.selectedChoice
  ) {
    throw new Error('clarify resolution does not match a delivered choice');
  }
  return selection;
}

function formatNotifyToolSuccess(result: NotifyDispatchResult): string {
  switch (result.action) {
    case 'brief':
      return result.status === 'debounced'
        ? `notify: brief debounced for topic "${result.target}".`
        : `notify: brief sent via ntfy to topic "${result.target}"${result.messageId ? ` (id ${result.messageId})` : ''}.`;
    case 'send':
      return `notify: send sent via ${result.delivery} to "${result.target}".`;
    case 'approval_request':
      return result.status === 'debounced'
        ? `notify: approval_request debounced for "${result.target}".`
        : `notify: approval_request sent via ${result.delivery} to "${result.target}".`;
    case 'clarify': {
      const outcome = result.clarification;
      if (outcome.status === 'resolved' && outcome.selectedChoice) {
        return `notify: clarify answered — chose "${outcome.selectedChoice}".`;
      }
      return `notify: clarify shared on ${outcome.channel}; waiting for a choice.`;
    }
    default:
      return 'notify: success.';
  }
}

function normalizeAction(value: string): NotifyAction {
  switch (value.trim()) {
    case 'brief':
      return 'brief';
    case 'send':
    case 'approval_request':
    case 'clarify':
      return value.trim() as NotifyAction;
    default:
      throw new Error(`unsupported notify action: ${value}`);
  }
}

function validateApprovalRequestInput(
  request: NotifyApprovalRequestInput,
): NotifyApprovalRequestInput {
  const normalized: NotifyApprovalRequestInput = {
    id: request.id.trim(),
    method: request.method.trim(),
    approvalAction: request.approvalAction.trim(),
    scope: request.scope.trim(),
    reason: request.reason.trim(),
    ...(typeof request.expiresAt === 'number' && Number.isFinite(request.expiresAt)
      ? { expiresAt: Math.trunc(request.expiresAt) }
      : {}),
    ...(request.reviewPath?.trim() ? { reviewPath: request.reviewPath.trim() } : {}),
  };

  if (!normalized.id) {
    throw new Error('approval_id is required');
  }
  if (!normalized.method) {
    throw new Error('approval_method is required');
  }
  if (!normalized.approvalAction) {
    throw new Error('approval_action is required');
  }
  if (!normalized.scope) {
    throw new Error('approval_scope is required');
  }
  if (!normalized.reason) {
    throw new Error('approval_reason is required');
  }
  if (normalized.expiresAt !== undefined && normalized.expiresAt <= 0) {
    throw new Error('approval_expires_at must be a positive epoch-millisecond timestamp');
  }

  return normalized;
}

function formatApprovalRequestNotification(request: NotifyApprovalRequestInput): string {
  const normalized = validateApprovalRequestInput(request);
  return [
    `Approval required: ${normalized.method} (${normalized.approvalAction})`,
    `Scope: ${normalized.scope}`,
    `Reason: ${normalized.reason}`,
    `Confirmation ID: ${normalized.id}`,
    ...(normalized.expiresAt !== undefined
      ? [`Expires: ${new Date(normalized.expiresAt).toISOString()}`]
      : []),
    `Review in admin: ${normalized.reviewPath ?? '/confirmations'}`,
  ].join('\n');
}

async function deliverApprovalRequestNotification(options: {
  request: NotifyApprovalRequestInput;
  briefNotifier: NotificationPort;
  channelSender?: NotifyChannelSender;
  operatorDiscordChannelId?: string;
  operatorNtfyTopic?: string;
  rateLimiter?: ExternalCommunicationRateLimiter;
  defaultBudgetChannel?: ExternalCommunicationChannel;
}): Promise<NotifyDispatchResult> {
  const request = validateApprovalRequestInput(options.request);
  const notification = formatApprovalRequestNotification(request);
  const operatorChannelId = options.operatorDiscordChannelId?.trim() || undefined;
  const defaultBudgetChannel = options.defaultBudgetChannel ?? 'discord';
  const errors: string[] = [];

  if (operatorChannelId) {
    try {
      if (!options.channelSender) {
        throw new Error('discord delivery is not wired');
      }
      const rate = options.rateLimiter?.evaluate({
        channel: 'discord',
        scope: operatorChannelId,
      });
      if (rate && !rate.allowed) {
        const retrySeconds = Math.max(1, Math.ceil((rate.retryAfterMs ?? 0) / 1000));
        throw new Error(
          `rate limit for discord reached: ${rate.used}/${rate.limit} in the last hour; retry in ${retrySeconds}s`,
        );
      }
      await options.channelSender.send({
        channel: 'discord',
        target: operatorChannelId,
        message: notification,
      });
      return {
        action: 'approval_request',
        status: 'sent',
        delivery: 'discord',
        target: operatorChannelId,
      };
    } catch (error) {
      errors.push(`discord: ${toErrorMessage(error)}`);
    }
  }

  try {
    const result = await options.briefNotifier.notify({
      sender: SYSTEM_APPROVAL_REQUEST_SENDER,
      message: notification,
      title: 'Companion approval required',
      priority: DEFAULT_APPROVAL_REQUEST_PRIORITY,
      topic: options.operatorNtfyTopic,
    });
    return {
      action: 'approval_request',
      status: result.status,
      delivery: 'ntfy',
      target: result.topic,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  } catch (error) {
    errors.push(`ntfy: ${toErrorMessage(error)}`);
  }

  if (!operatorChannelId) {
    errors.unshift(
      defaultBudgetChannel === 'discord'
        ? 'discord: operatorDiscordChannelId is not configured'
        : `${defaultBudgetChannel}: operator delivery target is not configured`,
    );
  }

  throw new Error(`approval_request delivery failed (${errors.join('; ')})`);
}

/** System-only operator alerts fan out through every configured gateway sink. */
export function createGatewayOperatorNotificationPort(
  gateway: { notifyOperator(params: NotifyNtfyParams): Promise<OperatorAlertResult> },
): NotificationPort {
  return {
    notify: async (params) => {
      await gateway.notifyOperator({
        ...params,
        sender: normalizeNotificationSenderMetadata(params.sender),
      });
      return { status: 'sent', topic: 'operator-alert-sinks' };
    },
  };
}

export function createGatewayDiscordNotifySender(
  gateway: { discordSend(channelId: string, content: string): Promise<void> },
): NotifyChannelSender {
  return {
    send: async ({ channel, target, message }) => {
      if (channel !== 'discord') {
        throw new Error(`${channel} delivery is not wired`);
      }
      await gateway.discordSend(target, message);
    },
  };
}

export function createNotifyDispatcher(options: NotifyDispatcherOptions): NotifyDispatcher {
  return new DefaultNotifyDispatcher(options);
}

interface ClarificationChannelRoute {
  channel: 'discord' | 'telegram';
  target: string;
}

/**
 * Resolve the current turn's channel id to the interactive channel that can
 * render clarify choices. Returns null (clarify unsupported here → fail closed)
 * for internal/scheduled contexts, Discord voice, and any non-interactive
 * surface (api, terminal, companion, …). Discord text channels are raw numeric
 * snowflakes (optionally `<snowflake>:<threadId>`); Telegram uses a `telegram:`
 * prefix.
 */
export function resolveClarificationChannelRoute(channelId: string): ClarificationChannelRoute | null {
  const trimmed = channelId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('internal:')) return null;
  if (trimmed.startsWith('telegram:')) return { channel: 'telegram', target: trimmed };
  if (trimmed.startsWith('discord-voice:')) return null;
  if (/^\d+(?::\d+)?$/.test(trimmed)) return { channel: 'discord', target: trimmed };
  return null;
}

/**
 * Agent-side clarification port that routes a structured clarification to the
 * live interactive channel of the current turn and delivers it through the
 * gateway (Discord buttons / Telegram numbered list). Fails closed when the turn
 * has no interactive channel or the active channel cannot present choices, so a
 * clarify is never silently dropped or fabricated.
 */
export function createGatewayClarificationPort(
  gateway: { clarifyDeliver(params: ClarifyDeliverParams): Promise<ClarifyDeliverResult> },
): ClarificationDeliveryPort {
  return {
    deliver: async (clarification: PendingClarification): Promise<ClarificationDeliveryResult> => {
      const requestContext = getRequestContext();
      const channelId = typeof requestContext?.channelId === 'string'
        ? requestContext.channelId.trim()
        : '';
      if (!channelId) {
        throw new Error('clarify has no active interactive channel in this turn');
      }
      const route = resolveClarificationChannelRoute(channelId);
      if (!route) {
        throw new Error(`clarify is not supported on channel "${channelId}"`);
      }
      const originatingUserId = typeof requestContext?.viewerAuthorId === 'string'
        ? requestContext.viewerAuthorId.trim()
        : '';
      return await gateway.clarifyDeliver({
        channel: route.channel,
        target: route.target,
        clarification,
        timeoutMs: CLARIFY_DELIVERY_TIMEOUT_MS,
        ...(originatingUserId ? { originatingUserId } : {}),
      });
    },
  };
}

function createHttpNotificationPort(options: HttpNtfyNotifierOptions): NotificationPort {
  return new HttpNtfyNotifier(options);
}

export function createHttpNotificationPortFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  credentialVault?: CredentialVaultPort,
): NotificationPort {
  return createHttpNotificationPort({
    baseUrl: env.NTFY_BASE_URL,
    topic: env.NTFY_TOPIC,
    token: resolveOptionalEnvCredential(credentialVault, 'NTFY_TOKEN', env),
    timeoutMs: parsePositiveIntEnv(env.NTFY_TIMEOUT_MS, DEFAULT_NTFY_TIMEOUT_MS),
    debounceWindowMs: parsePositiveIntEnv(env.NTFY_DEBOUNCE_MS, DEFAULT_NTFY_DEBOUNCE_MS),
  });
}

export interface NotifyToolOptions {
  gatewayMode?: boolean;
  companionOutreach?: AgentFacingIcpAutonomyRuntime;
  companionCandidateEnabled?: boolean;
  isCompanionCandidateAuthorized?: () => boolean;
}

const notifyToolParameters = Type.Union([
  Type.Object({
    action: Type.Literal('brief'),
    message: Type.String({ description: 'Body text for the operator brief.' }),
    title: Type.Optional(Type.String({ description: 'Optional ntfy title.' })),
    priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    topic: Type.Optional(Type.String({ description: 'Optional ntfy topic override.' })),
    budget_channel: Type.Optional(Type.Unsafe<ExternalCommunicationChannel>({
      type: 'string',
      enum: ['discord', 'email'],
      description: 'Optional safeguard budget to charge. Default: discord.',
    })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('send'),
    target_kind: Type.Optional(Type.Literal('external')),
    message: Type.String({ description: 'Body text for the outbound notification.' }),
    delivery_channel: Type.Unsafe<NotifyDeliveryChannel>({
      type: 'string',
      enum: ['discord', 'email'],
    }),
    delivery_target: Type.String({
      minLength: 1,
      description: 'Explicit external channel id or address.',
    }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('send'),
    target_kind: Type.Literal(COMPANION_NOTIFY_TARGET_KIND),
    contact_id: Type.String({
      minLength: 1,
      description: 'Exact canonical contact ID from contact lookup.',
    }),
    initiation_permit: Type.String({
      minLength: 1,
      description: 'Broker-issued one-use UUID.',
    }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('consider'),
    target_kind: Type.Literal(COMPANION_NOTIFY_TARGET_KIND),
    contact_id: Type.String({
      minLength: 1,
      description: 'Exact canonical contact ID from contact lookup.',
    }),
    reason_summary: Type.String({
      minLength: 1,
      maxLength: 1_000,
      description: 'Private bounded reason for considering contact; never shared with the peer or gateway.',
    }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('approval_request'),
    approval_id: Type.String({ minLength: 1 }),
    approval_method: Type.String({ minLength: 1 }),
    approval_action: Type.String({ minLength: 1 }),
    approval_scope: Type.String({ minLength: 1 }),
    approval_reason: Type.String({ minLength: 1 }),
    approval_expires_at: Type.Optional(Type.Integer({
      description: 'Optional approval expiry as epoch milliseconds.',
    })),
    review_path: Type.Optional(Type.String({
      description: 'Optional admin review path. Default: /confirmations.',
    })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('clarify'),
    question: Type.String({
      minLength: 1,
      maxLength: CLARIFY_MAX_QUESTION_LENGTH,
      description: 'The short question you need the person to answer.',
    }),
    choices: Type.Array(
      Type.String({ minLength: 1, maxLength: CLARIFY_MAX_CHOICE_LENGTH }),
      {
        minItems: CLARIFY_MIN_CHOICES,
        maxItems: CLARIFY_MAX_CHOICES,
        uniqueItems: true,
        description: 'The distinct options to choose between (2 to 5).',
      },
    ),
  }, { additionalProperties: false }),
]);

// Several otherwise tool-capable providers emit `{}` for a function whose
// root schema is an action-discriminated `anyOf`. Keep that strict union as the
// scheduler's execution contract, but give pi-ai a flat object schema that the
// model can fill reliably. Every action-specific field remains optional here;
// the canonical union above still rejects missing or cross-action fields before
// `execute` can run.
const notifyModelParameters = Type.Object({
  action: Type.Union([
    Type.Literal('brief'),
    Type.Literal('send'),
    Type.Literal('consider'),
    Type.Literal('approval_request'),
    Type.Literal('clarify'),
  ], {
    description: 'Required notify action. Supply every field required for the selected action.',
  }),
  message: Type.Optional(Type.String({
    description: 'Required for action=brief or action=send. Notification body text.',
  })),
  title: Type.Optional(Type.String({ description: 'Optional title for action=brief.' })),
  priority: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 5,
    description: 'Optional priority for action=brief.',
  })),
  topic: Type.Optional(Type.String({ description: 'Optional ntfy topic for action=brief.' })),
  budget_channel: Type.Optional(Type.Union([
    Type.Literal('discord'),
    Type.Literal('email'),
  ], {
    description: 'Optional safeguard budget for action=brief.',
  })),
  target_kind: Type.Optional(Type.Union([
    Type.Literal('external'),
    Type.Literal(COMPANION_NOTIFY_TARGET_KIND),
  ], {
    description: 'For action=send, use external or companion. Required for companion send and consider.',
  })),
  delivery_channel: Type.Optional(Type.Union([
    Type.Literal('discord'),
    Type.Literal('email'),
  ], {
    description: 'Required for action=send with an external target.',
  })),
  delivery_target: Type.Optional(Type.String({
    description: 'Required for action=send with an external target.',
  })),
  contact_id: Type.Optional(Type.String({
    description: 'Required for companion action=send or action=consider.',
  })),
  initiation_permit: Type.Optional(Type.String({
    description: 'Required broker-issued permit for companion action=send.',
  })),
  reason_summary: Type.Optional(Type.String({
    description: 'Required private reason for action=consider.',
  })),
  approval_id: Type.Optional(Type.String({
    description: 'Required for action=approval_request.',
  })),
  approval_method: Type.Optional(Type.String({
    description: 'Required for action=approval_request.',
  })),
  approval_action: Type.Optional(Type.String({
    description: 'Required for action=approval_request.',
  })),
  approval_scope: Type.Optional(Type.String({
    description: 'Required for action=approval_request.',
  })),
  approval_reason: Type.Optional(Type.String({
    description: 'Required for action=approval_request.',
  })),
  approval_expires_at: Type.Optional(Type.Integer({
    description: 'Optional expiry epoch milliseconds for action=approval_request.',
  })),
  review_path: Type.Optional(Type.String({
    description: 'Optional admin review path for action=approval_request.',
  })),
  question: Type.Optional(Type.String({
    maxLength: CLARIFY_MAX_QUESTION_LENGTH,
    description: 'Required question for action=clarify.',
  })),
  choices: Type.Optional(Type.Array(
    Type.String({ maxLength: CLARIFY_MAX_CHOICE_LENGTH }),
    {
      minItems: CLARIFY_MIN_CHOICES,
      maxItems: CLARIFY_MAX_CHOICES,
      uniqueItems: true,
      description: 'Required distinct choices for action=clarify.',
    },
  )),
}, { additionalProperties: false });

type NotifyToolParams = Static<typeof notifyToolParameters>;

export function createNotifyTool(
  dispatcher: NotifyDispatcher,
  options: NotifyToolOptions = {},
): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'notify',
    label: 'notify',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.notify,
    parameters: notifyToolParameters,
    modelParameters: notifyModelParameters,
    execute: async (
      _toolCallId: string,
      rawParams: NotifyToolParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      if (rawParams.action === 'consider') {
        return executeCompanionCandidateConsider(
          rawParams,
          options.companionCandidateEnabled === true,
          options.isCompanionCandidateAuthorized?.() === true,
        );
      }
      let action: NotifyAction;
      try {
        action = normalizeAction(rawParams.action);
      } catch (error) {
        return textResultWithError(`notify: failure (${toErrorMessage(error)}).`, true);
      }

      if (action === 'brief' || action === 'clarify') {
        const blockedContext = buildContextBlockReason();
        if (blockedContext) {
          return textResultWithError(
            `notify: blocked (${action} is not allowed from ${blockedContext}).`,
            true,
          );
        }
      }

      if (
        action === 'send'
        && 'target_kind' in rawParams
        && rawParams.target_kind === COMPANION_NOTIFY_TARGET_KIND
      ) {
        if (!options.companionOutreach) {
          return textResultWithError('notify: companion outreach is not wired in this runtime.', true);
        }
        return await executeCompanionNotify({
          runtime: options.companionOutreach,
          params: rawParams,
        });
      }

      if (action === 'send') {
        const blockedContext = buildExternalSendContextBlockReason();
        if (blockedContext) {
          return textResultWithError(
            `notify: blocked (send is not allowed from ${blockedContext}).`,
            true,
          );
        }
      }

      try {
        const normalizedParams = {
          ...rawParams,
          action,
        } as NotifyToolParams;
        const result = await dispatcher.dispatch(buildNotifyToolRequest(normalizedParams));
        return textResult(formatNotifyToolSuccess(result));
      } catch (error) {
        return textResultWithError(`notify: failure (${toErrorMessage(error)}).`, true);
      }
    },
  };

  const wirable = tool as WirableTool;
  wirable.wiringMeta = {
    ...(options.gatewayMode
      ? {
          requiredGatewayMethods: [
            'discord.send',
            'notify.ntfy',
            'companion.initiation.permit.prepare_handoff',
          ],
        }
      : {}),
    requiredServices: ['ntfy'],
  };

  return withCapabilityRequirement(tool, (params) => {
    const action = typeof params.action === 'string' ? params.action.trim() : '';
    switch (action) {
      case 'brief':
        return 'external.web';
      case 'send': {
        if (params.target_kind === COMPANION_NOTIFY_TARGET_KIND) {
          return 'external.companion';
        }
        const channel = typeof params.delivery_channel === 'string'
          ? params.delivery_channel.trim()
          : '';
        if (channel === 'discord') {
          return 'external.discord';
        }
        if (channel === 'email') {
          return 'external.email';
        }
        return ['external.discord', 'external.email'] as const;
      }
      case 'consider':
        return 'external.companion';
      case 'approval_request':
        return 'external.web';
      case 'clarify':
        return 'external.web';
      default:
        return ['external.web', 'external.discord', 'external.email'] as const;
    }
  });
}

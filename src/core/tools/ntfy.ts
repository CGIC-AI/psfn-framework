import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { NotifyNtfyParams, NotifyNtfyResult } from '../../boundary/gateway/protocol.js';
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
import { textResult, textResultWithError } from './results.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';

const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;
const DEFAULT_APPROVAL_REQUEST_PRIORITY = 4;

export type { NotificationPort } from '../../boundary/gateway/notification-port.js';

export type NotifyAction = 'brief' | 'send' | 'approval_request';
export type NotifyDeliveryChannel = 'discord' | 'email';
export type NotifyDelivery = 'ntfy' | NotifyDeliveryChannel;
export type NtfyNotifier = NotificationPort;

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

export type NotifyRequest =
  | NotifyBriefRequest
  | NotifySendRequest
  | NotifyApprovalRequest;

export interface NotifyDispatchResult {
  status: 'sent' | 'debounced';
  action: NotifyAction;
  delivery: NotifyDelivery;
  target: string;
  messageId?: string;
}

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
}

interface NotifyToolParams {
  action: NotifyAction | 'notify_operator';
  message?: string;
  title?: string;
  priority?: number;
  topic?: string;
  budget_channel?: ExternalCommunicationChannel;
  delivery_channel?: NotifyDeliveryChannel;
  delivery_target?: string;
  approval_id?: string;
  approval_method?: string;
  approval_action?: string;
  approval_scope?: string;
  approval_reason?: string;
  approval_expires_at?: number;
  review_path?: string;
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

    const message = params.message.trim();
    if (!message) {
      throw new Error('message is required');
    }

    const topic = params.topic?.trim() || this.topic;
    const title = params.title?.trim();
    const priority = this.normalizePriority(params.priority);

    const fingerprint = JSON.stringify({ topic, title: title ?? '', priority, message });
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

  constructor(options: NotifyDispatcherOptions) {
    this.briefNotifier = options.briefNotifier;
    this.channelSender = options.channelSender;
    this.operatorDiscordChannelId = options.operatorDiscordChannelId?.trim() || undefined;
    this.operatorNtfyTopic = options.operatorNtfyTopic?.trim() || undefined;
    this.rateLimiter = options.rateLimiter;
    this.defaultBudgetChannel = options.defaultBudgetChannel ?? 'discord';
  }

  async dispatch(request: NotifyRequest): Promise<NotifyDispatchResult> {
    switch (request.action) {
      case 'brief':
        return await this.sendBrief(request);
      case 'send':
        return await this.sendOutbound(request);
      case 'approval_request':
        return await this.sendApprovalRequest(request.request);
      default:
        throw new Error(`unsupported notify action: ${String((request as { action?: unknown }).action)}`);
    }
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

function buildNotifyToolRequest(params: NotifyToolParams): NotifyRequest {
  switch (params.action) {
    case 'brief':
    case 'notify_operator':
      return {
        action: 'brief',
        message: params.message ?? '',
        title: params.title,
        priority: params.priority,
        topic: params.topic,
        budgetChannel: params.budget_channel,
      };
    case 'send':
      return {
        action: 'send',
        message: params.message ?? '',
        deliveryChannel: params.delivery_channel ?? '',
        deliveryTarget: params.delivery_target ?? '',
      };
    case 'approval_request':
      return {
        action: 'approval_request',
        request: {
          id: params.approval_id ?? '',
          method: params.approval_method ?? '',
          approvalAction: params.approval_action ?? '',
          scope: params.approval_scope ?? '',
          reason: params.approval_reason ?? '',
          expiresAt: params.approval_expires_at,
          reviewPath: params.review_path,
        },
      };
    default:
      throw new Error(`unsupported notify action: ${String(params.action)}`);
  }
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
    default:
      return 'notify: success.';
  }
}

function normalizeAction(value: string): NotifyAction {
  switch (value.trim()) {
    case 'brief':
    case 'notify_operator':
      return 'brief';
    case 'send':
    case 'approval_request':
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

export function formatApprovalRequestNotification(request: NotifyApprovalRequestInput): string {
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

export async function deliverApprovalRequestNotification(options: {
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
      message: notification,
      title: 'PSFN approval required',
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

export function createGatewayNotificationPort(
  gateway: { notifyNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult> },
): NotificationPort {
  return {
    notify: (params) => gateway.notifyNtfy(params),
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

export function createHttpNotificationPort(options: HttpNtfyNotifierOptions): NotificationPort {
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
}

export function createNotifyTool(
  dispatcher: NotifyDispatcher,
  options: NotifyToolOptions = {},
): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'notify',
    label: 'notify',
    description:
      'Unified notification surface for operator briefs, lightweight outbound sends, and approval escalation. '
      + 'Use action="brief" to replace the legacy notify_operator behavior.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('brief'),
        Type.Literal('notify_operator'),
        Type.Literal('send'),
        Type.Literal('approval_request'),
      ], {
        description: 'Notification action: brief, send, or approval_request. Legacy notify_operator maps to brief.',
      }),
      message: Type.Optional(
        Type.String({
          description: 'Required for brief/send. Body text for the notification.',
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: 'Optional ntfy title for brief notifications.',
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 5,
          description: 'Optional ntfy priority for brief notifications.',
        }),
      ),
      topic: Type.Optional(
        Type.String({
          description: 'Optional ntfy topic override for brief notifications.',
        }),
      ),
      budget_channel: Type.Optional(
        Type.Unsafe<ExternalCommunicationChannel>({
          type: 'string',
          enum: ['discord', 'email'],
          description: 'Optional safeguard budget to charge for brief notifications. Default: discord.',
        }),
      ),
      delivery_channel: Type.Optional(
        Type.Unsafe<NotifyDeliveryChannel>({
          type: 'string',
          enum: ['discord', 'email'],
          description: 'Required for send. Explicit outbound delivery channel.',
        }),
      ),
      delivery_target: Type.Optional(
        Type.String({
          description: 'Required for send. Explicit external channel id or address.',
        }),
      ),
      approval_id: Type.Optional(
        Type.String({
          description: 'Required for approval_request. Stable approval or confirmation id.',
        }),
      ),
      approval_method: Type.Optional(
        Type.String({
          description: 'Required for approval_request. Underlying method awaiting review.',
        }),
      ),
      approval_action: Type.Optional(
        Type.String({
          description: 'Required for approval_request. Human-readable action awaiting review.',
        }),
      ),
      approval_scope: Type.Optional(
        Type.String({
          description: 'Required for approval_request. Scope awaiting approval.',
        }),
      ),
      approval_reason: Type.Optional(
        Type.String({
          description: 'Required for approval_request. Why operator review is needed.',
        }),
      ),
      approval_expires_at: Type.Optional(
        Type.Integer({
          description: 'Optional approval expiry as epoch milliseconds.',
        }),
      ),
      review_path: Type.Optional(
        Type.String({
          description: 'Optional admin review path. Default: /confirmations.',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      rawParams: NotifyToolParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: NotifyAction;
      try {
        action = normalizeAction(rawParams.action);
      } catch (error) {
        return textResultWithError(`notify: failure (${toErrorMessage(error)}).`, true);
      }

      if (action === 'brief') {
        const blockedContext = buildContextBlockReason();
        if (blockedContext) {
          return textResultWithError(
            `notify: blocked (brief is not allowed from ${blockedContext}).`,
            true,
          );
        }
      }

      try {
        const result = await dispatcher.dispatch(buildNotifyToolRequest({
          ...rawParams,
          action,
        }));
        return textResult(formatNotifyToolSuccess(result));
      } catch (error) {
        return textResultWithError(`notify: failure (${toErrorMessage(error)}).`, true);
      }
    },
  };

  const wirable = tool as WirableTool;
  wirable.wiringMeta = {
    ...(options.gatewayMode ? { requiredGatewayMethods: ['discord.send', 'notify.ntfy'] } : {}),
    requiredServices: ['ntfy'],
  };

  return withCapabilityRequirement(tool, (params) => {
    const action = typeof params.action === 'string' ? params.action.trim() : '';
    switch (action) {
      case 'brief':
      case 'notify_operator':
        return 'external.web';
      case 'send': {
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
      case 'approval_request':
        return 'external.web';
      default:
        return ['external.web', 'external.discord', 'external.email'] as const;
    }
  });
}

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { NotifyNtfyParams, NotifyNtfyResult } from '../boundary/gateway/protocol.js';
import type { WirableTool } from '../core/agent/tool-wiring-validator.js';
import type {
  ExternalCommunicationChannel,
  ExternalCommunicationRateLimiter,
} from '../system/capabilities/safeguards.js';
import {
  resolveOptionalEnvCredential,
  type CredentialVaultPort,
} from '../boundary/custody/credential-vault.js';
import { textResult, textResultWithError } from './results.js';
import { parsePositiveIntEnv } from '../shared/utils/env.js';
import { toErrorMessage } from '../shared/utils/errors.js';
import { getRequestContext } from '../llm/request-context.js';

const DEFAULT_NTFY_TIMEOUT_MS = 8_000;
const DEFAULT_NTFY_DEBOUNCE_MS = 60_000;

export interface NtfyNotifier {
  notify(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
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

class HttpNtfyNotifier implements NtfyNotifier {
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

function toHeaderByteString(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  if (!normalized) return '';
  return Buffer.from(normalized, 'utf8').toString('latin1');
}

export function createGatewayNtfyNotifier(
  gateway: { notifyNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult> },
): NtfyNotifier {
  return {
    notify: (params) => gateway.notifyNtfy(params),
  };
}

export function createHttpNtfyNotifier(options: HttpNtfyNotifierOptions): NtfyNotifier {
  return new HttpNtfyNotifier(options);
}

export function createHttpNtfyNotifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  credentialVault?: CredentialVaultPort,
): NtfyNotifier {
  return createHttpNtfyNotifier({
    baseUrl: env.NTFY_BASE_URL,
    topic: env.NTFY_TOPIC,
    token: resolveOptionalEnvCredential(credentialVault, 'NTFY_TOKEN', env),
    timeoutMs: parsePositiveIntEnv(env.NTFY_TIMEOUT_MS, DEFAULT_NTFY_TIMEOUT_MS),
    debounceWindowMs: parsePositiveIntEnv(env.NTFY_DEBOUNCE_MS, DEFAULT_NTFY_DEBOUNCE_MS),
  });
}

export interface NotifyOperatorToolOptions {
  rateLimiter?: ExternalCommunicationRateLimiter;
  defaultChannel?: ExternalCommunicationChannel;
  gatewayMode?: boolean;
}

export function createNotifyOperatorTool(
  notifier: NtfyNotifier,
  options: NotifyOperatorToolOptions = {},
): AgentTool<any> {
  const defaultChannel = options.defaultChannel ?? 'discord';
  const tool: AgentTool<any> = {
    name: 'notify_operator',
    label: 'notify_operator',
    description:
      'Send an out-of-band operator alert via ntfy. ' +
      'Returns explicit sent, debounced, or failure status.',
    parameters: Type.Object({
      message: Type.String({
        minLength: 1,
        description: 'Alert body text sent to ntfy.',
      }),
      title: Type.Optional(
        Type.String({
          description: 'Optional ntfy notification title.',
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 5,
          description: 'Optional ntfy priority (1-5).',
        }),
      ),
      topic: Type.Optional(
        Type.String({
          description: 'Optional topic override; defaults to configured NTFY_TOPIC.',
        }),
      ),
      channel: Type.Optional(
        Type.Unsafe<ExternalCommunicationChannel>({
          type: 'string',
          enum: ['discord', 'email'],
          description: 'External channel budget to charge against (discord/email). Default: discord.',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        message: string;
        title?: string;
        priority?: number;
        topic?: string;
        channel?: ExternalCommunicationChannel;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const message = params.message.trim();
      if (!message) {
        return textResultWithError('notify_operator: failure (message is required).', true);
      }

      const requestContext = getRequestContext();
      const requestChannelId = typeof requestContext?.channelId === 'string'
        ? requestContext.channelId.trim()
        : '';
      const requestCallType = requestContext?.callType;
      if (requestChannelId.startsWith('internal:') || requestCallType === 'scheduled') {
        const contextLabel = requestCallType === 'scheduled'
          ? 'scheduled'
          : `internal channel (${requestChannelId || 'unknown'})`;
        return textResultWithError(
          `notify_operator: blocked (not allowed from ${contextLabel} execution context).`,
          true,
        );
      }

      const channel = params.channel ?? defaultChannel;
      const topic = params.topic?.trim();

      if (options.rateLimiter) {
        const rate = options.rateLimiter.evaluate({
          channel,
          scope: topic || 'default-topic',
        });
        if (!rate.allowed) {
          const retrySeconds = Math.max(1, Math.ceil((rate.retryAfterMs ?? 0) / 1000));
          return textResultWithError(
            `notify_operator: blocked (rate limit for ${channel} reached: ${rate.used}/${rate.limit} in the last hour; retry in ${retrySeconds}s).`,
            true,
          );
        }
      }

      try {
        const result = await notifier.notify({
          message,
          title: params.title?.trim(),
          priority: params.priority,
          topic,
        });

        if (result.status === 'debounced') {
          return textResult(
            `notify_operator: debounced (duplicate alert suppressed for topic "${result.topic}").`,
          );
        }

        return textResult(
          `notify_operator: success (sent to topic "${result.topic}"${result.messageId ? `, id ${result.messageId}` : ''}).`,
        );
      } catch (error) {
        const messageText = toErrorMessage(error);
        return textResultWithError(`notify_operator: failure (${messageText}).`, true);
      }
    },
  };

  const wirable = tool as WirableTool;
  wirable.wiringMeta = {
    ...(options.gatewayMode ? { requiredGatewayMethods: ['notify.ntfy'] } : {}),
    requiredServices: ['ntfy'],
    contextRestrictions: {
      disallowInternal: true,
      disallowScheduled: true,
    },
  };

  return tool;
}

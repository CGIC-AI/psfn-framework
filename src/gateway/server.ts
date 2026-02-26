// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import { JSONRPCServer, JSONRPCClient, JSONRPCServerAndClient, JSONRPCErrorException } from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { ChannelOutboundDock } from '../channels/types.js';
import type { CapabilityTier, SubstrateMessage } from '../types.js';
import type { NdjsonConnection } from './transport.js';
import { createSocketServer } from './transport.js';
import { sanitizeWebContent } from './sanitize.js';
import { evaluateUrlPolicy, checkResolvedIP, type UrlPolicyConfig } from './url-policy.js';
import {
  GatewayErrors,
  type LLMChatParams,
  type LLMCompleteParams,
  type LLMEmbedParams,
  type DiscordSendParams,
  type DiscordTypingParams,
  type WebFetchParams,
  type FsReadParams,
  type FsWriteParams,
  type FsListParams,
  type NotifyNtfyParams,
  type NotifyNtfyResult,
  type PolicyContext,
  type PolicyDecision,
  type LLMChunkNotification,
  type RpcSubstrateMessage,
  type VoiceHandleMessageResult,
  type VoiceStreamStartParams,
  type VoiceStreamChunkParams,
  type VoiceStreamEndParams,
  type VoiceStreamCancelParams,
  type VoiceStreamEndResult,
  type VoiceStreamMetadata,
  type ConfirmationListParams,
  type ConfirmationListResult,
  type ConfirmationResolveParams,
  type ConfirmationResolveResult,
  type SessionHmacSignParams,
  type SessionHmacSignResult,
  type SessionHmacVerifyParams,
  type SessionHmacVerifyResult,
} from './protocol.js';
import { BoundedQueue, QueueOverflowError, type QueueOverflowPolicy } from './backpressure.js';

import { readFile, writeFile, glob as fsGlob } from 'node:fs/promises';
import { resolve, normalize, dirname, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import type { AuditStore } from './audit.js';
import {
  buildSessionHmacKeyring,
  signJournalEntry,
  verifyJournalEntryIntegrity,
  type SessionHmacKeyring,
} from '../session/journal-utils.js';
import { createComponentLogger } from '../logger.js';
import {
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
  type ConfirmationQueueEntry,
} from '../capabilities/confirmation-queue.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
const log = createComponentLogger('Gateway');

// ── Policy Engine ──

export interface PolicyConfig {
  workspacePath: string;
  allowedReadPaths?: string[];
  urlPolicy?: UrlPolicyConfig;
}

export interface GatewayNtfyConfig {
  baseUrl: string;
  defaultTopic: string;
  token?: string;
  timeoutMs: number;
  debounceWindowMs: number;
}

export interface GatewayConfirmationConfig {
  expiryMs: number;
  operatorDiscordChannelId?: string;
  ntfyTopic?: string;
}

const GATEWAY_SESSION_HMAC_KEYS_ENV = 'GATEWAY_SESSION_HMAC_KEYS';
const GATEWAY_SESSION_HMAC_KEY_ENV = 'GATEWAY_SESSION_HMAC_KEY';
const GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV = 'GATEWAY_SESSION_HMAC_ACTIVE_VERSION';

export function resolveGatewaySessionHmacKeyring(
  env: NodeJS.ProcessEnv = process.env,
): SessionHmacKeyring | null {
  return buildSessionHmacKeyring({
    serializedKeys: env[GATEWAY_SESSION_HMAC_KEYS_ENV],
    singleKey: env[GATEWAY_SESSION_HMAC_KEY_ENV],
    activeVersion: env[GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV],
  });
}

/** Check whether a resolved path falls inside any of the allowed prefixes */
function isInsideAllowedPaths(resolvedPath: string, allowedPrefixes: string[]): boolean {
  for (const prefix of allowedPrefixes) {
    if (resolvedPath.startsWith(prefix + '/') || resolvedPath === prefix) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the canonical (symlink-resolved) path for policy checking.
 * Returns the normalized path unchanged if the file doesn't exist (ENOENT).
 * For writes to new files, resolves the parent directory if it exists.
 * Returns null only if a symlink explicitly resolves outside allowed paths.
 */
function resolveCanonicalPath(normalized: string, isWrite: boolean): string {
  try {
    return realpathSync(normalized);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = path doesn't exist at all (not a symlink issue) — safe to use normalized
    // ELOOP = too many symlinks (suspicious, but ENOENT for broken symlink targets too)
    if (code === 'ENOENT') {
      // For writes, try to resolve the parent directory to catch symlinked parents
      if (isWrite) {
        try {
          const parentReal = realpathSync(dirname(normalized));
          const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
          return resolve(parentReal, basename);
        } catch {
          // Parent doesn't exist either — use normalized path (will fail at write time)
          return normalized;
        }
      }
      return normalized;
    }
    // For any other error (EACCES, ELOOP, etc.), use normalized path
    return normalized;
  }
}

export function evaluatePolicy(ctx: PolicyContext, policyConfig: PolicyConfig): PolicyDecision {
  const { method, params } = ctx;

  switch (method) {
    case 'llm.chat':
    case 'llm.complete':
    case 'llm.embed':
    case 'discord.send':
    case 'discord.typing':
    case 'notify.ntfy':
      return 'ALLOW';

    case 'web.fetch': {
      // Synchronous URL policy check so the audit log reflects the real decision
      const url = (params as Record<string, unknown>).url as string | undefined;
      if (url && policyConfig.urlPolicy) {
        const urlCheck = evaluateUrlPolicy(url, policyConfig.urlPolicy);
        if (!urlCheck.allowed) {
          return 'DENY';
        }
      }
      return 'ALLOW';
    }

    case 'fs.read':
    case 'fs.write': {
      const path = (params as Record<string, unknown>).path as string;
      const normalized = resolve(normalize(path));
      const workspace = resolve(normalize(policyConfig.workspacePath));

      // Build list of all allowed prefixes for this operation
      const allowedPrefixes = [workspace];
      if (method === 'fs.read' && policyConfig.allowedReadPaths) {
        for (const allowed of policyConfig.allowedReadPaths) {
          allowedPrefixes.push(resolve(normalize(allowed)));
        }
      }

      // Step 1: Check normalized path (string prefix match)
      if (!isInsideAllowedPaths(normalized, allowedPrefixes)) {
        return 'NEEDS_APPROVAL';
      }

      // Step 2: Resolve symlinks and check canonical path
      const isWrite = method === 'fs.write';
      const canonical = resolveCanonicalPath(normalized, isWrite);

      // If canonical differs from normalized (symlink), re-check against allowed prefixes
      if (canonical !== normalized && !isInsideAllowedPaths(canonical, allowedPrefixes)) {
        return 'DENY';
      }

      return 'ALLOW';
    }

    case 'fs.list': {
      const glob = (params as Record<string, unknown>).glob;
      if (glob !== undefined) {
        if (typeof glob !== 'string') {
          return 'DENY';
        }
        const trimmed = glob.trim();
        if (!trimmed || trimmed.length > 512 || trimmed.includes('\0')) {
          return 'DENY';
        }

        const normalizedGlob = normalize(trimmed).replace(/\\/g, '/');
        if (
          isAbsolute(trimmed) ||
          normalizedGlob === '..' ||
          normalizedGlob.startsWith('../') ||
          normalizedGlob.includes('/../')
        ) {
          return 'DENY';
        }
      }

      const maxEntries = (params as Record<string, unknown>).maxEntries;
      if (maxEntries !== undefined) {
        if (
          typeof maxEntries !== 'number' ||
          !Number.isFinite(maxEntries) ||
          Math.floor(maxEntries) < 1 ||
          maxEntries > 500
        ) {
          return 'DENY';
        }
      }

      return 'ALLOW';
    }

    default:
      return 'DENY';
  }
}

// ── Gateway Server Class ──

export interface GatewayServerOptions {
  socketPath: string;
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService;
  discordAdapter: ChannelOutboundDock;
  policyConfig: PolicyConfig;
  ntfy?: GatewayNtfyConfig;
  auditStore?: AuditStore;
  sessionHmacKeyring?: SessionHmacKeyring | null;
  confirmation?: Partial<GatewayConfirmationConfig>;
  capabilityTierProvider?: () => CapabilityTier;
}

const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_VOICE_CHUNK_SIZE = 120;
const DEFAULT_VOICE_QUEUE_SIZE = 32;
const DEFAULT_VOICE_OVERFLOW_POLICY: QueueOverflowPolicy = 'error';
const DEFAULT_CONFIRMATION_NOTIFICATION_PRIORITY = 4;

interface ReverseVoiceRpcMethods {
  handleMessage: string;
  start: string;
  chunk: string;
  end: string;
  cancel: string;
}

const PRIMARY_REVERSE_VOICE_RPC_METHODS: ReverseVoiceRpcMethods = {
  handleMessage: 'voice.handleMessage',
  start: 'voice.stream.start',
  chunk: 'voice.stream.chunk',
  end: 'voice.stream.end',
  cancel: 'voice.stream.cancel',
};

const LEGACY_REVERSE_VOICE_RPC_METHODS: ReverseVoiceRpcMethods = {
  handleMessage: 'discord.handleMessage',
  start: 'discord.voice.start',
  chunk: 'discord.voice.chunk',
  end: 'discord.voice.end',
  cancel: 'discord.voice.cancel',
};

export interface VoiceStreamRequestOptions {
  timeoutMs?: number;
  chunkSize?: number;
  maxQueueSize?: number;
  overflowPolicy?: QueueOverflowPolicy;
  correlationId?: string;
  streamId?: string;
  metadata?: VoiceStreamMetadata;
  signal?: AbortSignal;
}

export class GatewayServer {
  private netServer: net.Server | null = null;
  private connections = new Set<NdjsonConnection>();
  private rpcClients = new Map<NdjsonConnection, JSONRPCServerAndClient>();
  private options: GatewayServerOptions;
  private sessionHmacKeyring: SessionHmacKeyring | null;
  private streamRequestCounter = 0;
  private ntfyRecentAlerts = new Map<string, number>();
  private confirmationQueue: ConfirmationQueue;
  private confirmationConfig: GatewayConfirmationConfig;
  private capabilityTierProvider: () => CapabilityTier;

  constructor(options: GatewayServerOptions) {
    this.options = options;
    this.sessionHmacKeyring = options.sessionHmacKeyring === undefined
      ? resolveGatewaySessionHmacKeyring(process.env)
      : options.sessionHmacKeyring;
    this.confirmationConfig = {
      expiryMs: this.normalizePositiveInt(
        options.confirmation?.expiryMs,
        DEFAULT_CONFIRMATION_EXPIRY_MS,
      ),
      operatorDiscordChannelId: options.confirmation?.operatorDiscordChannelId?.trim() || undefined,
      ntfyTopic: options.confirmation?.ntfyTopic?.trim() || undefined,
    };
    this.confirmationQueue = new ConfirmationQueue({
      defaultExpiryMs: this.confirmationConfig.expiryMs,
    });
    this.capabilityTierProvider = options.capabilityTierProvider ?? (() => this.resolveCapabilityTierFromEnv());
    if (this.sessionHmacKeyring) {
      log.info('Session HMAC keyring configured', {
        activeVersion: this.sessionHmacKeyring.activeVersion,
        versionCount: Object.keys(this.sessionHmacKeyring.keys).length,
      });
    }
  }

  // Wrap a handler with audit timing — logs call, records duration/error on completion
  private audited<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary?: (params: P) => Record<string, unknown>,
  ): (params: P) => Promise<R> {
    return async (params: P) => {
      const summary = paramsSummary ? paramsSummary(params) : undefined;
      const auditId = this.audit(method, 'ALLOW', summary);
      const startTime = Date.now();
      try {
        const result = await handler(params);
        this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  // Wrap a gated handler — evaluates policy, logs decision, handles approval flow
  private gated<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary: (params: P) => Record<string, unknown>,
    approvalAction: string,
    approvalScope: (params: P) => string,
    approvalReason?: (params: P) => string,
  ): (params: P) => Promise<R> {
    return async (params: P) => {
      const decision = evaluatePolicy(
        { method, params: params as unknown as Record<string, unknown> },
        this.options.policyConfig,
      );
      const summary = paramsSummary(params);
      const auditId = this.audit(method, decision, summary);
      const startTime = Date.now();

      try {
        if (decision === 'DENY') {
          throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
        }
        if (decision === 'NEEDS_APPROVAL') {
          if (this.currentCapabilityTier() !== 'autonomous') {
            const paramsRecord = params as unknown as Record<string, unknown>;
            const queueEntry = this.confirmationQueue.enqueue(
              {
                method,
                action: approvalAction,
                scope: approvalScope(params),
                params: paramsRecord,
                companionReason: this.resolveCompanionReason(
                  paramsRecord,
                  approvalReason?.(params) ?? 'Outside workspace',
                ),
                expiresInMs: this.confirmationConfig.expiryMs,
              },
              async (approvedParams, entry) => this.executeQueuedAction(
                method,
                handler,
                paramsSummary,
                approvedParams as P,
                entry,
              ),
            );
            await this.notifyOperatorForPendingAction(queueEntry);
            throw new JSONRPCErrorException(
              `Your action is pending operator approval (id: ${queueEntry.id}).`,
              GatewayErrors.NEEDS_APPROVAL,
            );
          }
        }
        const result = await handler(params);
        this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  private currentCapabilityTier(): CapabilityTier {
    try {
      const tier = this.capabilityTierProvider();
      return isCapabilityTier(tier) ? tier : 'nursery';
    } catch {
      return 'nursery';
    }
  }

  private resolveCapabilityTierFromEnv(): CapabilityTier {
    const value = process.env.CAPABILITY_TIER?.trim().toLowerCase();
    if (value && isCapabilityTier(value)) {
      return value;
    }
    return 'nursery';
  }

  private resolveCompanionReason(
    params: Record<string, unknown>,
    fallback: string,
  ): string {
    const candidateKeys = ['reason', 'prompt', 'intent', 'summary'];
    for (const key of candidateKeys) {
      const raw = params[key];
      if (typeof raw === 'string' && raw.trim()) {
        return raw.trim();
      }
    }
    return fallback.trim() || 'No companion reason provided.';
  }

  private async executeQueuedAction<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary: (params: P) => Record<string, unknown>,
    params: P,
    entry: ConfirmationQueueEntry,
  ): Promise<R> {
    const queuedSummary = {
      ...paramsSummary(params),
      confirmationId: entry.id,
      confirmationDecision: 'approve',
    };
    const queuedAuditId = this.audit(method, 'ALLOW', queuedSummary);
    const queuedStart = Date.now();
    try {
      const result = await handler(params);
      this.auditComplete(queuedAuditId, queuedStart);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.auditComplete(queuedAuditId, queuedStart, message);
      throw error;
    }
  }

  private registerMethods(target: JSONRPCServerAndClient): void {
    const { llmProvider, embeddingService, discordAdapter } = this.options;

    // ── LLM Methods ──

    target.addMethod('llm.chat', this.audited('llm.chat',
      async (params: LLMChatParams) => {
        // Generate a unique requestId for this stream, or use the client-provided one
        const requestId = params.requestId ?? `gw-${++this.streamRequestCounter}`;
        const response = await llmProvider.stream(
          {
            systemPrompt: params.systemPrompt,
            messages: params.messages,
            ...(params.tools?.length ? { tools: params.tools } : {}),
          },
          params.stream ? {
            onText: (text) => {
              this.notifyAll('llm.chunk', { requestId, text } satisfies LLMChunkNotification);
            },
          } : undefined,
        );
        return {
          content: response.content,
          toolCalls: response.toolCalls,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          stopReason: response.stopReason,
          requestId,
        };
      },
      (p) => ({ model: p.model, stream: p.stream }),
    ));

    target.addMethod('llm.complete', this.audited('llm.complete',
      async (params: LLMCompleteParams) => {
        const response = await llmProvider.complete(
          { systemPrompt: params.systemPrompt, messages: params.messages },
          params.purpose,
        );
        return {
          content: response.content,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          stopReason: response.stopReason,
        };
      },
      (p) => ({ purpose: p.purpose }),
    ));

    target.addMethod('llm.embed', this.audited('llm.embed',
      async (params: LLMEmbedParams) => {
        const embeddings = await embeddingService.embedBatch(params.texts);
        return { embeddings: embeddings.map(e => Array.from(e)) };
      },
      (p) => ({ textCount: p.texts.length }),
    ));

    // ── Discord Methods ──

    target.addMethod('discord.send', this.audited('discord.send',
      async (params: DiscordSendParams) => {
        await discordAdapter.outbound.sendText(
          { channelId: params.channelId },
          params.content,
        );
        return { success: true };
      },
      (p) => ({ channelId: p.channelId }),
    ));

    target.addMethod('discord.typing', this.audited('discord.typing',
      async (_params: DiscordTypingParams) => ({ success: true }),
    ));

    // ── Confirmation queue management ──

    target.addMethod('confirmation.list', this.audited('confirmation.list',
      async (_params: ConfirmationListParams): Promise<ConfirmationListResult> => {
        return {
          entries: this.confirmationQueue.listPending(),
        };
      },
    ));

    target.addMethod('confirmation.resolve', this.audited('confirmation.resolve',
      async (params: ConfirmationResolveParams): Promise<ConfirmationResolveResult> => {
        return await this.confirmationQueue.resolve({
          id: params.id,
          decision: params.decision,
          modifiedParams: params.modifiedParams,
        });
      },
      (p) => ({
        id: p.id,
        decision: p.decision,
      }),
    ));

    target.addMethod('session.hmac.sign', this.audited('session.hmac.sign',
      async (params: SessionHmacSignParams): Promise<SessionHmacSignResult> => {
        if (!this.sessionHmacKeyring) {
          throw new JSONRPCErrorException(
            'Gateway session HMAC keyring is not configured',
            GatewayErrors.PROVIDER_ERROR,
          );
        }
        return {
          entry: signJournalEntry(params.entry, this.sessionHmacKeyring, params.previousHmac),
        };
      },
      (p) => ({
        type: p.entry.type,
        channelId: p.entry.channelId,
        id: p.entry.id,
      }),
    ));

    target.addMethod('session.hmac.verify', this.audited('session.hmac.verify',
      async (params: SessionHmacVerifyParams): Promise<SessionHmacVerifyResult> => {
        if (!this.sessionHmacKeyring) {
          throw new JSONRPCErrorException(
            'Gateway session HMAC keyring is not configured',
            GatewayErrors.PROVIDER_ERROR,
          );
        }
        return verifyJournalEntryIntegrity(params.entry, this.sessionHmacKeyring, params.previousHmac);
      },
      (p) => ({
        type: p.entry.type,
        channelId: p.entry.channelId,
        id: p.entry.id,
        keyVersion: p.entry._hmacKeyVersion,
      }),
    ));

    // ── ntfy operator alerts ──

    target.addMethod('notify.ntfy', this.audited('notify.ntfy',
      async (params: NotifyNtfyParams): Promise<NotifyNtfyResult> => {
        return await this.sendNtfy(params);
      },
      (p) => ({
        topic: p.topic ? 'override' : 'default',
        hasTitle: !!p.title,
        priority: p.priority,
        messageLength: typeof p.message === 'string' ? p.message.length : 0,
      }),
    ));

    // ── Web Fetch (gated) ──

    // Build URL policy config from environment and store on policyConfig
    // so evaluatePolicy() can use it for accurate audit logging
    const urlPolicyConfig = {
      allowHttp: process.env.ALLOW_HTTP_FETCH === 'true',
      domainAllowlist: process.env.FETCH_DOMAIN_ALLOWLIST
        ? process.env.FETCH_DOMAIN_ALLOWLIST.split(',').map(d => d.trim()).filter(Boolean)
        : undefined,
    };
    this.options.policyConfig.urlPolicy = urlPolicyConfig;

    target.addMethod('web.fetch', this.gated('web.fetch',
      async (params: WebFetchParams) => {
        // SSRF defense: evaluate URL policy before fetching
        const urlCheck = evaluateUrlPolicy(params.url, urlPolicyConfig);
        if (!urlCheck.allowed) {
          log.warn(`URL policy blocked fetch: ${urlCheck.reason} (${params.url})`);
          throw new JSONRPCErrorException(
            `URL blocked: ${urlCheck.reason}`,
            GatewayErrors.POLICY_DENIED,
          );
        }

        // Post-DNS-resolution check: catch DNS rebinding (e.g. evil.com → 127.0.0.1)
        const parsed = new URL(params.url);
        const dnsCheck = await checkResolvedIP(parsed.hostname);
        if (!dnsCheck.allowed) {
          log.warn(`DNS resolution blocked fetch: ${dnsCheck.reason} (${params.url})`);
          throw new JSONRPCErrorException(
            `URL blocked: ${dnsCheck.reason}`,
            GatewayErrors.POLICY_DENIED,
          );
        }

        // Use redirect: 'manual' to prevent open-redirect SSRF bypass
        // (attacker 302s to http://169.254.169.254/)
        const response = await fetch(params.url, {
          headers: { 'User-Agent': 'PurrsePhone-Substrate/0.1' },
          signal: AbortSignal.timeout(15_000),
          redirect: 'manual',
        });
        // If server redirected, validate the redirect target before following
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new JSONRPCErrorException('Redirect with no Location header', GatewayErrors.PROVIDER_ERROR);
          }
          const redirectUrl = new URL(location, params.url).href;
          const redirCheck = evaluateUrlPolicy(redirectUrl, urlPolicyConfig);
          if (!redirCheck.allowed) {
            log.warn(`Redirect URL blocked: ${redirCheck.reason} (${redirectUrl})`);
            throw new JSONRPCErrorException(`Redirect blocked: ${redirCheck.reason}`, GatewayErrors.POLICY_DENIED);
          }
          const redirParsed = new URL(redirectUrl);
          const redirDns = await checkResolvedIP(redirParsed.hostname);
          if (!redirDns.allowed) {
            log.warn(`Redirect DNS blocked: ${redirDns.reason} (${redirectUrl})`);
            throw new JSONRPCErrorException(`Redirect blocked: ${redirDns.reason}`, GatewayErrors.POLICY_DENIED);
          }
          // Follow the validated redirect (single hop only — prevents redirect chains)
          const redirectResponse = await fetch(redirectUrl, {
            headers: { 'User-Agent': 'PurrsePhone-Substrate/0.1' },
            signal: AbortSignal.timeout(15_000),
            redirect: 'error', // no further redirects
          });
          if (!redirectResponse.ok) {
            throw new JSONRPCErrorException(
              `Fetch failed after redirect: ${redirectResponse.status} ${redirectResponse.statusText}`,
              GatewayErrors.PROVIDER_ERROR,
            );
          }
          const rawRedirContent = await redirectResponse.text();
          const redirResult = sanitizeWebContent(rawRedirContent, redirectUrl);
          if (redirResult.injectionPatternsFound > 0) {
            log.warn(`Sanitized ${redirResult.injectionPatternsFound} injection patterns from ${redirectUrl}`);
          }
          return { content: redirResult.content, sanitized: redirResult.sanitized };
        }
        if (!response.ok) {
          throw new JSONRPCErrorException(
            `Fetch failed: ${response.status} ${response.statusText}`,
            GatewayErrors.PROVIDER_ERROR,
          );
        }
        const rawContent = await response.text();
        const result = sanitizeWebContent(rawContent, params.url);
        if (result.injectionPatternsFound > 0) {
          log.warn(`Sanitized ${result.injectionPatternsFound} injection patterns from ${params.url}`);
        }
        return { content: result.content, sanitized: result.sanitized };
      },
      (p) => ({ url: p.url }),
      'fetch', (p) => p.url,
    ));

    // ── Filesystem (gated) ──

    target.addMethod('fs.read', this.gated('fs.read',
      async (params: FsReadParams) => {
        const content = await readFile(params.path, 'utf-8');
        return { content };
      },
      (p) => ({ path: p.path }),
      'read', (p) => p.path,
    ));

    target.addMethod('fs.write', this.gated('fs.write',
      async (params: FsWriteParams) => {
        await writeFile(params.path, params.content, 'utf-8');
        return { success: true };
      },
      (p) => ({ path: p.path }),
      'write', (p) => p.path,
    ));

    target.addMethod('fs.list', this.gated('fs.list',
      async (params: FsListParams) => {
        const rawGlob = typeof params.glob === 'string' ? params.glob.trim() : '**/*';
        const normalizedGlob = rawGlob.replace(/\\/g, '/');
        if (
          !normalizedGlob ||
          normalizedGlob.length > 512 ||
          normalizedGlob.includes('\0') ||
          normalizedGlob.startsWith('/') ||
          normalizedGlob.startsWith('\\') ||
          /(^|\/)\.\.(\/|$)/.test(normalizedGlob)
        ) {
          throw new JSONRPCErrorException(
            'fs.list glob must be a non-empty workspace-relative pattern',
            GatewayErrors.POLICY_DENIED,
          );
        }

        const maxEntries = Number.isFinite(params.maxEntries)
          ? Math.max(1, Math.min(500, Math.floor(Number(params.maxEntries))))
          : 200;

        const workspaceRoot = resolve(normalize(this.options.policyConfig.workspacePath));
        const paths: string[] = [];
        for await (const match of fsGlob(normalizedGlob, {
          cwd: workspaceRoot,
          withFileTypes: false,
          dot: true,
        })) {
          const relative = String(match).replace(/\\/g, '/').replace(/^\.\//, '');
          const absolute = resolve(workspaceRoot, relative);
          if (!isInsideAllowedPaths(absolute, [workspaceRoot])) {
            continue;
          }
          paths.push(relative);
          if (paths.length >= maxEntries) {
            break;
          }
        }

        paths.sort((a, b) => a.localeCompare(b));
        return { paths };
      },
      (p) => ({ glob: p.glob ?? '**/*', maxEntries: p.maxEntries ?? 200 }),
      'read',
      (p) => p.glob ?? '**/*',
    ));
  }

  // ── Connection management ──

  start(): void {
    this.netServer = createSocketServer(this.options.socketPath, (conn) => {
      log.info('Agent connected');
      this.connections.add(conn);

      const serverAndClient = new JSONRPCServerAndClient(
        new JSONRPCServer(),
        new JSONRPCClient((request) => { conn.send(request); }),
      );
      this.registerMethods(serverAndClient);
      this.rpcClients.set(conn, serverAndClient);

      conn.onMessage(async (message) => {
        await serverAndClient.receiveAndSend(message as any);
      });

      conn.on('close', () => {
        log.info('Agent disconnected');
        this.connections.delete(conn);
        this.rpcClients.delete(conn);
      });

      conn.on('error', (err) => {
        log.error('Connection error', { error: err.message });
        this.connections.delete(conn);
        this.rpcClients.delete(conn);
      });
    });
  }

  // Send notification to all connected agents
  notifyAll(method: string, params: unknown): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    for (const conn of this.connections) {
      conn.send(notification);
    }
  }

  // Send notification to a specific connection
  notifyOne(conn: NdjsonConnection, method: string, params: unknown): void {
    conn.send({
      jsonrpc: '2.0' as const,
      method,
      params,
    });
  }

  /** Send an RPC request to the first connected agent and await its response */
  async requestAgent<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const first = this.rpcClients.values().next().value;
    if (!first) throw new Error('No agent connected');

    const result = await Promise.race([
      first.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent request timed out')), timeoutMs),
      ),
    ]);
    return result as T;
  }

  async requestAgentVoiceStream(
    message: SubstrateMessage,
    options: VoiceStreamRequestOptions = {},
  ): Promise<VoiceHandleMessageResult> {
    const client = this.rpcClients.values().next().value as JSONRPCServerAndClient | undefined;
    if (!client) {
      throw new Error('No agent connected');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const chunkSize = this.normalizePositiveInt(options.chunkSize, DEFAULT_VOICE_CHUNK_SIZE);
    const maxQueueSize = this.normalizePositiveInt(options.maxQueueSize, DEFAULT_VOICE_QUEUE_SIZE);
    const overflowPolicy = options.overflowPolicy ?? DEFAULT_VOICE_OVERFLOW_POLICY;
    const correlationId = options.correlationId ?? `voice-corr-${Date.now()}-${++this.streamRequestCounter}`;
    const streamId = options.streamId ?? `voice-stream-${Date.now()}-${this.streamRequestCounter}`;

    const queue = new BoundedQueue<string>({
      maxSize: maxQueueSize,
      overflowPolicy,
    });

    const chunks = this.chunkText(message.content ?? '', chunkSize);
    let droppedChunks = 0;
    for (const chunk of chunks) {
      try {
        const enqueueResult = queue.enqueue(chunk);
        if (enqueueResult.droppedReason) {
          droppedChunks += 1;
        }
      } catch (error) {
        if (error instanceof QueueOverflowError) {
          throw new JSONRPCErrorException(error.message, GatewayErrors.VOICE_STREAM_OVERFLOW);
        }
        throw error;
      }
    }

    const baseFrame = {
      correlationId,
      streamId,
      metadata: options.metadata,
    } as const;

    const invokeWithTimeout = async <T>(request: () => Promise<T>): Promise<T> => {
      if (options.signal?.aborted) {
        throw new Error('Voice stream aborted before dispatch');
      }

      return await Promise.race([
        request(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Agent voice stream timed out')), timeoutMs),
        ),
      ]);
    };

    let reverseVoiceMethods = PRIMARY_REVERSE_VOICE_RPC_METHODS;

    const sendCancel = async (sequence: number, reason: string): Promise<void> => {
      const cancelPayload: VoiceStreamCancelParams = {
        ...baseFrame,
        sequence,
        reason,
      };
      await invokeWithTimeout(() => client.request(reverseVoiceMethods.cancel, cancelPayload))
        .catch(() => undefined);
    };

    let sequence = 0;
    const serializedMessage = this.serializeMessage({
      ...message,
      content: '',
    });
    const startParams: VoiceStreamStartParams = {
      ...baseFrame,
      sequence,
      message: serializedMessage,
    };

    try {
      await invokeWithTimeout(() => client.request(reverseVoiceMethods.start, startParams));
    } catch (error) {
      if (this.isMethodNotFoundError(error)) {
        reverseVoiceMethods = LEGACY_REVERSE_VOICE_RPC_METHODS;
        try {
          await invokeWithTimeout(() => client.request(reverseVoiceMethods.start, startParams));
        } catch (legacyError) {
          if (this.isMethodNotFoundError(legacyError)) {
            return this.requestAgentViaHandlePath(client, serializedMessage, timeoutMs);
          }
          throw legacyError;
        }
      } else {
        throw error;
      }
    }

    let cancelled = false;

    try {
      while (queue.size > 0) {
        if (options.signal?.aborted) {
          cancelled = true;
          await sendCancel(sequence + 1, 'aborted');
          throw new Error('Voice stream aborted');
        }

        const text = queue.dequeue();
        if (text === undefined) break;

        sequence += 1;
        const chunkParams: VoiceStreamChunkParams = {
          ...baseFrame,
          sequence,
          text,
        };

        const ack = await invokeWithTimeout(() =>
          client.request(reverseVoiceMethods.chunk, chunkParams) as Promise<{
            accepted: boolean;
            droppedChunks?: number;
          }>,
        );

        if (!ack.accepted) {
          droppedChunks += 1;
        } else if (typeof ack.droppedChunks === 'number') {
          droppedChunks = Math.max(droppedChunks, ack.droppedChunks);
        }
      }

      sequence += 1;
      const endParams: VoiceStreamEndParams = {
        ...baseFrame,
        sequence,
        metadata: {
          ...(options.metadata ?? {}),
          droppedChunks,
        },
      };

      const streamResult = await invokeWithTimeout(() =>
        client.request(reverseVoiceMethods.end, endParams) as Promise<VoiceStreamEndResult>,
      );

      return {
        content: streamResult.content,
        channelId: streamResult.channelId,
        model: streamResult.model,
        durationMs: streamResult.durationMs,
      };
    } catch (error) {
      if (!cancelled) {
        await sendCancel(sequence + 1, 'stream-error');
      }
      throw error;
    }
  }

  private normalizePositiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || value === undefined) {
      return fallback;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }

  private chunkText(text: string, chunkSize: number): string[] {
    const source = text ?? '';
    if (!source) return [''];

    const chunks: string[] = [];
    for (let index = 0; index < source.length; index += chunkSize) {
      chunks.push(source.slice(index, index + chunkSize));
    }

    return chunks;
  }

  private async notifyOperatorForPendingAction(entry: ConfirmationQueueEntry): Promise<void> {
    const notification = this.formatPendingConfirmationAlert(entry);
    const operatorChannelId = this.confirmationConfig.operatorDiscordChannelId;
    let delivered = false;

    if (operatorChannelId) {
      try {
        await this.options.discordAdapter.outbound.sendText(
          { channelId: operatorChannelId },
          notification,
        );
        delivered = true;
      } catch (error) {
        log.warn('Failed to send confirmation alert via Discord', {
          confirmationId: entry.id,
          channelId: operatorChannelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!delivered && this.options.ntfy) {
      try {
        await this.sendNtfy({
          message: notification,
          title: 'PSFN approval required',
          priority: DEFAULT_CONFIRMATION_NOTIFICATION_PRIORITY,
          topic: this.confirmationConfig.ntfyTopic,
        });
        delivered = true;
      } catch (error) {
        log.warn('Failed to send confirmation alert via ntfy', {
          confirmationId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!delivered) {
      log.warn('No operator notification channel available for queued confirmation', {
        confirmationId: entry.id,
      });
    }
  }

  private formatPendingConfirmationAlert(entry: ConfirmationQueueEntry): string {
    return [
      `Approval required: ${entry.method} (${entry.action})`,
      `Scope: ${entry.scope}`,
      `Reason: ${entry.companionReason}`,
      `Confirmation ID: ${entry.id}`,
      `Expires: ${new Date(entry.expiresAt).toISOString()}`,
      'Review in admin: /confirmations',
    ].join('\n');
  }

  private async sendNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    const config = this.options.ntfy;
    if (!config) {
      throw new JSONRPCErrorException('ntfy is not configured', GatewayErrors.PROVIDER_ERROR);
    }

    const message = params.message?.trim();
    if (!message) {
      throw new JSONRPCErrorException('notify.ntfy requires a non-empty message', GatewayErrors.PROVIDER_ERROR);
    }

    const topic = params.topic?.trim() || config.defaultTopic;
    if (!topic) {
      throw new JSONRPCErrorException('notify.ntfy topic is not configured', GatewayErrors.PROVIDER_ERROR);
    }

    const title = params.title?.trim();
    const priority = this.normalizeNtfyPriority(params.priority);

    const fingerprint = JSON.stringify({ topic, title: title ?? '', priority, message });
    if (this.isDebouncedNtfyAlert(fingerprint, config.debounceWindowMs)) {
      return { status: 'debounced', topic };
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const endpoint = `${baseUrl}/${encodeURIComponent(topic)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (title) {
      headers.Title = title;
    }
    if (priority !== undefined) {
      headers.Priority = String(priority);
    }
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: message,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      throw new JSONRPCErrorException(
        `ntfy request failed: ${response.status} ${response.statusText}`,
        GatewayErrors.PROVIDER_ERROR,
      );
    }

    const messageId = response.headers.get('x-message-id') ?? undefined;
    return { status: 'sent', topic, ...(messageId ? { messageId } : {}) };
  }

  private normalizeNtfyPriority(priority: number | undefined): number | undefined {
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return undefined;
    }
    return Math.max(1, Math.min(5, Math.trunc(priority)));
  }

  private isDebouncedNtfyAlert(fingerprint: string, windowMs: number): boolean {
    if (windowMs <= 0) {
      return false;
    }

    const now = Date.now();
    const minTimestamp = now - windowMs;
    for (const [key, lastSeenAt] of this.ntfyRecentAlerts) {
      if (lastSeenAt < minTimestamp) {
        this.ntfyRecentAlerts.delete(key);
      }
    }

    const previous = this.ntfyRecentAlerts.get(fingerprint);
    this.ntfyRecentAlerts.set(fingerprint, now);
    return previous !== undefined && now - previous < windowMs;
  }

  private serializeMessage(message: SubstrateMessage): RpcSubstrateMessage {
    return {
      ...message,
      timestamp: message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : message.timestamp,
    };
  }

  private isMethodNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: number; message?: string };
    return candidate.code === -32601 || candidate.message === 'Method not found';
  }

  private async requestAgentViaHandlePath(
    client: JSONRPCServerAndClient,
    message: RpcSubstrateMessage,
    timeoutMs: number,
  ): Promise<VoiceHandleMessageResult> {
    const invokeHandle = async (method: string): Promise<VoiceHandleMessageResult> => {
      const result = await Promise.race([
        client.request(method, { message }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Agent voice handle request timed out')), timeoutMs),
        ),
      ]);
      return result as VoiceHandleMessageResult;
    };

    try {
      return await invokeHandle(PRIMARY_REVERSE_VOICE_RPC_METHODS.handleMessage);
    } catch (error) {
      if (!this.isMethodNotFoundError(error)) {
        throw error;
      }
      return await invokeHandle(LEGACY_REVERSE_VOICE_RPC_METHODS.handleMessage);
    }
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    this.rpcClients.clear();

    if (this.netServer) {
      await new Promise<void>((resolve) => {
        this.netServer!.close(() => resolve());
      });
    }

    log.info('Stopped');
  }

  private audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number {
    if (decision !== 'ALLOW') {
      log.info(`${method} → ${decision}`);
    }
    if (this.options.auditStore) {
      return this.options.auditStore.log(method, decision, params);
    }
    return 0;
  }

  private auditComplete(id: number, startTime: number, error?: string): void {
    if (this.options.auditStore && id > 0) {
      this.options.auditStore.complete(id, Date.now() - startTime, error);
    }
  }
}

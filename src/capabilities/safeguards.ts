import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { CapabilityTier } from '../types.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { resolveSafeguardAuditTrailPath } from '../persistence/layout.js';
import { parsePositiveIntEnv } from '../utils/env.js';

export type ToolReversibility = 'reversible' | 'irreversible';
export type ExternalCommunicationChannel = 'discord' | 'email';

const DEFAULT_IDENTITY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_RESTART_COOLDOWN_MS = 60_000;
const MIN_RESTART_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DISCORD_MESSAGES_PER_HOUR = 30;
const DEFAULT_EMAIL_MESSAGES_PER_HOUR = 10;

const TOOL_REVERSIBILITY_BY_NAME: Readonly<Record<string, ToolReversibility>> = {
  tool_search: 'reversible',
  toolset: 'irreversible',
  identity: 'irreversible',
  prompt_layer_list: 'reversible',
  prompt_layer_get: 'reversible',
  prompt_layer_rollback: 'irreversible',
  prompt_layer_update: 'irreversible',
  prompt_layer_toggle: 'irreversible',
  north_star: 'irreversible',
  settings_get: 'reversible',
  promoted_tools_list: 'reversible',
  promoted_tools_add: 'irreversible',
  promoted_tools_remove: 'irreversible',
  promoted_tools_swap: 'irreversible',
  heartbeat_get_policy: 'reversible',
  heartbeat_run_template: 'irreversible',
  heartbeat_update_policy: 'irreversible',
  schedule_task: 'irreversible',
  contact_list: 'reversible',
  contact_lookup: 'reversible',
  contact_note: 'irreversible',
  contact_link_identity: 'irreversible',
  contact_set_channel_privacy: 'irreversible',
  contact_set_trust: 'irreversible',
  memory: 'irreversible',
  memory_write: 'irreversible',
  memory_import_batch: 'reversible',
  memory_redact: 'irreversible',
  memory_delete: 'irreversible',
  undo_memory_delete: 'reversible',
  scratchpad: 'irreversible',
  repo_status: 'reversible',
  repo_diff: 'reversible',
  repo_apply_patch: 'irreversible',
  repo_commit: 'irreversible',
  repo_create_branch: 'irreversible',
  repo_open_pr: 'irreversible',
  issue_ready: 'reversible',
  issue_show: 'reversible',
  issue_create: 'irreversible',
  issue_update: 'irreversible',
  issue_close: 'irreversible',
  issue_sync: 'irreversible',
  self_restart: 'irreversible',
  self_rebuild: 'irreversible',
  notify_operator: 'irreversible',
  subagent: 'irreversible',
  spawn_shard: 'irreversible',
  think: 'reversible',
  skill_list: 'reversible',
};

const SAFEGUARD_TOOL_META = Symbol('psfn.safeguardToolMeta');

interface SafeguardAnnotatedTool {
  [SAFEGUARD_TOOL_META]?: {
    reversibility: ToolReversibility;
  };
  reversibility?: ToolReversibility;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function cloneRecord(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch {
    return { ...input };
  }
}

export interface SafeguardAuditEntry {
  timestamp: number;
  event: string;
  details: Record<string, unknown>;
}

export interface SafeguardAuditTrailOptions {
  filePath?: string;
  now?: () => number;
}

export class SafeguardAuditTrail {
  private readonly filePath?: string;
  private readonly now: () => number;
  private readonly memoryLog: SafeguardAuditEntry[] = [];

  constructor(options: SafeguardAuditTrailOptions = {}) {
    this.filePath = options.filePath?.trim() || undefined;
    this.now = options.now ?? Date.now;
  }

  append(event: string, details: Record<string, unknown> = {}): SafeguardAuditEntry {
    const entry: SafeguardAuditEntry = {
      timestamp: this.now(),
      event,
      details: cloneRecord(details),
    };
    this.memoryLog.push(entry);
    if (this.filePath) {
      appendJsonLine(this.filePath, entry);
    }
    return entry;
  }

  list(): SafeguardAuditEntry[] {
    return this.memoryLog.map((entry) => ({
      timestamp: entry.timestamp,
      event: entry.event,
      details: cloneRecord(entry.details),
    }));
  }
}

export function createSafeguardAuditTrail(
  dataDir: string,
  fileName = 'safeguards-audit.jsonl',
): SafeguardAuditTrail {
  return new SafeguardAuditTrail({
    filePath: fileName === 'safeguards-audit.jsonl'
      ? resolveSafeguardAuditTrailPath(dataDir)
      : join(dataDir, fileName),
  });
}

export function resolveToolReversibility(toolName: string): ToolReversibility {
  return TOOL_REVERSIBILITY_BY_NAME[toolName] ?? 'reversible';
}

export function tagToolWithReversibility<T extends AgentTool<any>>(
  tool: T,
  explicitReversibility?: ToolReversibility,
): T {
  const reversibility = explicitReversibility ?? resolveToolReversibility(tool.name);
  const annotated = tool as T & SafeguardAnnotatedTool;
  annotated[SAFEGUARD_TOOL_META] = { reversibility };
  annotated.reversibility = reversibility;
  return tool;
}

export function getToolReversibility(tool: AgentTool<any>): ToolReversibility {
  const annotated = tool as AgentTool<any> & SafeguardAnnotatedTool;
  return annotated[SAFEGUARD_TOOL_META]?.reversibility
    ?? annotated.reversibility
    ?? resolveToolReversibility(tool.name);
}

export interface IdentityEditStage {
  id: string;
  layerId: string;
  layerName: string;
  previousContent: string;
  nextContent: string;
  requestedBy: string;
  tier: CapabilityTier;
  requestedAt: number;
  readyAt: number;
  status: 'pending' | 'cancelled' | 'committed';
  cancelledAt?: number;
  committedAt?: number;
}

export interface IdentityEditStageRequest {
  layerId: string;
  layerName: string;
  previousContent: string;
  nextContent: string;
  requestedBy: string;
  tier: CapabilityTier;
  cooldownMs?: number;
}

export interface IdentityCoolingOffOptions {
  defaultCooldownMs?: number;
  now?: () => number;
  idFactory?: () => string;
  auditTrail?: SafeguardAuditTrail;
}

export interface IdentityStageResult {
  status: 'staged' | 'not_found' | 'already_cancelled' | 'already_committed' | 'cooling_off' | 'ready' | 'cancelled';
  stage?: IdentityEditStage;
  waitMs?: number;
}

export class IdentityCoolingOffManager {
  private readonly defaultCooldownMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly auditTrail?: SafeguardAuditTrail;
  private readonly stages = new Map<string, IdentityEditStage>();

  constructor(options: IdentityCoolingOffOptions = {}) {
    this.defaultCooldownMs = normalizePositiveInt(
      options.defaultCooldownMs,
      DEFAULT_IDENTITY_COOLDOWN_MS,
    );
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.auditTrail = options.auditTrail;
  }

  stageBaseLayerEdit(request: IdentityEditStageRequest): IdentityEditStage {
    const now = this.now();
    const cooldownMs = normalizePositiveInt(request.cooldownMs, this.defaultCooldownMs);
    const stage: IdentityEditStage = {
      id: this.idFactory(),
      layerId: request.layerId,
      layerName: request.layerName,
      previousContent: request.previousContent,
      nextContent: request.nextContent,
      requestedBy: request.requestedBy,
      tier: request.tier,
      requestedAt: now,
      readyAt: now + cooldownMs,
      status: 'pending',
    };
    this.stages.set(stage.id, stage);
    this.auditTrail?.append('identity.stage.created', {
      stageId: stage.id,
      layerId: stage.layerId,
      layerName: stage.layerName,
      tier: stage.tier,
      readyAt: stage.readyAt,
    });
    return { ...stage };
  }

  getStage(stageId: string): IdentityEditStage | null {
    const found = this.stages.get(stageId);
    return found ? { ...found } : null;
  }

  cancel(stageId: string): IdentityStageResult {
    const stage = this.stages.get(stageId);
    if (!stage) return { status: 'not_found' };
    if (stage.status === 'cancelled') return { status: 'already_cancelled', stage: { ...stage } };
    if (stage.status === 'committed') return { status: 'already_committed', stage: { ...stage } };

    const now = this.now();
    stage.status = 'cancelled';
    stage.cancelledAt = now;
    this.auditTrail?.append('identity.stage.cancelled', {
      stageId: stage.id,
      layerId: stage.layerId,
      layerName: stage.layerName,
      tier: stage.tier,
    });
    return { status: 'cancelled', stage: { ...stage } };
  }

  checkReady(stageId: string): IdentityStageResult {
    const stage = this.stages.get(stageId);
    if (!stage) return { status: 'not_found' };
    if (stage.status === 'cancelled') return { status: 'already_cancelled', stage: { ...stage } };
    if (stage.status === 'committed') return { status: 'already_committed', stage: { ...stage } };

    const now = this.now();
    if (now < stage.readyAt) {
      return {
        status: 'cooling_off',
        stage: { ...stage },
        waitMs: stage.readyAt - now,
      };
    }
    return {
      status: 'ready',
      stage: { ...stage },
      waitMs: 0,
    };
  }

  markCommitted(stageId: string): IdentityStageResult {
    const stage = this.stages.get(stageId);
    if (!stage) return { status: 'not_found' };
    if (stage.status === 'cancelled') return { status: 'already_cancelled', stage: { ...stage } };
    if (stage.status === 'committed') return { status: 'already_committed', stage: { ...stage } };

    const now = this.now();
    if (now < stage.readyAt) {
      return {
        status: 'cooling_off',
        stage: { ...stage },
        waitMs: stage.readyAt - now,
      };
    }

    stage.status = 'committed';
    stage.committedAt = now;
    this.auditTrail?.append('identity.stage.committed', {
      stageId: stage.id,
      layerId: stage.layerId,
      layerName: stage.layerName,
      tier: stage.tier,
    });
    return { status: 'ready', stage: { ...stage }, waitMs: 0 };
  }
}

export function createIdentityCoolingOffManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<IdentityCoolingOffOptions, 'defaultCooldownMs'> = {},
): IdentityCoolingOffManager {
  return new IdentityCoolingOffManager({
    ...options,
    defaultCooldownMs: parsePositiveIntEnv(
      env.SAFEGUARD_IDENTITY_COOLDOWN_MS,
      DEFAULT_IDENTITY_COOLDOWN_MS,
    ),
  });
}

export interface LifecycleRestartRequest {
  toolName: string;
  reason: string | undefined;
  tier: CapabilityTier;
}

export interface LifecycleRestartDecision {
  allowed: boolean;
  reason: string;
  retryAfterMs?: number;
}

export interface LifecycleRestartOptions {
  cooldownMs?: number;
  maxPerHour?: number;
  now?: () => number;
  auditTrail?: SafeguardAuditTrail;
}

export class LifecycleRestartSafeguard {
  private readonly cooldownMs: number;
  private readonly maxPerHour: number;
  private readonly now: () => number;
  private readonly auditTrail?: SafeguardAuditTrail;
  private readonly restartHistory: number[] = [];

  constructor(options: LifecycleRestartOptions = {}) {
    this.cooldownMs = Math.max(
      MIN_RESTART_COOLDOWN_MS,
      normalizePositiveInt(options.cooldownMs, DEFAULT_RESTART_COOLDOWN_MS),
    );
    this.maxPerHour = normalizePositiveInt(options.maxPerHour, DEFAULT_MAX_RESTARTS_PER_HOUR);
    this.now = options.now ?? Date.now;
    this.auditTrail = options.auditTrail;
  }

  evaluate(request: LifecycleRestartRequest): LifecycleRestartDecision {
    const now = this.now();
    const reason = request.reason?.trim() ?? '';
    if (!reason) {
      this.auditTrail?.append('lifecycle.restart.denied', {
        toolName: request.toolName,
        tier: request.tier,
        cause: 'missing_reason',
      });
      return {
        allowed: false,
        reason: 'Restart blocked: reason is required.',
      };
    }

    this.pruneHistory(now);

    const last = this.restartHistory[this.restartHistory.length - 1] as number | undefined;
    if (last !== undefined && (now - last) < this.cooldownMs) {
      const retryAfterMs = this.cooldownMs - (now - last);
      this.auditTrail?.append('lifecycle.restart.denied', {
        toolName: request.toolName,
        tier: request.tier,
        cause: 'cooldown',
        retryAfterMs,
      });
      return {
        allowed: false,
        reason: `Restart blocked: cooldown active (${Math.ceil(retryAfterMs / 1000)}s remaining).`,
        retryAfterMs,
      };
    }

    if (this.restartHistory.length >= this.maxPerHour) {
      const oldest = this.restartHistory[0] as number | undefined;
      const retryAfterMs = oldest === undefined
        ? ONE_HOUR_MS
        : Math.max(1, ONE_HOUR_MS - (now - oldest));
      this.auditTrail?.append('lifecycle.restart.denied', {
        toolName: request.toolName,
        tier: request.tier,
        cause: 'rate_limit',
        retryAfterMs,
        maxPerHour: this.maxPerHour,
      });
      return {
        allowed: false,
        reason: `Restart blocked: hourly limit reached (${this.maxPerHour}/hour).`,
        retryAfterMs,
      };
    }

    this.restartHistory.push(now);
    this.auditTrail?.append('lifecycle.restart.allowed', {
      toolName: request.toolName,
      tier: request.tier,
      reason,
      cooldownMs: this.cooldownMs,
      maxPerHour: this.maxPerHour,
      usedThisHour: this.restartHistory.length,
    });
    return {
      allowed: true,
      reason,
    };
  }

  private pruneHistory(now: number): void {
    const windowStart = now - ONE_HOUR_MS;
    while (this.restartHistory.length > 0 && this.restartHistory[0] < windowStart) {
      this.restartHistory.shift();
    }
  }
}

export function createLifecycleRestartSafeguardFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<LifecycleRestartOptions, 'cooldownMs' | 'maxPerHour'> = {},
): LifecycleRestartSafeguard {
  return new LifecycleRestartSafeguard({
    ...options,
    cooldownMs: parsePositiveIntEnv(
      env.SAFEGUARD_RESTART_COOLDOWN_MS,
      DEFAULT_RESTART_COOLDOWN_MS,
    ),
    maxPerHour: parsePositiveIntEnv(
      env.SAFEGUARD_MAX_RESTARTS_PER_HOUR,
      DEFAULT_MAX_RESTARTS_PER_HOUR,
    ),
  });
}

export interface ExternalCommunicationRateLimitOptions {
  discordPerHour?: number;
  emailPerHour?: number;
  now?: () => number;
  auditTrail?: SafeguardAuditTrail;
}

export interface ExternalCommunicationRateLimitRequest {
  channel: ExternalCommunicationChannel;
  scope?: string;
}

export interface ExternalCommunicationRateLimitDecision {
  allowed: boolean;
  limit: number;
  used: number;
  retryAfterMs?: number;
}

export class ExternalCommunicationRateLimiter {
  private readonly limits: Readonly<Record<ExternalCommunicationChannel, number>>;
  private readonly now: () => number;
  private readonly auditTrail?: SafeguardAuditTrail;
  private readonly history = new Map<string, number[]>();

  constructor(options: ExternalCommunicationRateLimitOptions = {}) {
    this.limits = {
      discord: normalizePositiveInt(
        options.discordPerHour,
        DEFAULT_DISCORD_MESSAGES_PER_HOUR,
      ),
      email: normalizePositiveInt(
        options.emailPerHour,
        DEFAULT_EMAIL_MESSAGES_PER_HOUR,
      ),
    };
    this.now = options.now ?? Date.now;
    this.auditTrail = options.auditTrail;
  }

  evaluate(request: ExternalCommunicationRateLimitRequest): ExternalCommunicationRateLimitDecision {
    const now = this.now();
    const scope = request.scope?.trim() || 'default';
    const key = `${request.channel}:${scope}`;
    const limit = this.limits[request.channel];
    const history = this.history.get(key) ?? [];
    const windowStart = now - ONE_HOUR_MS;
    const active = history.filter(timestamp => timestamp >= windowStart);

    if (active.length >= limit) {
      const oldest = active[0] as number | undefined;
      const retryAfterMs = oldest === undefined
        ? ONE_HOUR_MS
        : Math.max(1, ONE_HOUR_MS - (now - oldest));
      this.history.set(key, active);
      this.auditTrail?.append('external.rate_limit.denied', {
        channel: request.channel,
        scope,
        used: active.length,
        limit,
        retryAfterMs,
      });
      return {
        allowed: false,
        limit,
        used: active.length,
        retryAfterMs,
      };
    }

    active.push(now);
    this.history.set(key, active);
    this.auditTrail?.append('external.rate_limit.allowed', {
      channel: request.channel,
      scope,
      used: active.length,
      limit,
    });
    return {
      allowed: true,
      limit,
      used: active.length,
    };
  }
}

export function createExternalCommunicationRateLimiterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<ExternalCommunicationRateLimitOptions, 'discordPerHour' | 'emailPerHour'> = {},
): ExternalCommunicationRateLimiter {
  return new ExternalCommunicationRateLimiter({
    ...options,
    discordPerHour: parsePositiveIntEnv(
      env.SAFEGUARD_DISCORD_MESSAGES_PER_HOUR,
      DEFAULT_DISCORD_MESSAGES_PER_HOUR,
    ),
    emailPerHour: parsePositiveIntEnv(
      env.SAFEGUARD_EMAIL_MESSAGES_PER_HOUR,
      DEFAULT_EMAIL_MESSAGES_PER_HOUR,
    ),
  });
}

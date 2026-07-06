import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { CapabilityTier, SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SessionActivitySummary } from '../../persistence/sessions/store.js';
import type { MemoryStoreStats } from '../../faculties/memory/memory-store-port.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  type ChargePolicyRuntimeLane,
} from '../../shared/contracts/charge-policy.js';
import {
  getRunChargeRollingWindowSnapshot,
  getRunChargeSnapshot,
} from '../../shared/telemetry/run-charge.js';
import {
  buildRuntimeDiagnosticsSnapshot,
  type RuntimeDiagnosticsQuery,
  type RuntimeDiagnosticsSnapshot,
} from '../../shared/diagnostics/runtime-diagnostics.js';
import type { AdaptiveToolRuntimeState } from '../agent/adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from '../agent/tool-catalog.js';
import type { ObserverEvalSidecarHealthSnapshot } from '../eval/observer-sidecar/types.js';
import type { RuntimeServiceHealthStatus } from '../../operator/tool-health/types.js';
import { textResult } from './results.js';

const DEFAULT_RECENT_CHANNEL_LIMIT = 8;

type SectionStatus = 'available' | 'unavailable' | 'error';

interface SectionUnavailable {
  status: Extract<SectionStatus, 'unavailable'>;
  reason: string;
}

interface SectionError {
  status: Extract<SectionStatus, 'error'>;
  reason: string;
}

type MaybeAvailable<T> = (T & { status: Extract<SectionStatus, 'available'> })
  | SectionUnavailable
  | SectionError;

export interface SelfStatusToolRuntime {
  config: Pick<SubstrateConfig, 'capabilityTier' | 'chargePolicy' | 'shardToolsets'>;
  startedAtMs?: number;
  now?: () => number;
  getCapabilityTier?: () => CapabilityTier;
  getAdaptiveToolRuntimeState?: () => AdaptiveToolRuntimeState;
  getToolCatalogSnapshot?: () => RuntimeToolCatalogSnapshot;
  getToolHealthStatusByName?: () => ReadonlyMap<string, RuntimeServiceHealthStatus>;
  getObserverEvalSidecarHealth?: () => ObserverEvalSidecarHealthSnapshot;
  getMemoryStats?: () => Promise<MemoryStoreStats>;
  listRecentSessions?: (limit?: number) => SessionActivitySummary[];
  getStreamingState?: () => boolean;
  logsDir?: string;
  getDiagnosticsSnapshot?: (query: RuntimeDiagnosticsQuery) => RuntimeDiagnosticsSnapshot | Promise<RuntimeDiagnosticsSnapshot>;
}

interface SelfStatusParams {
  action?: 'snapshot' | 'diagnostics';
  recentChannelLimit?: number;
  windowMs?: number;
  sinceMs?: number;
  limit?: number;
  includeFileLogs?: boolean;
}

function unavailable(reason: string): SectionUnavailable {
  return { status: 'unavailable', reason };
}

function sectionError(reason: string): SectionError {
  return { status: 'error', reason };
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RECENT_CHANNEL_LIMIT;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function cloneRecord<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

type ToolCatalogSection = {
  generatedAt: number;
  tools: Array<{ name: string; scope: string }>;
} | SectionUnavailable | SectionError;

function resolveCapabilityTier(runtime: SelfStatusToolRuntime): MaybeAvailable<{
  tier: CapabilityTier;
  source: 'runtime' | 'config';
}> {
  if (runtime.getCapabilityTier) {
    try {
      return {
        status: 'available',
        tier: runtime.getCapabilityTier(),
        source: 'runtime',
      };
    } catch {
      return sectionError('capability_tier_provider_failed');
    }
  }

  if (runtime.config.capabilityTier) {
    return {
      status: 'available',
      tier: runtime.config.capabilityTier,
      source: 'config',
    };
  }

  return unavailable('capability tier provider is not wired');
}

function foldToolHealthStatus(
  statuses: readonly RuntimeServiceHealthStatus[],
): RuntimeServiceHealthStatus {
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('healthy')) return 'healthy';
  return 'not_applicable';
}

function resolveToolHealth(runtime: SelfStatusToolRuntime): {
  status: RuntimeServiceHealthStatus;
  tools: Array<{ name: string; status: RuntimeServiceHealthStatus }>;
} {
  const healthByName = runtime.getToolHealthStatusByName?.();
  const tools = [...(healthByName?.entries() ?? [])]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, status]) => ({ name, status }));
  return {
    status: foldToolHealthStatus(tools.map(tool => tool.status)),
    tools,
  };
}

function resolveTools(runtime: SelfStatusToolRuntime): MaybeAvailable<{
  coreTools: string[];
  extendedTools: string[];
  activeTools: Array<{ toolName: string; source: string }>;
  promotedToolsConfigured: string[];
  promotedToolsActive: string[];
  promotedToolsSkipped: AdaptiveToolRuntimeState['promotedToolsSkipped'];
  loadedExtendedTools: Array<{
    toolName: string;
    source: string;
    activatedAt: number;
    lastActivatedAt: number;
  }>;
  counts: {
    core: number;
    extended: number;
    active: number;
    promotedActive: number;
    loadedExtended: number;
  };
  catalog: ToolCatalogSection;
  health: ReturnType<typeof resolveToolHealth>;
}> {
  if (!runtime.getAdaptiveToolRuntimeState) {
    return unavailable('adaptive tool runtime state provider is not wired');
  }

  let state: AdaptiveToolRuntimeState;
  try {
    state = runtime.getAdaptiveToolRuntimeState();
  } catch {
    return sectionError('adaptive tool runtime state provider failed');
  }

  let catalog: ToolCatalogSection;
  if (!runtime.getToolCatalogSnapshot) {
    catalog = unavailable('tool catalog snapshot provider is not wired');
  } else {
    try {
      const snapshot = runtime.getToolCatalogSnapshot();
      catalog = {
        generatedAt: snapshot.generatedAt,
        tools: snapshot.tools
          .map(tool => ({ name: tool.name, scope: tool.scope }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
    } catch {
      catalog = sectionError('tool catalog snapshot provider failed');
    }
  }

  return {
    status: 'available',
    coreTools: [...state.coreTools],
    extendedTools: [...state.extendedTools],
    activeTools: state.activeTools.map(tool => ({ ...tool })),
    promotedToolsConfigured: [...state.promotedToolsConfigured],
    promotedToolsActive: [...state.promotedToolsActive],
    promotedToolsSkipped: state.promotedToolsSkipped.map(skip => ({
      ...skip,
      ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
    })),
    loadedExtendedTools: state.loadedExtendedTools.map(tool => ({ ...tool })),
    counts: {
      core: state.coreTools.length,
      extended: state.extendedTools.length,
      active: state.activeTools.length,
      promotedActive: state.promotedToolsActive.length,
      loadedExtended: state.loadedExtendedTools.length,
    },
    catalog,
    health: resolveToolHealth(runtime),
  };
}

function resolveCharge(runtime: SelfStatusToolRuntime): MaybeAvailable<{
  rollingWindowMs: number;
  rollingWindowEntryCount: number;
  currentRun: ReturnType<typeof getRunChargeSnapshot> | null;
  lanes: Record<ChargePolicyRuntimeLane, {
    quota: number;
    rollingWindowSpent: number;
    rollingWindowRemaining: number;
    currentRunSpent: number;
    currentRunRemaining: number;
  }>;
}> {
  const chargePolicy = runtime.config.chargePolicy;
  if (!chargePolicy) {
    return unavailable('charge policy is not configured');
  }

  const rolling = getRunChargeRollingWindowSnapshot(runtime.now?.() ?? Date.now());
  const currentRun = getRunChargeSnapshot() ?? null;
  const lanes = {} as Record<ChargePolicyRuntimeLane, {
    quota: number;
    rollingWindowSpent: number;
    rollingWindowRemaining: number;
    currentRunSpent: number;
    currentRunRemaining: number;
  }>;

  for (const lane of CHARGE_POLICY_RUNTIME_LANE_VALUES) {
    const quota = chargePolicy.runChargeQuotaByLane[lane];
    const rollingWindowSpent = rolling.spentByLane[lane] ?? 0;
    const currentRunSpent = currentRun?.quotaSpentByLane[lane] ?? 0;
    lanes[lane] = {
      quota,
      rollingWindowSpent,
      rollingWindowRemaining: Math.max(0, quota - rollingWindowSpent),
      currentRunSpent,
      currentRunRemaining: Math.max(0, quota - currentRunSpent),
    };
  }

  return {
    status: 'available',
    rollingWindowMs: rolling.windowMs,
    rollingWindowEntryCount: rolling.entryCount,
    currentRun,
    lanes,
  };
}

async function resolveMemory(runtime: SelfStatusToolRuntime): Promise<MaybeAvailable<{
  stats: MemoryStoreStats;
}>> {
  if (!runtime.getMemoryStats) {
    return unavailable('memory stats provider is not wired');
  }

  try {
    return {
      status: 'available',
      stats: await runtime.getMemoryStats(),
    };
  } catch {
    return sectionError('memory stats provider failed');
  }
}

function sanitizeSession(summary: SessionActivitySummary): {
  sessionId: string;
  channelId: string;
  channelType?: string;
  lastActivityAt: number;
  messageCount: number;
  lastRole: SessionActivitySummary['lastRole'];
} {
  return {
    sessionId: summary.sessionId,
    channelId: summary.channelId,
    ...(summary.channelType ? { channelType: summary.channelType } : {}),
    lastActivityAt: summary.lastActivityAt,
    messageCount: summary.messageCount,
    lastRole: summary.lastRole,
  };
}

function resolveChannels(runtime: SelfStatusToolRuntime, limit: number): MaybeAvailable<{
  recent: ReturnType<typeof sanitizeSession>[];
}> {
  if (!runtime.listRecentSessions) {
    return unavailable('recent session provider is not wired');
  }

  try {
    return {
      status: 'available',
      recent: runtime.listRecentSessions(limit).map(sanitizeSession),
    };
  } catch {
    return sectionError('recent session provider failed');
  }
}

function resolveUptime(runtime: SelfStatusToolRuntime): {
  status: 'available';
  startedAtMs: number;
  uptimeMs: number;
} {
  const now = runtime.now?.() ?? Date.now();
  const startedAtMs = runtime.startedAtMs ?? Math.trunc(now - process.uptime() * 1000);
  return {
    status: 'available',
    startedAtMs,
    uptimeMs: Math.max(0, now - startedAtMs),
  };
}

function resolveHeartbeat(
  channels: ReturnType<typeof resolveChannels>,
  now: number,
): MaybeAvailable<{
  channelId: string;
  sessionId: string;
  lastActivityAt: number;
  ageMs: number;
}> {
  if (channels.status !== 'available') {
    return unavailable('recent session provider is unavailable');
  }

  const heartbeat = channels.recent.find(session => (
    session.channelId.includes('heartbeat')
    || session.sessionId.includes('heartbeat')
  ));
  if (!heartbeat) {
    return unavailable('no heartbeat session activity is recorded in recent sessions');
  }

  return {
    status: 'available',
    channelId: heartbeat.channelId,
    sessionId: heartbeat.sessionId,
    lastActivityAt: heartbeat.lastActivityAt,
    ageMs: Math.max(0, now - heartbeat.lastActivityAt),
  };
}

function resolveObserverEval(runtime: SelfStatusToolRuntime): MaybeAvailable<{
  healthStatus: ObserverEvalSidecarHealthSnapshot['status'];
  enabled: boolean;
  available: boolean;
  accepting: boolean;
  queue: ObserverEvalSidecarHealthSnapshot['queue'];
  counts: ObserverEvalSidecarHealthSnapshot['counts'];
  lastDrop?: Omit<NonNullable<ObserverEvalSidecarHealthSnapshot['lastDrop']>, 'turnId' | 'requestId'>;
  lastFailure?: Omit<NonNullable<ObserverEvalSidecarHealthSnapshot['lastFailure']>, 'turnId' | 'requestId' | 'message'>;
}> {
  if (!runtime.getObserverEvalSidecarHealth) {
    return unavailable('observer eval sidecar health provider is not wired');
  }

  try {
    const health = runtime.getObserverEvalSidecarHealth();
    return {
      status: 'available',
      healthStatus: health.status,
      enabled: health.enabled,
      available: health.available,
      accepting: health.accepting,
      queue: cloneRecord(health.queue),
      counts: cloneRecord(health.counts),
      ...(health.lastDrop
        ? {
            lastDrop: {
              reason: health.lastDrop.reason,
              observedAt: health.lastDrop.observedAt,
            },
          }
        : {}),
      ...(health.lastFailure
        ? {
            lastFailure: {
              reason: health.lastFailure.reason,
              attempt: health.lastFailure.attempt,
              observedAt: health.lastFailure.observedAt,
            },
          }
        : {}),
    };
  } catch {
    return sectionError('observer eval sidecar health provider failed');
  }
}

function resolveSubstrate(runtime: SelfStatusToolRuntime): {
  status: 'available';
  streaming: boolean | SectionUnavailable | SectionError;
  observerEval: ReturnType<typeof resolveObserverEval>;
  shardToolsets: SubstrateConfig['shardToolsets'] | SectionUnavailable;
} {
  let streaming: boolean | SectionUnavailable | SectionError;
  if (!runtime.getStreamingState) {
    streaming = unavailable('streaming state provider is not wired');
  } else {
    try {
      streaming = runtime.getStreamingState();
    } catch {
      streaming = sectionError('streaming state provider failed');
    }
  }

  return {
    status: 'available',
    streaming,
    observerEval: resolveObserverEval(runtime),
    shardToolsets: runtime.config.shardToolsets
      ? { ...runtime.config.shardToolsets }
      : unavailable('shard toolset config is not configured'),
  };
}

export async function buildSelfStatusSnapshot(
  runtime: SelfStatusToolRuntime,
  params: SelfStatusParams = {},
): Promise<Record<string, unknown>> {
  const now = runtime.now?.() ?? Date.now();
  const recentChannelLimit = clampLimit(params.recentChannelLimit);
  const channels = resolveChannels(runtime, recentChannelLimit);

  return {
    schemaVersion: 1,
    generatedAt: now,
    capability: resolveCapabilityTier(runtime),
    tools: resolveTools(runtime),
    charge: resolveCharge(runtime),
    channels,
    heartbeat: resolveHeartbeat(channels, now),
    uptime: resolveUptime(runtime),
    memory: await resolveMemory(runtime),
    substrate: resolveSubstrate(runtime),
  };
}

export async function buildSelfDiagnosticsSnapshot(
  runtime: SelfStatusToolRuntime,
  params: SelfStatusParams = {},
): Promise<Record<string, unknown>> {
  const query: RuntimeDiagnosticsQuery = {
    ...(runtime.now ? { now: runtime.now } : {}),
    ...(runtime.logsDir ? { logsDir: runtime.logsDir } : {}),
    ...(params.windowMs !== undefined ? { windowMs: params.windowMs } : {}),
    ...(params.sinceMs !== undefined ? { sinceMs: params.sinceMs } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.includeFileLogs !== undefined ? { includeFileLogs: params.includeFileLogs } : {}),
  };

  try {
    return runtime.getDiagnosticsSnapshot
      ? await runtime.getDiagnosticsSnapshot(query)
      : buildRuntimeDiagnosticsSnapshot(query);
  } catch {
    return {
      schemaVersion: 1,
      generatedAt: runtime.now?.() ?? Date.now(),
      status: 'error',
      reason: 'diagnostics provider failed',
    };
  }
}

export function createSelfStatusTool(runtime: SelfStatusToolRuntime): AgentTool<any> {
  return {
    name: 'self_status',
    label: 'self_status',
    description:
      'Read safe structured runtime self-status or diagnostics. The diagnostics action returns bounded, redacted warnings/errors, validation counts, lifecycle events, backup status, and unavailable markers for kube-only data.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('snapshot'),
        Type.Literal('diagnostics'),
      ], {
        description: 'Use diagnostics for redacted recent warning/error and runtime diagnostic data. Defaults to snapshot.',
      })),
      recentChannelLimit: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 20,
        description: 'Maximum recent channel summaries to include. Message content is never returned.',
      })),
      windowMs: Type.Optional(Type.Number({
        minimum: 1000,
        maximum: 86_400_000,
        description: 'Diagnostics lookback window in milliseconds. Bounded to at most 24 hours.',
      })),
      sinceMs: Type.Optional(Type.Number({
        minimum: 0,
        description: 'Diagnostics lower timestamp bound in Unix milliseconds. Older ranges are clamped to the bounded window.',
      })),
      limit: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 100,
        description: 'Maximum diagnostic records per section.',
      })),
      includeFileLogs: Type.Optional(Type.Boolean({
        description: 'Whether diagnostics should include bounded reads from the runtime log directory when present.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: SelfStatusParams = {},
    ): Promise<AgentToolResult<Record<string, never>>> => textResult(
      JSON.stringify(
        params.action === 'diagnostics'
          ? await buildSelfDiagnosticsSnapshot(runtime, params)
          : await buildSelfStatusSnapshot(runtime, params),
        null,
        2,
      ),
    ),
  };
}

import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import type { CapabilityTier, SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
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
import { buildSelfDiagnosisReport, type SelfDiagnosisDeps } from './self-diagnosis.js';
import type { ToolConformanceRunResult } from '../agent/tool-conformance/types.js';
import { textResult, textResultWithError } from './results.js';
import { toRecordView } from '../../shared/utils/types.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import {
  executeSelfAvailabilityAction,
  SELF_AVAILABILITY_ACTIONS,
  type SelfAvailabilityAction,
} from './self-availability.js';

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
  getCapabilityGrantSnapshot?: () => CapabilityGrantSnapshot;
  getAdaptiveToolRuntimeState?: () => AdaptiveToolRuntimeState;
  getToolCatalogSnapshot?: () => RuntimeToolCatalogSnapshot;
  getToolHealthStatusByName?: () => ReadonlyMap<string, RuntimeServiceHealthStatus>;
  getObserverEvalSidecarHealth?: () => ObserverEvalSidecarHealthSnapshot;
  getMemoryStats?: () => Promise<MemoryStoreStats>;
  listRecentSessions?: (limit?: number) => SessionActivitySummary[];
  getStreamingState?: () => boolean;
  logsDir?: string;
  getDiagnosticsSnapshot?: (query: RuntimeDiagnosticsQuery) => RuntimeDiagnosticsSnapshot | Promise<RuntimeDiagnosticsSnapshot>;
  /**
   * Fail-closed dependency surface for the `diagnose` action. Absent when the
   * runtime cannot introspect its Kubernetes deployment; the action then reports
   * an explicit unavailable result instead of guessing.
   */
  diagnosis?: SelfDiagnosisDeps;
  /**
   * Runs the LLM-free tool-surface conformance sweep and returns the aggregated
   * result as the single tool result. The sweep executes tool handlers directly
   * and never writes tool observations into a conversational session store.
   */
  runConformance?: (trigger: 'manual') => Promise<ToolConformanceRunResult>;
  availability?: AgentFacingIcpAutonomyRuntime;
}

interface SelfStatusParams {
  action?: 'capabilities' | 'snapshot' | 'diagnose' | 'logs' | 'conformance' | SelfAvailabilityAction;
  state?: Parameters<AgentFacingIcpAutonomyRuntime['publishOwnAvailability']>[0]['state'];
  expires_at_ms?: number;
  revision?: number;
  expected_revision?: number;
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
  return structuredClone(record);
}

type ToolCatalogSection = {
  generatedAt: number;
  tools: Array<{ name: string; scope: string }>;
} | SectionUnavailable | SectionError;

function resolveCapabilityTier(runtime: SelfStatusToolRuntime): MaybeAvailable<{
  tier: CapabilityTier;
  grantedTokens: readonly string[];
  source: 'runtime' | 'config';
}> {
  if (runtime.getCapabilityGrantSnapshot) {
    try {
      const snapshot = runtime.getCapabilityGrantSnapshot();
      return {
        status: 'available',
        tier: snapshot.tier,
        grantedTokens: [...snapshot.grantedTokens],
        source: 'runtime',
      };
    } catch {
      return sectionError('capability_grant_provider_failed');
    }
  }

  if (runtime.getCapabilityTier) {
    try {
      const tier = runtime.getCapabilityTier();
      if (tier === 'custom') {
        return sectionError('custom capability grant provider is not wired');
      }
      return {
        status: 'available',
        tier,
        grantedTokens: resolveTierCapabilityTokens(tier),
        source: 'runtime',
      };
    } catch {
      return sectionError('capability_tier_provider_failed');
    }
  }

  if (runtime.config.capabilityTier) {
    if (runtime.config.capabilityTier === 'custom') {
      return sectionError('custom capability grant provider is not wired');
    }
    return {
      status: 'available',
      tier: runtime.config.capabilityTier,
      grantedTokens: resolveTierCapabilityTokens(runtime.config.capabilityTier),
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
  counts: {
    core: number;
    extended: number;
    active: number;
    pinnedOrderApplied: number;
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
    counts: {
      core: state.coreTools.length,
      extended: state.extendedTools.length,
      active: state.activeTools.length,
      pinnedOrderApplied: state.promotedToolsActive.length,
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
    return toRecordView(runtime.getDiagnosticsSnapshot
      ? await runtime.getDiagnosticsSnapshot(query)
      : buildRuntimeDiagnosticsSnapshot(query));
  } catch {
    return {
      schemaVersion: 1,
      generatedAt: runtime.now?.() ?? Date.now(),
      status: 'error',
      reason: 'diagnostics provider failed',
    };
  }
}

export async function buildSelfStatusResult(
  runtime: SelfStatusToolRuntime,
  params: SelfStatusParams = {},
): Promise<Record<string, unknown>> {
  if (params.action === 'capabilities') {
    return {
      schemaVersion: 1,
      generatedAt: runtime.now?.() ?? Date.now(),
      capability: resolveCapabilityTier(runtime),
    };
  }
  if (params.action === 'diagnose') {
    if (!runtime.diagnosis) {
      return {
        schemaVersion: 1,
        action: 'diagnose',
        status: 'unavailable',
        reason: 'self-diagnosis dependencies are not wired into this runtime',
      };
    }
    return buildSelfDiagnosisReport(runtime.diagnosis);
  }
  if (params.action === 'logs') {
    return buildSelfDiagnosticsSnapshot(runtime, params);
  }
  return buildSelfStatusSnapshot(runtime, params);
}

export function createSelfStatusTool(runtime: SelfStatusToolRuntime): SubstrateAgentTool {
  return {
    name: 'self_status',
    label: 'self_status',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.self_status,
    parameters: Type.Object({
      action: Type.Optional(Type.Union(
        [
          Type.Literal('capabilities'),
          Type.Literal('snapshot'),
          Type.Literal('diagnose'),
          Type.Literal('logs'),
          Type.Literal('conformance'),
          ...SELF_AVAILABILITY_ACTIONS.map(action => Type.Literal(action)),
        ],
        {
          description: 'capabilities returns only the current tier and effective grant; snapshot (default) returns the broader runtime snapshot; diagnose returns the Kubernetes self-diagnosis report; logs returns redacted recent diagnostics; conformance runs the tool-surface sweep.',
        },
      )),
      recentChannelLimit: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 20,
        description: 'Maximum recent channel summaries to include (snapshot only). Message content is never returned.',
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
      state: Type.Optional(Type.Union([
        Type.Literal('available'),
        Type.Literal('open_to_chat'),
        Type.Literal('busy'),
        Type.Literal('resting'),
        Type.Literal('do_not_disturb'),
      ], { description: 'Required for availability_publish.' })),
      expires_at_ms: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Required for availability_publish. Expiring epoch-millisecond lease bound.',
      })),
      revision: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Required optimistic revision for availability_publish.',
      })),
      expected_revision: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Required current revision for availability_clear.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: SelfStatusParams = {},
    ): Promise<AgentToolResult<unknown>> => {
      if (params.action && SELF_AVAILABILITY_ACTIONS.includes(params.action as SelfAvailabilityAction)) {
        if (!runtime.availability) {
          return textResultWithError(
            `self_status action="${params.action}" is unavailable: ICP availability runtime is not wired.`,
            true,
          );
        }
        return await executeSelfAvailabilityAction({
          runtime: runtime.availability,
          params: params as Parameters<typeof executeSelfAvailabilityAction>[0]['params'],
          nowMs: runtime.now?.(),
        });
      }
      if (params.action === 'conformance') {
        if (!runtime.runConformance) {
          return textResultWithError('self_status action="conformance" is unavailable: conformance runner is not wired.', true);
        }
        const result = await runtime.runConformance('manual');
        return textResult(JSON.stringify(result, null, 2));
      }
      return textResult(JSON.stringify(await buildSelfStatusResult(runtime, params), null, 2));
    },
  };
}

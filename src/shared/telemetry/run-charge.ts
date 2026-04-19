import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { CorrelationMetadata, RunChargeEvent, RunChargeLineage } from '../contracts/runtime.js';
import type {
  ChargePolicyConfig,
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from '../../system/config/charge-policy-config.js';
import type { EventBus } from '../event-bus.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';

interface RunChargeAccount {
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
}

interface RunChargeContextState {
  chargePolicy: ChargePolicyConfig;
  eventBus?: Pick<EventBus, 'emit'> | null;
  lane: ChargePolicyRuntimeLane;
  lineage: RunChargeLineage;
  account: RunChargeAccount;
  correlation?: Partial<CorrelationMetadata>;
}

export interface RunChargeContextInput {
  chargePolicy?: ChargePolicyConfig;
  eventBus?: Pick<EventBus, 'emit'> | null;
  lane: ChargePolicyRuntimeLane;
  runId?: string;
  parentRunId?: string;
  rootRunId?: string;
  correlation?: Partial<CorrelationMetadata>;
}

export interface RunChargeChargeInput {
  amount?: number;
  chargePolicy?: ChargePolicyConfig;
  correlation?: Partial<CorrelationMetadata>;
  details?: Record<string, unknown>;
  eventBus?: Pick<EventBus, 'emit'> | null;
  lane?: ChargePolicyRuntimeLane;
  parentRunId?: string;
  rootRunId?: string;
  runId?: string;
}

export interface ChargeSurfaceInspection {
  lane: ChargePolicyRuntimeLane;
  surface: ChargePolicySurface;
  amount: number;
  quota: number;
  spentBefore: number;
  spentAfter: number;
  remainingBefore: number;
  remainingAfter: number;
  allowed: boolean;
}

const runChargeStorage = new AsyncLocalStorage<RunChargeContextState>();

function normalizePositiveNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function createRunChargeAccount(): RunChargeAccount {
  return { spentByLane: {} };
}

function createFallbackRunId(prefix = 'run-charge'): string {
  return `${prefix}-${randomUUID()}`;
}

function resolveBaseRunId(parent: RunChargeContextState | undefined): string {
  const requestContext = getRequestContext();
  return parent?.lineage.runId
    || requestContext?.requestId?.trim()
    || requestContext?.turnId?.trim()
    || requestContext?.toolCallId?.trim()
    || createFallbackRunId();
}

function resolveRunId(
  parent: RunChargeContextState | undefined,
  input: Pick<RunChargeContextInput, 'runId'>,
): string {
  const explicit = input.runId?.trim();
  if (explicit) {
    return explicit;
  }
  if (parent) {
    return createFallbackRunId(parent.lineage.runId);
  }
  return resolveBaseRunId(parent);
}

function resolveLineage(
  parent: RunChargeContextState | undefined,
  input: RunChargeContextInput,
  runId: string,
): RunChargeLineage {
  const parentRunId = input.parentRunId?.trim() || parent?.lineage.runId;
  const rootRunId = input.rootRunId?.trim() || parent?.lineage.rootRunId || parentRunId || runId;
  return {
    runId,
    rootRunId,
    ...(parentRunId ? { parentRunId } : {}),
  };
}

function resolveCorrelation(
  parent: RunChargeContextState | undefined,
  input: RunChargeContextInput,
): Partial<CorrelationMetadata> | undefined {
  const requestContext = getRequestContext();
  const merged = {
    ...(parent?.correlation ?? {}),
    ...(requestContext ?? {}),
    ...(input.correlation ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function createChargeEvent(input: {
  amount: number;
  correlation?: Partial<CorrelationMetadata>;
  details?: Record<string, unknown>;
  lane: ChargePolicyRuntimeLane;
  lineage: RunChargeLineage;
  surface: ChargePolicySurface;
  spentAfter: number;
  quota: number;
}): RunChargeEvent {
  return {
    timestampMs: Date.now(),
    lane: input.lane,
    surface: input.surface,
    amount: input.amount,
    quota: input.quota,
    spentAfter: input.spentAfter,
    remainingAfter: Math.max(0, input.quota - input.spentAfter),
    lineage: input.lineage,
    ...(input.correlation ?? {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

export function inspectChargeSurface(
  surface: ChargePolicySurface,
  input: RunChargeChargeInput = {},
): ChargeSurfaceInspection | null {
  const context = getRunChargeContext();
  const chargePolicy = input.chargePolicy ?? context?.chargePolicy;
  if (!chargePolicy) {
    return null;
  }

  const lane = input.lane ?? context?.lane;
  if (!lane) {
    throw new Error(`Charge surface "${surface}" requires a runtime lane`);
  }

  const amount = normalizePositiveNumber(input.amount ?? chargePolicy.surfaceCosts[surface]);
  if (amount === 0) {
    return null;
  }

  const quota = chargePolicy.runChargeQuotaByLane[lane];
  const spentBefore = context?.account.spentByLane[lane] ?? 0;
  const spentAfter = spentBefore + amount;
  return {
    lane,
    surface,
    amount,
    quota,
    spentBefore,
    spentAfter,
    remainingBefore: Math.max(0, quota - spentBefore),
    remainingAfter: Math.max(0, quota - spentAfter),
    allowed: spentAfter <= quota,
  };
}

export function getRunChargeContext(): RunChargeContextState | undefined {
  return runChargeStorage.getStore();
}

export function runWithChargeContext<T>(
  input: RunChargeContextInput,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = getRunChargeContext();
  const chargePolicy = input.chargePolicy ?? parent?.chargePolicy;
  if (!chargePolicy) {
    throw new Error('runWithChargeContext requires a charge policy');
  }
  const runId = resolveRunId(parent, input);
  return runChargeStorage.run({
    chargePolicy,
    eventBus: input.eventBus ?? parent?.eventBus,
    lane: input.lane,
    lineage: resolveLineage(parent, input, runId),
    account: parent?.account ?? createRunChargeAccount(),
    correlation: resolveCorrelation(parent, input),
  }, fn);
}

export function chargeSurface(
  surface: ChargePolicySurface,
  input: RunChargeChargeInput = {},
): RunChargeEvent | null {
  const context = getRunChargeContext();
  const eventBus = input.eventBus ?? context?.eventBus;
  const inspection = inspectChargeSurface(surface, input);
  if (!inspection) {
    return null;
  }

  if (!inspection.allowed) {
    throw new Error(
      `Charge quota exceeded for lane "${inspection.lane}" while charging "${surface}" (${inspection.spentAfter}/${inspection.quota}).`,
    );
  }

  if (context) {
    context.account.spentByLane[inspection.lane] = inspection.spentAfter;
  }

  const lineage = {
    runId: input.runId?.trim() || context?.lineage.runId || resolveBaseRunId(context),
    rootRunId: input.rootRunId?.trim() || context?.lineage.rootRunId || context?.lineage.parentRunId || input.runId?.trim() || resolveBaseRunId(context),
    ...(input.parentRunId?.trim()
      ? { parentRunId: input.parentRunId.trim() }
      : context?.lineage.parentRunId
        ? { parentRunId: context.lineage.parentRunId }
        : {}),
  } satisfies RunChargeLineage;

  const event = createChargeEvent({
    amount: inspection.amount,
    correlation: {
      ...(context?.correlation ?? {}),
      ...(input.correlation ?? {}),
    },
    details: input.details,
    lane: inspection.lane,
    lineage,
    surface,
    spentAfter: inspection.spentAfter,
    quota: inspection.quota,
  });

  void eventBus?.emit('agent.charge', event);
  return event;
}

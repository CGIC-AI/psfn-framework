import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { CorrelationMetadata, RunChargeEvent, RunChargeLineage } from '../contracts/runtime.js';
import type {
  ChargePolicyConfig,
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from '../contracts/charge-policy.js';
import type { EventBus } from '../event-bus.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';

interface RunChargeAccount {
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  directSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  foldedSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  foldBacks: RunChargeLineageProvenance[];
  orphanedChildren: RunChargeLineageProvenance[];
}

interface RunChargeQuotaAccount {
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
}

export interface RunChargeLineageProvenance {
  disposition: 'folded' | 'orphaned';
  lineage: RunChargeLineage;
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  directSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  foldedSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  foldBacks: RunChargeLineageProvenance[];
  orphanedChildren: RunChargeLineageProvenance[];
}

export interface RunChargeSnapshot {
  lineage: RunChargeLineage;
  lane: ChargePolicyRuntimeLane;
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  directSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  foldedSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  foldBacks: RunChargeLineageProvenance[];
  orphanedChildren: RunChargeLineageProvenance[];
  quotaSpentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
}

export interface RunChargeRollingWindowSnapshot {
  windowMs: number;
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  entryCount: number;
}

interface RunChargeContextState {
  chargePolicy: ChargePolicyConfig;
  eventBus?: Pick<EventBus, 'emit'> | null;
  lane: ChargePolicyRuntimeLane;
  lineage: RunChargeLineage;
  account: RunChargeAccount;
  quotaAccount: RunChargeQuotaAccount;
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
  quotaSpentBefore: number;
  quotaSpentAfter: number;
  rollingWindowSpentBefore: number;
  rollingWindowSpentAfter: number;
  rollingWindowRemainingBefore: number;
  rollingWindowRemainingAfter: number;
  allowed: boolean;
}

const runChargeStorage = new AsyncLocalStorage<RunChargeContextState>();
export const RUN_CHARGE_ROLLING_WINDOW_MS = 24 * 60 * 60_000;

interface RollingChargeWindowEntry {
  sourceKey: string;
  timestampMs: number;
  lane: ChargePolicyRuntimeLane;
  amount: number;
}

let rollingChargeWindowEntries: RollingChargeWindowEntry[] = [];

function normalizePositiveNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function createRunChargeAccount(): RunChargeAccount {
  return {
    spentByLane: {},
    directSpentByLane: {},
    foldedSpentByLane: {},
    foldBacks: [],
    orphanedChildren: [],
  };
}

function createRunChargeQuotaAccount(): RunChargeQuotaAccount {
  return { spentByLane: {} };
}

function addSpentByLane(
  target: Partial<Record<ChargePolicyRuntimeLane, number>>,
  lane: ChargePolicyRuntimeLane,
  amount: number,
): void {
  if (amount <= 0) {
    return;
  }
  target[lane] = (target[lane] ?? 0) + amount;
}

function cloneSpentByLane(
  source: Partial<Record<ChargePolicyRuntimeLane, number>>,
): Partial<Record<ChargePolicyRuntimeLane, number>> {
  return { ...source };
}

function createRollingWindowEventKey(event: RunChargeEvent): string {
  return JSON.stringify([
    event.timestampMs,
    event.lane,
    event.surface,
    event.amount,
    event.lineage.runId,
    event.lineage.rootRunId,
    event.lineage.parentRunId ?? '',
    event.requestId ?? '',
    event.turnId ?? '',
    event.toolCallId ?? '',
    event.callType ?? '',
    event.purpose ?? '',
  ]);
}

function pruneRollingChargeWindow(nowMs: number): void {
  const cutoffMs = nowMs - RUN_CHARGE_ROLLING_WINDOW_MS;
  rollingChargeWindowEntries = rollingChargeWindowEntries.filter(entry => entry.timestampMs >= cutoffMs);
}

function getRollingWindowSpentForLane(lane: ChargePolicyRuntimeLane, nowMs: number): number {
  pruneRollingChargeWindow(nowMs);
  return rollingChargeWindowEntries.reduce((total, entry) => {
    if (entry.timestampMs > nowMs || entry.lane !== lane) {
      return total;
    }
    return total + entry.amount;
  }, 0);
}

function recordRollingChargeEvent(event: RunChargeEvent): void {
  if (event.amount <= 0) {
    return;
  }
  pruneRollingChargeWindow(event.timestampMs);
  const sourceKey = createRollingWindowEventKey(event);
  if (rollingChargeWindowEntries.some(entry => entry.sourceKey === sourceKey)) {
    return;
  }
  rollingChargeWindowEntries.push({
    sourceKey,
    timestampMs: event.timestampMs,
    lane: event.lane,
    amount: event.amount,
  });
}

export function hydrateRunChargeRollingWindowFromEvents(
  events: readonly RunChargeEvent[],
  nowMs = Date.now(),
): void {
  pruneRollingChargeWindow(nowMs);
  for (const event of events) {
    if (event.amount <= 0 || event.timestampMs > nowMs) {
      continue;
    }
    recordRollingChargeEvent(event);
  }
  pruneRollingChargeWindow(nowMs);
}

export function getRunChargeRollingWindowSnapshot(nowMs = Date.now()): RunChargeRollingWindowSnapshot {
  pruneRollingChargeWindow(nowMs);
  const spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>> = {};
  let entryCount = 0;
  for (const entry of rollingChargeWindowEntries) {
    if (entry.timestampMs > nowMs) {
      continue;
    }
    entryCount += 1;
    addSpentByLane(spentByLane, entry.lane, entry.amount);
  }
  return {
    windowMs: RUN_CHARGE_ROLLING_WINDOW_MS,
    spentByLane,
    entryCount,
  };
}

export function resetRunChargeRollingWindowForTests(): void {
  rollingChargeWindowEntries = [];
}

function cloneLineageProvenance(record: RunChargeLineageProvenance): RunChargeLineageProvenance {
  return {
    disposition: record.disposition,
    lineage: { ...record.lineage },
    spentByLane: cloneSpentByLane(record.spentByLane),
    directSpentByLane: cloneSpentByLane(record.directSpentByLane),
    foldedSpentByLane: cloneSpentByLane(record.foldedSpentByLane),
    foldBacks: record.foldBacks.map(cloneLineageProvenance),
    orphanedChildren: record.orphanedChildren.map(cloneLineageProvenance),
  };
}

function snapshotAccountLineage(
  lineage: RunChargeLineage,
  account: RunChargeAccount,
  disposition: RunChargeLineageProvenance['disposition'],
): RunChargeLineageProvenance {
  return {
    disposition,
    lineage: { ...lineage },
    spentByLane: cloneSpentByLane(account.spentByLane),
    directSpentByLane: cloneSpentByLane(account.directSpentByLane),
    foldedSpentByLane: cloneSpentByLane(account.foldedSpentByLane),
    foldBacks: account.foldBacks.map(cloneLineageProvenance),
    orphanedChildren: account.orphanedChildren.map(cloneLineageProvenance),
  };
}

function foldChildAccountIntoParent(
  parent: RunChargeAccount,
  child: RunChargeAccount,
  childLineage: RunChargeLineage,
): void {
  const childSnapshot = snapshotAccountLineage(childLineage, child, 'folded');
  for (const [lane, amount] of Object.entries(childSnapshot.spentByLane)) {
    addSpentByLane(parent.spentByLane, lane as ChargePolicyRuntimeLane, amount);
    addSpentByLane(parent.foldedSpentByLane, lane as ChargePolicyRuntimeLane, amount);
  }
  parent.foldBacks.push(childSnapshot);
}

function recordOrphanedChildAccount(
  parent: RunChargeAccount,
  child: RunChargeAccount,
  childLineage: RunChargeLineage,
): void {
  const childSnapshot = snapshotAccountLineage(childLineage, child, 'orphaned');
  const hasSpend = Object.values(childSnapshot.spentByLane).some((amount) => amount > 0);
  if (!hasSpend) {
    return;
  }
  parent.orphanedChildren.push(childSnapshot);
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
  timestampMs: number;
  quota: number;
}): RunChargeEvent {
  return {
    timestampMs: input.timestampMs,
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
  const quotaSpentBefore = context?.quotaAccount.spentByLane[lane] ?? spentBefore;
  const quotaSpentAfter = quotaSpentBefore + amount;
  const nowMs = Date.now();
  const rollingWindowSpentBefore = getRollingWindowSpentForLane(lane, nowMs);
  const rollingWindowSpentAfter = rollingWindowSpentBefore + amount;
  return {
    lane,
    surface,
    amount,
    quota,
    spentBefore,
    spentAfter,
    remainingBefore: Math.max(0, quota - quotaSpentBefore),
    remainingAfter: Math.max(0, quota - quotaSpentAfter),
    quotaSpentBefore,
    quotaSpentAfter,
    rollingWindowSpentBefore,
    rollingWindowSpentAfter,
    rollingWindowRemainingBefore: Math.max(0, quota - rollingWindowSpentBefore),
    rollingWindowRemainingAfter: Math.max(0, quota - rollingWindowSpentAfter),
    allowed: quotaSpentAfter <= quota && rollingWindowSpentAfter <= quota,
  };
}

export function getRunChargeContext(): RunChargeContextState | undefined {
  return runChargeStorage.getStore();
}

export function getRunChargeSnapshot(): RunChargeSnapshot | undefined {
  const context = getRunChargeContext();
  if (!context) {
    return undefined;
  }
  return {
    lineage: { ...context.lineage },
    lane: context.lane,
    spentByLane: cloneSpentByLane(context.account.spentByLane),
    directSpentByLane: cloneSpentByLane(context.account.directSpentByLane),
    foldedSpentByLane: cloneSpentByLane(context.account.foldedSpentByLane),
    foldBacks: context.account.foldBacks.map(cloneLineageProvenance),
    orphanedChildren: context.account.orphanedChildren.map(cloneLineageProvenance),
    quotaSpentByLane: cloneSpentByLane(context.quotaAccount.spentByLane),
  };
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
  const state: RunChargeContextState = {
    chargePolicy,
    eventBus: input.eventBus ?? parent?.eventBus,
    lane: input.lane,
    lineage: resolveLineage(parent, input, runId),
    account: createRunChargeAccount(),
    quotaAccount: parent?.quotaAccount ?? createRunChargeQuotaAccount(),
    correlation: resolveCorrelation(parent, input),
  };
  return runChargeStorage.run(state, async () => {
    try {
      const result = await fn();
      if (parent) {
        foldChildAccountIntoParent(parent.account, state.account, state.lineage);
      }
      return result;
    } catch (error) {
      if (parent) {
        recordOrphanedChildAccount(parent.account, state.account, state.lineage);
      }
      throw error;
    }
  });
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
    const scope = inspection.quotaSpentAfter > inspection.quota ? 'run' : 'rolling 24-hour';
    const spentAfter = scope === 'run' ? inspection.quotaSpentAfter : inspection.rollingWindowSpentAfter;
    throw new Error(
      `Charge quota exceeded for lane "${inspection.lane}" while charging "${surface}" (${spentAfter}/${inspection.quota}; ${scope} budget).`,
    );
  }

  if (context) {
    addSpentByLane(context.account.spentByLane, inspection.lane, inspection.amount);
    addSpentByLane(context.account.directSpentByLane, inspection.lane, inspection.amount);
    addSpentByLane(context.quotaAccount.spentByLane, inspection.lane, inspection.amount);
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
    spentAfter: inspection.rollingWindowSpentAfter,
    timestampMs: Date.now(),
    quota: inspection.quota,
  });

  recordRollingChargeEvent(event);
  void eventBus?.emit('agent.charge', event);
  return event;
}

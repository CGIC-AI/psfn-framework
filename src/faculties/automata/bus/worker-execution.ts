import type { SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type {
  AutomataArtifactRef,
  AutomataRunOutcome,
  ProductionAutomataClassId,
} from '../registry-contract.js';
import { createAutomataTextValidator } from '../validation.js';
import {
  buildAutomataTerminalHandoffKey,
  type AutomataTerminalHandoffKind,
  type AutomataTerminalLifecycleDelivery,
  type AutomataTerminalLifecyclePort,
  type AutomataWorkerLineage,
  type AutomataWorkerTerminalUsage,
} from '../terminal-lifecycle.js';
import type {
  AutomataBusToolAction,
  AutomataBusWorkerAccess,
  AutomataBusWorkerBriefing,
  AutomataBusWorkerScope,
} from './worker-access-contracts.js';
import {
  AutomataBusBriefingSchemaError,
  buildAutomataBusWorkerScope,
  isAutomataBusWorkerEligible,
  resolveAutomataBusWorkerFormation,
} from './worker-access-formation.js';
import { createAutomataBusTool } from './worker-access-tool.js';

/**
 * The five ordered lifecycle stages every Bus-aware automata class passes
 * through. The order is the conformance contract: a class may skip or degrade a
 * stage, but it can never reorder one, and it can never reach `terminal`
 * without first passing `handoff`.
 */
export const AUTOMATA_WORKER_LIFECYCLE_STAGES = [
  'begin',
  'brief',
  'tool',
  'handoff',
  'terminal',
] as const;

export type AutomataWorkerLifecycleStage = typeof AUTOMATA_WORKER_LIFECYCLE_STAGES[number];

export type AutomataWorkerStageStatus = 'ok' | 'degraded' | 'skipped' | 'failed' | 'replayed';

export interface AutomataWorkerLifecycleEvent {
  stage: AutomataWorkerLifecycleStage;
  status: AutomataWorkerStageStatus;
  companionId: string;
  automatonClass: ProductionAutomataClassId;
  runId: string;
  attempt: number;
  detail?: string;
  /** Present only when a briefing failed its version contract. */
  briefingSchema?: { expected: number; received: string; field: string };
}

type AutomataWorkerTelemetryPort = (event: AutomataWorkerLifecycleEvent) => void;

/** Stages whose failure is dispositioned by owner policy rather than fixed code. */
type AutomataWorkerRecoverableStage = Extract<
  AutomataWorkerLifecycleStage,
  'brief' | 'handoff'
>;

interface AutomataWorkerStageFailure {
  stage: AutomataWorkerRecoverableStage;
  /** Zero on the first attempt, incremented for each policy-directed retry. */
  attemptIndex: number;
  error: unknown;
}

type AutomataWorkerFailureDisposition = 'retry' | 'fail' | 'degrade';

/**
 * Owner-policy disposition for a recoverable Bus stage failure. A policy that
 * answers `retry` owns its own bound: the wrapper re-attempts the stage for as
 * long as the policy keeps asking, passing an increasing `attemptIndex`.
 */
export type AutomataWorkerFailurePolicy = (
  failure: AutomataWorkerStageFailure,
) => AutomataWorkerFailureDisposition;

/**
 * Production default. Bus unavailability degrades the run loudly instead of
 * killing useful work: a briefing failure runs the worker Bus-blind, and a
 * terminal handoff failure still terminalizes the durable run with its true
 * outcome. Both emit `degraded` telemetry; neither is silent.
 */
export const AUTOMATA_WORKER_DEGRADE_POLICY: AutomataWorkerFailurePolicy = () => 'degrade';

/** Authoritative run identity resolved by the class-specific run adapter. */
export interface AutomataWorkerRunBinding {
  companionId: string;
  lineage: AutomataWorkerLineage;
  /** Durable attempt identity (the run's worker generation). */
  attempt: number;
  /**
   * False when the durable run is already terminal. The wrapper then skips
   * briefing, tool formation, and terminalization so a restart or retry can
   * neither duplicate a terminal event nor re-execute a finished run.
   */
  execute: boolean;
}

export interface AutomataWorkerTerminalRequest {
  lifecycleState: 'completed' | 'failed' | 'cancelled';
  outcome: AutomataRunOutcome;
  stateReason: string;
  failureReason?: string;
  atMs: number;
}

/** Class-specific durable run adapter over the authoritative run registry. */
export interface AutomataWorkerRunPort {
  begin(): Promise<AutomataWorkerRunBinding>;
  terminalize(request: AutomataWorkerTerminalRequest): Promise<void>;
}

export interface AutomataWorkerOutcome {
  lifecycleState: 'completed' | 'failed' | 'cancelled';
  outcome: AutomataRunOutcome;
  stateReason: string;
  failureReason?: string;
  resultKind: 'final' | 'partial' | 'none';
  /** Class-authored process summary; never worker output or transcript text. */
  summary?: string;
  usage?: AutomataWorkerTerminalUsage;
  outputRefs?: readonly AutomataArtifactRef[];
  parentHandoffRef?: string;
  atMs?: number;
}

export interface AutomataWorkerSettlement {
  handoff: AutomataTerminalLifecycleDelivery;
  handoffKind: AutomataTerminalHandoffKind;
  /** False when the durable run was already terminal before this settlement. */
  terminalized: boolean;
}

export interface AutomataBusWorkerRunOptions {
  access?: AutomataBusWorkerAccess | null;
  run: AutomataWorkerRunPort;
  terminal?: AutomataTerminalLifecyclePort | null;
  /** Bounded current-state briefing query. Owner-supplied, never model-supplied. */
  briefingQuery: string;
  allowedActions?: readonly AutomataBusToolAction[];
  policy?: AutomataWorkerFailurePolicy;
  telemetry?: AutomataWorkerTelemetryPort;
}

const requiredText = createAutomataTextValidator('Automata terminal');

/** Every durable reference a terminal receipt reports must be real and unique. */
function normalizeReceiptRefs(values: readonly string[], field: string): string[] {
  const normalized = values.map((value, index) => requiredText(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Automata terminal ${field} must not contain duplicates`);
  }
  return normalized;
}

/** Bus actions that leave durable learned state, as opposed to reading it. */
const WRITE_ACTIONS = new Set<AutomataBusToolAction>(['append', 'correct', 'handoff']);

interface BusWriteObserver {
  writes: number;
}

interface FormedAccess {
  scope: AutomataBusWorkerScope | null;
  briefing: AutomataBusWorkerBriefing | null;
  promptBlock: string | null;
  tool: SubstrateAgentTool | null;
}

function briefingSchemaTelemetry(
  error: unknown,
): Pick<AutomataWorkerLifecycleEvent, 'briefingSchema'> {
  if (!(error instanceof AutomataBusBriefingSchemaError)) return {};
  return {
    briefingSchema: {
      expected: error.expectedSchemaVersion,
      received: error.receivedSchemaVersion,
      field: error.field,
    },
  };
}

/**
 * Run one policy-dispositioned Bus stage.
 *
 * `retry` re-attempts, `fail` rethrows, and `degrade` returns the caller's
 * degraded value (or `undefined` when the caller has none).
 */
async function runRecoverableStage<T>(input: {
  stage: AutomataWorkerRecoverableStage;
  policy: AutomataWorkerFailurePolicy;
  attempt: () => Promise<T>;
  onFailure: (error: unknown, disposition: AutomataWorkerFailureDisposition) => void;
  degraded?: (error: unknown) => T;
}): Promise<T | undefined> {
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await input.attempt();
    } catch (error) {
      const disposition = input.policy({ stage: input.stage, attemptIndex, error });
      input.onFailure(error, disposition);
      if (disposition === 'retry') continue;
      if (disposition === 'fail') throw error;
      return input.degraded ? input.degraded(error) : undefined;
    }
  }
}

/**
 * One Bus-aware automata run.
 *
 * The wrapper owns identity binding, durable run start, the bounded briefing,
 * instruction/tool formation, the deterministic terminal handoff, and
 * exactly-once terminalization. Callers own only the class-specific work
 * between {@link openAutomataBusWorkerRun} and {@link AutomataBusWorkerRun.settle}.
 */
export class AutomataBusWorkerRun {
  private settlement: AutomataWorkerSettlement | null = null;
  private settling: Promise<AutomataWorkerSettlement> | null = null;

  private constructor(
    private readonly options: AutomataBusWorkerRunOptions,
    private readonly observer: BusWriteObserver,
    readonly binding: AutomataWorkerRunBinding,
    private readonly formed: FormedAccess,
  ) {}

  /** Authoritative worker scope, or null when this run has no Bus access. */
  get scope(): AutomataBusWorkerScope | null {
    return this.formed.scope;
  }

  /** Bounded current-state briefing, or null when absent or degraded. */
  get briefing(): AutomataBusWorkerBriefing | null {
    return this.formed.briefing;
  }

  /** Bus instruction block for the worker's system prompt, or null. */
  get promptBlock(): string | null {
    return this.formed.promptBlock;
  }

  /** Governed `automata_bus` tool bound to this run's scope, or null. */
  get tool(): SubstrateAgentTool | null {
    return this.formed.tool;
  }

  /** Accepted Bus writes observed on this run's tool. */
  get observedBusWrites(): number {
    return this.observer.writes;
  }

  static async open(options: AutomataBusWorkerRunOptions): Promise<AutomataBusWorkerRun> {
    const binding = await options.run.begin();
    const observer: BusWriteObserver = { writes: 0 };
    const emit = (
      stage: AutomataWorkerLifecycleStage,
      status: AutomataWorkerStageStatus,
      extra: Partial<AutomataWorkerLifecycleEvent> = {},
    ): void => {
      options.telemetry?.({
        stage,
        status,
        companionId: binding.companionId,
        automatonClass: binding.lineage.automatonClass,
        runId: binding.lineage.runId,
        attempt: binding.attempt,
        ...extra,
      });
    };
    emit('begin', binding.execute ? 'ok' : 'replayed');
    const formed = await formAccess({ options, binding, observer, emit });
    return new AutomataBusWorkerRun(options, observer, binding, formed);
  }

  /**
   * Record the deterministic terminal handoff and terminalize the durable run,
   * in that order, exactly once. A repeated call returns the first settlement,
   * so a retried caller can never duplicate either effect.
   */
  settle(outcome: AutomataWorkerOutcome): Promise<AutomataWorkerSettlement> {
    if (this.settlement) return Promise.resolve(this.settlement);
    this.settling ??= this.settleOnce(outcome).then(
      settlement => {
        this.settlement = settlement;
        return settlement;
      },
      error => {
        // A failed settlement is not a settlement. Both effects are idempotent
        // (key-bound handoff, terminal-replay guard), so a caller that retries
        // after a transient store failure can still reach a terminal state.
        this.settling = null;
        throw error;
      },
    );
    return this.settling;
  }

  private emit(
    stage: AutomataWorkerLifecycleStage,
    status: AutomataWorkerStageStatus,
    extra: Partial<AutomataWorkerLifecycleEvent> = {},
  ): void {
    this.options.telemetry?.({
      stage,
      status,
      companionId: this.binding.companionId,
      automatonClass: this.binding.lineage.automatonClass,
      runId: this.binding.lineage.runId,
      attempt: this.binding.attempt,
      ...extra,
    });
  }

  private async settleOnce(outcome: AutomataWorkerOutcome): Promise<AutomataWorkerSettlement> {
    const handoffKind: AutomataTerminalHandoffKind =
      this.observer.writes > 0 || outcome.summary !== undefined ? 'useful' : 'no_finding';
    if (!this.binding.execute) {
      this.emit('handoff', 'replayed');
      this.emit('terminal', 'replayed');
      return { handoff: { status: 'not_configured' }, handoffKind, terminalized: false };
    }
    const handoff = await this.recordHandoff(outcome, handoffKind);
    // Terminalization is the last act on every path, including a failed Bus
    // handoff, and it is never swallowed: an unterminalized run is an orphan.
    await this.options.run.terminalize({
      lifecycleState: outcome.lifecycleState,
      outcome: outcome.outcome,
      stateReason: outcome.stateReason,
      ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
      atMs: outcome.atMs ?? Date.now(),
    });
    this.emit('terminal', 'ok', { detail: outcome.lifecycleState });
    return { handoff, handoffKind, terminalized: true };
  }

  private async recordHandoff(
    outcome: AutomataWorkerOutcome,
    handoffKind: AutomataTerminalHandoffKind,
  ): Promise<AutomataTerminalLifecycleDelivery> {
    const port = this.options.terminal;
    if (!port) {
      this.emit('handoff', 'skipped', { detail: 'terminal_port_not_configured' });
      return { status: 'not_configured' };
    }
    const idempotencyKey = buildAutomataTerminalHandoffKey({
      automatonClass: this.binding.lineage.automatonClass,
      runId: this.binding.lineage.runId,
      attempt: this.binding.attempt,
    });
    const outputRefs = outcome.outputRefs ?? [];
    const delivery = await runRecoverableStage<AutomataTerminalLifecycleDelivery>({
      stage: 'handoff',
      policy: this.options.policy ?? AUTOMATA_WORKER_DEGRADE_POLICY,
      attempt: async () => {
        const receipt = await port.recordTerminalHandoff({
          idempotencyKey,
          lineage: this.binding.lineage,
          lifecycleState: outcome.lifecycleState,
          outcome: outcome.outcome,
          stateReason: outcome.stateReason,
          ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
          resultKind: outcome.resultKind,
          handoffKind,
          ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          outputRefs,
          ...(outcome.parentHandoffRef ? { parentHandoffRef: outcome.parentHandoffRef } : {}),
          occurredAtMs: outcome.atMs ?? Date.now(),
        });
        return {
          status: 'recorded',
          idempotencyKey,
          handoffRef: requiredText(receipt.handoffRef, 'handoff ref'),
          replay: !receipt.inserted,
          findingRefs: normalizeReceiptRefs(receipt.findingRefs, 'finding refs'),
          evidenceRefs: normalizeReceiptRefs(receipt.evidenceRefs, 'evidence refs'),
          artifactRefs: receipt.artifactRefs.map(reference => ({ ...reference })),
        };
      },
      onFailure: (error, disposition) => {
        this.emit('handoff', disposition === 'degrade' ? 'degraded' : 'failed', {
          detail: toErrorMessage(error),
        });
      },
      degraded: error => ({ status: 'failed', idempotencyKey, error: toErrorMessage(error) }),
    });
    if (!delivery) throw new Error('Automata Bus terminal handoff produced no delivery');
    if (delivery.status === 'recorded') {
      this.emit('handoff', delivery.replay ? 'replayed' : 'ok', { detail: handoffKind });
    }
    return delivery;
  }
}

async function formAccess(input: {
  options: AutomataBusWorkerRunOptions;
  binding: AutomataWorkerRunBinding;
  observer: BusWriteObserver;
  emit: (
    stage: AutomataWorkerLifecycleStage,
    status: AutomataWorkerStageStatus,
    extra?: Partial<AutomataWorkerLifecycleEvent>,
  ) => void;
}): Promise<FormedAccess> {
  const { options, binding, observer, emit } = input;
  const eligible = binding.execute
    && isAutomataBusWorkerEligible(options.access, binding.lineage.automatonClass);
  if (!eligible) {
    const detail = binding.execute ? 'class_not_eligible' : 'run_already_terminal';
    emit('brief', 'skipped', { detail });
    emit('tool', 'skipped', { detail });
    return { scope: null, briefing: null, promptBlock: null, tool: null };
  }
  const access = options.access!;
  const scope = buildAutomataBusWorkerScope(access, {
    automatonClass: binding.lineage.automatonClass,
    runId: binding.lineage.runId,
    taskId: binding.lineage.taskId,
  });
  const formation = await runRecoverableStage({
    stage: 'brief',
    policy: options.policy ?? AUTOMATA_WORKER_DEGRADE_POLICY,
    attempt: async () => await resolveAutomataBusWorkerFormation({
      access,
      scope,
      query: options.briefingQuery,
    }),
    onFailure: (error, disposition) => {
      emit('brief', disposition === 'degrade' ? 'degraded' : 'failed', {
        detail: toErrorMessage(error),
        ...briefingSchemaTelemetry(error),
      });
    },
  });
  const tool = createAutomataBusTool({
    access,
    scope: formation?.scope ?? scope,
    ...(options.allowedActions ? { allowedActions: options.allowedActions } : {}),
    observe: observation => {
      if (observation.status === 'ok' && WRITE_ACTIONS.has(observation.action)) {
        observer.writes += 1;
      }
    },
  });
  if (formation === undefined) {
    // Degraded briefing: the worker still gets its governed tool and can search
    // the Bus itself, but no spawn briefing reaches its prompt.
    emit('tool', 'ok', { detail: 'briefing_degraded' });
    return { scope, briefing: null, promptBlock: null, tool };
  }
  if (formation === null) {
    emit('brief', 'skipped', { detail: 'class_not_eligible' });
    emit('tool', 'skipped', { detail: 'class_not_eligible' });
    return { scope: null, briefing: null, promptBlock: null, tool: null };
  }
  emit('brief', 'ok', { detail: `items:${formation.briefing.itemCount}` });
  emit('tool', 'ok');
  return {
    scope: formation.scope,
    briefing: formation.briefing,
    promptBlock: formation.promptBlock,
    tool,
  };
}

export async function openAutomataBusWorkerRun(
  options: AutomataBusWorkerRunOptions,
): Promise<AutomataBusWorkerRun> {
  return await AutomataBusWorkerRun.open(options);
}

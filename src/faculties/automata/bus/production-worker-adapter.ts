import { createHash, randomUUID } from 'node:crypto';

import { createComponentLogger } from '../../../shared/logger.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEventPublisher,
  type HealthEventSource,
} from '../../../shared/contracts/health-event.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  AUTOMATA_TERMINAL_HANDOFF_SOURCE,
  AUTOMATA_TERMINAL_HANDOFF_SOURCES,
  AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
  type AutomataTerminalHandoffKind,
  type AutomataTerminalHandoffReceipt,
  type AutomataTerminalLifecyclePort,
  type AutomataWorkerLineage,
  type AutomataWorkerRunInspection,
  type CommittedAutomataTerminalHandoff,
  type PersistedAutomataTerminalOutcome,
  type RecordAutomataTerminalHandoffInput,
} from '../terminal-lifecycle.js';
import {
  AUTOMATA_RUN_OUTCOMES,
  type AutomataArtifactRef,
  type AutomataRunOutcome,
  type AutomataRunRecord,
  type ProductionAutomataClassId,
} from '../registry-contract.js';
import type { AutomataRunRegistry } from '../run-registry.js';
import { createAutomataTextValidator } from '../validation.js';
import {
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
  AUTOMATA_BUS_RELATIONS_FEATURE,
  AUTOMATA_BUS_SCHEMA_VERSION,
  type AutomataBusEvent,
  type AutomataBusEventContext,
  type AutomataBusFeature,
  type AutomataBusFindingBody,
  type AutomataBusRelationBody,
} from './contract.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import type { AutomataBusAudience } from './postgres-store.js';
import type { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import type {
  AutomataBusWorkerAccess,
  AutomataBusWorkerBounds,
  AutomataBusWorkerPort,
  AutomataBusWorkerScope,
} from './worker-access.js';
import { AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION } from './worker-access.js';

interface CanonicalAppendInput {
  eventId: string;
  occurredAt: string;
  run: AutomataRunRecord;
  type: AutomataBusEvent['type'];
  body: AutomataBusFindingBody | AutomataBusRelationBody;
  audiences: readonly AutomataBusAudience[];
  sensitivity: SensitivityLevel;
}

interface CanonicalAppendResult {
  event: AutomataBusEvent;
  inserted: boolean;
  indexStatus: 'indexed' | 'lagging' | 'not-current';
}

const requiredText = createAutomataTextValidator('Automata Bus');
const lifecycleLog = createComponentLogger('automata.bus.terminal-lifecycle');

function stableId(namespace: string, values: readonly unknown[]): string {
  return `${namespace}:v1:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function contextFromRun(run: AutomataRunRecord): AutomataBusEventContext {
  return {
    automatonClass: run.automatonClass,
    runId: run.runId,
    taskId: run.taskId,
    sessionIds: [...run.sessionIds],
    // Artifact custody evolves after a handoff is linked to the run. Event
    // context must remain byte-stable across an idempotent replay; evidence
    // references live in the immutable finding body instead.
    artifactRefs: [],
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
  };
}

function exactRunForScope(
  registry: AutomataRunRegistry,
  companionId: string,
  scope: Pick<AutomataBusWorkerScope, 'companionId' | 'runId' | 'taskId' | 'automatonClass'>,
): AutomataRunRecord {
  if (scope.companionId !== companionId) {
    throw new Error('Automata Bus scope does not match the runtime companion');
  }
  const run = registry.getRun(scope.runId);
  if (!run) throw new Error(`Automata Bus run "${scope.runId}" is not registered`);
  if (
    run.companionId !== companionId
    || run.taskId !== scope.taskId
    || run.automatonClass !== scope.automatonClass
  ) {
    throw new Error('Automata Bus scope does not match authoritative run lineage');
  }
  return run;
}

/**
 * The only production append path used by worker and lifecycle adapters.
 * Appends are serialized in-process as an optimization. Cross-process sequence
 * correctness is owned by the store's companion-locked database transaction.
 */
export class CanonicalAutomataBusWriter {
  private appendTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    companionId: string;
    store: Pick<PostgresAutomataBusRuntimeStore, 'appendAllocated'>;
    runtime: AutomataBusProductionRuntime;
  }) {
    requiredText(options.companionId, 'writer companionId');
  }

  append(input: CanonicalAppendInput): Promise<CanonicalAppendResult> {
    const operation = this.appendTail.then(() => this.appendSerialized(input));
    this.appendTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async appendSerialized(input: CanonicalAppendInput): Promise<CanonicalAppendResult> {
    const persisted = await this.options.store.appendAllocated({
      companionId: this.options.companionId,
      eventId: requiredText(input.eventId, 'eventId'),
      createEvent: sequence => {
        const hasLessonAttribution = input.type === 'finding'
          ? (input.body as AutomataBusFindingBody).lessonAttribution !== undefined
          : (input.body as AutomataBusRelationBody).replacement?.lessonAttribution !== undefined;
        const mustUnderstand: AutomataBusFeature[] = [
          ...(input.type === 'relation' ? [AUTOMATA_BUS_RELATIONS_FEATURE] : []),
          ...(hasLessonAttribution ? [AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE] : []),
        ];
        const base = {
          schemaVersion: AUTOMATA_BUS_SCHEMA_VERSION,
          eventId: requiredText(input.eventId, 'eventId'),
          companionId: this.options.companionId,
          sequence,
          occurredAt: new Date(input.occurredAt).toISOString(),
          mustUnderstand,
          context: contextFromRun(input.run),
        };
        return input.type === 'finding'
          ? { ...base, type: 'finding', body: input.body as AutomataBusFindingBody }
          : { ...base, type: 'relation', body: input.body as AutomataBusRelationBody };
      },
      audiences: input.audiences,
      sensitivity: input.sensitivity,
    });
    return await this.indexPersisted(persisted.event, persisted.inserted);
  }

  private async indexPersisted(
    event: AutomataBusEvent,
    inserted: boolean,
  ): Promise<CanonicalAppendResult> {
    const current = await this.options.runtime.canonical.getCurrentByEventIds({
      eventIds: [event.eventId],
      visibility: {
        companionId: this.options.companionId,
        audience: 'operator',
        maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
      },
      filters: {},
    });
    const finding = current[0];
    if (!finding) {
      return { event, inserted, indexStatus: 'not-current' };
    }
    const indexed = await this.options.runtime.indexing.indexCurrentFinding(finding);
    return { event, inserted, indexStatus: indexed.status };
  }
}

function evidenceForRefs(
  refs: readonly string[],
  summary: string,
): AutomataBusFindingBody['evidence'] {
  const unique = [...new Set(refs.map(reference => requiredText(reference, 'evidence reference')))];
  return unique.map(reference => ({ kind: 'artifact', reference, summary }));
}

function workerFindingBody(input: Parameters<AutomataBusWorkerPort['append']>[0]): AutomataBusFindingBody {
  return {
    claim: requiredText(input.claim, 'claim'),
    provenance: input.provenance,
    evidence: input.evidence.map(entry => ({ ...entry })),
    verification: {
      status: input.verificationStatus,
      ...(input.verificationStatus === 'pending'
        ? {}
        : {
            by: input.scope.runId,
            evidenceRefs: input.evidence.map(entry => entry.reference),
          }),
    },
    ...(input.source ? { source: input.source } : {}),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.lessonAttribution === undefined
      ? {}
      : {
          lessonAttribution: {
            ...input.lessonAttribution,
            contradictionEventIds: [...input.lessonAttribution.contradictionEventIds],
          },
        }),
  };
}

export function createProductionAutomataBusWorkerAccess(options: {
  companionId: string;
  registry: AutomataRunRegistry;
  store: PostgresAutomataBusRuntimeStore;
  runtime: AutomataBusProductionRuntime;
  writer: CanonicalAutomataBusWriter;
  bounds: AutomataBusWorkerBounds;
  maxSensitivity?: SensitivityLevel;
}): AutomataBusWorkerAccess {
  const companionId = requiredText(options.companionId, 'worker companionId');
  const visibility = (scope: AutomataBusWorkerScope) => ({
    companionId: exactRunForScope(options.registry, companionId, scope).companionId,
    audience: scope.audience,
    maxSensitivity: scope.maxSensitivity,
  });
  const port: AutomataBusWorkerPort = {
    isClassEligible: classId => options.registry.listClasses().some(candidate => (
      candidate.id === classId && candidate.busEligibility === 'eligible'
    )),
    brief: async input => {
      const { text, itemCount, diagnostics } = await options.runtime.query.createSpawnBriefing({
        query: input.query ?? options.registry.getRun(input.scope.runId)?.taskSummary ?? input.scope.taskId,
        visibility: visibility(input.scope),
      });
      return {
        schemaVersion: AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION,
        text,
        itemCount,
        diagnostics,
      };
    },
    search: async input => await options.runtime.query.search({
      query: input.query,
      visibility: visibility(input.scope),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
    append: async input => {
      const run = exactRunForScope(options.registry, companionId, input.scope);
      return await options.writer.append({
        eventId: `automata-bus-finding:${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        run,
        type: 'finding',
        body: workerFindingBody(input),
        audiences: ['eligible-automata', 'operator'],
        sensitivity: input.scope.maxSensitivity,
      });
    },
    correct: async input => {
      const run = exactRunForScope(options.registry, companionId, input.scope);
      const [target] = await options.store.readCurrentFindingsByEventIds({
        companionId,
        audience: input.scope.audience,
        maxSensitivity: input.scope.maxSensitivity,
        eventIds: [input.targetEventId],
      });
      if (!target) throw new Error('Automata Bus correction target is not current or visible');
      const reason = requiredText(input.reason, 'correction reason');
      const replacement: AutomataBusFindingBody | undefined = input.relation === 'retracts'
        ? undefined
        : {
            claim: requiredText(input.replacementClaim ?? '', 'replacement claim'),
            provenance: 'computed',
            evidence: [{
              kind: 'artifact',
              reference: input.targetEventId,
              summary: reason,
            }],
            verification: { status: 'pending' },
            ...(target.effectiveFinding.body.lessonAttribution
              ? {
                  lessonAttribution: {
                    ...target.effectiveFinding.body.lessonAttribution,
                    contradictionEventIds: [
                      ...target.effectiveFinding.body.lessonAttribution.contradictionEventIds,
                    ],
                  },
                }
              : {}),
          };
      return await options.writer.append({
        eventId: `automata-bus-relation:${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        run,
        type: 'relation',
        body: {
          targetEventId: input.targetEventId,
          relation: input.relation,
          reason,
          ...(replacement ? { replacement } : {}),
        },
        audiences: target.audiences,
        sensitivity: target.sensitivity,
      });
    },
    handoff: async input => {
      const run = exactRunForScope(options.registry, companionId, input.scope);
      const validationRefs = input.validationPerformed.map(value => (
        stableId('automata-bus-validation', [run.runId, value])
      ));
      const references = [...input.outputRefs, ...validationRefs];
      if (references.length === 0) references.push(`automata-run:${run.runId}`);
      return await options.writer.append({
        eventId: `automata-bus-handoff:${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        run,
        type: 'finding',
        body: {
          claim: [
            `Worker handoff: ${requiredText(input.summary, 'handoff summary')}`,
            ...(input.blocker ? [`Blocker: ${input.blocker}`] : []),
            ...(input.nextAction ? [`Next action: ${input.nextAction}`] : []),
          ].join('\n'),
          provenance: 'computed',
          evidence: evidenceForRefs(references, 'Worker handoff evidence'),
          verification: { status: 'pending' },
          source: 'automata-bus-worker-handoff',
        },
        audiences: ['eligible-automata', 'operator'],
        sensitivity: input.scope.maxSensitivity,
      });
    },
    runs: async input => {
      exactRunForScope(options.registry, companionId, input.scope);
      return options.registry.listRuns({
        ...(input.status ? { status: input.status } : {}),
        ...(input.classId ? { classId: input.classId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    },
    inspect: async input => {
      exactRunForScope(options.registry, companionId, input.scope);
      const history = await options.store.readHistory({
        companionId,
        audience: input.scope.audience,
        maxSensitivity: input.scope.maxSensitivity,
      });
      return {
        ...(input.eventId
          ? { events: history.filter(event => event.eventId === input.eventId) }
          : {}),
        ...(input.runId
          ? {
              run: options.registry.getRun(input.runId),
              events: history.filter(event => event.context.runId === input.runId),
            }
          : {}),
      };
    },
  };
  return {
    port,
    bounds: { ...options.bounds },
    identity: {
      companionId,
      audience: 'eligible-automata',
      maxSensitivity: options.maxSensitivity ?? SENSITIVITY_LEVELS.at(-1)!,
    },
  };
}

function assertLifecycleLineage(
  registry: AutomataRunRegistry,
  companionId: string,
  lineage: AutomataWorkerLineage,
): AutomataRunRecord {
  const run = exactRunForScope(registry, companionId, {
    companionId,
    runId: lineage.runId,
    taskId: lineage.taskId,
    automatonClass: lineage.automatonClass,
  });
  if (
    run.workerId !== lineage.workerId
    || run.parentRunId !== lineage.parentRunId
    || run.sourceRunId !== lineage.sourceRunId
    || JSON.stringify([...run.sessionIds].sort()) !== JSON.stringify([...lineage.sessionIds].sort())
  ) {
    throw new Error('Automata terminal lineage does not match the authoritative run registry');
  }
  return run;
}

function lifecycleArtifacts(input: RecordAutomataTerminalHandoffInput): AutomataArtifactRef[] {
  return [
    ...input.outputRefs.map(reference => ({ ...reference })),
    ...(input.parentHandoffRef
      ? [{ kind: 'parent_completion_handoff', ref: input.parentHandoffRef, custody: 'durable' as const }]
      : []),
  ];
}

function terminalClaim(input: RecordAutomataTerminalHandoffInput): string {
  return [
    `Automata terminal state: ${input.lifecycleState}`,
    `Class: ${input.lineage.automatonClass}`,
    `Outcome: ${input.outcome}`,
    `Reason: ${requiredText(input.stateReason, 'terminal state reason')}`,
    `Result: ${input.resultKind}`,
    `Handoff: ${input.handoffKind}`,
    ...(input.summary ? [`Summary: ${requiredText(input.summary, 'terminal summary')}`] : []),
    ...(input.usage
      ? [`Usage: model=${input.usage.model}; inputTokens=${input.usage.inputTokens}; outputTokens=${input.usage.outputTokens}; turns=${input.usage.turns}; durationMs=${input.usage.durationMs}`]
      : []),
    ...(input.failureReason ? [`Failure: ${input.failureReason}`] : []),
  ].join('\n');
}

const TERMINAL_CLAIM_STATE_PREFIX = 'Automata terminal state: ';
const TERMINAL_CLAIM_CLASS_PREFIX = 'Class: ';
const TERMINAL_CLAIM_OUTCOME_PREFIX = 'Outcome: ';
const TERMINAL_CLAIM_REASON_PREFIX = 'Reason: ';
const TERMINAL_CLAIM_RESULT_PREFIX = 'Result: ';
const TERMINAL_CLAIM_HANDOFF_PREFIX = 'Handoff: ';
const TERMINAL_CLAIM_FAILURE_PREFIX = 'Failure: ';
const TERMINAL_LIFECYCLE_STATES = ['completed', 'failed', 'cancelled'] as const;

function readClaimField(line: string | undefined, prefix: string, label: string): string {
  if (line === undefined || !line.startsWith(prefix)) {
    throw new Error(`Persisted automata terminal claim is missing its ${label} line`);
  }
  return requiredText(line.slice(prefix.length), `terminal claim ${label}`);
}

/**
 * Read the structured terminal facts back out of a claim this module wrote.
 *
 * `terminalClaim` is the serializer; this is its exact inverse, and the pair is
 * round-trip tested. It exists so a replaying settle path can converge the run
 * registry onto the DURABLE terminal the Bus already holds instead of onto the
 * outcome its post-crash re-run happened to produce (psfn-framework-8n40k).
 * Anything that does not match the emitted shape throws — a claim we cannot
 * read exactly is never guessed at.
 */
export function parseTerminalClaim(
  claim: string,
  expectedAutomatonClass: string,
): PersistedAutomataTerminalOutcome {
  const failureIndex = claim.indexOf(`\n${TERMINAL_CLAIM_FAILURE_PREFIX}`);
  const head = failureIndex === -1 ? claim : claim.slice(0, failureIndex);
  const failureReason = failureIndex === -1
    ? undefined
    : requiredText(
      claim.slice(failureIndex + 1 + TERMINAL_CLAIM_FAILURE_PREFIX.length),
      'terminal claim failure reason',
    );
  const lines = head.split('\n');
  const lifecycleState = readClaimField(lines[0], TERMINAL_CLAIM_STATE_PREFIX, 'lifecycle state');
  if (!TERMINAL_LIFECYCLE_STATES.includes(lifecycleState as typeof TERMINAL_LIFECYCLE_STATES[number])) {
    throw new Error(`Persisted automata terminal claim has an unsupported lifecycle state "${lifecycleState}"`);
  }
  const automatonClass = readClaimField(lines[1], TERMINAL_CLAIM_CLASS_PREFIX, 'class');
  if (automatonClass !== expectedAutomatonClass) {
    throw new Error('Persisted automata terminal claim belongs to a different automaton class');
  }
  const outcome = readClaimField(lines[2], TERMINAL_CLAIM_OUTCOME_PREFIX, 'outcome');
  if (!AUTOMATA_RUN_OUTCOMES.includes(outcome as AutomataRunOutcome)) {
    throw new Error(`Persisted automata terminal claim has an unsupported outcome "${outcome}"`);
  }
  const stateReason = readClaimField(lines[3], TERMINAL_CLAIM_REASON_PREFIX, 'state reason');
  readClaimField(lines[4], TERMINAL_CLAIM_RESULT_PREFIX, 'result kind');
  readClaimField(lines[5], TERMINAL_CLAIM_HANDOFF_PREFIX, 'handoff kind');
  return {
    lifecycleState: lifecycleState as PersistedAutomataTerminalOutcome['lifecycleState'],
    outcome: outcome as AutomataRunOutcome,
    stateReason,
    ...(failureReason ? { failureReason } : {}),
  };
}

/** Durable Bus event id one terminal handoff is committed under. */
function terminalHandoffEventId(idempotencyKey: string): string {
  return stableId('automata-bus-terminal', [idempotencyKey]);
}

/**
 * Read one committed terminal handoff back out of the durable ledger.
 *
 * Companion scope is bound at the query level and re-asserted through the
 * registry by the caller, so this can never surface another companion's run.
 * A row that exists but is not a readable terminal finding throws rather than
 * being treated as absence — an unreadable terminal is never guessed at.
 */
async function readCommittedTerminalHandoff(input: {
  companionId: string;
  store: PostgresAutomataBusRuntimeStore;
  idempotencyKey: string;
  automatonClass: ProductionAutomataClassId;
}): Promise<{ handoff: CommittedAutomataTerminalHandoff; claim: string } | null> {
  const eventId = terminalHandoffEventId(input.idempotencyKey);
  const persisted = await input.store.readEventById({
    companionId: input.companionId,
    audience: 'eligible-automata',
    maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
    eventId,
  });
  if (!persisted) return null;
  if (persisted.type !== 'finding') {
    throw new Error('Persisted automata terminal handoff is not a finding event');
  }
  return {
    handoff: {
      handoffRef: eventId,
      occurredAtMs: Date.parse(persisted.occurredAt),
      outcome: parseTerminalClaim(persisted.body.claim, input.automatonClass),
      findingRefs: [eventId],
      evidenceRefs: persisted.body.evidence.map(evidence => evidence.reference),
    },
    claim: persisted.body.claim,
  };
}

/**
 * The health plane's identity for one terminal-handoff replay divergence
 * (psfn-framework-zu8d2).
 *
 * The subject is the HANDOFF KIND and nothing else. A run id would make every
 * crashed run its own group and defeat repeat detection; a class name is an
 * unbounded label the content-free envelope refuses to carry. Grouping on the
 * kind is what turns "this settle path keeps diverging" into one episode the
 * repeated-failure detector can open.
 */
function terminalReplayDivergenceSubject(handoffKind: AutomataTerminalHandoffKind): string {
  return `terminal_handoff_replay:${handoffKind}`;
}

/**
 * Project one replay divergence into the health plane.
 *
 * A WARN line is not an alertable condition: the durable finding wins and the
 * process carries on, so without this a settle path that keeps reaching a
 * different conclusion after every crash is visible only to whoever reads logs.
 * Severity is `warning` rather than `degraded` — nothing was lost, the two
 * views of one run simply disagreed — and the emit is fire-and-forget with a
 * logged catch, exactly like every other health emitter in an error path: a
 * telemetry fault must never mask the fault being reported.
 */
function emitTerminalReplayDivergenceHealthEvent(
  health: AutomataTerminalLifecycleHealthOptions | undefined,
  handoffKind: AutomataTerminalHandoffKind,
): void {
  if (!health) return;
  void emitHealthEvent(health.publisher, {
    owner: health.source.owner,
    severity: 'warning',
    code: 'terminal_handoff_replay_diverged',
    provenance: {
      process: health.source.process,
      component: 'automata',
      observerId: processObserverId(),
      subjectHash: hashHealthEventSubject(terminalReplayDivergenceSubject(handoffKind)),
    },
    observedAtMs: Date.now(),
  }).catch((error: unknown) => {
    lifecycleLog.error('Automata terminal replay divergence health event emission failed', {
      error: toErrorMessage(error),
    });
  });
}

/**
 * Where this adapter's health observations go. Optional: a deployment without a
 * health plane keeps the WARN line and nothing else, exactly as before.
 */
export interface AutomataTerminalLifecycleHealthOptions {
  publisher: HealthEventPublisher;
  source: HealthEventSource;
}

export function createAutomataTerminalLifecycleAdapter(options: {
  companionId: string;
  registry: AutomataRunRegistry;
  store: PostgresAutomataBusRuntimeStore;
  writer: CanonicalAutomataBusWriter;
  health?: AutomataTerminalLifecycleHealthOptions;
}): AutomataTerminalLifecyclePort {
  const companionId = requiredText(options.companionId, 'lifecycle companionId');
  return {
    recordTerminalHandoff: async (
      input: RecordAutomataTerminalHandoffInput,
    ): Promise<AutomataTerminalHandoffReceipt> => {
      const run = assertLifecycleLineage(options.registry, companionId, input.lineage);
      const artifacts = lifecycleArtifacts(input);
      const evidenceRefs = [
        ...artifacts.map(reference => reference.ref),
        `automata-run:${run.runId}`,
      ];
      const eventId = terminalHandoffEventId(input.idempotencyKey);
      // Replay path (psfn-framework-8n40k): a run that crashed between this
      // handoff's commit and its registry terminalization re-runs its work and
      // arrives here again with a freshly computed timestamp. Re-READ the
      // committed terminal instead of recomputing one: recomputation differs
      // byte-wise from the persisted event, so the append would be rejected as
      // a reused id, degrade, and leave the registry disagreeing with the
      // durable Bus finding. The durable finding wins.
      const committed = await readCommittedTerminalHandoff({
        companionId,
        store: options.store,
        idempotencyKey: input.idempotencyKey,
        automatonClass: input.lineage.automatonClass,
      });
      if (committed) {
        // A replay whose recomputed terminal disagrees with the durable one is
        // not silently swallowed: the durable finding still wins (that is the
        // convergence contract), but the disagreement is reported.
        if (committed.claim !== terminalClaim(input)) {
          lifecycleLog.warn(
            'Automata terminal replay disagrees with the durable Bus finding; converging on the durable terminal',
            {
              automatonClass: input.lineage.automatonClass,
              runId: input.lineage.runId,
              idempotencyKey: input.idempotencyKey,
              replayLifecycleState: input.lifecycleState,
              replayOutcome: input.outcome,
            },
          );
          // psfn-framework-zu8d2: the log line stays for the operator; this is
          // the alertable condition the detector can actually count.
          emitTerminalReplayDivergenceHealthEvent(options.health, input.handoffKind);
        }
        return {
          handoffRef: committed.handoff.handoffRef,
          inserted: false,
          findingRefs: [...committed.handoff.findingRefs],
          // Evidence comes from the durable finding; artifact refs are the
          // caller's own handles for this settlement (event context carries
          // none — custody evolves after the handoff is linked).
          evidenceRefs: [...committed.handoff.evidenceRefs],
          artifactRefs: artifacts,
          occurredAtMs: committed.handoff.occurredAtMs,
          persistedOutcome: { ...committed.handoff.outcome },
        };
      }
      const appended = await options.writer.append({
        eventId,
        occurredAt: new Date(input.occurredAtMs).toISOString(),
        run,
        type: 'finding',
        body: {
          claim: terminalClaim(input),
          provenance: 'computed',
          evidence: evidenceForRefs(evidenceRefs, 'Authoritative automata terminal lineage'),
          verification: { status: 'pending' },
          source: input.handoffKind === 'useful'
            ? AUTOMATA_TERMINAL_HANDOFF_SOURCE
            : AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
        },
        audiences: ['eligible-automata', 'operator'],
        sensitivity: SENSITIVITY_LEVELS.at(-1)!,
      });
      return {
        handoffRef: eventId,
        inserted: appended.inserted,
        findingRefs: [eventId],
        evidenceRefs,
        artifactRefs: artifacts,
      };
    },
    readTerminalHandoff: async (input: {
      idempotencyKey: string;
      lineage: AutomataWorkerLineage;
    }): Promise<CommittedAutomataTerminalHandoff | null> => {
      // Same companion-scoped registry assertion the write path makes: a read
      // for a run this companion does not own is refused, not answered.
      assertLifecycleLineage(options.registry, companionId, input.lineage);
      const committed = await readCommittedTerminalHandoff({
        companionId,
        store: options.store,
        idempotencyKey: input.idempotencyKey,
        automatonClass: input.lineage.automatonClass,
      });
      return committed ? committed.handoff : null;
    },
    inspectRun: async (lineage: AutomataWorkerLineage): Promise<AutomataWorkerRunInspection> => {
      const run = assertLifecycleLineage(options.registry, companionId, lineage);
      const events = (await options.store.readHistory({
        companionId,
        audience: 'eligible-automata',
        maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
      })).filter(event => event.context.runId === run.runId);
      const findingRefs = events.filter(event => event.type === 'finding').map(event => event.eventId);
      const evidenceRefs = [...new Set(events.flatMap(event => (
        event.type === 'finding'
          ? event.body.evidence.map(evidence => evidence.reference)
          : event.body.replacement?.evidence.map(evidence => evidence.reference) ?? []
      )))];
      return {
        runId: run.runId,
        taskId: run.taskId,
        sessionIds: [...run.sessionIds],
        findingRefs,
        evidenceRefs,
        artifactRefs: run.artifacts.map(reference => ({ ...reference })),
        handoffRefs: events
          .filter(event => (
            event.type === 'finding'
            && event.body.source !== undefined
            && AUTOMATA_TERMINAL_HANDOFF_SOURCES.includes(event.body.source)
          ))
          .map(event => event.eventId),
      };
    },
  };
}

export function automataBusWorkerBoundsFromOwnerPolicy(input: {
  query: {
    maxQueryChars: number;
    maxSearchResults: number;
    maxBriefingChars: number;
    maxBriefingItems: number;
  };
  recentRunLimit: number;
}): AutomataBusWorkerBounds {
  return {
    maxQueryChars: input.query.maxQueryChars,
    maxTextChars: input.query.maxBriefingChars,
    maxArrayItems: input.query.maxBriefingItems,
    maxSearchResults: input.query.maxSearchResults,
    maxRunResults: input.recentRunLimit,
    maxBriefingChars: input.query.maxBriefingChars,
    maxBriefingItems: input.query.maxBriefingItems,
    maxToolResultChars: input.query.maxBriefingChars,
  };
}

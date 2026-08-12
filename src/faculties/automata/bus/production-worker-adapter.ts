import { createHash, randomUUID } from 'node:crypto';

import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import type {
  RecordSubagentTerminalHandoffInput,
  SubagentAutomataLifecyclePort,
  SubagentAutomataLineage,
  SubagentAutomataRunInspection,
  SubagentAutomataTerminalReceipt,
} from '../../subagents/automata-lifecycle.js';
import type {
  AutomataArtifactRef,
  AutomataRunRecord,
} from '../registry-contract.js';
import type { AutomataRunRegistry } from '../run-registry.js';
import {
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
  AUTOMATA_BUS_RELATIONS_FEATURE,
  AUTOMATA_BUS_SCHEMA_VERSION,
  type AutomataBusEvent,
  type AutomataBusEventContext,
  type AutomataBusFeature,
  type AutomataBusFindingBody,
  type AutomataBusRelationBody,
  parseAutomataBusEvent,
} from './contract.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import type {
  AutomataBusAudience,
  AutomataBusSqlPool,
} from './postgres-store.js';
import type { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import type {
  AutomataBusWorkerAccess,
  AutomataBusWorkerBounds,
  AutomataBusWorkerPort,
  AutomataBusWorkerScope,
} from './worker-access.js';

interface SequenceRow {
  next_sequence: unknown;
}

interface ExistingEventRow {
  event_json: unknown;
  audiences: unknown;
  sensitivity: unknown;
}

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

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Automata Bus ${field} must be non-empty`);
  return normalized;
}

function stableId(namespace: string, values: readonly unknown[]): string {
  return `${namespace}:v1:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function parsePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Automata Bus ${field} must be a positive safe integer`);
  }
  return parsed;
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
 * Appends are serialized in-process so a companion's monotonically increasing
 * sequence is allocated immediately before the store's transactional append.
 */
export class CanonicalAutomataBusWriter {
  private appendTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    companionId: string;
    pool: AutomataBusSqlPool;
    store: PostgresAutomataBusRuntimeStore;
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
    const existing = await this.options.pool.query<ExistingEventRow>(`
      SELECT event_json, audiences, sensitivity
      FROM automata_bus_events
      WHERE companion_id = $1 AND event_id = $2
    `, [this.options.companionId, input.eventId]);
    const incumbent = existing.rows[0];
    if (incumbent) {
      const parsed = parseAutomataBusEvent(incumbent.event_json);
      if (parsed.status !== 'accepted') {
        throw new Error('Automata Bus idempotency lookup returned an invalid event');
      }
      const event = parsed.value;
      const same = event.type === input.type
        && event.occurredAt === new Date(input.occurredAt).toISOString()
        && JSON.stringify(event.context) === JSON.stringify(contextFromRun(input.run))
        && JSON.stringify(event.body) === JSON.stringify(input.body)
        && JSON.stringify(incumbent.audiences) === JSON.stringify([...input.audiences].sort())
        && incumbent.sensitivity === input.sensitivity;
      if (!same) {
        throw new Error(`Automata Bus eventId ${input.eventId} was reused with different content`);
      }
      return await this.indexPersisted(event, false);
    }
    const next = await this.options.pool.query<SequenceRow>(`
      SELECT (COALESCE(MAX(sequence), 0) + 1)::bigint AS next_sequence
      FROM automata_bus_events
      WHERE companion_id = $1
    `, [this.options.companionId]);
    const sequence = parsePositiveInteger(next.rows[0]?.next_sequence, 'next sequence');
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
    const event: AutomataBusEvent = input.type === 'finding'
      ? { ...base, type: 'finding', body: input.body as AutomataBusFindingBody }
      : { ...base, type: 'relation', body: input.body as AutomataBusRelationBody };
    const persisted = await this.options.store.append({
      companionId: this.options.companionId,
      event,
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
    brief: async input => await options.runtime.query.createSpawnBriefing({
      query: input.query ?? options.registry.getRun(input.scope.runId)?.taskSummary ?? input.scope.taskId,
      visibility: visibility(input.scope),
    }),
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
          relation: input.relation as AutomataBusRelationBody['relation'],
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
  lineage: SubagentAutomataLineage,
): AutomataRunRecord {
  const run = exactRunForScope(registry, companionId, {
    companionId,
    runId: lineage.runId,
    taskId: lineage.taskId,
    automatonClass: 'subagent.bounded',
  });
  if (
    run.workerId !== lineage.workerId
    || run.parentRunId !== lineage.parentRunId
    || run.sourceRunId !== lineage.sourceRunId
    || JSON.stringify([...run.sessionIds].sort()) !== JSON.stringify([...lineage.sessionIds].sort())
  ) {
    throw new Error('Subagent lifecycle lineage does not match the authoritative run registry');
  }
  return run;
}

function lifecycleArtifacts(input: RecordSubagentTerminalHandoffInput): AutomataArtifactRef[] {
  return [
    ...input.outputRefs.map(reference => ({ ...reference })),
    ...(input.parentHandoffRef
      ? [{ kind: 'parent_completion_handoff', ref: input.parentHandoffRef, custody: 'durable' as const }]
      : []),
  ];
}

export function createSubagentAutomataLifecycleAdapter(options: {
  companionId: string;
  registry: AutomataRunRegistry;
  store: PostgresAutomataBusRuntimeStore;
  writer: CanonicalAutomataBusWriter;
}): SubagentAutomataLifecyclePort {
  const companionId = requiredText(options.companionId, 'lifecycle companionId');
  return {
    recordTerminalHandoff: async (
      input: RecordSubagentTerminalHandoffInput,
    ): Promise<SubagentAutomataTerminalReceipt> => {
      const run = assertLifecycleLineage(options.registry, companionId, input.lineage);
      const artifacts = lifecycleArtifacts(input);
      const evidenceRefs = [
        ...artifacts.map(reference => reference.ref),
        `automata-run:${run.runId}`,
      ];
      const eventId = stableId('automata-bus-subagent-terminal', [input.idempotencyKey]);
      const appended = await options.writer.append({
        eventId,
        occurredAt: new Date(input.occurredAtMs).toISOString(),
        run,
        type: 'finding',
        body: {
          claim: [
            `Subagent terminal state: ${input.lifecycleState}`,
            `Outcome: ${input.outcome}`,
            `Reason: ${requiredText(input.stateReason, 'terminal state reason')}`,
            `Result: ${input.resultKind}`,
            `Usage: model=${input.usage.model}; inputTokens=${input.usage.inputTokens}; outputTokens=${input.usage.outputTokens}; turns=${input.usage.turns}; durationMs=${input.usage.durationMs}`,
            ...(input.failureReason ? [`Failure: ${input.failureReason}`] : []),
          ].join('\n'),
          provenance: 'computed',
          evidence: evidenceForRefs(evidenceRefs, 'Authoritative subagent terminal lineage'),
          verification: { status: 'pending' },
          source: 'subagent-terminal-handoff',
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
    inspectRun: async (lineage: SubagentAutomataLineage): Promise<SubagentAutomataRunInspection> => {
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
          .filter(event => event.type === 'finding' && event.body.source === 'subagent-terminal-handoff')
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

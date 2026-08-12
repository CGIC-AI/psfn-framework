import { createHash } from 'node:crypto';

import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  AUTOMATA_BUS_RELATIONS_FEATURE,
  AUTOMATA_BUS_SCHEMA_VERSION,
  parseAutomataBusEvent,
  type AutomataBusFindingBody,
  type AutomataBusRelationKind,
} from './contract.js';
import type {
  AutomataBusAudience,
  PersistedAutomataBusCurrentFinding,
} from './postgres-store.js';
import {
  AutomataBusReviewerCandidateGenerator,
  type AutomataBusReviewerCandidateBatch,
  type AutomataBusReviewerCandidateCluster,
  type AutomataBusReviewerNominationPort,
  type AutomataBusReviewerScope,
} from './reviewer-candidates.js';
import {
  parseAutomataBusReviewerPolicy,
  type AutomataBusReviewerPolicy,
} from './reviewer-policy.js';

export type AutomataBusReviewerCurrentFinding = PersistedAutomataBusCurrentFinding;

export interface AutomataBusReviewerFindingPort {
  loadCurrent(input: {
    scope: AutomataBusReviewerScope;
    eventIds: readonly string[];
  }): Promise<readonly AutomataBusReviewerCurrentFinding[]>;
}

interface AutomataBusReviewerWork {
  purpose: 'background';
  model: string;
  durable: true;
  maxOutputTokens: number;
  deadlineMs: number;
  tokenCeiling: number;
  costCeilingUsd: number;
  cancellation: 'caller_signal';
  retryPolicy: 'none';
  chargeLane: 'maintenance';
  chargeSurface: 'externalModelConsult';
}

export interface AutomataBusReviewerModelPort {
  review(input: {
    scope: AutomataBusReviewerScope;
    reviewerRunId: string;
    cluster: AutomataBusReviewerCandidateCluster;
    /** Complete immutable current events, including original claim and evidence. */
    findings: readonly AutomataBusReviewerCurrentFinding[];
    work: AutomataBusReviewerWork;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

interface AutomataBusReviewerMutationInput {
  scope: AutomataBusReviewerScope;
  reviewerRunId: string;
  clusterId: string;
  idempotencyKey: string;
  targetEventId: string;
  relation: AutomataBusRelationKind;
  reason: string;
  evidenceRefs: readonly string[];
  replacement?: AutomataBusFindingBody;
  audiences: readonly AutomataBusAudience[];
  sensitivity: SensitivityLevel;
}

export interface AutomataBusReviewerMutationPort {
  /** Adapter appends one immutable relation; it may never update current rows directly. */
  appendRelation(input: AutomataBusReviewerMutationInput): Promise<unknown>;
}

export type AutomataBusReviewerOutcomeStatus =
  | 'applied'
  | 'no-change'
  | 'uncertain'
  | 'partial'
  | 'failed'
  | 'stale';

export interface AutomataBusReviewerOutcome {
  attemptId: string;
  clusterId: string;
  reviewerRunId: string;
  companionId: string;
  candidateKind: AutomataBusReviewerCandidateCluster['kind'];
  eventIds: readonly string[];
  status: AutomataBusReviewerOutcomeStatus;
  occurredAt: string;
  reason: string;
  evidenceRefs: readonly string[];
  relation?: AutomataBusRelationKind;
  relationEventId?: string;
}

export interface AutomataBusReviewerOutcomeCounts {
  applied: number;
  noChange: number;
  uncertain: number;
  partial: number;
  failed: number;
  stale: number;
}

export interface AutomataBusReviewerHealth {
  status: 'healthy' | 'degraded' | 'disabled';
  pendingClusters: number;
  lastRunAt?: string;
  outcomes: AutomataBusReviewerOutcomeCounts;
}

export interface AutomataBusReviewerOutcomePort {
  findHandledClusterIds(input: {
    scope: AutomataBusReviewerScope;
    clusterIds: readonly string[];
  }): Promise<readonly string[]>;
  /** Durable idempotent insert keyed by attemptId. */
  record(outcome: AutomataBusReviewerOutcome): Promise<void>;
  readHealth(input: {
    scope: AutomataBusReviewerScope;
    maxOutcomes: number;
  }): Promise<AutomataBusReviewerHealth>;
}

export interface AutomataBusReviewerRunInput extends AutomataBusReviewerScope {
  runId: string;
  signal?: AbortSignal;
}

export interface AutomataBusReviewerRunReport {
  status: 'completed' | 'disabled';
  health: AutomataBusReviewerHealth['status'];
  attempted: number;
  skippedHandled: number;
  backlog: AutomataBusReviewerCandidateBatch['backlog'] & {
    remainingClusters: number;
  };
  outcomes: AutomataBusReviewerOutcomeCounts;
}

/** Scheduler/composition handoff; registration remains outside the core seam. */
export interface AutomataBusReviewerTaskPort {
  readonly enabled: boolean;
  readonly cadenceMs: number;
  run(input: AutomataBusReviewerRunInput): Promise<AutomataBusReviewerRunReport>;
  readHealth(scope: AutomataBusReviewerScope): Promise<AutomataBusReviewerHealth>;
}

interface ParsedNoMutationDecision {
  outcome: 'no-change' | 'uncertain';
  reason: string;
  evidenceRefs: string[];
}

interface ParsedRelationDecision {
  outcome: 'relation';
  targetEventId: string;
  relation: AutomataBusRelationKind;
  reason: string;
  evidenceRefs: string[];
  replacement?: AutomataBusFindingBody;
}

type ParsedDecision = ParsedNoMutationDecision | ParsedRelationDecision;

interface ParsedExecution {
  status: 'complete' | 'failed' | 'partial';
  reason?: string;
  decision?: ParsedDecision;
}

const DECISION_BASE_KEYS = ['outcome', 'reason', 'evidenceRefs'] as const;
const RELATION_DECISION_KEYS = new Set([
  ...DECISION_BASE_KEYS,
  'targetEventId',
  'relation',
  'replacement',
]);
const NO_MUTATION_DECISION_KEYS = new Set(DECISION_BASE_KEYS);
const RELATION_KINDS = new Set<AutomataBusRelationKind>([
  'corrects',
  'retracts',
  'supersedes',
]);

function requiredText(value: unknown, field: string, maximum?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Automata Bus reviewer ${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (maximum !== undefined && normalized.length > maximum) {
    throw new Error(`Automata Bus reviewer ${field} exceeds its owner limit`);
  }
  return normalized;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`Automata Bus reviewer ${field} contains unknown fields: ${unknown.join(', ')}`);
  }
}

function normalizeScope(scope: AutomataBusReviewerScope): AutomataBusReviewerScope {
  const companionId = requiredText(scope.companionId, 'companionId');
  const audience: unknown = scope.audience;
  if (audience !== 'operator') {
    throw new Error('Automata Bus reviewer audience must be operator');
  }
  if (!SENSITIVITY_LEVELS.includes(scope.maxSensitivity)) {
    throw new Error('Automata Bus reviewer maxSensitivity is invalid');
  }
  return { companionId, audience: 'operator', maxSensitivity: scope.maxSensitivity };
}

function normalizeEvidenceRefs(
  value: unknown,
  allowed: ReadonlySet<string>,
  policy: AutomataBusReviewerPolicy,
  required: boolean,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Automata Bus reviewer decision evidenceRefs must be an array');
  }
  if (value.length > policy.maxEvidenceRefsPerReview) {
    throw new Error('Automata Bus reviewer decision exceeds maxEvidenceRefsPerReview');
  }
  const references = value.map((reference, index) => (
    requiredText(reference, `decision.evidenceRefs[${index}]`)
  ));
  if (new Set(references).size !== references.length) {
    throw new Error('Automata Bus reviewer decision evidenceRefs must be unique');
  }
  if (required && references.length === 0) {
    throw new Error('Automata Bus reviewer relation must cite inspected evidence');
  }
  for (const reference of references) {
    if (!allowed.has(reference)) {
      throw new Error(`Automata Bus reviewer decision cites uninspected evidence: ${reference}`);
    }
  }
  return references;
}

function parseExecutionEnvelope(value: unknown): {
  status: 'complete' | 'failed' | 'partial';
  value: Record<string, unknown>;
} {
  if (!isRecord(value)) throw new Error('Automata Bus reviewer model result must be an object');
  if (value.status !== 'complete' && value.status !== 'failed' && value.status !== 'partial') {
    throw new Error('Automata Bus reviewer model status is invalid');
  }
  const allowed = value.status === 'complete'
    ? new Set(['status', 'decision'])
    : new Set(['status', 'reason']);
  assertExactKeys(value, allowed, 'model result');
  return { status: value.status, value };
}

function validateReplacement(
  replacement: unknown,
  target: AutomataBusReviewerCurrentFinding,
  relation: AutomataBusRelationKind,
  reason: string,
  now: string,
): AutomataBusFindingBody | undefined {
  const synthetic = parseAutomataBusEvent({
    schemaVersion: AUTOMATA_BUS_SCHEMA_VERSION,
    eventId: 'automata-bus-review-validation',
    companionId: target.effectiveFinding.companionId,
    sequence: target.effectiveFinding.sequence + 1,
    occurredAt: now,
    mustUnderstand: [AUTOMATA_BUS_RELATIONS_FEATURE],
    context: target.effectiveFinding.context,
    type: 'relation',
    body: {
      targetEventId: target.effectiveFinding.eventId,
      relation,
      reason,
      ...(replacement !== undefined ? { replacement } : {}),
    },
  });
  if (synthetic.status !== 'accepted' || synthetic.value.type !== 'relation') {
    const issues = synthetic.status === 'accepted' ? ['expected a relation'] : synthetic.issues;
    throw new Error(`Automata Bus reviewer relation is invalid: ${issues.join('; ')}`);
  }
  return synthetic.value.body.replacement;
}

function parseDecision(
  value: unknown,
  findings: readonly AutomataBusReviewerCurrentFinding[],
  policy: AutomataBusReviewerPolicy,
  now: string,
): ParsedDecision {
  if (!isRecord(value)) throw new Error('Automata Bus reviewer decision must be an object');
  const allowedEvidence = new Set<string>();
  for (const finding of findings) {
    finding.effectiveFinding.body.evidence.forEach(evidence => allowedEvidence.add(evidence.reference));
    finding.effectiveFinding.context.artifactRefs.forEach(reference => allowedEvidence.add(reference));
  }
  if (value.outcome === 'no-change' || value.outcome === 'uncertain') {
    assertExactKeys(value, NO_MUTATION_DECISION_KEYS, 'decision');
    return {
      outcome: value.outcome,
      reason: requiredText(value.reason, 'decision.reason', policy.maxDecisionReasonChars),
      evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, allowedEvidence, policy, false),
    };
  }
  if (value.outcome !== 'relation') {
    throw new Error('Automata Bus reviewer decision outcome is invalid');
  }
  assertExactKeys(value, RELATION_DECISION_KEYS, 'decision');
  const targetEventId = requiredText(value.targetEventId, 'decision.targetEventId');
  const target = findings.find(finding => finding.effectiveFinding.eventId === targetEventId);
  if (target === undefined) {
    throw new Error('Automata Bus reviewer relation target was not loaded for this cluster');
  }
  if (typeof value.relation !== 'string' || !RELATION_KINDS.has(
    value.relation as AutomataBusRelationKind,
  )) {
    throw new Error('Automata Bus reviewer relation kind is invalid');
  }
  const relation = value.relation as AutomataBusRelationKind;
  const reason = requiredText(value.reason, 'decision.reason', policy.maxDecisionReasonChars);
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs, allowedEvidence, policy, true);
  const replacement = validateReplacement(value.replacement, target, relation, reason, now);
  return {
    outcome: 'relation',
    targetEventId,
    relation,
    reason,
    evidenceRefs,
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

function parseExecution(
  value: unknown,
  findings: readonly AutomataBusReviewerCurrentFinding[],
  policy: AutomataBusReviewerPolicy,
  now: string,
): ParsedExecution {
  const envelope = parseExecutionEnvelope(value);
  if (envelope.status !== 'complete') {
    return {
      status: envelope.status,
      reason: requiredText(envelope.value.reason, 'model result.reason', policy.maxDecisionReasonChars),
    };
  }
  return {
    status: 'complete',
    decision: parseDecision(envelope.value.decision, findings, policy, now),
  };
}

function parseMutationResult(value: unknown):
  | { status: 'appended' | 'replayed'; eventId: string }
  | { status: 'stale'; reason: string } {
  if (!isRecord(value)) throw new Error('Automata Bus reviewer mutation result must be an object');
  if (value.status === 'appended' || value.status === 'replayed') {
    assertExactKeys(value, new Set(['status', 'eventId']), 'mutation result');
    return { status: value.status, eventId: requiredText(value.eventId, 'mutation eventId') };
  }
  if (value.status === 'stale') {
    assertExactKeys(value, new Set(['status', 'reason']), 'mutation result');
    return { status: 'stale', reason: requiredText(value.reason, 'mutation stale reason') };
  }
  throw new Error('Automata Bus reviewer mutation result status is invalid');
}

function emptyCounts(): AutomataBusReviewerOutcomeCounts {
  return { applied: 0, noChange: 0, uncertain: 0, partial: 0, failed: 0, stale: 0 };
}

function increment(
  counts: AutomataBusReviewerOutcomeCounts,
  status: AutomataBusReviewerOutcomeStatus,
): void {
  if (status === 'no-change') counts.noChange += 1;
  else counts[status] += 1;
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${prefix}:v1:${digest}`;
}

function disableModelRetries(): 'none' {
  return 'none';
}

function assertCurrentFindings(
  findings: readonly AutomataBusReviewerCurrentFinding[],
  cluster: AutomataBusReviewerCandidateCluster,
  scope: AutomataBusReviewerScope,
): void {
  const ids = findings.map(finding => finding.effectiveFinding.eventId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Automata Bus reviewer finding port returned duplicate current findings');
  }
  if (
    ids.length !== cluster.eventIds.length
    || ids.some(eventId => !cluster.eventIds.includes(eventId))
  ) {
    throw new Error('Automata Bus reviewer candidate became stale before review');
  }
  for (const finding of findings) {
    if (
      finding.effectiveFinding.companionId !== scope.companionId
      || !finding.audiences.includes(scope.audience)
      || !sensitivityAtMost(finding.sensitivity, scope.maxSensitivity)
    ) {
      throw new Error('Automata Bus reviewer finding port returned data outside reviewer scope');
    }
  }
}

function evidenceRefCount(findings: readonly AutomataBusReviewerCurrentFinding[]): number {
  const references = new Set<string>();
  for (const finding of findings) {
    finding.effectiveFinding.body.evidence.forEach(evidence => references.add(evidence.reference));
    finding.effectiveFinding.context.artifactRefs.forEach(reference => references.add(reference));
  }
  return references.size;
}

export class AutomataBusReviewerService implements AutomataBusReviewerTaskPort {
  readonly enabled: boolean;
  readonly cadenceMs: number;
  private readonly policy: AutomataBusReviewerPolicy;

  constructor(private readonly options: {
    candidates: { generate(scope: AutomataBusReviewerScope): Promise<AutomataBusReviewerCandidateBatch> };
    findings: AutomataBusReviewerFindingPort;
    model: AutomataBusReviewerModelPort;
    mutations: AutomataBusReviewerMutationPort;
    outcomes: AutomataBusReviewerOutcomePort;
    policy: AutomataBusReviewerPolicy;
    now?: () => Date;
  }) {
    this.policy = parseAutomataBusReviewerPolicy(options.policy, 'runtime composition');
    this.enabled = this.policy.enabled;
    this.cadenceMs = this.policy.cadenceMs;
  }

  async readHealth(scopeInput: AutomataBusReviewerScope): Promise<AutomataBusReviewerHealth> {
    const scope = normalizeScope(scopeInput);
    if (!this.enabled) {
      return { status: 'disabled', pendingClusters: 0, outcomes: emptyCounts() };
    }
    return await this.options.outcomes.readHealth({
      scope,
      maxOutcomes: this.policy.maxClustersPerRun,
    });
  }

  async run(input: AutomataBusReviewerRunInput): Promise<AutomataBusReviewerRunReport> {
    const scope = normalizeScope(input);
    const reviewerRunId = requiredText(input.runId, 'runId');
    if (!this.enabled) {
      return {
        status: 'disabled',
        health: 'disabled',
        attempted: 0,
        skippedHandled: 0,
        backlog: {
          findingsScanned: 0,
          nominationsSeen: 0,
          clustersReturned: 0,
          hasMore: false,
          remainingClusters: 0,
        },
        outcomes: emptyCounts(),
      };
    }
    const batch = await this.options.candidates.generate(scope);
    if (batch.clusters.length > this.policy.maxClustersPerRun) {
      throw new Error('Automata Bus reviewer candidate generator exceeded maxClustersPerRun');
    }
    const clusterIds = batch.clusters.map(cluster => cluster.clusterId);
    const handledIds = await this.options.outcomes.findHandledClusterIds({ scope, clusterIds });
    if (
      handledIds.length > clusterIds.length
      || new Set(handledIds).size !== handledIds.length
      || handledIds.some(clusterId => !clusterIds.includes(clusterId))
    ) {
      throw new Error('Automata Bus reviewer outcome port returned invalid handled cluster ids');
    }
    const handled = new Set(handledIds);
    const pending = batch.clusters.filter(cluster => !handled.has(cluster.clusterId));
    const selected = pending.slice(0, this.policy.maxReviewsPerRun);
    const counts = emptyCounts();
    const occurredAt = (this.options.now?.() ?? new Date()).toISOString();
    const record = async (
      cluster: AutomataBusReviewerCandidateCluster,
      status: AutomataBusReviewerOutcomeStatus,
      reason: string,
      evidenceRefs: readonly string[] = [],
      relation?: { kind: AutomataBusRelationKind; eventId: string },
    ): Promise<void> => {
      await this.options.outcomes.record({
        attemptId: stableId('automata-bus-review-attempt', [reviewerRunId, cluster.clusterId]),
        clusterId: cluster.clusterId,
        reviewerRunId,
        companionId: scope.companionId,
        candidateKind: cluster.kind,
        eventIds: cluster.eventIds,
        status,
        occurredAt,
        reason,
        evidenceRefs,
        ...(relation ? { relation: relation.kind, relationEventId: relation.eventId } : {}),
      });
      increment(counts, status);
    };

    for (const cluster of selected) {
      let findings: readonly AutomataBusReviewerCurrentFinding[];
      try {
        findings = await this.options.findings.loadCurrent({ scope, eventIds: cluster.eventIds });
        assertCurrentFindings(findings, cluster, scope);
        const byEventId = new Map(findings.map(finding => [
          finding.effectiveFinding.eventId,
          finding,
        ]));
        findings = cluster.eventIds.map(eventId => byEventId.get(eventId)!);
      } catch (error) {
        await record(cluster, 'stale', toErrorMessage(error));
        continue;
      }
      if (evidenceRefCount(findings) > this.policy.maxEvidenceRefsPerReview) {
        await record(cluster, 'partial', 'Candidate evidence exceeds maxEvidenceRefsPerReview');
        continue;
      }
      if (JSON.stringify({ cluster, findings }).length > this.policy.maxReviewInputChars) {
        await record(cluster, 'partial', 'Candidate input exceeds maxReviewInputChars');
        continue;
      }

      let execution: ParsedExecution;
      try {
        execution = parseExecution(await this.options.model.review({
          scope,
          reviewerRunId,
          cluster,
          findings,
          work: {
            purpose: 'background',
            model: this.policy.model,
            durable: true,
            maxOutputTokens: this.policy.maxOutputTokens,
            deadlineMs: this.policy.deadlineMs,
            tokenCeiling: this.policy.tokenCeiling,
            costCeilingUsd: this.policy.costCeilingUsd,
            cancellation: 'caller_signal',
            retryPolicy: disableModelRetries(),
            chargeLane: 'maintenance',
            chargeSurface: 'externalModelConsult',
          },
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }), findings, this.policy, occurredAt);
      } catch (error) {
        await record(cluster, 'failed', toErrorMessage(error));
        continue;
      }
      if (execution.status !== 'complete') {
        await record(cluster, execution.status, execution.reason ?? execution.status);
        continue;
      }
      const decision = execution.decision;
      if (decision === undefined) {
        await record(cluster, 'failed', 'Complete reviewer result omitted its decision');
        continue;
      }
      if (decision.outcome !== 'relation') {
        await record(cluster, decision.outcome, decision.reason, decision.evidenceRefs);
        continue;
      }

      const target = findings.find(finding => (
        finding.effectiveFinding.eventId === decision.targetEventId
      ));
      if (target === undefined) {
        await record(cluster, 'failed', 'Reviewer relation target was not loaded');
        continue;
      }
      const idempotencyKey = stableId('automata-bus-review-relation', [
        cluster.clusterId,
        decision.targetEventId,
        decision.relation,
        decision.reason,
        decision.evidenceRefs,
        decision.replacement,
      ]);
      let mutation;
      try {
        mutation = parseMutationResult(await this.options.mutations.appendRelation({
          scope,
          reviewerRunId,
          clusterId: cluster.clusterId,
          idempotencyKey,
          targetEventId: decision.targetEventId,
          relation: decision.relation,
          reason: decision.reason,
          evidenceRefs: decision.evidenceRefs,
          ...(decision.replacement !== undefined ? { replacement: decision.replacement } : {}),
          audiences: target.audiences,
          sensitivity: target.sensitivity,
        }));
      } catch (error) {
        await record(cluster, 'failed', toErrorMessage(error), decision.evidenceRefs);
        continue;
      }
      if (mutation.status === 'stale') {
        await record(cluster, 'stale', mutation.reason, decision.evidenceRefs);
        continue;
      }
      await record(
        cluster,
        'applied',
        decision.reason,
        decision.evidenceRefs,
        { kind: decision.relation, eventId: mutation.eventId },
      );
    }

    const degraded = counts.failed > 0 || counts.partial > 0;
    return {
      status: 'completed',
      health: degraded ? 'degraded' : 'healthy',
      attempted: selected.length,
      skippedHandled: handled.size,
      backlog: {
        ...batch.backlog,
        hasMore: batch.backlog.hasMore || pending.length > selected.length,
        remainingClusters: pending.length - selected.length,
      },
      outcomes: counts,
    };
  }
}

/**
 * Preferred composition entry: candidate generation and review execution share
 * the same parsed owner policy, preventing threshold or bound drift.
 */
export function createAutomataBusReviewerTask(options: {
  nominations: AutomataBusReviewerNominationPort;
  findings: AutomataBusReviewerFindingPort;
  model: AutomataBusReviewerModelPort;
  mutations: AutomataBusReviewerMutationPort;
  outcomes: AutomataBusReviewerOutcomePort;
  policy: AutomataBusReviewerPolicy;
  now?: () => Date;
}): AutomataBusReviewerTaskPort {
  const policy = parseAutomataBusReviewerPolicy(options.policy, 'runtime composition');
  return new AutomataBusReviewerService({
    candidates: new AutomataBusReviewerCandidateGenerator({
      nominations: options.nominations,
      policy,
    }),
    findings: options.findings,
    model: options.model,
    mutations: options.mutations,
    outcomes: options.outcomes,
    policy,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

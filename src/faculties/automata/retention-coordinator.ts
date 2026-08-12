import { createHash, randomUUID } from 'node:crypto';
import type { AutomataRunStatus } from './registry-contract.js';
import type {
  AutomataRetentionAuditEvent,
  AutomataRetentionDecision,
  AutomataRetentionProof,
  AutomataRetentionProofPort,
  AutomataRetentionReason,
  AutomataRetentionRunResult,
  AutomataRetentionStorePort,
  AutomataSessionPurgeSurface,
  ExactSessionPurgePort,
  ExactSessionPurgeReport,
  PermanentReferenceCustodyPort,
} from './retention-contract.js';
import type { AutomataSessionClassification } from './session-classification.js';
import { createAutomataTextValidator } from './validation.js';

const terminalRunStatuses: ReadonlySet<AutomataRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const exactPurgeSurfaces: ReadonlySet<AutomataSessionPurgeSurface> = new Set([
  'journals',
  'journal_rolls',
  'channel_index',
  'transcript_projection',
  'turn_records',
  'redis_tail_pointers',
]);

const requiredText = createAutomataTextValidator('Automata retention');

function uniqueReferences(values: readonly string[]): string[] {
  return [...new Set(values.map((value, index) => requiredText(value, `reference[${index}]`)))].sort();
}

function promotionReferences(proof: AutomataRetentionProof): string[] | null {
  const receipt = proof.promotionReceipt;
  if (!receipt) return null;
  if (receipt.disposition === 'nothing_to_promote') {
    return uniqueReferences([receipt.receiptRef]);
  }
  if (receipt.receiptRefs.length === 0) return null;
  return uniqueReferences([...receipt.receiptRefs, ...receipt.copiedEvidenceRefs]);
}

function identityMatches(
  classification: AutomataSessionClassification,
  proof: AutomataRetentionProof,
): boolean {
  return proof.companionId === classification.companionId
    && proof.sessionId === classification.sessionId
    && proof.runId === classification.runId
    && proof.automatonClass === classification.automatonClass;
}

export function evaluateAutomataRetentionEligibility(
  classification: AutomataSessionClassification,
  proof: AutomataRetentionProof | null,
  nowMs: number,
): AutomataRetentionDecision {
  if (!proof) return { eligible: false, reason: 'proof_missing', preserveReferences: [] };
  if (!identityMatches(classification, proof)) {
    return { eligible: false, reason: 'target_mismatch', preserveReferences: [] };
  }
  if (proof.workerGeneration !== classification.workerGeneration) {
    return { eligible: false, reason: 'generation_not_terminal', preserveReferences: [] };
  }
  if (proof.generationState !== 'terminal') {
    return { eligible: false, reason: 'generation_not_terminal', preserveReferences: [] };
  }
  if (!terminalRunStatuses.has(proof.runStatus)) {
    return { eligible: false, reason: 'run_not_terminal', preserveReferences: [] };
  }
  if (!Number.isSafeInteger(proof.pendingWorkCount) || proof.pendingWorkCount !== 0) {
    return { eligible: false, reason: 'pending_work', preserveReferences: [] };
  }
  if (proof.handoffState === 'pending') {
    return { eligible: false, reason: 'pending_handoff', preserveReferences: [] };
  }
  if (proof.artifacts.some(artifact => artifact.custody !== 'durable')) {
    return { eligible: false, reason: 'artifact_custody_pending', preserveReferences: [] };
  }
  const promotionRefs = promotionReferences(proof);
  if (!promotionRefs) {
    return { eligible: false, reason: 'promotion_receipt_missing', preserveReferences: [] };
  }
  if (proof.reviewState === 'pending') {
    return { eligible: false, reason: 'review_pending', preserveReferences: [] };
  }
  if (classification.automatonClass === 'shard.long_horizon' && proof.foldState !== 'folded') {
    return { eligible: false, reason: 'shard_unfolded', preserveReferences: [] };
  }
  if (nowMs < classification.retentionDeadlineMs) {
    return { eligible: false, reason: 'retention_window_open', preserveReferences: [] };
  }
  requiredText(proof.targetRevision, 'targetRevision');
  return {
    eligible: true,
    reason: 'eligible',
    preserveReferences: uniqueReferences([
      ...promotionRefs,
      ...proof.artifacts.map(artifact => artifact.ref),
    ]),
  };
}

function errorDigest(error: unknown): string {
  const source = error instanceof Error
    ? `${error.name}:${error.message}`
    : `${typeof error}:${String(error)}`;
  return createHash('sha256').update(source).digest('hex');
}

function removedCounts(report: ExactSessionPurgeReport): Partial<Record<AutomataSessionPurgeSurface, number>> {
  return Object.fromEntries(report.surfaces.map(entry => [entry.surface, entry.removedCount]));
}

function validatePurgeReport(
  classification: AutomataSessionClassification,
  proof: AutomataRetentionProof,
  preserveReferences: readonly string[],
  report: ExactSessionPurgeReport,
): void {
  if (
    report.companionId !== classification.companionId
    || report.sessionId !== classification.sessionId
    || report.runId !== classification.runId
    || report.targetRevision !== proof.targetRevision
  ) {
    throw new Error('Exact-session purge report target does not match the authorized target');
  }
  const reported = new Set<AutomataSessionPurgeSurface>();
  for (const surface of report.surfaces) {
    if (!exactPurgeSurfaces.has(surface.surface) || reported.has(surface.surface)) {
      throw new Error('Exact-session purge report contains an unknown or duplicate surface');
    }
    if (!Number.isSafeInteger(surface.removedCount) || surface.removedCount < 0) {
      throw new Error('Exact-session purge report contains an invalid removal count');
    }
    reported.add(surface.surface);
  }
  if (reported.size !== exactPurgeSurfaces.size) {
    throw new Error('Exact-session purge report is missing a required surface');
  }
  const expectedReferences = uniqueReferences(preserveReferences);
  const verifiedReferences = uniqueReferences(report.verifiedPreservedReferences);
  if (JSON.stringify(expectedReferences) !== JSON.stringify(verifiedReferences)) {
    throw new Error('Exact-session purge did not verify every permanent reference');
  }
}

function auditEvent(input: {
  attemptId: string;
  suffix: string;
  classification: AutomataSessionClassification;
  kind: AutomataRetentionAuditEvent['kind'];
  reason: AutomataRetentionReason;
  occurredAtMs: number;
  proof?: AutomataRetentionProof;
  report?: ExactSessionPurgeReport;
  preservedReferenceCount?: number;
  errorDigest?: string;
}): AutomataRetentionAuditEvent {
  return {
    schemaVersion: 1,
    eventId: `${input.attemptId}:${input.suffix}`,
    attemptId: input.attemptId,
    companionId: input.classification.companionId,
    sessionId: input.classification.sessionId,
    runId: input.classification.runId,
    automatonClass: input.classification.automatonClass,
    workerGeneration: input.classification.workerGeneration,
    kind: input.kind,
    reason: input.reason,
    occurredAtMs: input.occurredAtMs,
    ...(input.proof ? { targetRevision: input.proof.targetRevision } : {}),
    ...(input.report ? { removedCounts: removedCounts(input.report) } : {}),
    ...(input.preservedReferenceCount === undefined
      ? {}
      : { preservedReferenceCount: input.preservedReferenceCount }),
    ...(input.errorDigest ? { errorDigest: input.errorDigest } : {}),
  };
}

export class AutomataRetentionCoordinator {
  constructor(private readonly ports: {
    store: AutomataRetentionStorePort;
    proofs: AutomataRetentionProofPort;
    custody: PermanentReferenceCustodyPort;
    purge: ExactSessionPurgePort;
  }) {}

  async run(input: {
    companionId: string;
    nowMs: number;
    limit: number;
  }): Promise<AutomataRetentionRunResult[]> {
    const companionId = requiredText(input.companionId, 'companionId');
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error('Automata retention nowMs must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('Automata retention limit must be a positive safe integer');
    }
    const candidates = await this.ports.store.listDueAutomataSessions(
      companionId,
      input.nowMs,
      input.limit,
    );
    const results: AutomataRetentionRunResult[] = [];
    for (const classification of candidates) {
      if (classification.companionId !== companionId) {
        throw new Error('Automata retention store returned a cross-companion candidate');
      }
      results.push(await this.processCandidate(classification, input.nowMs));
    }
    return results;
  }

  private async processCandidate(
    classification: AutomataSessionClassification,
    nowMs: number,
  ): Promise<AutomataRetentionRunResult> {
    if (await this.ports.store.hasPurgeReceipt(
      classification.companionId,
      classification.sessionId,
    )) {
      return {
        sessionId: classification.sessionId,
        outcome: 'already_purged',
        reason: 'already_purged',
      };
    }

    const attemptId = randomUUID();
    const proof = await this.ports.proofs.loadProof(classification);
    const firstDecision = evaluateAutomataRetentionEligibility(classification, proof, nowMs);
    if (!firstDecision.eligible || !proof) {
      await this.ports.store.appendAuditEvent(auditEvent({
        attemptId,
        suffix: 'retained',
        classification,
        kind: 'retained',
        reason: firstDecision.reason,
        occurredAtMs: nowMs,
        ...(proof ? { proof } : {}),
      }));
      return { sessionId: classification.sessionId, outcome: 'retained', reason: firstDecision.reason };
    }

    const revalidated = await this.ports.proofs.loadProof(classification);
    const finalDecision = evaluateAutomataRetentionEligibility(classification, revalidated, nowMs);
    if (!revalidated || !finalDecision.eligible || revalidated.targetRevision !== proof.targetRevision) {
      const reason: AutomataRetentionReason = revalidated && finalDecision.eligible
        ? 'target_changed'
        : finalDecision.reason;
      await this.ports.store.appendAuditEvent(auditEvent({
        attemptId,
        suffix: 'retained',
        classification,
        kind: 'retained',
        reason,
        occurredAtMs: nowMs,
        ...(revalidated ? { proof: revalidated } : {}),
      }));
      return { sessionId: classification.sessionId, outcome: 'retained', reason };
    }

    const preserveReferences = finalDecision.preserveReferences;
    try {
      await this.ports.custody.assertResolvable(preserveReferences, {
        companionId: classification.companionId,
        runId: classification.runId,
      });
    } catch (error) {
      await this.recordFailure(classification, revalidated, attemptId, nowMs, 'evidence_unresolvable', error);
      return {
        sessionId: classification.sessionId,
        outcome: 'retryable_failure',
        reason: 'evidence_unresolvable',
      };
    }

    await this.ports.store.appendAuditEvent(auditEvent({
      attemptId,
      suffix: 'started',
      classification,
      kind: 'purge_started',
      reason: 'eligible',
      occurredAtMs: nowMs,
      proof: revalidated,
      preservedReferenceCount: preserveReferences.length,
    }));

    let report: ExactSessionPurgeReport;
    try {
      report = await this.ports.purge.purgeExactSession({
        companionId: classification.companionId,
        sessionId: classification.sessionId,
        runId: classification.runId,
        targetRevision: revalidated.targetRevision,
        preserveReferences,
      });
      validatePurgeReport(classification, revalidated, preserveReferences, report);
      await this.ports.custody.assertResolvable(preserveReferences, {
        companionId: classification.companionId,
        runId: classification.runId,
      });
    } catch (error) {
      const reason: AutomataRetentionReason = error instanceof Error
        && error.message.startsWith('Exact-session purge')
        ? 'purge_incomplete'
        : 'purge_failed';
      await this.recordFailure(classification, revalidated, attemptId, nowMs, reason, error);
      return { sessionId: classification.sessionId, outcome: 'retryable_failure', reason };
    }

    await this.ports.store.appendAuditEvent(auditEvent({
      attemptId,
      suffix: 'purged',
      classification,
      kind: 'purged',
      reason: 'eligible',
      occurredAtMs: nowMs,
      proof: revalidated,
      report,
      preservedReferenceCount: preserveReferences.length,
    }));
    return { sessionId: classification.sessionId, outcome: 'purged', reason: 'eligible' };
  }

  private async recordFailure(
    classification: AutomataSessionClassification,
    proof: AutomataRetentionProof,
    attemptId: string,
    occurredAtMs: number,
    reason: AutomataRetentionReason,
    error: unknown,
  ): Promise<void> {
    await this.ports.store.appendAuditEvent(auditEvent({
      attemptId,
      suffix: 'failure',
      classification,
      kind: 'retryable_failure',
      reason,
      occurredAtMs,
      proof,
      errorDigest: errorDigest(error),
    }));
  }
}

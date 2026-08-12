import { createHash } from 'node:crypto';

import type { AutomataLessonGroup } from './lesson-projection.js';

export interface GovernedAutomataLessonReviewRequest {
  artifactPath: string;
  content: string;
  mediaType: 'application/json';
  provenance: string;
}

export interface GovernedAutomataLessonReviewReceipt {
  reviewId: string;
  status: 'pending';
}

/** Existing Garden shared-workspace review path adapter. This port creates a review, never a target mutation. */
export interface GovernedAutomataLessonReviewPort {
  propose(request: GovernedAutomataLessonReviewRequest): Promise<GovernedAutomataLessonReviewReceipt>;
}

interface AutomataLessonChangeTarget {
  kind: 'instruction' | 'tool';
  id: string;
  baseRevision: string;
}

export interface PrepareAutomataLessonProposalInput {
  group: AutomataLessonGroup;
  target: AutomataLessonChangeTarget;
  before: string;
  after: string;
  rationaleCode: string;
}

export interface PreparedAutomataLessonProposal {
  proposalId: string;
  status: 'prepared-not-submitted';
  reviewPath: '/api/admin/shared-workspace/proposals';
  request: GovernedAutomataLessonReviewRequest;
}

export interface AutomataLessonProposalPolicy {
  maxChangeChars: number;
  maxSourceIds: number;
}

const SAFE_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u;
const SHA256_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Automata lesson proposal ${field} must be a positive safe integer`);
  }
  return value;
}

function safeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!SAFE_IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`Automata lesson proposal ${field} must be a content-safe identifier`);
  }
  return normalized;
}

function requiredChangeText(value: string, field: string, maximum: number): string {
  if (value.trim().length === 0) throw new Error(`Automata lesson proposal ${field} must be non-empty`);
  if (value.length > maximum) throw new Error(`Automata lesson proposal ${field} exceeds maxChangeChars`);
  return value.replaceAll('\r\n', '\n');
}

function buildUnifiedDiff(target: AutomataLessonChangeTarget, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  return [
    `--- ${target.kind}/${target.id}@${target.baseRevision}`,
    `+++ ${target.kind}/${target.id}@proposed`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map(line => `-${line}`),
    ...afterLines.map(line => `+${line}`),
  ].join('\n');
}

function assertProposalEligible(group: AutomataLessonGroup, maxSourceIds: number): void {
  safeIdentifier(group.groupId, 'group.groupId');
  safeIdentifier(group.automatonClass, 'group.automatonClass');
  safeIdentifier(group.promptRevision, 'group.promptRevision');
  safeIdentifier(group.toolName, 'group.toolName');
  safeIdentifier(group.failureCategory, 'group.failureCategory');
  safeIdentifier(group.lessonCode, 'group.lessonCode');
  group.sourceFindingIds.forEach((eventId, index) => {
    safeIdentifier(eventId, `group.sourceFindingIds[${index}]`);
  });
  group.contradiction.sourceFindingIds.forEach((eventId, index) => {
    safeIdentifier(eventId, `group.contradiction.sourceFindingIds[${index}]`);
  });
  if (group.evidenceIds.some(evidenceId => !SHA256_ID_PATTERN.test(evidenceId))) {
    throw new Error('Automata lesson proposal evidence IDs must be redacted sha256 identifiers');
  }
  if (group.support !== 'supported') {
    throw new Error('Automata lesson proposal requires a supported recurrent group');
  }
  if (group.contradiction.present) {
    throw new Error('Automata lesson proposal refuses a contradicted group');
  }
  if (group.inferenceOnly) {
    throw new Error('Automata lesson proposal refuses an inference-only group');
  }
  if (group.evidenceQuality !== 'verified') {
    throw new Error('Automata lesson proposal requires verified evidence');
  }
  if (group.sourceTraceTruncated || group.sourceFindingIds.length > maxSourceIds) {
    throw new Error('Automata lesson proposal requires a complete bounded source trace');
  }
}

function stableProposalId(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export class AutomataLessonProposalService {
  private readonly policy: AutomataLessonProposalPolicy;

  constructor(private readonly options: {
    review: GovernedAutomataLessonReviewPort;
    policy: AutomataLessonProposalPolicy;
  }) {
    this.policy = Object.freeze({
      maxChangeChars: positiveInteger(options.policy.maxChangeChars, 'maxChangeChars'),
      maxSourceIds: positiveInteger(options.policy.maxSourceIds, 'maxSourceIds'),
    });
  }

  prepare(input: PrepareAutomataLessonProposalInput): PreparedAutomataLessonProposal {
    assertProposalEligible(input.group, this.policy.maxSourceIds);
    const target = {
      kind: input.target.kind,
      id: safeIdentifier(input.target.id, 'target.id'),
      baseRevision: safeIdentifier(input.target.baseRevision, 'target.baseRevision'),
    } satisfies AutomataLessonChangeTarget;
    const before = requiredChangeText(input.before, 'before', this.policy.maxChangeChars);
    const after = requiredChangeText(input.after, 'after', this.policy.maxChangeChars);
    if (before === after) throw new Error('Automata lesson proposal requires a non-empty diff');
    const rationaleCode = safeIdentifier(input.rationaleCode, 'rationaleCode');
    const diff = buildUnifiedDiff(target, before, after);
    const proposalId = stableProposalId([
      input.group.groupId,
      target,
      rationaleCode,
      diff,
      input.group.sourceFindingIds,
      input.group.evidenceIds,
    ]);
    const artifact = {
      schemaVersion: 1,
      kind: 'automata_lesson_change_proposal',
      state: 'review_required',
      proposalId,
      target,
      rationaleCode,
      diff,
      source: {
        groupId: input.group.groupId,
        sourceFindingIds: [...input.group.sourceFindingIds],
        evidenceIds: [...input.group.evidenceIds],
        interpretation: input.group.interpretation,
      },
      safeguards: {
        appliesChange: false,
        promotesPrimaryMemory: false,
        publishesTelemetry: false,
        requiresCogSecAndIndependentReview: true,
      },
    } as const;
    return {
      proposalId,
      status: 'prepared-not-submitted',
      reviewPath: '/api/admin/shared-workspace/proposals',
      request: {
        artifactPath: `automata/lesson-proposals/${proposalId}.json`,
        content: JSON.stringify(artifact, null, 2),
        mediaType: 'application/json',
        provenance: `automata-lesson:${input.group.groupId}`,
      },
    };
  }

  /** Explicit action: creates a pending review artifact; it cannot apply the described change. */
  async submitForReview(
    prepared: PreparedAutomataLessonProposal,
  ): Promise<GovernedAutomataLessonReviewReceipt> {
    const receipt = await this.options.review.propose(prepared.request);
    if (receipt.reviewId.trim().length === 0) {
      throw new Error('Governed review port returned an invalid pending receipt');
    }
    return { reviewId: receipt.reviewId, status: 'pending' };
  }
}

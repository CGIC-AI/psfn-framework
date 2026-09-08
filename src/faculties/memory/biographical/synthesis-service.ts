// ── Portable biography candidate synthesis (o61vb.12) ──
//
// One maintenance pass that mines already-authorized memory silos for durable,
// typed biography candidates and stages them for review. Everything it emits is
// a candidate: this service has no activation authority and never writes an
// active claim.
//
// Privacy shape, in order:
//   1. `collectAuthorizedBiographicalSources` applies subject authorization in
//      SQL and owner candidate policy in process. No excluded body reaches this
//      module at all.
//   2. Synthesis sees only those admitted bodies, for one canonical subject at
//      a time. Two silos are never in the same prompt.
//   3. `resolveLiveBiographicalCandidates` re-reads every cited source and
//      rejects any candidate whose evidence drifted since collection, so a
//      source revoked mid-run cannot be persisted.
//   4. `writeCandidate` re-applies the same owner policy at the persistence
//      boundary, so a caller that skipped step 1 still fails closed.
//
// Grouping is by canonical subject and explicit dyad, never by channel: the
// same dyad seen in two rooms is one social context.

import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import {
  BIOGRAPHY_CANDIDATE_SYNTHESIS_PROMPT_KEY,
  getDefaultPromptText,
} from '../../../core/identity/prompt-registry.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import { injectPromptRuntimeTokens } from '../../../core/identity/prompt-runtime.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../../primitives/llm/work-spec.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { computeStageInputDigest } from './stage-cursor.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import type { BiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { collectAuthorizedBiographicalSources } from './authorized-sources.js';
import { claimConflictKey } from './claim-kinds.js';
import { resolveLiveBiographicalCandidates } from './live-source-rebuild.js';
import { PORTABLE_BIOGRAPHY_CANDIDATE_KINDS } from './stable-candidate.js';
import { prepareBiographicalClaim } from './store-port.js';
import type {
  BiographicalClaimWriteInput,
  BiographicalProfileStorePort,
} from './store-port.js';
import type {
  BiographicalCandidateRationale,
  BiographicalCandidateSocialContext,
  BiographicalClaimKind,
  BiographicalClaimSource,
  BiographicalCollectionDepth,
  BiographicalSubjectRef,
} from './types.js';

const log = createComponentLogger('Biography');

/** Only these kinds are dyadic; a companion-self scan cannot propose them. */
const DYADIC_CANDIDATE_KINDS: readonly BiographicalClaimKind[] = [
  'relationship',
  'shared-language',
];

/**
 * One canonical subject to scan, with the social context its candidates are
 * grouped under. Subject selection is runtime authority: the synthesizer never
 * chooses whom it is writing about.
 */
export interface BiographySynthesisTarget {
  readonly subject: BiographicalSubjectRef;
  readonly socialContext: BiographicalCandidateSocialContext;
  readonly depth: BiographicalCollectionDepth;
}

/**
 * Bounded target enumeration. The epic's collection-depth rule lives here:
 * recognition-depth contacts keep only their Recent Contact Shape and are not
 * mined for durable claims.
 */
export interface BiographySynthesisTargetPort {
  listTargets(limit: number): Promise<readonly BiographySynthesisTarget[]>;
}

/** Content-free run telemetry. No subject id, claim value, or source body. */
/**
 * How a resumable background stage finished (o61vb.16). `complete` means the
 * stage drained its work and may release the fleet baton; `yield` means it
 * stopped at a safe boundary with work left and must be resumed.
 */
export type BiographyStageOutcome = 'complete' | 'yield';

/**
 * Safe-boundary hook. A stage calls this between whole targets — never mid
 * write — and stops when it is told to yield, so foreground work preempts
 * without losing durable progress.
 */
export interface BiographyStageControl {
  onSafeBoundary?: () => Promise<'continue' | 'yield'>;
}

export interface BiographySynthesisTelemetry {
  readonly automataRunId: string;
  readonly outcome: BiographyStageOutcome;
  /** Targets skipped because their admitted evidence has not changed. */
  readonly targetsUnchanged: number;
  readonly targetsRemaining: number;
  readonly targetsScanned: number;
  readonly targetsSynthesized: number;
  readonly sourcesScanned: number;
  readonly sourcesAdmitted: number;
  readonly sourcesWithheldByPolicy: number;
  readonly candidatesEmitted: number;
  readonly candidatesStaged: number;
  readonly candidatesSuperseded: number;
  readonly candidatesCoalesced: number;
  readonly candidatesWithheld: number;
  readonly candidatesDuplicate: number;
  readonly targetsFailed: number;
}

export interface BiographySynthesisServiceOptions {
  readonly memoryStore: MemoryStorePort;
  readonly profileStore: BiographicalProfileStorePort;
  readonly llmClient: LLMProviderPort;
  readonly promptRegistry: PromptRegistryStatePort | null;
  readonly targets: BiographySynthesisTargetPort;
  readonly companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
  /** Read per run so an owner-file edit takes effect on the next pass. */
  readonly candidatePolicy: () => BiographicalCandidatePolicy;
  readonly depthPolicy: () => BiographicalDepthPolicy;
  readonly onComplete?: (telemetry: BiographySynthesisTelemetry) => void;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

interface CoalescedCandidate {
  readonly write: BiographicalClaimWriteInput;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly mergedCount: number;
}

function admittedKindsForSubject(
  subject: BiographicalSubjectRef,
): readonly BiographicalClaimKind[] {
  return subject.kind === 'companion'
    ? PORTABLE_BIOGRAPHY_CANDIDATE_KINDS.filter(kind => !DYADIC_CANDIDATE_KINDS.includes(kind))
    : PORTABLE_BIOGRAPHY_CANDIDATE_KINDS;
}

function subjectContextBlock(target: BiographySynthesisTarget): string {
  return target.subject.kind === 'companion'
    ? [
        'Subject kind: the companion themself (autobiography)',
        `Canonical companion id: ${target.subject.companionId}`,
        'Dyadic kinds are not available in this scan.',
      ].join('\n')
    : [
        'Subject kind: a canonical human contact',
        `Canonical contact id: ${target.subject.contactId}`,
        'Dyadic kinds describe this contact and the companion running the scan.',
      ].join('\n');
}

function formatSourceMemory(memory: PurrMemory): string {
  return `- [${memory.id}] [${memory.type}] ${memory.text} `
    + `(sensitivity=${memory.sensitivity}, importance=${memory.importance.toFixed(2)}, `
    + `confidence=${memory.confidence.toFixed(2)})`;
}

/**
 * Union two source sets by exact snapshot identity. Returns undefined when the
 * union would exceed the owner's per-candidate source budget: coalescing must
 * never silently drop provenance, so an over-budget pair stays separate.
 */
function unionSources(
  left: readonly BiographicalClaimSource[],
  right: readonly BiographicalClaimSource[],
  limit: number,
): readonly BiographicalClaimSource[] | undefined {
  const byIdentity = new Map<string, BiographicalClaimSource>();
  for (const source of [...left, ...right]) {
    byIdentity.set(`${source.ref}@${source.revision}@${source.evidenceDigest}`, source);
  }
  return byIdentity.size > limit ? undefined : [...byIdentity.values()];
}

/**
 * Durable cursor key for one canonical biography subject. Canonical identity
 * only: a cursor must survive restart and mean the same thing to whichever
 * companion holds the fleet baton next.
 */
export function stageCursorKeyForSubject(subject: BiographicalSubjectRef): string {
  return subject.kind === 'companion'
    ? `companion:${subject.companionId}`
    : `contact:${subject.contactId}`;
}

export class BiographySynthesisService {
  constructor(private readonly options: BiographySynthesisServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * One synthesis pass. Every target is isolated: a target that throws is
   * counted and skipped so one unreadable silo cannot stop the pass, but the
   * failure is never swallowed silently.
   */
  async run(control: BiographyStageControl = {}): Promise<BiographySynthesisTelemetry> {
    const policy = this.options.candidatePolicy();
    const automataRunId = this.options.newRunId?.() ?? `biography-synthesis:${crypto.randomUUID()}`;
    const targets = await this.options.targets.listTargets(
      policy.budgets.maxCandidatesPerAutomataRun,
    );
    let targetsSynthesized = 0;
    let sourcesScanned = 0;
    let sourcesAdmitted = 0;
    let sourcesWithheld = 0;
    let candidatesEmitted = 0;
    let candidatesStaged = 0;
    let candidatesSuperseded = 0;
    let candidatesCoalesced = 0;
    let candidatesWithheld = 0;
    let candidatesDuplicate = 0;
    let targetsFailed = 0;
    let targetsUnchanged = 0;
    let runBudget = policy.budgets.maxCandidatesPerAutomataRun;
    let outcomeState: BiographyStageOutcome = 'complete';
    let processed = 0;

    for (const target of targets) {
      if (runBudget <= 0) break;
      // Safe boundary: between whole targets, never mid write. A yield here
      // leaves every durable cursor exactly where the last finished target put
      // it, so the next pass resumes rather than repeats.
      if (processed > 0 && await control.onSafeBoundary?.() === 'yield') {
        outcomeState = 'yield';
        break;
      }
      processed += 1;
      try {
        const outcome = await this.synthesizeTarget({ target, policy, automataRunId, runBudget });
        if (outcome.unchanged) targetsUnchanged += 1;
        sourcesScanned += outcome.sourcesScanned;
        sourcesAdmitted += outcome.sourcesAdmitted;
        sourcesWithheld += outcome.sourcesWithheldByPolicy;
        candidatesEmitted += outcome.candidatesEmitted;
        candidatesStaged += outcome.candidatesStaged;
        candidatesSuperseded += outcome.candidatesSuperseded;
        candidatesCoalesced += outcome.candidatesCoalesced;
        candidatesWithheld += outcome.candidatesWithheld;
        candidatesDuplicate += outcome.candidatesDuplicate;
        if (outcome.synthesized) targetsSynthesized += 1;
        runBudget -= outcome.candidatesStaged;
      } catch (error) {
        targetsFailed += 1;
        // Content-free: the subject kind and the failure text only. A subject
        // id would make an error log a cross-silo disclosure channel.
        log.warn('Biography synthesis target failed', {
          subjectKind: target.subject.kind,
          error: toErrorMessage(error),
        });
      }
    }

    const telemetry: BiographySynthesisTelemetry = {
      automataRunId,
      outcome: outcomeState,
      targetsUnchanged,
      targetsRemaining: Math.max(0, targets.length - processed),
      targetsScanned: targets.length,
      targetsSynthesized,
      sourcesScanned,
      sourcesAdmitted,
      sourcesWithheldByPolicy: sourcesWithheld,
      candidatesEmitted,
      candidatesStaged,
      candidatesSuperseded,
      candidatesCoalesced,
      candidatesWithheld,
      candidatesDuplicate,
      targetsFailed,
    };
    this.options.onComplete?.(telemetry);
    return telemetry;
  }

  private async synthesizeTarget(input: {
    readonly target: BiographySynthesisTarget;
    readonly policy: BiographicalCandidatePolicy;
    readonly automataRunId: string;
    readonly runBudget: number;
  }): Promise<{
    synthesized: boolean;
    /** The admitted evidence digest matched the durable cursor: no model call. */
    unchanged: boolean;
    sourcesScanned: number;
    sourcesAdmitted: number;
    sourcesWithheldByPolicy: number;
    candidatesEmitted: number;
    candidatesStaged: number;
    candidatesSuperseded: number;
    candidatesCoalesced: number;
    candidatesWithheld: number;
    candidatesDuplicate: number;
  }> {
    const { target, policy } = input;
    const depth = this.options.depthPolicy()[target.depth];
    // A run can never consume more sources than its own candidate and
    // per-candidate source budgets allow, so the scan bound is derived from
    // owner policy rather than being an independent tuning value.
    const scanLimit = policy.budgets.maxSourcesPerCandidate
      * policy.budgets.maxCandidatesPerAutomataRun;
    const collection = await collectAuthorizedBiographicalSources({
      memoryStore: this.options.memoryStore,
      subject: target.subject,
      policy,
      scanLimit,
    });
    const withheldByPolicy = Object.values(collection.withheldByPolicy)
      .reduce((total, count) => total + count, 0);
    const empty = {
      synthesized: false,
      unchanged: false,
      sourcesScanned: collection.scannedCount,
      sourcesAdmitted: collection.evidence.length,
      sourcesWithheldByPolicy: withheldByPolicy,
      candidatesEmitted: 0,
      candidatesStaged: 0,
      candidatesSuperseded: 0,
      candidatesCoalesced: 0,
      candidatesWithheld: 0,
      candidatesDuplicate: 0,
    };
    if (collection.evidence.length === 0) return empty;

    const candidateLimit = Math.min(depth.candidateLimitPerRefresh, input.runBudget);
    if (candidateLimit <= 0) return empty;

    // Durable no-change gate (o61vb.16). The digest covers exactly the admitted
    // source snapshots this target would have reasoned over, so an unchanged
    // silo costs one cursor read and zero model calls. It is checked after the
    // policy filter on purpose: a source becoming inadmissible changes the
    // digest and correctly re-opens the target.
    const cursorKey = stageCursorKeyForSubject(target.subject);
    const evidenceDigest = computeStageInputDigest(collection.evidence.map(
      entry => `${entry.source.ref}@${entry.source.revision}@${entry.source.evidenceDigest}`,
    ));
    const cursor = await this.options.profileStore.getStageCursor(
      'biography_synthesis',
      cursorKey,
    );
    if (cursor?.observedDigest === evidenceDigest) {
      return { ...empty, unchanged: true };
    }

    const admittedKinds = admittedKindsForSubject(target.subject);
    const now = this.now();
    const response = await this.synthesize({ target, collection, candidateLimit, admittedKinds });
    const resolution = await resolveLiveBiographicalCandidates({
      responseContent: response,
      memoryStore: this.options.memoryStore,
      subject: target.subject,
      companionSubject: this.options.companionSubject,
      availableEvidence: collection.evidence,
      depth: target.depth,
      candidateLimit,
      admittedKinds,
      now,
    });

    const coalesced = this.coalesce(resolution.resolved.map(entry => entry.write), policy);
    let staged = 0;
    let superseded = 0;
    let duplicate = 0;
    for (const candidate of coalesced) {
      const disposition = await this.stageCandidate({
        candidate,
        target,
        policy,
        automataRunId: input.automataRunId,
        now,
      });
      if (disposition === 'staged') staged += 1;
      if (disposition === 'superseded') {
        staged += 1;
        superseded += 1;
      }
      if (disposition === 'duplicate') duplicate += 1;
    }
    // The cursor advances only after the whole target's candidates are durably
    // staged, so a crash mid-target re-runs it rather than silently skipping it.
    await this.options.profileStore.writeStageCursor({
      stage: 'biography_synthesis',
      cursorKey,
      observedDigest: evidenceDigest,
      now,
    });
    return {
      synthesized: true,
      unchanged: false,
      sourcesScanned: collection.scannedCount,
      sourcesAdmitted: collection.evidence.length,
      sourcesWithheldByPolicy: withheldByPolicy,
      candidatesEmitted: resolution.emittedCount,
      candidatesStaged: staged,
      candidatesSuperseded: superseded,
      candidatesCoalesced: coalesced.reduce(
        (total, entry) => total + (entry.mergedCount > 1 ? 1 : 0),
        0,
      ),
      candidatesWithheld: resolution.withheld.length,
      candidatesDuplicate: duplicate,
    };
  }

  private async synthesize(input: {
    readonly target: BiographySynthesisTarget;
    readonly collection: Awaited<ReturnType<typeof collectAuthorizedBiographicalSources>>;
    readonly candidateLimit: number;
    readonly admittedKinds: readonly BiographicalClaimKind[];
  }): Promise<string> {
    const template = this.options.promptRegistry?.getPrompt(
      BIOGRAPHY_CANDIDATE_SYNTHESIS_PROMPT_KEY,
    ) ?? getDefaultPromptText(BIOGRAPHY_CANDIDATE_SYNTHESIS_PROMPT_KEY);
    const prompt = injectPromptRuntimeTokens(template)
      .replace('{subject_context}', subjectContextBlock(input.target))
      .replace('{biographical_candidate_limit}', String(input.candidateLimit))
      .replace('{admitted_kinds}', input.admittedKinds.join(', '))
      .replace(
        '{memory_facts}',
        input.collection.evidence.map(entry => formatSourceMemory(entry.memory)).join('\n'),
      );
    const response = await completeWithWorkSpec(
      this.options.llmClient,
      {
        systemPrompt: prompt,
        messages: [{
          role: 'user',
          content: 'Propose the structured biography candidates now.',
        }],
      },
      buildLLMWorkSpec({
        purpose: 'memory',
        durable: true,
        correlation: {
          requestId: `biography-candidate-synthesis:${this.now().getTime()}`,
          channelId: 'internal:biography-synthesis',
          callType: 'scheduled',
          purpose: 'memory.biography.candidate_synthesis',
          originType: 'scheduled',
          originStage: 'memory.biography.candidate_synthesis',
        },
      }),
    );
    return response.content;
  }

  /**
   * Coalesce candidates that reduce to the same canonical claim within one run.
   * Duplicate evidence merges into a single candidate whose source set is the
   * union of both proposals, so no provenance is lost; genuinely different
   * values stay separate candidates for review to arbitrate.
   */
  private coalesce(
    writes: readonly BiographicalClaimWriteInput[],
    policy: BiographicalCandidatePolicy,
  ): CoalescedCandidate[] {
    const byClaimDigest = new Map<string, CoalescedCandidate>();
    for (const write of writes) {
      const prepared = prepareBiographicalClaim({ ...write, status: 'candidate' });
      const existing = byClaimDigest.get(prepared.claimDigest);
      if (existing === undefined) {
        byClaimDigest.set(prepared.claimDigest, {
          write,
          claimDigest: prepared.claimDigest,
          sourceSetDigest: prepared.sourceSetDigest,
          mergedCount: 1,
        });
        continue;
      }
      const sources = unionSources(
        existing.write.sources,
        write.sources,
        policy.budgets.maxSourcesPerCandidate,
      );
      if (sources === undefined) continue;
      const merged: BiographicalClaimWriteInput = { ...existing.write, sources };
      const mergedPrepared = prepareBiographicalClaim({ ...merged, status: 'candidate' });
      byClaimDigest.set(prepared.claimDigest, {
        write: merged,
        claimDigest: mergedPrepared.claimDigest,
        sourceSetDigest: mergedPrepared.sourceSetDigest,
        mergedCount: existing.mergedCount + 1,
      });
    }
    return [...byClaimDigest.values()];
  }

  /**
   * Stage one coalesced candidate.
   *
   * Restart safety lives here: an identical claim already active, or already
   * staged over the identical source set, writes nothing. The same claim over a
   * drifted source set supersedes its predecessor rather than accumulating,
   * so a re-run after a partial pass converges instead of duplicating.
   */
  private async stageCandidate(input: {
    readonly candidate: CoalescedCandidate;
    readonly target: BiographySynthesisTarget;
    readonly policy: BiographicalCandidatePolicy;
    readonly automataRunId: string;
    readonly now: Date;
  }): Promise<'staged' | 'superseded' | 'duplicate'> {
    const { candidate, target, policy } = input;
    return await this.options.profileStore.runClaimTransaction(
      candidate.write.subject,
      candidate.write.kind,
      async store => {
        const active = await store.listClaims({
          subject: candidate.write.subject,
          kind: candidate.write.kind,
          status: 'active',
        });
        if (active.some(claim => claim.claimDigest === candidate.claimDigest)) {
          return 'duplicate';
        }
        const staged = await store.listCandidates({
          claimDigest: candidate.claimDigest,
          limit: policy.budgets.maxPendingCandidates,
        });
        const open = staged.filter(
          record => !['active', 'rejected', 'superseded'].includes(record.stage),
        );
        const identical = open.find(
          record => record.sourceSetDigest === candidate.sourceSetDigest,
        );
        if (identical !== undefined) return 'duplicate';
        const prior = open[0];
        const rationale = this.rationaleFor({ candidate, active, recurring: prior !== undefined });
        const { status: _ignoredStatus, portabilityScope: _ignoredScope, ...claimWrite } =
          candidate.write;
        const written = await store.writeCandidate({
          claim: { ...claimWrite, now: input.now },
          automataRunId: input.automataRunId,
          automataAuthorityRef: `maintenance:biography-synthesis:${input.automataRunId}`,
          policy,
          socialContext: target.socialContext,
          rationale,
          ...(prior !== undefined ? { supersedesCandidateId: prior.id } : {}),
        });
        if (prior === undefined) return 'staged';
        // Append-only: the predecessor becomes terminal under the owner policy
        // that authorized this synthesis, and its receipts stay intact.
        await store.transitionCandidate({
          candidateId: prior.id,
          expectedRevision: prior.revision,
          to: 'superseded',
          receipts: [{
            authority: 'owner_policy',
            decision: 'superseded',
            actorAuthorityRef: `owner-policy:${written.policyDigest}`,
            reason: 'owner_policy_supersession',
          }],
          now: input.now,
        });
        return 'superseded';
      },
    );
  }

  private rationaleFor(input: {
    readonly candidate: CoalescedCandidate;
    readonly active: readonly { claimDigest: string; kind: BiographicalClaimKind;
      subject: BiographicalSubjectRef; value: unknown;
      relatedSubject?: BiographicalSubjectRef }[];
    readonly recurring: boolean;
  }): BiographicalCandidateRationale {
    if (input.candidate.mergedCount > 1) return 'coalesced_duplicate_evidence';
    if (input.recurring) return 'recurring_evidence';
    const key = claimConflictKey(
      input.candidate.write.kind,
      input.candidate.write.subject,
      input.candidate.write.value,
      input.candidate.write.relatedSubject,
    );
    const contradicts = input.active.some(claim => (
      claimConflictKey(
        claim.kind,
        claim.subject,
        claim.value as never,
        claim.relatedSubject,
      ) === key
    ));
    return contradicts ? 'contradicts_active_claim' : 'new_subject_claim';
  }
}

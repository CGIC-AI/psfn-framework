import { createHash } from 'node:crypto';
import type { IntrospectionAuditConfig } from '../../system/config/scheduler-config.js';
import type { IntrospectionConsentStore } from './consent-store.js';
import {
  isUnconfiguredIntrospectionConsentPolicy,
  type BlindedAuditorPort,
  type CompanionLandmarkReflectorPort,
  type IntrospectionAuditCandidate,
  type IntrospectionAuditPersistencePort,
  type IntrospectionAuditSourcePort,
  type IntrospectionConsentRevision,
} from './contracts.js';

export type IntrospectionAuditGateReason =
  | 'infrastructure_disabled'
  | 'consent_unconfigured'
  | 'consent_disabled'
  | 'no_eligible_content'
  | 'completed';

export interface IntrospectionAuditRunResult {
  reason: IntrospectionAuditGateReason;
  candidates: number;
  audited: number;
  landmarksCreated: number;
}

function normalizeForReplayDetection(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function longestCommonContiguousLength(left: string, right: string): number {
  if (!left || !right) return 0;
  let previous = new Uint16Array(right.length + 1);
  let longest = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      longest = Math.max(longest, current[rightIndex]);
    }
    previous = current;
  }
  return longest;
}

function assertNoSourceReplay(observation: string, sources: readonly string[]): void {
  const normalizedObservation = normalizeForReplayDetection(observation);
  for (const source of sources) {
    const normalizedSource = normalizeForReplayDetection(source);
    if (!normalizedSource) continue;
    const threshold = Math.min(16, normalizedSource.length);
    if (longestCommonContiguousLength(normalizedSource, normalizedObservation) >= threshold) {
      throw new Error('Introspection auditor observation echoed source material');
    }
  }
}

export class IntrospectionConsentChangedDuringAuditError extends Error {
  constructor() {
    super('Introspection consent changed or no longer permits this channel during audit');
    this.name = 'IntrospectionConsentChangedDuringAuditError';
  }
}

export class IntrospectionSourceChangedDuringAuditError extends Error {
  constructor() {
    super('Introspection source is retired, redacted, or otherwise no longer eligible during audit');
    this.name = 'IntrospectionSourceChangedDuringAuditError';
  }
}

function assertConsentStillActive(
  consentStore: Pick<IntrospectionConsentStore, 'load'>,
  baseline: IntrospectionConsentRevision,
  channelId: string,
): void {
  const current = consentStore.load();
  if (
    isUnconfiguredIntrospectionConsentPolicy(current)
    || !current.enabled
    || current.revision !== baseline.revision
    || current.hash !== baseline.hash
    || !current.allowedPublicChannelIds.includes(channelId)
  ) {
    throw new IntrospectionConsentChangedDuringAuditError();
  }
}

async function assertAuditStillAuthorized(
  consentStore: Pick<IntrospectionConsentStore, 'load'>,
  baseline: IntrospectionConsentRevision,
  source: IntrospectionAuditSourcePort,
  candidate: IntrospectionAuditCandidate,
): Promise<void> {
  assertConsentStillActive(consentStore, baseline, candidate.channelId);
  const eligible = await source.isCandidateStillEligible(candidate);
  // Eligibility can require an archive scan. Consent is mutable while that
  // scan yields, so the result cannot authorize the next disclosure boundary
  // until the consent revision is checked again.
  assertConsentStillActive(consentStore, baseline, candidate.channelId);
  if (!eligible) {
    throw new IntrospectionSourceChangedDuringAuditError();
  }
}

function landmarkId(sourceRef: string, consentHash: string): string {
  return `introspection-${createHash('sha256')
    .update(`${sourceRef}\0${consentHash}`)
    .digest('hex')
    .slice(0, 24)}`;
}

export class IntrospectionAuditRuntime {
  constructor(private readonly options: {
    config: IntrospectionAuditConfig;
    consentStore: Pick<IntrospectionConsentStore, 'load'>;
    source: IntrospectionAuditSourcePort;
    auditor: BlindedAuditorPort;
    reflector: CompanionLandmarkReflectorPort;
    persistence: IntrospectionAuditPersistencePort;
    now?: () => Date;
  }) {}

  async runOnce(): Promise<IntrospectionAuditRunResult> {
    const { config } = this.options;
    if (!config.enabled) {
      return { reason: 'infrastructure_disabled', candidates: 0, audited: 0, landmarksCreated: 0 };
    }
    const consent = this.options.consentStore.load();
    if (isUnconfiguredIntrospectionConsentPolicy(consent)) {
      return { reason: 'consent_unconfigured', candidates: 0, audited: 0, landmarksCreated: 0 };
    }
    if (!consent.enabled) {
      return { reason: 'consent_disabled', candidates: 0, audited: 0, landmarksCreated: 0 };
    }
    const candidates = await this.options.source.listCandidates({
      allowedPublicChannelIds: consent.allowedPublicChannelIds,
      recentSessionLimit: config.recentSessionLimit,
      recentTurnLimit: config.recentTurnLimit,
      maxSourceChars: config.maxSourceChars,
    });
    let audited = 0;
    let landmarksCreated = 0;
    for (const candidate of candidates) {
      if (audited >= config.maxCandidatesPerRun) break;
      if (await this.options.persistence.hasAuditedSource(candidate.sourceRef)) continue;
      await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
      const estimate = await this.options.auditor.estimateStableReply(candidate);
      await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
      const comparison = await this.options.auditor.compareReplies(candidate, estimate.stableReply);
      await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
      audited += 1;
      const createdAt = (this.options.now?.() ?? new Date()).toISOString();
      const provenance = {
        sourceRefs: candidate.provenanceRefs,
        privacy: 'verbatim_public',
        consentActor: consent.actor,
      };
      if (!comparison.diverged) {
        await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
        await this.options.persistence.appendAuditDecision({
          sourceRef: candidate.sourceRef,
          outcome: 'no_divergence',
          confidence: comparison.confidence,
          consentRevision: consent.revision,
          consentHash: consent.hash,
          provenance,
          createdAt,
        });
        continue;
      }
      if (comparison.confidence < config.minConfidence) {
        await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
        await this.options.persistence.appendAuditDecision({
          sourceRef: candidate.sourceRef,
          outcome: 'below_confidence',
          confidence: comparison.confidence,
          consentRevision: consent.revision,
          consentHash: consent.hash,
          provenance,
          createdAt,
        });
        continue;
      }
      if (!comparison.type) {
        throw new Error('Diverged introspection result is missing divergence type');
      }
      assertNoSourceReplay(comparison.observation, [
        candidate.publicStimulus,
        candidate.actualReply,
        estimate.stableReply,
      ]);
      await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
      const reflection = await this.options.reflector.reflect({
        divergenceType: comparison.type,
        observation: comparison.observation,
        confidence: comparison.confidence,
      });
      await assertAuditStillAuthorized(this.options.consentStore, consent, this.options.source, candidate);
      await this.options.persistence.appendLandmark({
        id: landmarkId(candidate.sourceRef, consent.hash),
        sourceRef: candidate.sourceRef,
        channelId: candidate.channelId,
        turnId: candidate.turnId,
        occurredAt: candidate.occurredAt,
        divergenceType: comparison.type,
        observation: comparison.observation,
        confidence: comparison.confidence,
        companionReflection: reflection.reflection,
        consentRevision: consent.revision,
        consentHash: consent.hash,
        stableEstimatorModel: estimate.model,
        divergenceAuditorModel: comparison.model,
        companionReflectorModel: reflection.model,
        provenance,
        createdAt,
      });
      landmarksCreated += 1;
    }
    return {
      reason: candidates.length === 0 ? 'no_eligible_content' : 'completed',
      candidates: candidates.length,
      audited,
      landmarksCreated,
    };
  }
}

import { createHash } from 'node:crypto';
import type { IntrospectionAuditConfig } from '../../system/config/scheduler-config.js';
import type { IntrospectionConsentStore } from './consent-store.js';
import type {
  BlindedAuditorPort,
  CompanionLandmarkReflectorPort,
  IntrospectionAuditPersistencePort,
  IntrospectionAuditSourcePort,
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

function sourceFragments(text: string): string[] {
  const compact = text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (compact.length < 24) return compact ? [compact] : [];
  const fragments: string[] = [];
  for (let index = 0; index + 24 <= compact.length; index += 12) {
    fragments.push(compact.slice(index, index + 24));
  }
  return fragments;
}

function assertNoSourceReplay(observation: string, sources: readonly string[]): void {
  const normalized = observation.replace(/\s+/g, ' ').toLocaleLowerCase();
  const leaked = sources.flatMap(sourceFragments).find(fragment => normalized.includes(fragment));
  if (leaked) {
    throw new Error('Introspection auditor observation echoed source material');
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
    if (consent.status === 'unconfigured') {
      return { reason: 'consent_unconfigured', candidates: 0, audited: 0, landmarksCreated: 0 };
    }
    if (!consent.enabled) {
      return { reason: 'consent_disabled', candidates: 0, audited: 0, landmarksCreated: 0 };
    }
    const candidates = this.options.source.listCandidates({
      allowedPublicChannelIds: consent.allowedPublicChannelIds,
      recentSessionLimit: config.recentSessionLimit,
      recentTurnLimit: config.recentTurnLimit,
      maxSourceChars: config.maxSourceChars,
    });
    let audited = 0;
    let landmarksCreated = 0;
    for (const candidate of candidates.slice(0, config.maxCandidatesPerRun)) {
      if (await this.options.persistence.hasAuditedSource(candidate.sourceRef)) continue;
      const estimate = await this.options.auditor.estimateStableReply(candidate);
      const comparison = await this.options.auditor.compareReplies(candidate, estimate.stableReply);
      audited += 1;
      const createdAt = (this.options.now?.() ?? new Date()).toISOString();
      const provenance = {
        sourceRefs: candidate.provenanceRefs,
        privacy: 'verbatim_public',
        consentActor: consent.actor,
      };
      if (!comparison.diverged) {
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
      const reflection = await this.options.reflector.reflect({
        divergenceType: comparison.type,
        observation: comparison.observation,
        confidence: comparison.confidence,
      });
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

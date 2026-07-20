// Garden inspection surface for the Partner Affect shadow observation
// foundation (docs/partner-affect.md slice 1). Read-only: operators can see
// the current policy, the deterministic shadow estimate with per-family
// evidence health, and recent accepted/suppressed observation records. The
// records contain summarized scalars and structural reason codes only — raw
// sensitive source content is rejected upstream and never stored, so it can
// never appear here.

import type { PartnerAffectShadowStorePort } from '../../../core/emotion/partner-affect/shadow-store-port.js';
import { computePartnerAffectShadowEstimate } from '../../../core/emotion/partner-affect/shadow-estimate.js';
import type {
  PartnerAffectObservation,
  PartnerAffectShadowEstimate,
  PartnerAffectShadowPolicy,
  PartnerAffectSuppressedObservation,
} from '../../../shared/contracts/partner-affect.js';

const ESTIMATE_EVIDENCE_FETCH_LIMIT = 1_000;
const DEFAULT_OBSERVATION_LIST_LIMIT = 100;
const MAX_OBSERVATION_LIST_LIMIT = 500;

export interface PartnerAffectShadowPolicySummary {
  enabled: boolean;
  partnerContactId: string | null;
  staleAfterMs: number;
  evidenceWindowMs: number;
  minConfidence: number;
  minIndependentFamilies: number;
  conflictValueTolerance: number;
  allowedSignalFamilies: string[];
  sourceCount: number;
  revokedSourceCount: number;
  maxRetainedObservations: number;
  policyRevision: string;
}

export interface PartnerAffectShadowSnapshot {
  policy: PartnerAffectShadowPolicySummary;
  estimate: PartnerAffectShadowEstimate;
}

export interface PartnerAffectShadowObservationsPage {
  accepted: PartnerAffectObservation[];
  suppressed: PartnerAffectSuppressedObservation[];
}

export interface AdminPartnerAffectShadowService {
  getShadowSnapshot(): Promise<PartnerAffectShadowSnapshot>;
  listObservations(limit?: number): Promise<PartnerAffectShadowObservationsPage>;
}

export interface AdminPartnerAffectShadowDataServiceOptions {
  store: PartnerAffectShadowStorePort;
  /** Fresh policy per read so Garden edits are reflected without restart. */
  loadPolicy: () => PartnerAffectShadowPolicy;
  now?: () => number;
}

function summarizePolicy(policy: PartnerAffectShadowPolicy): PartnerAffectShadowPolicySummary {
  return {
    enabled: policy.enabled,
    partnerContactId: policy.partnerContactId,
    staleAfterMs: policy.staleAfterMs,
    evidenceWindowMs: policy.evidenceWindowMs,
    minConfidence: policy.minConfidence,
    minIndependentFamilies: policy.minIndependentFamilies,
    conflictValueTolerance: policy.conflictValueTolerance,
    allowedSignalFamilies: [...policy.allowedSignalFamilies],
    sourceCount: policy.sources.length,
    revokedSourceCount: policy.sources.filter(source => source.revoked).length,
    maxRetainedObservations: policy.maxRetainedObservations,
    policyRevision: policy.policyRevision,
  };
}

export class AdminPartnerAffectShadowDataService implements AdminPartnerAffectShadowService {
  private readonly store: PartnerAffectShadowStorePort;
  private readonly loadPolicy: () => PartnerAffectShadowPolicy;
  private readonly now: () => number;

  constructor(options: AdminPartnerAffectShadowDataServiceOptions) {
    this.store = options.store;
    this.loadPolicy = options.loadPolicy;
    this.now = options.now ?? Date.now;
  }

  async getShadowSnapshot(): Promise<PartnerAffectShadowSnapshot> {
    const policy = this.loadPolicy();
    const nowMs = this.now();
    const observations = policy.partnerContactId === null
      ? []
      : await this.store.listAccepted({
        partnerContactId: policy.partnerContactId,
        sinceMs: Math.max(0, nowMs - Math.max(policy.evidenceWindowMs, policy.staleAfterMs)),
        limit: ESTIMATE_EVIDENCE_FETCH_LIMIT,
      });
    return {
      policy: summarizePolicy(policy),
      estimate: computePartnerAffectShadowEstimate({ observations, policy, nowMs }),
    };
  }

  async listObservations(limit?: number): Promise<PartnerAffectShadowObservationsPage> {
    const boundedLimit = limit ?? DEFAULT_OBSERVATION_LIST_LIMIT;
    if (
      !Number.isSafeInteger(boundedLimit)
      || boundedLimit < 1
      || boundedLimit > MAX_OBSERVATION_LIST_LIMIT
    ) {
      throw new Error(
        `partner-affect observation list limit must be an integer in [1, ${String(MAX_OBSERVATION_LIST_LIMIT)}]`,
      );
    }
    const policy = this.loadPolicy();
    const accepted = policy.partnerContactId === null
      ? []
      : await this.store.listAccepted({
        partnerContactId: policy.partnerContactId,
        limit: boundedLimit,
      });
    const suppressed = await this.store.listSuppressed({ limit: boundedLimit });
    return { accepted, suppressed };
  }
}

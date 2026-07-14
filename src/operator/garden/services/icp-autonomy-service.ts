import type { IcpInitiationCandidateStorePort } from '../../../core/icp/autonomy-store-ports.js';
import type { IcpAutonomyRuntimeEnablement } from '../../../core/icp/runtime-enablement.js';
import type { IcpAdminProjectionStore } from '../../../persistence/postgres/icp-admin-projection-store.js';
import type { IcpAutonomyReasonCode } from '../../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { AdminSettingsService } from './types/settings.js';
import type {
  AdminIcpAutonomyData,
  AdminIcpAutonomyService,
  AdminIcpCandidateCancelInput,
  AdminIcpCandidateView,
  AdminIcpMutationResult,
  AdminIcpPermitView,
} from './types/icp-autonomy.js';

const ADMIN_ICP_LIMIT = 50;

export interface AdminIcpAutonomyServiceDependencies {
  localCompanionId?: string;
  candidateStore?: IcpInitiationCandidateStorePort | null;
  projectionStore?: IcpAdminProjectionStore | null;
  runtimeEnablement: IcpAutonomyRuntimeEnablement;
  settingsService: AdminSettingsService;
  operatorLeaseTtlMs: number;
  now?: () => number;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function projectCandidate(
  candidate: Awaited<ReturnType<IcpInitiationCandidateStorePort['getCandidate']>> & {},
): AdminIcpCandidateView {
  return {
    candidateId: candidate.candidateId,
    rootInitiationId: candidate.rootInitiationId,
    localCompanionId: candidate.localCompanionId,
    peerCompanionId: candidate.peerCompanionId,
    preferredChannel: candidate.preferredChannel,
    source: candidate.source,
    provenanceRef: candidate.provenanceRef,
    createdAtMs: candidate.createdAtMs,
    expiresAtMs: candidate.expiresAtMs,
    status: candidate.status,
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    revision: candidate.revision,
  };
}

function projectPermit({ permitId: _permitId, ...permit }: {
  permitId: string;
} & AdminIcpPermitView): AdminIcpPermitView {
  return permit;
}

function addReason(
  counts: Map<IcpAutonomyReasonCode, number>,
  reasonCode: IcpAutonomyReasonCode | undefined,
): void {
  if (reasonCode) counts.set(reasonCode, (counts.get(reasonCode) ?? 0) + 1);
}

export class AdminIcpAutonomyDataService implements AdminIcpAutonomyService {
  private readonly now: () => number;

  constructor(private readonly deps: AdminIcpAutonomyServiceDependencies) {
    this.now = deps.now ?? Date.now;
    positiveInteger(deps.operatorLeaseTtlMs, 'operatorLeaseTtlMs');
  }

  async getData(): Promise<AdminIcpAutonomyData> {
    const settings = (await this.deps.settingsService.getSettingsData()).effectiveIcpAutonomy;
    const available = Boolean(
      this.deps.localCompanionId
      && this.deps.candidateStore
      && this.deps.projectionStore,
    );
    const projection = this.deps.projectionStore
      ? await this.deps.projectionStore.readProjection(ADMIN_ICP_LIMIT)
      : { availability: [], episodes: [], permits: [], fatigue: [], costs: [] };
    const candidates = this.deps.candidateStore
      ? (await this.deps.candidateStore.listCandidates({ limit: ADMIN_ICP_LIMIT }))
        .map(projectCandidate)
      : [];
    const nowMs = this.now();
    const reasonCounts = new Map<IcpAutonomyReasonCode, number>();
    for (const candidate of candidates) addReason(reasonCounts, candidate.reasonCode);
    for (const episode of projection.episodes) addReason(reasonCounts, episode.closeReasonCode);
    for (const permit of projection.permits) addReason(reasonCounts, permit.reasonCode);

    const failureCount = candidates.filter(candidate => candidate.status === 'rejected').length
      + projection.episodes.filter(episode => episode.status === 'suppressed').length
      + projection.fatigue.reduce((sum, item) => sum + item.failedCount, 0)
      + projection.costs.filter(cost => !cost.allowed).length;
    const runtimeEnabled = this.deps.runtimeEnablement.isEnabled();
    const quietState = !runtimeEnabled
      ? 'disabled'
      : failureCount > 0
        ? 'failures_observed'
        : candidates.length === 0
          ? 'no_candidates'
          : 'active';
    const quietExplanation = quietState === 'disabled'
      ? 'Autonomous initiation is disabled in the running process.'
      : quietState === 'failures_observed'
        ? 'Recent bounded control-plane records include rejected, suppressed, failed, or denied activity.'
        : quietState === 'no_candidates'
          ? 'No local autonomous initiation candidates are recorded; quiet is not itself a failure.'
          : 'Local candidate activity is recorded; inspect machine-readable reasons and lifecycle state.';

    return {
      available,
      localCompanionId: this.deps.localCompanionId ?? null,
      runtimeEnabled,
      settings,
      availability: projection.availability.map(lease => ({
        ...lease,
        local: lease.companionId === this.deps.localCompanionId,
        current: lease.issuedAtMs <= nowMs && lease.expiresAtMs > nowMs,
      })),
      candidates,
      episodes: projection.episodes.map(episode => ({
        ...episode,
        links: {
          sessions: '/sessions',
          charges: '/charge-budget',
          modelUsage: '/models',
        },
      })),
      permits: projection.permits.map(projectPermit),
      fatigue: projection.fatigue,
      costs: projection.costs,
      reasonCounts: [...reasonCounts.entries()]
        .map(([reasonCode, count]) => ({ reasonCode, count }))
        .sort((left, right) => right.count - left.count
          || left.reasonCode.localeCompare(right.reasonCode)),
      failureCount,
      quietState,
      quietExplanation,
      redaction: {
        privateMotivation: 'withheld',
        peerContactIds: 'withheld',
        permitBearerIds: 'withheld',
        transcripts: 'not_collected',
      },
    };
  }

  async cancelCandidate(input: AdminIcpCandidateCancelInput): Promise<AdminIcpMutationResult> {
    const { candidateStore, projectionStore, localCompanionId } = this.requireControlDependencies();
    positiveInteger(input.expectedRevision, 'expectedRevision');
    const candidate = await candidateStore.getCandidate(input.candidateId);
    if (!candidate || candidate.localCompanionId !== localCompanionId) {
      throw new Error('ICP candidate not found for this companion');
    }
    if (candidate.revision !== input.expectedRevision) {
      throw new Error('ICP candidate revision conflict');
    }
    if (!['pending', 'deferred', 'permitted'].includes(candidate.status)) {
      throw new Error(`ICP candidate cannot be cancelled from ${candidate.status}`);
    }

    let revokedPermitCount = 0;
    if (candidate.status === 'permitted') {
      const permit = await projectionStore.shared.getPermitByCandidate(candidate.candidateId);
      if (!permit || permit.status !== 'issued') {
        throw new Error('ICP permitted candidate has no revocable issued permit');
      }
      await projectionStore.shared.revokePermit(
        permit.permitId,
        permit.revision,
        this.now(),
        'operator_cancelled',
      );
      revokedPermitCount = 1;
    }
    await candidateStore.transitionCandidate({
      candidateId: candidate.candidateId,
      expectedStatus: candidate.status,
      expectedRevision: candidate.revision,
      status: 'cancelled',
      reasonCode: 'operator_cancelled',
    });
    return {
      ok: true,
      revokedPermitCount,
      message: 'Candidate cancelled',
    };
  }

  async setDoNotDisturb(): Promise<AdminIcpMutationResult> {
    const { projectionStore, localCompanionId } = this.requireControlDependencies();
    const nowMs = this.now();
    const current = await projectionStore.shared.getAvailability(localCompanionId);
    const result = await projectionStore.shared.publishAvailabilityAndInvalidate({
      companionId: localCompanionId,
      state: 'do_not_disturb',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + this.deps.operatorLeaseTtlMs,
      source: 'operator',
      revision: (current?.revision ?? 0) + 1,
    }, 'peer_do_not_disturb');
    return {
      ok: true,
      revokedPermitCount: result.revokedPermits.length,
      message: 'Operator do-not-disturb lease published',
    };
  }

  async emergencyDisable(): Promise<AdminIcpMutationResult> {
    this.deps.runtimeEnablement.disable();
    const dnd = await this.setDoNotDisturb();
    const schedulerJson = this.deps.settingsService.getSubConfigJson('scheduler');
    if (!schedulerJson) throw new Error('scheduler.json is unavailable');
    const scheduler = JSON.parse(schedulerJson) as unknown;
    if (!isRecord(scheduler) || !isRecord(scheduler.icpAutonomy)) {
      throw new Error('scheduler.json does not contain canonical icpAutonomy settings');
    }
    const updated = structuredClone(scheduler);
    if (!isRecord(updated.icpAutonomy)) {
      throw new Error('scheduler.json does not contain canonical icpAutonomy settings');
    }
    updated.icpAutonomy.enabled = false;
    const saved = this.deps.settingsService.saveSubConfigJson(
      'scheduler',
      JSON.stringify(updated),
    );
    if (!saved.ok) throw new Error(saved.message);
    return {
      ok: true,
      revokedPermitCount: dnd.revokedPermitCount,
      message: 'Autonomous initiation disabled live and in scheduler.json; DND invalidated outstanding permits',
    };
  }

  async close(): Promise<void> {
    await this.deps.projectionStore?.close();
  }

  private requireControlDependencies(): {
    localCompanionId: string;
    candidateStore: IcpInitiationCandidateStorePort;
    projectionStore: IcpAdminProjectionStore;
  } {
    if (!this.deps.localCompanionId || !this.deps.candidateStore || !this.deps.projectionStore) {
      throw new Error('ICP autonomy control backend unavailable');
    }
    return {
      localCompanionId: this.deps.localCompanionId,
      candidateStore: this.deps.candidateStore,
      projectionStore: this.deps.projectionStore,
    };
  }
}

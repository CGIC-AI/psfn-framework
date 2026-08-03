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
  /**
   * Probe for ICP-eligible sibling contacts (channel='companion' +
   * machine-intelligence) in this companion's own contact store (hrmrq.34).
   * Topology-independent, so the Garden can name the missing sibling seed
   * explicitly instead of reporting an undifferentiated quiet lane.
   */
  countCompanionPeerContacts?: () => Promise<number>;
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
    if (deps.localCompanionId && deps.projectionStore
      && deps.projectionStore.localCompanionId !== deps.localCompanionId) {
      throw new Error('ICP admin projection is bound to a different companion');
    }
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
      : {
        availability: [],
        episodes: [],
        permits: [],
        fatigue: [],
        costs: [],
        costProjection: {
          available: false as const,
          unavailableReason: 'control_plane_unavailable' as const,
        },
      };
    const localCompanionId = this.deps.localCompanionId;
    const candidates = this.deps.candidateStore && localCompanionId
      ? (await this.deps.candidateStore.listCandidates({ limit: ADMIN_ICP_LIMIT }))
        .filter(candidate => candidate.localCompanionId === localCompanionId)
        .map(projectCandidate)
      : [];
    const availability = localCompanionId
      ? projection.availability.filter(lease => lease.companionId === localCompanionId)
      : [];
    const episodes = localCompanionId
      ? projection.episodes.filter(episode =>
        episode.participantCompanionIds.includes(localCompanionId))
      : [];
    const permits = localCompanionId
      ? projection.permits.filter(permit =>
        permit.senderCompanionId === localCompanionId
        || permit.recipientCompanionId === localCompanionId)
      : [];
    const fatigue = localCompanionId
      ? projection.fatigue.filter(item =>
        item.localCompanionId === localCompanionId
        || item.peerCompanionId === localCompanionId)
      : [];
    const costs = localCompanionId
      ? projection.costs
        .filter(cost => cost.participantCompanionIds.includes(localCompanionId))
        .map(({ participantCompanionIds: _participantCompanionIds, ...cost }) => cost)
      : [];
    const nowMs = this.now();
    const reasonCounts = new Map<IcpAutonomyReasonCode, number>();
    for (const candidate of candidates) addReason(reasonCounts, candidate.reasonCode);
    for (const episode of episodes) addReason(reasonCounts, episode.closeReasonCode);
    for (const permit of permits) addReason(reasonCounts, permit.reasonCode);

    const failureCount = candidates.filter(candidate => candidate.status === 'rejected').length
      + episodes.filter(episode => episode.status === 'suppressed').length
      + fatigue.reduce((sum, item) => sum + item.failedCount, 0)
      + costs.filter(cost => !cost.allowed).length;
    const runtimeEnabled = this.deps.runtimeEnablement.isEnabled();
    const companionPeerContactCount = this.deps.countCompanionPeerContacts
      ? await this.deps.countCompanionPeerContacts()
      : null;
    // Truthful per-gate attribution (hrmrq.34): 'disabled' distinguishes the
    // scheduler.json owner flag from the in-process emergency fence;
    // 'unavailable_topology' names the single-companion (or unprovisioned
    // control-plane) case instead of misattributing it to the runtime flag;
    // an empty candidate lane with zero sibling contacts names the missing
    // seed:sibling-contacts maintenance step explicitly.
    const onDiskEnabled = settings.scheduler.onDiskValue.enabled;
    const quietState = !runtimeEnabled
      ? 'disabled'
      : !available
        ? 'unavailable_topology'
        : failureCount > 0
          ? 'failures_observed'
          : candidates.length === 0
            ? 'no_candidates'
            : 'active';
    const quietExplanation = quietState === 'disabled'
      ? (onDiskEnabled
        ? 'Autonomous initiation was emergency-disabled in this running process (one-way runtime fence). '
          + 'scheduler.json still has icpAutonomy.enabled = true; restart the agent to restore autonomy.'
        : 'Autonomous initiation is disabled by scheduler.json (icpAutonomy.enabled = false). '
          + 'The capability tier may still grant it; enable the flag in Settings under the scheduler '
          + 'owner file and restart the agent.')
      : quietState === 'unavailable_topology'
        ? 'The runtime flag is enabled, but this deployment is not a multi-companion topology '
          + '(no shared ICP control plane is provisioned), so there is no companion peer to initiate toward. '
          + 'The control plane is wired but empty; multi-companion mode with at least one sibling companion is required.'
        : quietState === 'failures_observed'
          ? 'Recent bounded control-plane records include rejected, suppressed, failed, or denied activity.'
          : quietState === 'no_candidates'
            ? (companionPeerContactCount === 0
              ? 'No local autonomous initiation candidates are recorded — and no ICP-eligible sibling contact '
                + "exists (no contact carries a channel='companion' identity), so peer selection can never succeed. "
                + 'Run `npm run seed:sibling-contacts -- --apply` to seed mutual sibling contacts (bead x5t4).'
              : 'No local autonomous initiation candidates are recorded; quiet is not itself a failure.')
            : 'Local candidate activity is recorded; inspect machine-readable reasons and lifecycle state.';

    return {
      available,
      localCompanionId: this.deps.localCompanionId ?? null,
      runtimeEnabled,
      companionPeerContactCount,
      settings,
      availability: availability.map(lease => ({
        ...lease,
        local: lease.companionId === this.deps.localCompanionId,
        current: lease.issuedAtMs <= nowMs && lease.expiresAtMs > nowMs,
      })),
      candidates,
      episodes: episodes.map(episode => ({
        ...episode,
        links: {
          sessions: '/sessions',
          charges: '/charge-budget',
          modelUsage: '/models',
        },
      })),
      permits: permits.map(projectPermit),
      fatigue,
      costs,
      costProjection: projection.costProjection,
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
      if (!permit) {
        throw new Error('ICP permitted candidate has no durable permit');
      }
      if (permit.status === 'consumed') {
        throw new Error('ICP permitted candidate permit was already consumed');
      }
      if (permit.status === 'issued') {
        await projectionStore.shared.revokePermit(
          permit.permitId,
          permit.revision,
          this.now(),
          'operator_cancelled',
        );
        revokedPermitCount = 1;
      }
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
    const saved = await this.deps.settingsService.saveSubConfigJson(
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

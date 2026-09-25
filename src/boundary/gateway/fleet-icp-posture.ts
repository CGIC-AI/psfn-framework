import {
  MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  type IcpAvailabilityState,
} from '../../shared/contracts/icp-autonomy.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { IcpFleetHealthRead, IcpFleetHealthReadPort } from '../../persistence/postgres/icp-fleet-health-reader.js';
import type { GatewayFleetConnectionSnapshot } from './server/companion-violations.js';

/**
 * Bounded, authorization-safe ICP posture for the Fleet page (h248l.4).
 *
 * Rendering is passive: posture derives from the gateway's own connection
 * table, a process-local record of companion-local policy RPC outcomes, and
 * one content-free shared-schema read. It never triggers adjudication, never
 * opens a tenant schema, and never emits pair trust/block decisions,
 * candidate/permit IDs, raw reasons, or participant identities.
 */
const FLEET_ICP_POSTURE_PROTOCOL = Object.freeze({
  /** Wire vocabulary: `deliveredTurns24h` is always this trailing window. */
  activityWindowMs: 24 * 60 * 60_000,
});

type FleetIcpClusterState = 'inactive_singleton' | 'starting' | 'ready' | 'degraded';

export type FleetIcpCompanionPosture =
  | Readonly<{ state: 'ready'; reason: IcpAvailabilityState; lifecycle: 'member' }>
  | Readonly<{ state: 'offline'; reason: 'agent_disconnected' | 'agent_starting'; lifecycle: 'member' }>
  | Readonly<{
    state: 'policy_unavailable';
    reason: 'policy_authority_failed' | 'availability_withdrawn' | 'coordination_state_unavailable';
    lifecycle: 'member';
  }>
  | Readonly<{ state: 'not_applicable'; reason: 'singleton_fleet'; lifecycle: 'member' }>
  | Readonly<{ state: 'not_applicable'; reason: 'lifecycle_draining'; lifecycle: 'draining' }>;

type FleetIcpActivity =
  | Readonly<{ status: 'not_applicable' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
    status: 'available';
    activeChannels: number;
    activeChannelsTruncated: boolean;
    deliveredTurns24h: number;
    readyPairs: number;
  }>;

export interface FleetIcpClusterProjection {
  readonly state: FleetIcpClusterState;
  readonly activity: FleetIcpActivity;
}

/** Fleet-wide internal snapshot; never serialized directly. */
export interface FleetIcpPostureSnapshot {
  readonly cluster: FleetIcpClusterState;
  readonly companions: ReadonlyMap<string, FleetIcpCompanionPosture>;
  readonly health: IcpFleetHealthRead | 'unavailable' | 'not_applicable';
}

export interface FleetIcpPostureSource {
  snapshot(input: {
    readonly nowMs: number;
    readonly connections: GatewayFleetConnectionSnapshot;
  }): Promise<FleetIcpPostureSnapshot>;
}

interface PolicyOutcome {
  lastSuccessMs?: number;
  lastFailureMs?: number;
}

/**
 * Process-local record of companion-local ICP policy RPC outcomes. Bounded to
 * the fleet roster; unknown companions are ignored rather than accumulated.
 */
export class IcpPolicyOutcomeRecorder {
  private readonly outcomes = new Map<string, PolicyOutcome>();

  constructor(private readonly fleetCompanionIds: ReadonlySet<string>) {}

  recordSuccess(companionId: string, nowMs: number): void {
    if (!this.fleetCompanionIds.has(companionId)) return;
    const outcome = this.outcomes.get(companionId) ?? {};
    outcome.lastSuccessMs = nowMs;
    this.outcomes.set(companionId, outcome);
  }

  recordFailure(companionId: string, nowMs: number): void {
    if (!this.fleetCompanionIds.has(companionId)) return;
    const outcome = this.outcomes.get(companionId) ?? {};
    outcome.lastFailureMs = nowMs;
    this.outcomes.set(companionId, outcome);
  }

  /**
   * A failure is current until a later success, until the agent reconnects
   * (a fresh connection supersedes failures against the old one), or until it
   * ages out.
   */
  isFailing(companionId: string, nowMs: number, connectedAtMs: number): boolean {
    const outcome = this.outcomes.get(companionId);
    if (outcome?.lastFailureMs === undefined) return false;
    if (outcome.lastFailureMs < connectedAtMs) return false;
    if (outcome.lastSuccessMs !== undefined && outcome.lastSuccessMs >= outcome.lastFailureMs) {
      return false;
    }
    return nowMs - outcome.lastFailureMs <= MAX_ICP_AVAILABILITY_LEASE_TTL_MS;
  }

  /** Wrap one companion-local authority request so its outcome is recorded. */
  observe<T>(companionId: string, now: () => number, request: () => Promise<T>): Promise<T> {
    return request().then(
      (value) => {
        this.recordSuccess(companionId, now());
        return value;
      },
      (error: unknown) => {
        this.recordFailure(companionId, now());
        throw error;
      },
    );
  }
}

const SINGLETON: FleetIcpCompanionPosture = Object.freeze({
  state: 'not_applicable', reason: 'singleton_fleet', lifecycle: 'member',
});
const DRAINING: FleetIcpCompanionPosture = Object.freeze({
  state: 'not_applicable', reason: 'lifecycle_draining', lifecycle: 'draining',
});

export function deriveFleetIcpPosture(input: {
  readonly fleetCompanionIds: readonly string[];
  readonly icpActive: boolean;
  readonly health: IcpFleetHealthRead | 'unavailable';
  readonly connections: GatewayFleetConnectionSnapshot;
  readonly policyOutcomes: Pick<IcpPolicyOutcomeRecorder, 'isFailing'>;
  readonly nowMs: number;
}): FleetIcpPostureSnapshot {
  const companions = new Map<string, FleetIcpCompanionPosture>();
  const fenced = input.health === 'unavailable'
    ? new Set<string>()
    : input.health.lifecycleFenced;
  const participants = input.fleetCompanionIds.filter(id => !fenced.has(id));
  if (!input.icpActive || participants.length < 2) {
    for (const id of input.fleetCompanionIds) {
      companions.set(id, fenced.has(id) ? DRAINING : SINGLETON);
    }
    return Object.freeze({
      cluster: 'inactive_singleton',
      companions,
      health: 'not_applicable',
    });
  }
  const connectionById = new Map<string, GatewayFleetConnectionSnapshot['connections'][number]>(
    input.connections.connections.map(connection => [connection.companionId, connection]),
  );
  for (const id of input.fleetCompanionIds) {
    if (fenced.has(id)) {
      companions.set(id, DRAINING);
      continue;
    }
    const connection = connectionById.get(id);
    if (!connection || connection.state === 'registering') {
      const everSeen = Object.hasOwn(input.connections.lastSeenByCompanionId, id);
      companions.set(id, Object.freeze({
        state: 'offline',
        reason: connection || !everSeen ? 'agent_starting' : 'agent_disconnected',
        lifecycle: 'member',
      }));
      continue;
    }
    if (input.health === 'unavailable') {
      companions.set(id, Object.freeze({
        state: 'policy_unavailable', reason: 'coordination_state_unavailable', lifecycle: 'member',
      }));
      continue;
    }
    if (input.policyOutcomes.isFailing(id, input.nowMs, connection.connectedAt)) {
      companions.set(id, Object.freeze({
        state: 'policy_unavailable', reason: 'policy_authority_failed', lifecycle: 'member',
      }));
      continue;
    }
    const lease = input.health.availability.get(id);
    if (!lease || lease.expiresAtMs <= input.nowMs) {
      companions.set(id, Object.freeze({
        state: 'policy_unavailable', reason: 'availability_withdrawn', lifecycle: 'member',
      }));
      continue;
    }
    companions.set(id, Object.freeze({ state: 'ready', reason: lease.state, lifecycle: 'member' }));
  }
  const participantPostures = participants.map(id => companions.get(id)!);
  let cluster: FleetIcpClusterState;
  if (participantPostures.every(posture => posture.state === 'ready')) {
    cluster = 'ready';
  } else if (participantPostures.every(posture => posture.state === 'ready'
    || (posture.state === 'offline' && posture.reason === 'agent_starting'))) {
    cluster = 'starting';
  } else {
    cluster = 'degraded';
  }
  return Object.freeze({ cluster, companions, health: input.health });
}

/**
 * Narrows a fleet-wide snapshot to one principal's visible companions. The
 * coarse cluster state is fleet-level by design (Fleet is the one surface that
 * may aggregate); every count covers only channels and pairs whose members are
 * all visible, so hidden companions and relationships are not enumerable.
 */
export function projectFleetIcpCluster(
  snapshot: FleetIcpPostureSnapshot,
  visibleCompanionIds: readonly string[],
): FleetIcpClusterProjection {
  if (snapshot.health === 'not_applicable') {
    return Object.freeze({ state: snapshot.cluster, activity: Object.freeze({ status: 'not_applicable' }) });
  }
  if (snapshot.health === 'unavailable') {
    return Object.freeze({ state: snapshot.cluster, activity: Object.freeze({ status: 'unavailable' }) });
  }
  const visible = new Set(visibleCompanionIds);
  const activeChannels = snapshot.health.openEpisodes.filter(episode => (
    episode.participantCompanionIds.every(id => visible.has(id))
  )).length;
  let deliveredTurns24h = 0;
  for (const pair of snapshot.health.pairVolume) {
    if (visible.has(pair.firstCompanionId) && visible.has(pair.secondCompanionId)) {
      deliveredTurns24h += pair.deliveredTurns;
    }
  }
  const readyVisible = visibleCompanionIds.filter(id => snapshot.companions.get(id)?.state === 'ready').length;
  return Object.freeze({
    state: snapshot.cluster,
    activity: Object.freeze({
      status: 'available',
      activeChannels,
      activeChannelsTruncated: snapshot.health.openEpisodesTruncated,
      deliveredTurns24h,
      readyPairs: (readyVisible * (readyVisible - 1)) / 2,
    }),
  });
}

export class GatewayFleetIcpPostureSource implements FleetIcpPostureSource {
  private readonly fleetCompanionIds: readonly string[];
  private inFlight: Promise<IcpFleetHealthRead | 'unavailable'> | null = null;

  constructor(private readonly options: {
    readonly fleetCompanionIds: readonly string[];
    /** True only when the gateway owns a live ICP control plane (multi-companion). */
    readonly icpActive: boolean;
    readonly reader?: IcpFleetHealthReadPort;
    readonly policyOutcomes: Pick<IcpPolicyOutcomeRecorder, 'isFailing'>;
    readonly reportReadFailure: (error: unknown) => void;
  }) {
    if (options.fleetCompanionIds.length === 0
      || options.fleetCompanionIds.some(id => !isRfc4122Uuid(id))
      || new Set(options.fleetCompanionIds).size !== options.fleetCompanionIds.length) {
      throw new Error('Fleet ICP posture requires a valid non-empty roster');
    }
    if (options.icpActive && !options.reader) {
      throw new Error('Fleet ICP posture requires the shared health reader when ICP is active');
    }
    this.fleetCompanionIds = Object.freeze([...options.fleetCompanionIds].sort());
  }

  async snapshot(input: {
    readonly nowMs: number;
    readonly connections: GatewayFleetConnectionSnapshot;
  }): Promise<FleetIcpPostureSnapshot> {
    const health = this.options.icpActive && this.fleetCompanionIds.length >= 2
      ? await this.readShared(input.nowMs)
      : 'unavailable';
    return deriveFleetIcpPosture({
      fleetCompanionIds: this.fleetCompanionIds,
      icpActive: this.options.icpActive,
      health: this.options.icpActive ? health : 'unavailable',
      connections: input.connections,
      policyOutcomes: this.options.policyOutcomes,
      nowMs: input.nowMs,
    });
  }

  /** Concurrent portal requests share one bounded shared-schema read. */
  private async readShared(nowMs: number): Promise<IcpFleetHealthRead | 'unavailable'> {
    if (this.inFlight) return await this.inFlight;
    const reader = this.options.reader!;
    this.inFlight = reader.read({
      companionIds: this.fleetCompanionIds,
      nowMs,
      deliveredSinceMs: nowMs - FLEET_ICP_POSTURE_PROTOCOL.activityWindowMs,
    }).catch((error: unknown) => {
      this.options.reportReadFailure(error);
      return 'unavailable' as const;
    }).finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }
}

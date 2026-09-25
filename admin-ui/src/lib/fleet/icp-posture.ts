import { hasExactKeys, isRecord } from '../../../../src/shared/utils/types.js';

/**
 * Strict client mirror of the gateway's bounded Fleet ICP posture (h248l.4).
 * Every field is a closed enum or a non-negative count; anything wider is a
 * protocol violation and fails the whole projection closed.
 */
type FleetIcpClusterState = 'inactive_singleton' | 'starting' | 'ready' | 'degraded';
export type FleetIcpTone = 'good' | 'warn' | 'bad' | 'neutral';

const AVAILABILITY_REASONS = ['available', 'open_to_chat', 'busy', 'resting', 'do_not_disturb'] as const;
const OFFLINE_REASONS = ['agent_disconnected', 'agent_starting'] as const;
const POLICY_REASONS = [
  'policy_authority_failed',
  'availability_withdrawn',
  'coordination_state_unavailable',
] as const;
const CLUSTER_STATES = ['inactive_singleton', 'starting', 'ready', 'degraded'] as const;
const MAX_ICP_COUNT = 1_000_000_000;

export type FleetIcpCompanionPosture =
  | { state: 'ready'; reason: typeof AVAILABILITY_REASONS[number]; lifecycle: 'member' }
  | { state: 'offline'; reason: typeof OFFLINE_REASONS[number]; lifecycle: 'member' }
  | { state: 'policy_unavailable'; reason: typeof POLICY_REASONS[number]; lifecycle: 'member' }
  | { state: 'not_applicable'; reason: 'singleton_fleet'; lifecycle: 'member' }
  | { state: 'not_applicable'; reason: 'lifecycle_draining'; lifecycle: 'draining' };

type FleetIcpActivity =
  | { status: 'not_applicable' }
  | { status: 'unavailable' }
  | {
      status: 'available';
      activeChannels: number;
      activeChannelsTruncated: boolean;
      deliveredTurns24h: number;
      readyPairs: number;
    };

export interface FleetIcpCluster {
  state: FleetIcpClusterState;
  activity: FleetIcpActivity;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_ICP_COUNT) {
    throw new Error('Cluster portal returned an invalid ICP count');
  }
  return value as number;
}

export function parseFleetIcpCompanion(value: unknown): FleetIcpCompanionPosture {
  if (!isRecord(value) || !hasExactKeys(value, ['state', 'reason', 'lifecycle'])) {
    throw new Error('Cluster portal returned an invalid ICP posture');
  }
  const { state, reason, lifecycle } = value;
  if (state === 'ready' && lifecycle === 'member' && oneOf(reason, AVAILABILITY_REASONS)) {
    return { state, reason, lifecycle };
  }
  if (state === 'offline' && lifecycle === 'member' && oneOf(reason, OFFLINE_REASONS)) {
    return { state, reason, lifecycle };
  }
  if (state === 'policy_unavailable' && lifecycle === 'member' && oneOf(reason, POLICY_REASONS)) {
    return { state, reason, lifecycle };
  }
  if (state === 'not_applicable' && reason === 'singleton_fleet' && lifecycle === 'member') {
    return { state, reason, lifecycle };
  }
  if (state === 'not_applicable' && reason === 'lifecycle_draining' && lifecycle === 'draining') {
    return { state, reason, lifecycle };
  }
  throw new Error('Cluster portal returned an invalid ICP posture');
}

export function parseFleetIcpCluster(value: unknown): FleetIcpCluster {
  if (!isRecord(value)
    || !hasExactKeys(value, ['state', 'activity'])
    || !oneOf(value.state, CLUSTER_STATES)
    || !isRecord(value.activity)) {
    throw new Error('Cluster portal returned an invalid ICP cluster posture');
  }
  const activity = value.activity;
  if (activity.status === 'not_applicable' || activity.status === 'unavailable') {
    if (!hasExactKeys(activity, ['status'])) {
      throw new Error('Cluster portal ICP activity was widened');
    }
    return { state: value.state, activity: { status: activity.status } };
  }
  if (activity.status !== 'available'
    || !hasExactKeys(activity, [
      'status',
      'activeChannels',
      'activeChannelsTruncated',
      'deliveredTurns24h',
      'readyPairs',
    ])
    || typeof activity.activeChannelsTruncated !== 'boolean') {
    throw new Error('Cluster portal returned invalid ICP activity');
  }
  return {
    state: value.state,
    activity: {
      status: 'available',
      activeChannels: count(activity.activeChannels),
      activeChannelsTruncated: activity.activeChannelsTruncated,
      deliveredTurns24h: count(activity.deliveredTurns24h),
      readyPairs: count(activity.readyPairs),
    },
  };
}

const COMPANION_REASON_LABELS: Readonly<Record<FleetIcpCompanionPosture['reason'], string>> = {
  available: 'Available',
  open_to_chat: 'Open to chat',
  busy: 'Busy',
  resting: 'Resting',
  do_not_disturb: 'Do not disturb',
  agent_disconnected: 'Agent disconnected',
  agent_starting: 'Agent starting',
  policy_authority_failed: 'Local policy authority not answering',
  availability_withdrawn: 'No current availability lease',
  coordination_state_unavailable: 'Shared coordination state unreadable',
  singleton_fleet: 'Only one companion in the fleet',
  lifecycle_draining: 'Being removed from the fleet',
};

export function describeFleetIcpCompanion(posture: FleetIcpCompanionPosture): {
  label: string;
  detail: string;
  tone: FleetIcpTone;
} {
  const detail = COMPANION_REASON_LABELS[posture.reason];
  switch (posture.state) {
    case 'ready':
      return { label: 'ICP Ready', detail, tone: 'good' };
    case 'offline':
      return {
        label: 'ICP Offline',
        detail,
        tone: posture.reason === 'agent_starting' ? 'warn' : 'bad',
      };
    case 'policy_unavailable':
      return { label: 'ICP Policy unavailable', detail, tone: 'bad' };
    case 'not_applicable':
      return {
        label: posture.lifecycle === 'draining' ? 'ICP Draining' : 'ICP Not applicable',
        detail,
        tone: 'neutral',
      };
  }
}

const CLUSTER_LABELS: Readonly<Record<FleetIcpClusterState, { label: string; tone: FleetIcpTone }>> = {
  inactive_singleton: { label: 'Inactive (single companion)', tone: 'neutral' },
  starting: { label: 'Starting', tone: 'warn' },
  ready: { label: 'Ready', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'bad' },
};

export function describeFleetIcpCluster(cluster: FleetIcpCluster): { label: string; tone: FleetIcpTone } {
  return CLUSTER_LABELS[cluster.state];
}

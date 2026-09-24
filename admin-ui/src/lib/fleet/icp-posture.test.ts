import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  describeFleetIcpCluster,
  describeFleetIcpCompanion,
  parseFleetIcpCluster,
  parseFleetIcpCompanion,
} from './icp-posture';

describe('Fleet ICP posture client contract', () => {
  it('accepts every cluster state and bounded activity shape', () => {
    for (const state of ['inactive_singleton', 'starting', 'ready', 'degraded'] as const) {
      expect(parseFleetIcpCluster({ state, activity: { status: 'unavailable' } }).state).toBe(state);
    }
    expect(parseFleetIcpCluster({
      state: 'ready',
      activity: {
        status: 'available',
        activeChannels: 2,
        activeChannelsTruncated: false,
        deliveredTurns24h: 14,
        readyPairs: 1,
      },
    }).activity).toEqual({
      status: 'available',
      activeChannels: 2,
      activeChannelsTruncated: false,
      deliveredTurns24h: 14,
      readyPairs: 1,
    });
  });

  it('rejects widened, unknown, or negative ICP data', () => {
    expect(() => parseFleetIcpCluster({ state: 'federated', activity: { status: 'unavailable' } }))
      .toThrow(/ICP cluster/u);
    expect(() => parseFleetIcpCluster({
      state: 'ready', activity: { status: 'not_applicable', pairs: [] },
    })).toThrow(/widened/u);
    expect(() => parseFleetIcpCluster({
      state: 'ready',
      activity: {
        status: 'available',
        activeChannels: -1,
        activeChannelsTruncated: false,
        deliveredTurns24h: 0,
        readyPairs: 0,
      },
    })).toThrow(/count/u);
    expect(() => parseFleetIcpCluster({
      state: 'ready',
      activity: {
        status: 'available',
        activeChannels: 0,
        activeChannelsTruncated: false,
        deliveredTurns24h: 0,
        readyPairs: 0,
        participantIds: [],
      },
    })).toThrow(/activity/u);
    for (const invalid of [
      { state: 'ready', reason: 'trusted', lifecycle: 'member' },
      { state: 'offline', reason: 'available', lifecycle: 'member' },
      { state: 'not_applicable', reason: 'lifecycle_draining', lifecycle: 'member' },
      { state: 'policy_unavailable', reason: 'policy_authority_failed', lifecycle: 'member', raw: 'x' },
    ]) {
      expect(() => parseFleetIcpCompanion(invalid)).toThrow(/ICP posture/u);
    }
  });

  it('maps missing availability to explicit ready/offline/policy-unavailable labels', () => {
    expect(describeFleetIcpCompanion(parseFleetIcpCompanion({
      state: 'policy_unavailable', reason: 'availability_withdrawn', lifecycle: 'member',
    }))).toEqual({
      label: 'ICP Policy unavailable', detail: 'No current availability lease', tone: 'bad',
    });
    expect(describeFleetIcpCompanion(parseFleetIcpCompanion({
      state: 'offline', reason: 'agent_starting', lifecycle: 'member',
    }))).toMatchObject({ label: 'ICP Offline', tone: 'warn' });
    expect(describeFleetIcpCompanion(parseFleetIcpCompanion({
      state: 'ready', reason: 'do_not_disturb', lifecycle: 'member',
    }))).toMatchObject({ label: 'ICP Ready', detail: 'Do not disturb' });
    expect(describeFleetIcpCompanion(parseFleetIcpCompanion({
      state: 'not_applicable', reason: 'lifecycle_draining', lifecycle: 'draining',
    }))).toMatchObject({ label: 'ICP Draining' });
    expect(describeFleetIcpCluster({ state: 'degraded', activity: { status: 'unavailable' } }))
      .toEqual({ label: 'Degraded', tone: 'bad' });
  });

  it('renders the ICP panel on the Fleet info view with human-readable names', () => {
    const page = readFileSync(new URL('../../routes/fleet/+page.svelte', import.meta.url), 'utf8');
    expect(page).toContain('<FleetIcpPosture {projection} />');
    const panel = readFileSync(
      new URL('../components/fleet/FleetIcpPosture.svelte', import.meta.url),
      'utf8',
    );
    for (const required of [
      'companion.displayName',
      'Active channels',
      'Messages (24h)',
      'Ready pairs',
      'describeFleetIcpCompanion(companion.icp)',
    ]) {
      expect(panel).toContain(required);
    }
  });
});

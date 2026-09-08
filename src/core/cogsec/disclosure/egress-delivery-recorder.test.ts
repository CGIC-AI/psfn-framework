// The recorder seam (psfn-framework-ccgdz.6): posture comes from the existing
// CogSec mode with no second switch, ownership binds one row to one companion,
// and a failed write is reported rather than swallowed.

import { describe, expect, it, vi } from 'vitest';

import { EgressDeliveryRecorder } from './egress-delivery-recorder.js';
import { egressContentSha256, type EgressDeliveryRecord } from './egress-delivery-record.js';
import type { CogSecMode } from '../../../shared/contracts/cogsec-mode.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const COMPANION_A = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const COMPANION_B = '9a8b7c66-1d2e-4f3a-8b9c-0d1e2f3a4b5c';

function fakeStore() {
  const rows: EgressDeliveryRecord[] = [];
  return {
    rows,
    port: {
      record: vi.fn(async (record: EgressDeliveryRecord) => {
        rows.push(record);
        return 'recorded' as const;
      }),
      getByDeliveryRef: async () => null,
      listByGenerationContextRef: async () => [],
      close: async () => {},
    },
  };
}

const baseRequest = {
  surface: 'social_reply' as const,
  disposition: 'released' as const,
  turnId: TURN_ID,
  attemptRef: 'discord-event-77',
  contentSha256: egressContentSha256('hello room'),
  destination: { kind: 'public_room' as const, channelId: 'discord:room-1' },
  proof: {
    custodySnapshotRef: `turn:${TURN_ID}`,
    sourceCount: 2,
    hasUnclassifiedSource: false,
    classification: 'auto_shareable' as const,
    effectiveSensitivity: 'public' as const,
  },
  decisionAllowed: true,
};

describe('EgressDeliveryRecorder', () => {
  it('derives the posture from the CogSec mode, with no second switch', () => {
    let mode: CogSecMode = 'shadow';
    const recorder = new EgressDeliveryRecorder({
      store: fakeStore().port,
      getCogSecMode: () => mode,
    });
    expect(recorder.enforcementPosture()).toBe('shadow');
    mode = 'boundary';
    expect(recorder.enforcementPosture()).toBe('enforce');
    mode = 'strict';
    expect(recorder.enforcementPosture()).toBe('enforce');
  });

  it('binds each row to exactly one companion, so routing never mixes them', async () => {
    const storeA = fakeStore();
    const storeB = fakeStore();
    const recorderA = new EgressDeliveryRecorder({
      store: storeA.port,
      companionId: COMPANION_A,
      getCogSecMode: () => 'boundary',
      now: () => 1_800_000_000_000,
    });
    const recorderB = new EgressDeliveryRecorder({
      store: storeB.port,
      companionId: COMPANION_B,
      getCogSecMode: () => 'boundary',
      now: () => 1_800_000_000_000,
    });
    // Two companions replying to the SAME room event on the same turn id: the
    // delivery keys collide by construction, so only ownership separates them.
    await recorderA.record(baseRequest);
    await recorderB.record(baseRequest);
    expect(storeA.rows[0]?.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
    expect(storeB.rows[0]?.owner).toEqual({ kind: 'companion', companionId: COMPANION_B });
    expect(storeA.rows[0]?.deliveryRef).toBe(storeB.rows[0]?.deliveryRef);
  });

  it('records a runtime with no resolvable companion as system-owned', async () => {
    const store = fakeStore();
    const recorder = new EgressDeliveryRecorder({
      store: store.port,
      companionId: 'not-a-uuid',
      getCogSecMode: () => 'boundary',
    });
    await recorder.record(baseRequest);
    expect(store.rows[0]?.owner).toEqual({ kind: 'system' });
  });

  it('defaults the outcome to the lineage\'s own classification', async () => {
    const store = fakeStore();
    const recorder = new EgressDeliveryRecorder({
      store: store.port,
      getCogSecMode: () => 'boundary',
    });
    await recorder.record(baseRequest);
    expect(store.rows[0]?.outcome).toBe('auto_shareable');
  });

  it('reports a failed write instead of throwing or claiming success', async () => {
    const store = fakeStore();
    store.port.record.mockRejectedValueOnce(new Error('connection terminated'));
    const recorder = new EgressDeliveryRecorder({
      store: store.port,
      getCogSecMode: () => 'boundary',
    });
    const result = await recorder.record(baseRequest);
    expect(result.written).toBe(false);
    // The record was built (so the caller can see what would have been stored)
    // even though nothing durable exists.
    expect(result.record?.turnId).toBe(TURN_ID);
  });

  it('reports an unbuildable record rather than writing a malformed one', async () => {
    const store = fakeStore();
    const recorder = new EgressDeliveryRecorder({
      store: store.port,
      getCogSecMode: () => 'boundary',
    });
    const result = await recorder.record({
      ...baseRequest,
      disposition: 'held',
      decisionAllowed: false,
    });
    expect(result.written).toBe(false);
    expect(result.record).toBeNull();
    expect(store.port.record).not.toHaveBeenCalled();
  });
});

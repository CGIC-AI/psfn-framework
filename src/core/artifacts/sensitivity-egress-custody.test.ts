// Chain of custody on the artifact (files and images) egress surface
// (psfn-framework-ccgdz.6). Outward file egress carries the same requirement as
// text: an unprovable share is not an operator decision, it is a chain that
// does not exist, so it is held before the approval queue ever sees it.

import { describe, expect, it, vi } from 'vitest';

import { authorizeArtifactEgress, authorizeRecoveredArtifactEgress } from './sensitivity-egress.js';
import { classifyArtifactSensitivity } from '../../shared/contracts/artifact-sensitivity.js';
import { EgressDeliveryRecorder } from '../cogsec/disclosure/index.js';
import type {
  EgressDeliveryRecord,
  TurnEgressCustodyProof,
} from '../cogsec/disclosure/egress-delivery-record.js';
import { createApprovalQueuePortFromConfirmationQueue } from '../../system/capabilities/approval-queue-port.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import type { CogSecMode } from '../../shared/contracts/cogsec-mode.js';
import type { Attachment } from '../../shared/contracts/runtime.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const COMPANION_A = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const ROOM_CHANNEL = 'discord:public-room';

const attachment: Attachment = {
  url: 'https://images.example.test/art.png',
  contentType: 'image/png',
  name: 'art.png',
  localPath: '/workspace/images/art.png',
};

const publicClassification = classifyArtifactSensitivity(
  [{ ref: 'memory:public-note', sensitivity: 'public' }],
  new Date('2026-07-16T12:00:00.000Z'),
);

const PROVEN: TurnEgressCustodyProof = {
  custodySnapshotRef: `turn:${TURN_ID}`,
  sourceCount: 2,
  hasUnclassifiedSource: false,
  classification: 'auto_shareable',
  effectiveSensitivity: 'public',
};

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

function custodyDeps(input: {
  store: ReturnType<typeof fakeStore>;
  proof: TurnEgressCustodyProof | undefined;
  mode: CogSecMode;
}) {
  return {
    recorder: new EgressDeliveryRecorder({
      store: input.store.port,
      companionId: COMPANION_A,
      getCogSecMode: () => input.mode,
      now: () => 1_800_000_000_000,
    }),
    turnId: TURN_ID,
    proof: input.proof,
    resolveChannel: () => ({ channelPrivacy: 'public', broadcast: false }),
  };
}

describe('artifact egress custody', () => {
  it('records an outward file share against the turn\'s custody snapshot', async () => {
    const store = fakeStore();
    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification: publicClassification,
      destination: {
        audience: 'external',
        channelId: ROOM_CHANNEL,
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({ store, proof: PROVEN, mode: 'boundary' }),
      },
    });

    expect(decision.disposition).toBe('proceed');
    const [row] = store.rows;
    expect(row?.surface).toBe('artifact_share');
    expect(row?.disposition).toBe('released');
    expect(row?.custodySnapshotRef).toBe(`turn:${TURN_ID}`);
    expect(row?.destination?.kind).toBe('public_room');
    expect(row?.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
    // The payload identity is a digest, never a path or a file name.
    expect(JSON.stringify(row)).not.toContain('art.png');
    expect(JSON.stringify(row)).not.toContain('/workspace');
  });

  it('holds an outward image share whose turn has no custody snapshot', async () => {
    const store = fakeStore();
    const queue = new ConfirmationQueue({ idFactory: () => 'artifact-approval-1' });
    const notify = vi.fn(async () => ({ messageId: 'notice-1' }));
    const executeApprovedShare = vi.fn(async () => {});

    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification: publicClassification,
      destination: {
        audience: 'external',
        channelId: ROOM_CHANNEL,
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        approvalQueue: createApprovalQueuePortFromConfirmationQueue(queue),
        notifier: { notify } as never,
        executeApprovedShare,
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({
          store,
          proof: { ...PROVEN, custodySnapshotRef: undefined },
          mode: 'strict',
        }),
      },
    });

    expect(decision).toEqual({
      disposition: 'held',
      attachments: [],
      holdReason: 'custody_snapshot_missing',
    });
    // Held BEFORE the approval queue: an unprovable share is not something an
    // operator could meaningfully approve.
    expect(queue.listPending()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(executeApprovedShare).not.toHaveBeenCalled();
    expect(store.rows[0]?.disposition).toBe('held');
  });

  it('observes the same gap under a shadow posture and still shares', async () => {
    const store = fakeStore();
    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification: publicClassification,
      destination: {
        audience: 'external',
        channelId: ROOM_CHANNEL,
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({ store, proof: undefined, mode: 'shadow' }),
      },
    });

    expect(decision.disposition).toBe('proceed');
    expect(store.rows[0]?.disposition).toBe('released');
    expect(store.rows[0]?.holdReason).toBe('lineage_missing');
  });

  it('leaves self and primary-contact delivery untouched', async () => {
    const store = fakeStore();
    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification: publicClassification,
      destination: {
        audience: 'primary_contact',
        channelId: 'discord:dm-v',
        channelType: 'discord',
        surface: 'conversation',
      },
      deps: {
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({ store, proof: undefined, mode: 'strict' }),
      },
    });

    expect(decision).toEqual({ disposition: 'proceed', attachments: [attachment] });
    expect(store.rows).toHaveLength(0);
  });

  it('re-checks a recovered turn against this run\'s proof, not the interrupted one', async () => {
    const store = fakeStore();
    const decision = await authorizeRecoveredArtifactEgress({
      attachments: [attachment],
      destination: {
        audience: 'external',
        channelId: ROOM_CHANNEL,
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({ store, proof: undefined, mode: 'boundary' }),
      },
    });

    expect(decision).toEqual({
      disposition: 'held',
      attachments: [],
      holdReason: 'lineage_missing',
    });
  });

  it('holds when the delivery record itself cannot be written', async () => {
    const store = fakeStore();
    store.port.record.mockRejectedValueOnce(new Error('connection terminated'));
    const executeApprovedShare = vi.fn(async () => {});

    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification: publicClassification,
      destination: {
        audience: 'external',
        channelId: ROOM_CHANNEL,
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        executeApprovedShare,
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({ store, proof: PROVEN, mode: 'boundary' }),
      },
    });

    expect(decision).toEqual({
      disposition: 'held',
      attachments: [],
      holdReason: 'custody_store_unavailable',
    });
    expect(executeApprovedShare).not.toHaveBeenCalled();
  });
});

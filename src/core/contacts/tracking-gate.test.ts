import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFilePendingContactApprovalStore,
  type PendingContactApprovalStore,
} from './pending-contact-approvals.js';
import {
  createContactTrackingGate,
  resolveContactTrackingMode,
} from './tracking-gate.js';

const APPROVAL_CHANNEL = 'discord:big-room';
const ROLE_GATED_CHANNEL = 'discord:reserved-room';

const CHANNEL_LABELS = {
  [APPROVAL_CHANNEL]: { contactTracking: 'approval' as const },
  [ROLE_GATED_CHANNEL]: { contactTracking: 'role_gated' as const },
  'discord:friends-room': { contactTracking: 'auto' as const },
};

describe('resolveContactTrackingMode', () => {
  it('defaults to auto when no labels exist', () => {
    expect(resolveContactTrackingMode(undefined, 'discord:anywhere')).toBe('auto');
    expect(resolveContactTrackingMode({}, 'discord:anywhere')).toBe('auto');
  });

  it('defaults to auto for channels without a label', () => {
    expect(resolveContactTrackingMode(CHANNEL_LABELS, 'discord:unlabeled')).toBe('auto');
  });

  it('reads the exact channel-id label', () => {
    expect(resolveContactTrackingMode(CHANNEL_LABELS, APPROVAL_CHANNEL)).toBe('approval');
    expect(resolveContactTrackingMode(CHANNEL_LABELS, 'discord:friends-room')).toBe('auto');
    expect(resolveContactTrackingMode(CHANNEL_LABELS, ROLE_GATED_CHANNEL)).toBe('role_gated');
  });
});

describe('createContactTrackingGate', () => {
  let tempDir: string;
  let pendingApprovals: PendingContactApprovalStore;
  let notify: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-tracking-gate-'));
    pendingApprovals = createFilePendingContactApprovalStore(join(tempDir, 'pending.json'));
    notify = vi.fn().mockResolvedValue(undefined);
    warn = vi.fn();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeGate() {
    return createContactTrackingGate({
      channelLabels: CHANNEL_LABELS,
      pendingApprovals,
      notifyOperatorPendingContact: notify,
      logger: { warn },
    });
  }

  function makeSighting(overrides: Partial<Parameters<ReturnType<typeof makeGate>['reportUntrackedSpeaker']>[0]> = {}) {
    return {
      channel: 'discord',
      channelUserId: 'user-42',
      displayName: 'vtubegooner69',
      channelId: APPROVAL_CHANNEL,
      messageId: 'msg-1',
      messagePreview: 'hello everyone',
      ...overrides,
    };
  }

  it('resolves auto for unlabeled channels and approval for labeled ones', () => {
    const gate = makeGate();
    expect(gate.resolveMode('discord:unlabeled')).toBe('auto');
    expect(gate.resolveMode(APPROVAL_CHANNEL)).toBe('approval');
    expect(gate.isAutoContactCreationAllowed('discord:unlabeled')).toBe(true);
    expect(gate.isAutoContactCreationAllowed(APPROVAL_CHANNEL)).toBe(false);
  });

  it('fails closed with a clear error when a role_gated channel is operated in (AC4)', () => {
    const gate = makeGate();
    expect(() => gate.resolveMode(ROLE_GATED_CHANNEL)).toThrow(/role_gated.*reserved.*not implemented/);
    expect(() => gate.isAutoContactCreationAllowed(ROLE_GATED_CHANNEL)).toThrow(/role_gated/);
  });

  it('enqueues a new untracked speaker and notifies the operator exactly once', async () => {
    const gate = makeGate();

    const first = await gate.reportUntrackedSpeaker(makeSighting());
    expect(first).toBe('enqueued');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      channel: 'discord',
      channelUserId: 'user-42',
      displayName: 'vtubegooner69',
      channelId: APPROVAL_CHANNEL,
      status: 'pending',
    });

    // Second message from the same speaker: entry updated, no re-notify.
    const second = await gate.reportUntrackedSpeaker(
      makeSighting({ messageId: 'msg-2', messagePreview: 'second message' }),
    );
    expect(second).toBe('pending');
    expect(notify).toHaveBeenCalledTimes(1);

    const entry = await pendingApprovals.getByIdentity('discord', 'user-42');
    expect(entry?.messagePreviews.map(preview => preview.preview)).toEqual([
      'hello everyone',
      'second message',
    ]);
  });

  it('never re-enqueues or re-notifies a denied speaker', async () => {
    const gate = makeGate();
    await gate.reportUntrackedSpeaker(makeSighting());
    const entry = await pendingApprovals.getByIdentity('discord', 'user-42');
    await pendingApprovals.markDenied(entry!.id);
    notify.mockClear();

    const disposition = await gate.reportUntrackedSpeaker(
      makeSighting({ messageId: 'msg-3', messagePreview: 'still here' }),
    );
    expect(disposition).toBe('denied');
    expect(notify).not.toHaveBeenCalled();

    const denied = await pendingApprovals.getByIdentity('discord', 'user-42');
    expect(denied?.status).toBe('denied');
    expect(denied?.messagePreviews).toHaveLength(1);
  });

  it('keeps the durable queue entry when the notification delivery fails (warn, not throw)', async () => {
    notify.mockRejectedValueOnce(new Error('ntfy is not configured'));
    const gate = makeGate();

    const disposition = await gate.reportUntrackedSpeaker(makeSighting());
    expect(disposition).toBe('enqueued');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/notification/i);
    expect(await pendingApprovals.getByIdentity('discord', 'user-42')).toBeDefined();
  });
});

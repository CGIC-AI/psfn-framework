import { describe, expect, it, vi } from 'vitest';
import { createApprovalQueuePortFromConfirmationQueue } from '../../system/capabilities/approval-queue-port.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import { classifyArtifactSensitivity } from '../../shared/contracts/artifact-sensitivity.js';
import type { Attachment } from '../../shared/contracts/runtime.js';
import {
  authorizeArtifactEgress,
  authorizeRecoveredArtifactEgress,
  type ArtifactEgressDestination,
} from './sensitivity-egress.js';

const attachment: Attachment = {
  url: 'https://images.example.test/art.png',
  contentType: 'image/png',
  name: 'art.png',
  localPath: '/workspace/images/art.png',
};

describe('artifact sensitivity egress', () => {
  it('lets a high-sensitivity artifact go directly to the primary contact', async () => {
    const executeApprovedShare = vi.fn(async () => {});
    const classification = classifyArtifactSensitivity([
      { ref: 'memory:private', sensitivity: 'confidential' },
    ], new Date('2026-07-16T12:00:00.000Z'));

    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification,
      destination: {
        audience: 'primary_contact',
        channelId: 'discord:dm-v',
        channelType: 'discord',
        surface: 'conversation',
      },
      deps: {
        executeApprovedShare,
        readCurrentClassifications: async () => [classification],
      },
    });

    expect(decision).toEqual({ disposition: 'proceed', attachments: [attachment] });
    expect(executeApprovedShare).not.toHaveBeenCalled();
  });

  it('queues a public high-sensitivity share, notifies V, and executes only after approval', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'artifact-approval-1' });
    const approvalQueue = createApprovalQueuePortFromConfirmationQueue(queue);
    const notify = vi.fn(async () => ({ messageId: 'notice-1' }));
    const executeApprovedShare = vi.fn(async () => {});
    const classification = classifyArtifactSensitivity([
      { ref: 'memory:private', sensitivity: 'intimate' },
    ], new Date('2026-07-16T12:00:00.000Z'));

    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification,
      destination: {
        audience: 'external',
        channelId: 'discord:public-room',
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        approvalQueue,
        notifier: { notify },
        executeApprovedShare,
        readCurrentClassifications: async () => [classification],
      },
    });

    expect(decision).toMatchObject({
      disposition: 'queued',
      attachments: [],
      queueEntry: { id: 'artifact-approval-1', method: 'artifact.share' },
      sensitivity: 'intimate',
    });
    expect(queue.listPending()).toHaveLength(1);
    expect(executeApprovedShare).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.artifact_egress.approval',
      },
      message: expect.stringContaining('not included in this notification'),
    }));

    const resolved = await queue.resolve(
      { id: 'artifact-approval-1', decision: 'approve' },
      { kind: 'operator', id: 'operator:test' },
    );
    expect(resolved).toMatchObject({ status: 'approved', executed: true });
    expect(executeApprovedShare).toHaveBeenCalledWith(
      [attachment],
      expect.objectContaining({ channelId: 'discord:public-room' }),
    );
  });

  it('fails closed for an ambiguous audience even when sensitivity is public', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'artifact-approval-ambiguous' });
    const classification = classifyArtifactSensitivity([
      { ref: 'turn:ambiguous', sensitivity: 'public' },
    ], new Date('2026-07-16T12:00:00.000Z'));

    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification,
      destination: {
        audience: 'ambiguous',
        channelId: 'internal:unknown',
        channelType: 'terminal',
        surface: 'external',
      },
      deps: {
        approvalQueue: createApprovalQueuePortFromConfirmationQueue(queue),
        notifier: { notify: vi.fn(async () => ({})) },
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [classification],
      },
    });

    expect(decision.disposition).toBe('queued');
    expect(queue.listPending()).toHaveLength(1);
  });

  it('rejects approval when classification changed after review was requested', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'artifact-approval-stale' });
    const requestedClassification = classifyArtifactSensitivity([
      { ref: 'memory:private', sensitivity: 'intimate' },
    ], new Date('2026-07-16T12:00:00.000Z'));
    let currentClassification = requestedClassification;
    await authorizeArtifactEgress({
      attachments: [attachment],
      classification: requestedClassification,
      destination: {
        audience: 'external',
        channelId: 'discord:public-room',
        channelType: 'discord',
        surface: 'public_channel',
      },
      deps: {
        approvalQueue: createApprovalQueuePortFromConfirmationQueue(queue),
        notifier: { notify: vi.fn(async () => ({})) },
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [currentClassification],
      },
    });
    currentClassification = classifyArtifactSensitivity([
      { ref: 'memory:private', sensitivity: 'confidential' },
    ], new Date('2026-07-16T13:00:00.000Z'));

    const resolved = await queue.resolve(
      { id: 'artifact-approval-stale', decision: 'approve' },
      { kind: 'operator', id: 'operator:test' },
    );

    expect(resolved).toMatchObject({ status: 'failed', executed: false });
    expect(resolved.message).toContain('Artifact sensitivity changed');
  });

  it('uses current recovered classification and reuses an already-pending external approval', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'recovered-artifact-approval' });
    const approvalQueue = createApprovalQueuePortFromConfirmationQueue(queue);
    const notify = vi.fn(async () => ({ messageId: 'notice-recovered-artifact' }));
    const executeApprovedShare = vi.fn(async () => {});
    const currentClassification = classifyArtifactSensitivity([
      { ref: 'memory:private-current', sensitivity: 'confidential' },
    ], new Date('2026-07-16T15:00:00.000Z'));
    const deps = {
      approvalQueue,
      notifier: { notify },
      executeApprovedShare,
      readCurrentClassifications: vi.fn(async () => [currentClassification]),
    };
    const destination: ArtifactEgressDestination = {
      audience: 'external',
      channelId: 'companion-dm:local:peer',
      channelType: 'companion',
      surface: 'external',
    };

    const first = await authorizeRecoveredArtifactEgress({
      attachments: [attachment],
      destination,
      deps,
    });
    const replay = await authorizeRecoveredArtifactEgress({
      attachments: [attachment],
      destination,
      deps,
    });

    expect(first).toMatchObject({
      disposition: 'queued',
      attachments: [],
      queueEntry: { id: 'recovered-artifact-approval' },
      sensitivity: 'confidential',
    });
    expect(replay).toMatchObject({
      disposition: 'queued',
      attachments: [],
      queueEntry: { id: 'recovered-artifact-approval' },
    });
    expect(queue.listPending()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);

    await queue.resolve(
      { id: 'recovered-artifact-approval', decision: 'approve' },
      { kind: 'operator', id: 'operator:test' },
    );
    const afterApprovalReplay = await authorizeRecoveredArtifactEgress({
      attachments: [attachment],
      destination,
      deps,
    });
    expect(afterApprovalReplay).toMatchObject({
      disposition: 'settled',
      attachments: [],
      queueEntryId: 'recovered-artifact-approval',
      resolution: 'approved',
    });
    expect(queue.listPending()).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(executeApprovedShare).toHaveBeenCalledTimes(1);
  });

  it('fails recovered external egress closed when current classification is unavailable', async () => {
    const queue = new ConfirmationQueue();
    const notify = vi.fn(async () => ({}));

    await expect(authorizeRecoveredArtifactEgress({
      attachments: [attachment],
      destination: {
        audience: 'external',
        channelId: 'companion-dm:local:peer',
        channelType: 'companion',
        surface: 'external',
      },
      deps: {
        approvalQueue: createApprovalQueuePortFromConfirmationQueue(queue),
        notifier: { notify },
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => {
          throw new Error('current sidecar is unavailable');
        },
      },
    })).rejects.toThrow('current sidecar is unavailable');

    expect(queue.listPending()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('lets recovered self/V artifact egress proceed without external classification review', async () => {
    const readCurrentClassifications = vi.fn(async () => {
      throw new Error('self recovery must not require an external-release sidecar check');
    });

    const decision = await authorizeRecoveredArtifactEgress({
      attachments: [attachment],
      destination: {
        audience: 'primary_contact',
        channelId: 'discord:dm-v',
        channelType: 'discord',
        surface: 'conversation',
      },
      deps: {
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications,
      },
    });

    expect(decision).toEqual({ disposition: 'proceed', attachments: [attachment] });
    expect(readCurrentClassifications).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  listPendingPaidDeliverables,
  notePendingPaidDeliverable,
  runWithPaidDeliverableTracking,
} from './paid-deliverable-tracking.js';

describe('paid-deliverable-tracking', () => {
  it('records and lists paid deliverables within a tracking scope', async () => {
    const listed = await runWithPaidDeliverableTracking(async () => {
      notePendingPaidDeliverable({
        surface: 'paidImageGeneration',
        toolName: 'selfie_create',
        toolCallId: 'call-1',
        identifier: 'req-1',
        artifactCount: 2,
      });
      return listPendingPaidDeliverables();
    });

    expect(listed).toEqual([{
      surface: 'paidImageGeneration',
      toolName: 'selfie_create',
      toolCallId: 'call-1',
      identifier: 'req-1',
      artifactCount: 2,
    }]);
  });

  it('accumulates multiple deliverables in one scope', async () => {
    const listed = await runWithPaidDeliverableTracking(async () => {
      notePendingPaidDeliverable({ surface: 'paidImageGeneration', toolName: 'media' });
      notePendingPaidDeliverable({ surface: 'paidImageGeneration', toolName: 'selfie_create' });
      return listPendingPaidDeliverables();
    });

    expect(listed).toHaveLength(2);
  });

  it('returns a defensive copy that cannot mutate the store', async () => {
    await runWithPaidDeliverableTracking(async () => {
      notePendingPaidDeliverable({ surface: 'paidImageGeneration' });
      const first = listPendingPaidDeliverables();
      (first as { surface: string }[]).push({ surface: 'spoofed' });
      expect(listPendingPaidDeliverables()).toHaveLength(1);
    });
  });

  it('is a no-op outside a tracking scope and lists nothing', () => {
    expect(() => notePendingPaidDeliverable({ surface: 'paidImageGeneration' })).not.toThrow();
    expect(listPendingPaidDeliverables()).toEqual([]);
  });

  it('isolates deliverables to their own scope', async () => {
    await runWithPaidDeliverableTracking(async () => {
      notePendingPaidDeliverable({ surface: 'paidImageGeneration', toolName: 'media' });
    });
    // A fresh scope starts empty; the previous scope's entries do not leak.
    const listed = await runWithPaidDeliverableTracking(async () => listPendingPaidDeliverables());
    expect(listed).toEqual([]);
  });
});

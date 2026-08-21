import { describe, expect, it, vi } from 'vitest';

import type { AutomataBusCanonicalFinding } from './query-ports.js';
import {
  AutomataBusReindexService,
  type AutomataBusReindexLease,
  type AutomataBusReindexRuntimePort,
  type AutomataBusReindexSourcePort,
} from './reindex-service.js';

const LEASE: AutomataBusReindexLease = {
  companionId: 'companion-a',
  leaseToken: 'lease-a',
  snapshotSequence: 7,
  mutationFence: 11,
};

function finding(companionId: string, eventId: string): AutomataBusCanonicalFinding {
  return {
    eventId,
    companionId,
    sequence: 1,
    occurredAt: '2026-08-20T12:00:00.000Z',
    automatonClass: 'subagent.bounded',
    taskId: `task-${eventId}`,
    runId: `run-${eventId}`,
    claim: `claim-${eventId}`,
    provenance: 'computed',
    verificationStatus: 'pending',
    audience: 'eligible-automata',
    sensitivity: 'personal',
  };
}

function runtime(
  onComplete?: (input: { companionId: string; eventIds: readonly string[] }) => void,
  onBegin?: () => void,
): AutomataBusReindexRuntimePort & {
  begin: ReturnType<typeof vi.fn>;
  index: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    begin: vi.fn(async input => {
      onBegin?.();
      return { ...LEASE, companionId: input.companionId };
    }),
    index: vi.fn(async () => ({ status: 'indexed' as const })),
    complete: vi.fn(async input => {
      onComplete?.(input);
    }),
    fail: vi.fn(async () => undefined),
  };
}

describe('AutomataBusReindexService', () => {
  it('acquires the companion lease before reading and completes the exact fenced snapshot', async () => {
    const calls: string[] = [];
    const source: AutomataBusReindexSourcePort = {
      readCurrent: vi.fn(async input => {
        calls.push('snapshot');
        return {
          companionId: input.companionId,
          findings: [finding(input.companionId, 'a')],
          hasMore: false,
        };
      }),
    };
    const index = runtime(undefined, () => {
      calls.push('lease');
    });
    const service = new AutomataBusReindexService({
      companionId: 'companion-a',
      maxFindings: 2,
      source,
      runtime: index,
    });

    await service.reindex({ companionId: 'companion-a' });

    expect(calls).toEqual(['lease', 'snapshot']);
    expect(source.readCurrent).toHaveBeenCalledWith({
      companionId: 'companion-a',
      limit: 2,
      snapshotSequence: 7,
    });
    expect(index.complete).toHaveBeenCalledWith({
      companionId: 'companion-a',
      eventIds: ['a'],
      leaseToken: 'lease-a',
      mutationFence: 11,
      snapshotSequence: 7,
    });
  });

  it('keeps three companion indexes distinct across service restart', async () => {
    const companionIds = ['companion-a', 'companion-b', 'companion-c'];
    const completed = new Map<string, string[]>();
    for (const companionId of companionIds) {
      const source: AutomataBusReindexSourcePort = {
        async readCurrent(input) {
          return {
            companionId: input.companionId,
            findings: [finding(input.companionId, 'same-event-id')],
            hasMore: false,
          };
        },
      };
      const index = runtime(input => {
        completed.set(input.companionId, [...input.eventIds]);
      });
      const createService = () => new AutomataBusReindexService({
        companionId,
        maxFindings: 2,
        source,
        runtime: index,
      });

      await createService().reindex({ companionId });
      await createService().reindex({ companionId });
    }

    expect(completed).toEqual(new Map([
      ['companion-a', ['same-event-id']],
      ['companion-b', ['same-event-id']],
      ['companion-c', ['same-event-id']],
    ]));
  });

  it('rebuilds one exact companion within the owner bound', async () => {
    const source: AutomataBusReindexSourcePort = {
      readCurrent: vi.fn(async input => ({
        companionId: input.companionId,
        findings: [finding(input.companionId, 'a'), finding(input.companionId, 'b')],
        hasMore: false,
      })),
    };
    const index = runtime();
    const service = new AutomataBusReindexService({
      companionId: 'companion-a',
      maxFindings: 3,
      source,
      runtime: index,
    });

    await expect(service.reindex({ companionId: 'companion-a' })).resolves.toEqual({
      companionId: 'companion-a',
      status: 'completed',
      processed: 2,
      indexed: 2,
      lagging: 0,
    });
    expect(source.readCurrent).toHaveBeenCalledWith({
      companionId: 'companion-a',
      limit: 3,
      snapshotSequence: LEASE.snapshotSequence,
    });
    expect(index.begin).toHaveBeenCalledWith({ companionId: 'companion-a' });
    expect(index.index).toHaveBeenCalledTimes(2);
    expect(index.complete).toHaveBeenCalledWith({
      ...LEASE,
      eventIds: ['a', 'b'],
    });
    expect(index.fail).not.toHaveBeenCalled();
  });

  it('fails closed before mutation on cross-companion, ambiguous, or over-bound sources', async () => {
    const source: AutomataBusReindexSourcePort = {
      readCurrent: vi.fn(async () => ({
        companionId: 'companion-b',
        findings: [finding('companion-b', 'b')],
        hasMore: false,
      })),
    };
    const index = runtime();
    const service = new AutomataBusReindexService({
      companionId: 'companion-a',
      maxFindings: 1,
      source,
      runtime: index,
    });

    await expect(service.reindex({ companionId: 'companion-b' }))
      .rejects.toThrow('companion scope mismatch');
    await expect(service.reindex({ companionId: 'companion-a' }))
      .rejects.toThrow('cross-companion source');
    expect(index.begin).toHaveBeenCalledOnce();
    expect(index.fail).toHaveBeenCalledWith(LEASE);

    const overBound = new AutomataBusReindexService({
      companionId: 'companion-a',
      maxFindings: 1,
      source: {
        async readCurrent() {
          return {
            companionId: 'companion-a',
            findings: [finding('companion-a', 'a')],
            hasMore: true,
          };
        },
      },
      runtime: index,
    });
    await expect(overBound.reindex({ companionId: 'companion-a' }))
      .rejects.toThrow('exceeds the owner reindex bound');
    expect(index.begin).toHaveBeenCalledTimes(2);
  });

  it('marks only the exact companion degraded when indexing cannot complete', async () => {
    const source: AutomataBusReindexSourcePort = {
      async readCurrent(input) {
        return {
          companionId: input.companionId,
          findings: [finding(input.companionId, 'a')],
          hasMore: false,
        };
      },
    };
    const index = runtime();
    index.index.mockResolvedValue({ status: 'lagging' as const });
    const service = new AutomataBusReindexService({
      companionId: 'companion-a',
      maxFindings: 2,
      source,
      runtime: index,
    });

    await expect(service.reindex({ companionId: 'companion-a' }))
      .rejects.toThrow('left 1 finding lagging');
    expect(index.fail).toHaveBeenCalledWith(LEASE);
    expect(index.complete).not.toHaveBeenCalled();
  });
});

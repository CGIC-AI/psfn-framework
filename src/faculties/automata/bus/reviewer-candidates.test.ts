import { describe, expect, it, vi } from 'vitest';

import {
  AutomataBusReviewerCandidateGenerator,
  type AutomataBusReviewerNominationPort,
} from './reviewer-candidates.js';

const POLICY = {
  similarityThreshold: 0.9,
  maxFindingsPerRun: 12,
  maxNominationsPerRun: 10,
  maxCandidatesPerCluster: 3,
  maxClustersPerRun: 4,
} as const;

describe('AutomataBusReviewerCandidateGenerator', () => {
  it('forms deterministic bounded clusters for every reviewer nomination kind', async () => {
    const nominations: AutomataBusReviewerNominationPort = {
      nominate: vi.fn(async () => ({
        nominations: [
          { kind: 'orphan-provenance', eventIds: ['event-d'] },
          {
            kind: 'duplicate',
            eventIds: ['event-b', 'event-a'],
            similarityScore: 0.99,
          },
          { kind: 'stale-evidence', eventIds: ['event-c'] },
          {
            kind: 'contradiction',
            eventIds: ['event-d', 'event-a'],
            similarityScore: 0.93,
          },
          {
            kind: 'duplicate',
            eventIds: ['event-c', 'event-b'],
            similarityScore: 0.95,
          },
          {
            kind: 'duplicate',
            eventIds: ['event-a', 'below-threshold'],
            similarityScore: 0.2,
          },
        ],
        totalNominations: 6,
        findingsScanned: 8,
        hasMore: false,
      })),
    };
    const generator = new AutomataBusReviewerCandidateGenerator({ nominations, policy: POLICY });

    const scope = {
      companionId: 'companion-a',
      audience: 'operator' as const,
      maxSensitivity: 'confidential' as const,
    };
    const first = await generator.generate(scope);
    const second = await generator.generate(scope);

    expect(first).toEqual(second);
    expect(first.clusters.map(cluster => ({
      kind: cluster.kind,
      eventIds: cluster.eventIds,
      similarityScore: cluster.similarityScore,
    }))).toEqual([
      {
        kind: 'contradiction',
        eventIds: ['event-a', 'event-d'],
        similarityScore: 0.93,
      },
      {
        kind: 'duplicate',
        eventIds: ['event-a', 'event-b', 'event-c'],
        similarityScore: 0.99,
      },
      {
        kind: 'orphan-provenance',
        eventIds: ['event-d'],
        similarityScore: undefined,
      },
      {
        kind: 'stale-evidence',
        eventIds: ['event-c'],
        similarityScore: undefined,
      },
    ]);
    expect(new Set(first.clusters.map(cluster => cluster.clusterId)).size).toBe(4);
    expect(first.backlog).toEqual({
      findingsScanned: 8,
      nominationsSeen: 6,
      clustersReturned: 4,
      hasMore: false,
    });
    expect(nominations.nominate).toHaveBeenCalledWith({
      scope,
      similarityThreshold: POLICY.similarityThreshold,
      maxFindings: POLICY.maxFindingsPerRun,
      maxNominations: POLICY.maxNominationsPerRun,
    });
  });

  it('rejects an adapter that exceeds an owner bound instead of processing an unbounded response', async () => {
    const nominations: AutomataBusReviewerNominationPort = {
      nominate: vi.fn(async () => ({
        nominations: Array.from({ length: POLICY.maxNominationsPerRun + 1 }, (_, index) => ({
          kind: 'stale-evidence' as const,
          eventIds: [`event-${String(index)}`],
        })),
        totalNominations: POLICY.maxNominationsPerRun + 1,
        findingsScanned: POLICY.maxFindingsPerRun,
        hasMore: true,
      })),
    };

    await expect(new AutomataBusReviewerCandidateGenerator({
      nominations,
      policy: POLICY,
    }).generate({
      companionId: 'companion-a',
      audience: 'operator',
      maxSensitivity: 'confidential',
    })).rejects.toThrow(/maxNominationsPerRun/);
  });

  it('splits an oversized connected component into deterministic overlapping bounded clusters', async () => {
    const nominations: AutomataBusReviewerNominationPort = {
      nominate: vi.fn(async () => ({
        nominations: [
          { kind: 'duplicate', eventIds: ['event-d', 'event-e'], similarityScore: 0.94 },
          { kind: 'duplicate', eventIds: ['event-a', 'event-b'], similarityScore: 0.99 },
          { kind: 'duplicate', eventIds: ['event-c', 'event-d'], similarityScore: 0.95 },
          { kind: 'duplicate', eventIds: ['event-b', 'event-c'], similarityScore: 0.96 },
        ],
        totalNominations: 4,
        findingsScanned: 5,
        hasMore: false,
      })),
    };

    const result = await new AutomataBusReviewerCandidateGenerator({
      nominations,
      policy: POLICY,
    }).generate({
      companionId: 'companion-a',
      audience: 'operator',
      maxSensitivity: 'confidential',
    });

    expect(result.clusters.map(candidate => candidate.eventIds)).toEqual([
      ['event-a', 'event-b', 'event-c'],
      ['event-c', 'event-d', 'event-e'],
    ]);
    expect(result.backlog.hasMore).toBe(false);
  });

  it('uses cosine scores only to nominate and exposes no current-state mutation dependency', async () => {
    const nominations: AutomataBusReviewerNominationPort = {
      nominate: vi.fn(async () => ({
        nominations: [{
          kind: 'duplicate',
          eventIds: ['event-a', 'event-b'],
          similarityScore: 1,
        }],
        totalNominations: 1,
        findingsScanned: 2,
        hasMore: false,
      })),
    };
    const generator = new AutomataBusReviewerCandidateGenerator({ nominations, policy: POLICY });

    const result = await generator.generate({
      companionId: 'companion-a',
      audience: 'operator',
      maxSensitivity: 'confidential',
    });

    expect(result.clusters).toHaveLength(1);
    expect(Object.keys(generator).sort()).toEqual(['nominations', 'policy']);
  });
});

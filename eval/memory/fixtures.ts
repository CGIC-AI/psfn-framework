import type { MemoryRegressionFixture } from './types.js';

const DIRECT_TRUST = 'trusted' as const;
const DIRECT_VISIBILITY = 'direct' as const;

function l0(input: {
  id: string;
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}) {
  return {
    layer: 'L0' as const,
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    role: input.role,
    content: input.content,
    createdAt: input.createdAt,
    trustLevel: DIRECT_TRUST,
    channelVisibility: DIRECT_VISIBILITY,
  };
}

export const MEMORY_REGRESSION_FIXTURES: readonly MemoryRegressionFixture[] = [
  {
    id: 'current-state-workspace',
    family: 'current-state-change',
    description: 'A current-state change should retrieve the newest fact and supersede the stale fact.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-workspace-old',
          sessionId: 'session-current-state',
          turnId: 'turn-workspace-old',
          role: 'user',
          content: 'My writable workspace is /home/ada/old_lab for now.',
          createdAt: '2026-06-01T10:00:00.000Z',
        }),
        l0({
          id: 'l0-workspace-new',
          sessionId: 'session-current-state',
          turnId: 'turn-workspace-new',
          role: 'user',
          content: 'Update: my writable workspace moved to /home/ada/purrsephone.',
          createdAt: '2026-06-05T10:00:00.000Z',
        }),
      ],
      l01Episodes: [],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-workspace-old',
          text: 'Ada current writable workspace is /home/ada/old_lab.',
          tags: ['workspace', 'current_state'],
          sensitivity: 'personal',
          sourceRefs: ['l0:l0-workspace-old'],
          createdAt: '2026-06-01T10:01:00.000Z',
          confidence: 0.92,
        },
      ],
    },
    writes: [
      {
        id: 'write-workspace-new',
        text: 'Ada current writable workspace is /home/ada/purrsephone.',
        tags: ['workspace', 'current_state'],
        sensitivity: 'personal',
        sourceRef: 'l0:l0-workspace-new',
        timestamp: '2026-06-05T10:01:00.000Z',
        createsMemoryId: 'm-workspace-new',
        expectedSupersededMemoryIds: ['m-workspace-old'],
      },
    ],
    retrievals: [
      {
        id: 'retrieve-current-workspace',
        query: 'current writable workspace path',
        topK: 3,
        trustLevel: 'trusted',
        expectedMemoryIds: ['m-workspace-new'],
      },
    ],
    maintenance: {
      queueItems: [
        {
          id: 'queue-workspace-supersede',
          enqueuedAt: '2026-06-05T10:01:00.000Z',
          processedAt: '2026-06-05T10:03:30.000Z',
        },
      ],
    },
  },
  {
    id: 'compatible-tea-update',
    family: 'compatible-update',
    description: 'Compatible preference additions should coexist rather than superseding each other.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-tea-oolong',
          sessionId: 'session-compatible-update',
          turnId: 'turn-tea-oolong',
          role: 'user',
          content: 'I like oolong tea in the morning.',
          createdAt: '2026-06-02T09:00:00.000Z',
        }),
      ],
      l01Episodes: [],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-tea-oolong',
          text: 'Ada likes oolong tea in the morning.',
          tags: ['preference', 'tea'],
          sensitivity: 'personal',
          sourceRefs: ['l0:l0-tea-oolong'],
          createdAt: '2026-06-02T09:01:00.000Z',
          confidence: 0.9,
        },
      ],
    },
    writes: [
      {
        id: 'write-tea-jasmine',
        text: 'Ada also likes jasmine tea after lunch.',
        tags: ['preference', 'tea'],
        sensitivity: 'personal',
        sourceRef: 'l0:l0-tea-jasmine',
        timestamp: '2026-06-05T12:15:00.000Z',
        createsMemoryId: 'm-tea-jasmine',
        expectedSupersededMemoryIds: [],
        compatibleUpdate: true,
      },
    ],
    retrievals: [
      {
        id: 'retrieve-tea-preferences',
        query: 'tea preferences oolong jasmine',
        topK: 4,
        trustLevel: 'trusted',
        expectedMemoryIds: ['m-tea-oolong', 'm-tea-jasmine'],
      },
    ],
    maintenance: {
      queueItems: [
        {
          id: 'queue-compatible-review',
          enqueuedAt: '2026-06-05T12:15:00.000Z',
          processedAt: '2026-06-05T12:16:30.000Z',
        },
      ],
    },
  },
  {
    id: 'true-contradiction-pager',
    family: 'true-contradiction',
    description: 'A true contradiction should supersede the stale fact and retrieve the replacement.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-pager-off',
          sessionId: 'session-contradiction',
          turnId: 'turn-pager-off',
          role: 'user',
          content: 'My pager stays off on weekends.',
          createdAt: '2026-05-29T17:00:00.000Z',
        }),
      ],
      l01Episodes: [],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-pager-off',
          text: 'Ada pager is off on weekends.',
          tags: ['availability', 'pager', 'weekend'],
          sensitivity: 'personal',
          sourceRefs: ['l0:l0-pager-off'],
          createdAt: '2026-05-29T17:01:00.000Z',
          confidence: 0.88,
        },
      ],
    },
    writes: [
      {
        id: 'write-pager-on',
        text: 'Ada pager is on for Saturday maintenance.',
        tags: ['availability', 'pager', 'weekend', 'current_state'],
        sensitivity: 'personal',
        sourceRef: 'l0:l0-pager-on',
        timestamp: '2026-06-05T18:10:00.000Z',
        createsMemoryId: 'm-pager-on',
        expectedSupersededMemoryIds: ['m-pager-off'],
      },
    ],
    retrievals: [
      {
        id: 'retrieve-pager-current',
        query: 'current pager weekend Saturday maintenance',
        topK: 3,
        trustLevel: 'trusted',
        expectedMemoryIds: ['m-pager-on'],
      },
    ],
    maintenance: {
      queueItems: [
        {
          id: 'queue-pager-supersede',
          enqueuedAt: '2026-06-05T18:10:00.000Z',
          processedAt: '2026-06-05T18:14:30.000Z',
        },
      ],
    },
  },
  {
    id: 'episodic-overlap-orbit-garden',
    family: 'episodic-overlap',
    description: 'Overlapping L0 spans for the same event should merge into one canonical L0.1 episode.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-orbit-a',
          sessionId: 'session-episode-overlap',
          turnId: 'turn-orbit-a',
          role: 'user',
          content: 'We started the orbit garden shakedown and found one stuck valve.',
          createdAt: '2026-06-03T14:00:00.000Z',
        }),
        l0({
          id: 'l0-orbit-b',
          sessionId: 'session-episode-overlap',
          turnId: 'turn-orbit-b',
          role: 'assistant',
          content: 'Orbit garden shakedown continued; the valve issue was isolated.',
          createdAt: '2026-06-03T14:03:00.000Z',
        }),
      ],
      l01Episodes: [
        {
          layer: 'L0.1',
          id: 'ep-orbit-overlap-a',
          threadId: 'thread-orbit',
          channelId: 'direct:ada',
          startedAt: '2026-06-03T14:00:00.000Z',
          endedAt: '2026-06-03T14:04:00.000Z',
          summary: 'Orbit garden shakedown identified a stuck valve.',
          salientFacts: ['orbit garden shakedown', 'stuck valve isolated'],
          eventKey: 'orbit-garden-shakedown',
          provenanceRefs: ['l0:l0-orbit-a'],
          trustLevel: 'trusted',
        },
        {
          layer: 'L0.1',
          id: 'ep-orbit-overlap-b',
          threadId: 'thread-orbit',
          channelId: 'direct:ada',
          startedAt: '2026-06-03T14:02:00.000Z',
          endedAt: '2026-06-03T14:06:00.000Z',
          summary: 'The same orbit garden shakedown isolated the stuck valve.',
          salientFacts: ['orbit garden shakedown', 'stuck valve isolated'],
          eventKey: 'orbit-garden-shakedown',
          provenanceRefs: ['l0:l0-orbit-b'],
          trustLevel: 'trusted',
        },
      ],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-orbit-valve',
          text: 'Orbit garden shakedown isolated a stuck valve.',
          tags: ['episode', 'orbit_garden'],
          sensitivity: 'personal',
          sourceRefs: ['episode:ep-orbit-overlap-a', 'episode:ep-orbit-overlap-b'],
          createdAt: '2026-06-03T14:07:00.000Z',
          confidence: 0.86,
        },
      ],
    },
    writes: [],
    retrievals: [
      {
        id: 'retrieve-orbit-garden',
        query: 'orbit garden shakedown stuck valve',
        topK: 3,
        trustLevel: 'trusted',
        expectedMemoryIds: ['m-orbit-valve'],
      },
    ],
    maintenance: {
      expectedEpisodeMergeGroups: [['ep-orbit-overlap-a', 'ep-orbit-overlap-b']],
      queueItems: [
        {
          id: 'queue-episode-overlap',
          enqueuedAt: '2026-06-03T14:06:00.000Z',
          processedAt: '2026-06-03T14:09:00.000Z',
        },
      ],
    },
  },
  {
    id: 'episodic-paraphrase-market-run',
    family: 'episodic-paraphrase',
    description: 'Paraphrased descriptions of the same event should merge instead of becoming duplicate episodes.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-market-a',
          sessionId: 'session-episode-paraphrase',
          turnId: 'turn-market-a',
          role: 'user',
          content: 'Yesterday we walked to the night market and bought green plums.',
          createdAt: '2026-06-04T08:00:00.000Z',
        }),
        l0({
          id: 'l0-market-b',
          sessionId: 'session-episode-paraphrase',
          turnId: 'turn-market-b',
          role: 'user',
          content: 'That evening market trip with the green plums was the same outing.',
          createdAt: '2026-06-04T08:04:00.000Z',
        }),
      ],
      l01Episodes: [
        {
          layer: 'L0.1',
          id: 'ep-market-paraphrase-a',
          threadId: 'thread-market',
          channelId: 'direct:ada',
          startedAt: '2026-06-04T08:00:00.000Z',
          endedAt: '2026-06-04T08:02:00.000Z',
          summary: 'Ada and companion walked to the night market and bought green plums.',
          salientFacts: ['night market outing', 'green plums'],
          eventKey: 'night-market-green-plums',
          provenanceRefs: ['l0:l0-market-a'],
          trustLevel: 'trusted',
        },
        {
          layer: 'L0.1',
          id: 'ep-market-paraphrase-b',
          threadId: 'thread-market',
          channelId: 'direct:ada',
          startedAt: '2026-06-04T08:03:00.000Z',
          endedAt: '2026-06-04T08:05:00.000Z',
          summary: 'The green plum evening market trip was the same outing.',
          salientFacts: ['evening market outing', 'green plums'],
          eventKey: 'night-market-green-plums',
          provenanceRefs: ['l0:l0-market-b'],
          trustLevel: 'trusted',
        },
      ],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-market-plums',
          text: 'Ada and companion had one night market outing where they bought green plums.',
          tags: ['episode', 'market', 'green_plums'],
          sensitivity: 'personal',
          sourceRefs: ['episode:ep-market-paraphrase-a', 'episode:ep-market-paraphrase-b'],
          createdAt: '2026-06-04T08:06:00.000Z',
          confidence: 0.84,
        },
      ],
    },
    writes: [],
    retrievals: [
      {
        id: 'retrieve-market-plums',
        query: 'night market green plums outing',
        topK: 3,
        trustLevel: 'trusted',
        expectedMemoryIds: ['m-market-plums'],
      },
    ],
    maintenance: {
      expectedEpisodeMergeGroups: [['ep-market-paraphrase-a', 'ep-market-paraphrase-b']],
      queueItems: [
        {
          id: 'queue-episode-paraphrase',
          enqueuedAt: '2026-06-04T08:05:00.000Z',
          processedAt: '2026-06-04T08:09:00.000Z',
        },
      ],
    },
  },
  {
    id: 'privacy-trust-deployment-token',
    family: 'privacy-trust',
    description: 'Trust ceilings should withhold secret facts while still retrieving useful lower-risk context.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-incident-summary',
          sessionId: 'session-privacy',
          turnId: 'turn-incident-summary',
          role: 'user',
          content: 'For incident summaries, prefer concise bullet lists.',
          createdAt: '2026-06-05T08:30:00.000Z',
        }),
        l0({
          id: 'l0-deploy-token',
          sessionId: 'session-privacy',
          turnId: 'turn-deploy-token',
          role: 'user',
          content: 'The deployment token is private and must not appear in normal retrieval.',
          createdAt: '2026-06-05T08:31:00.000Z',
        }),
      ],
      l01Episodes: [],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-incident-summary-style',
          text: 'Ada prefers concise bullet lists for incident summaries.',
          tags: ['incident', 'summary', 'preference'],
          sensitivity: 'personal',
          sourceRefs: ['l0:l0-incident-summary'],
          createdAt: '2026-06-05T08:32:00.000Z',
          confidence: 0.91,
        },
        {
          layer: 'L2',
          id: 'm-deploy-token-secret',
          text: 'Ada deployment token is stored in the red vault.',
          tags: ['deployment', 'token', 'secret'],
          sensitivity: 'secret',
          sourceRefs: ['l0:l0-deploy-token'],
          createdAt: '2026-06-05T08:33:00.000Z',
          confidence: 0.96,
        },
      ],
    },
    writes: [],
    retrievals: [
      {
        id: 'retrieve-incident-regular-trust',
        query: 'deployment token incident summary preference',
        topK: 4,
        trustLevel: 'regular',
        expectedMemoryIds: ['m-incident-summary-style'],
        expectedWithheldMemoryIds: ['m-deploy-token-secret'],
      },
    ],
    maintenance: {
      queueItems: [
        {
          id: 'queue-privacy-review',
          enqueuedAt: '2026-06-05T08:33:00.000Z',
          processedAt: '2026-06-05T08:35:30.000Z',
        },
      ],
    },
  },
  {
    id: 'withheld-context-research-notes',
    family: 'withheld-context',
    description: 'Withheld context should be counted and excluded from prompt snippets even at high trust.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-research-safe',
          sessionId: 'session-withheld',
          turnId: 'turn-research-safe',
          role: 'assistant',
          content: 'The safe research note says calibration runs should retain run IDs.',
          createdAt: '2026-06-05T15:00:00.000Z',
        }),
        l0({
          id: 'l0-research-withheld',
          sessionId: 'session-withheld',
          turnId: 'turn-research-withheld',
          role: 'user',
          content: 'This private research note is withdrawn from recall.',
          createdAt: '2026-06-05T15:01:00.000Z',
        }),
      ],
      l01Episodes: [],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-research-safe',
          text: 'Calibration research runs should retain run IDs.',
          tags: ['research', 'calibration', 'run_id'],
          sensitivity: 'personal',
          sourceRefs: ['l0:l0-research-safe'],
          createdAt: '2026-06-05T15:02:00.000Z',
          confidence: 0.87,
        },
        {
          layer: 'L2',
          id: 'm-research-withheld',
          text: 'Withdrawn private research note about calibration run IDs.',
          tags: ['research', 'calibration', 'withheld'],
          sensitivity: 'private',
          sourceRefs: ['l0:l0-research-withheld'],
          createdAt: '2026-06-05T15:03:00.000Z',
          confidence: 0.8,
          retrievalPolicy: {
            allowRecall: false,
            withheldReason: 'consent.withdrawn',
          },
        },
      ],
    },
    writes: [],
    retrievals: [
      {
        id: 'retrieve-withheld-context',
        query: 'calibration research run ids',
        topK: 4,
        trustLevel: 'primary',
        expectedMemoryIds: ['m-research-safe'],
        expectedWithheldMemoryIds: ['m-research-withheld'],
      },
    ],
    maintenance: {
      queueItems: [
        {
          id: 'queue-withheld-context',
          enqueuedAt: '2026-06-05T15:03:00.000Z',
          processedAt: '2026-06-05T15:04:00.000Z',
        },
      ],
    },
  },
  {
    id: 'backup-restore-weekly-review',
    family: 'backup-restore-degradation',
    description: 'Backup and restore should preserve retrievable L2 facts and canonical L0.1 episodes.',
    seed: {
      l0Entries: [
        l0({
          id: 'l0-weekly-review',
          sessionId: 'session-backup-restore',
          turnId: 'turn-weekly-review',
          role: 'user',
          content: 'Weekly review happens Monday at 10:00 with the blue notebook.',
          createdAt: '2026-06-01T13:00:00.000Z',
        }),
      ],
      l01Episodes: [
        {
          layer: 'L0.1',
          id: 'ep-weekly-review',
          threadId: 'thread-review',
          channelId: 'direct:ada',
          startedAt: '2026-06-01T13:00:00.000Z',
          endedAt: '2026-06-01T13:02:00.000Z',
          summary: 'Ada set the weekly review for Monday at 10:00 with the blue notebook.',
          salientFacts: ['weekly review Monday 10:00', 'blue notebook'],
          eventKey: 'weekly-review-blue-notebook',
          provenanceRefs: ['l0:l0-weekly-review'],
          trustLevel: 'trusted',
        },
      ],
      l2Memories: [
        {
          layer: 'L2',
          id: 'm-weekly-review',
          text: 'Ada weekly review happens Monday at 10:00 with the blue notebook.',
          tags: ['schedule', 'weekly_review', 'blue_notebook'],
          sensitivity: 'personal',
          sourceRefs: ['l0:l0-weekly-review', 'episode:ep-weekly-review'],
          createdAt: '2026-06-01T13:03:00.000Z',
          confidence: 0.93,
        },
      ],
    },
    writes: [],
    retrievals: [],
    maintenance: {
      queueItems: [
        {
          id: 'queue-backup-restore',
          enqueuedAt: '2026-06-01T13:03:00.000Z',
          processedAt: '2026-06-01T13:05:30.000Z',
        },
      ],
    },
    backupRestore: {
      probeAfterRestore: {
        id: 'retrieve-weekly-review-after-restore',
        query: 'weekly review Monday 10 blue notebook',
        topK: 3,
        trustLevel: 'trusted',
        expectedMemoryIds: ['m-weekly-review'],
      },
    },
  },
];

// Live-database integration tests for the bounded room-participation lease
// store (jp36.5.5). Follows the shared-schema harness pattern: a throwaway
// dockerized postgres, a fresh database per test. Covers what a fake store
// cannot: the real shared-chain DDL and its CHECK constraints, the atomic
// consider-once claim under concurrency, and — the acceptance criterion — that
// an active lease and its exact context watermark survive a process restart
// without replaying an already-considered message.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresRoomParticipationLeaseStore } from './room-participation-lease-store.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL = 'discord:guild-1:room-general';
const NOW = 1_700_000_000_000;
const TTL_MS = 15 * 60_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  // The store runs no DDL: the gateway migration authority provisions the
  // shared schema before agents connect. Mirror that here.
  await bootstrapSharedSchema(database.databaseUrl);
  return database.databaseUrl;
}

function claimInput(overrides: {
  companionId?: string;
  messageId: string;
  timestampMs: number;
  authorIsMachine?: boolean;
  nowMs?: number;
  maxContinuationCandidates?: number;
  maxConsecutiveMachineContinuations?: number;
}) {
  return {
    companionId: overrides.companionId ?? COMPANION_A,
    channelId: CHANNEL,
    messageId: overrides.messageId,
    timestampMs: overrides.timestampMs,
    authorIsMachine: overrides.authorIsMachine ?? false,
    nowMs: overrides.nowMs ?? NOW,
    maxContinuationCandidates: overrides.maxContinuationCandidates ?? 6,
    maxConsecutiveMachineContinuations: overrides.maxConsecutiveMachineContinuations ?? 2,
  };
}

describe('room participation lease store integration', () => {
  it(
    'survives a restart with the exact watermark and never re-considers a message',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'reply',
          watermarkMessageId: 'msg-0',
          watermarkTimestampMs: NOW - 1_000,
          authorIsMachine: false,
          nowMs: NOW,
          expiresAtMs: NOW + TTL_MS,
        });
        const claimed = await store.claimContinuation(
          claimInput({ messageId: 'msg-1', timestampMs: NOW + 1_000 }),
        );
        expect(claimed?.consideredCount).toBe(1);
        expect(claimed?.watermarkMessageId).toBe('msg-1');
      } finally {
        await store.shutdown();
      }

      // A fresh process (new pool, no in-memory state) resumes the conversation.
      const restarted = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        const resumed = await restarted.read({
          companionId: COMPANION_A,
          channelId: CHANNEL,
        });
        expect(resumed?.status).toBe('active');
        expect(resumed?.openedDisposition).toBe('reply');
        expect(resumed?.watermarkMessageId).toBe('msg-1');
        expect(resumed?.watermarkTimestampMs).toBe(NOW + 1_000);
        expect(resumed?.consideredCount).toBe(1);

        // The already-considered message is refused after the restart ...
        expect(await restarted.claimContinuation(
          claimInput({ messageId: 'msg-1', timestampMs: NOW + 1_000, nowMs: NOW + 2_000 }),
        )).toBeNull();
        // ... and so is anything at or behind the durable watermark ...
        expect(await restarted.claimContinuation(
          claimInput({ messageId: 'msg-0', timestampMs: NOW - 1_000, nowMs: NOW + 2_000 }),
        )).toBeNull();
        // ... while the conversation genuinely continues forward.
        const next = await restarted.claimContinuation(
          claimInput({ messageId: 'msg-2', timestampMs: NOW + 2_000, nowMs: NOW + 2_000 }),
        );
        expect(next?.consideredCount).toBe(2);
        expect(next?.watermarkMessageId).toBe('msg-2');
      } finally {
        await restarted.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'admits one claim per physical message under concurrency',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'reaction',
          watermarkMessageId: 'msg-0',
          watermarkTimestampMs: NOW - 1_000,
          authorIsMachine: false,
          nowMs: NOW,
          expiresAtMs: NOW + TTL_MS,
        });
        const results = await Promise.all([
          store.claimContinuation(claimInput({ messageId: 'msg-1', timestampMs: NOW + 1 })),
          store.claimContinuation(claimInput({ messageId: 'msg-1', timestampMs: NOW + 1 })),
          store.claimContinuation(claimInput({ messageId: 'msg-1', timestampMs: NOW + 1 })),
        ]);
        expect(results.filter(result => result !== null)).toHaveLength(1);
        const lease = await store.read({ companionId: COMPANION_A, channelId: CHANNEL });
        expect(lease?.consideredCount).toBe(1);
      } finally {
        await store.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'enforces the bounded budget, the bot-loop fence, and the lapsed deadline in SQL',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'reply',
          watermarkMessageId: 'msg-0',
          watermarkTimestampMs: NOW - 1_000,
          authorIsMachine: false,
          nowMs: NOW,
          expiresAtMs: NOW + TTL_MS,
        });
        // Budget: the cap is re-checked inside the claim, not only by the caller.
        expect(await store.claimContinuation(claimInput({
          messageId: 'msg-1',
          timestampMs: NOW + 1_000,
          maxContinuationCandidates: 1,
        }))).not.toBeNull();
        expect(await store.claimContinuation(claimInput({
          messageId: 'msg-2',
          timestampMs: NOW + 2_000,
          maxContinuationCandidates: 1,
        }))).toBeNull();

        // Bot-loop fence: consecutive machine authors accumulate, a human clears.
        const machineOne = await store.claimContinuation(claimInput({
          messageId: 'msg-3',
          timestampMs: NOW + 3_000,
          authorIsMachine: true,
        }));
        expect(machineOne?.machineStreak).toBe(1);
        const machineTwo = await store.claimContinuation(claimInput({
          messageId: 'msg-4',
          timestampMs: NOW + 4_000,
          authorIsMachine: true,
        }));
        expect(machineTwo?.machineStreak).toBe(2);
        expect(await store.claimContinuation(claimInput({
          messageId: 'msg-5',
          timestampMs: NOW + 5_000,
          authorIsMachine: true,
        }))).toBeNull();
        const human = await store.claimContinuation(claimInput({
          messageId: 'msg-6',
          timestampMs: NOW + 6_000,
        }));
        expect(human?.machineStreak).toBe(0);

        // A lapsed deadline neither claims nor refreshes: membership is over.
        const lapsed = NOW + TTL_MS + 1;
        expect(await store.claimContinuation(claimInput({
          messageId: 'msg-7',
          timestampMs: lapsed,
          nowMs: lapsed,
        }))).toBeNull();
        expect(await store.refresh({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          nowMs: lapsed,
          expiresAtMs: lapsed + TTL_MS,
          watermarkMessageId: 'msg-7',
          watermarkTimestampMs: lapsed,
          authorIsMachine: false,
        })).toBeNull();
      } finally {
        await store.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'keeps two companions independent and retires a lease terminally',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        for (const companionId of [COMPANION_A, COMPANION_B]) {
          await store.open({
            companionId,
            channelId: CHANNEL,
            disposition: 'reply',
            watermarkMessageId: 'msg-0',
            watermarkTimestampMs: NOW - 1_000,
            authorIsMachine: false,
            nowMs: NOW,
            expiresAtMs: NOW + TTL_MS,
          });
        }
        // Both may consider the same room message: the shared speaking arbiter,
        // not this lease, decides which of them may actually send.
        expect(await store.claimContinuation(claimInput({
          messageId: 'msg-1',
          timestampMs: NOW + 1_000,
        }))).not.toBeNull();
        expect(await store.claimContinuation(claimInput({
          companionId: COMPANION_B,
          messageId: 'msg-1',
          timestampMs: NOW + 1_000,
        }))).not.toBeNull();

        const closed = await store.close({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          reason: 'withdrawn',
          nowMs: NOW + 2_000,
        });
        expect(closed?.status).toBe('closed');
        expect(closed?.closeReason).toBe('withdrawn');
        // Terminal: a closed lease neither closes again nor claims again.
        expect(await store.close({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          reason: 'expiry',
          nowMs: NOW + 3_000,
        })).toBeNull();
        expect(await store.claimContinuation(claimInput({
          messageId: 'msg-2',
          timestampMs: NOW + 3_000,
        }))).toBeNull();
        // The peer's membership is untouched.
        expect((await store.read({ companionId: COMPANION_B, channelId: CHANNEL }))?.status)
          .toBe('active');

        // Re-opening after withdrawal restores a fresh bounded budget.
        const reopened = await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'endogenous_room_entry',
          watermarkMessageId: 'msg-9',
          watermarkTimestampMs: NOW + 9_000,
          authorIsMachine: false,
          nowMs: NOW + 9_000,
          expiresAtMs: NOW + 9_000 + TTL_MS,
        });
        expect(reopened?.status).toBe('active');
        expect(reopened?.consideredCount).toBe(0);
        expect(reopened?.closeReason).toBeNull();
      } finally {
        await store.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rolls the ignore streak and clears it on a chosen reaction or reply',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'reply',
          watermarkMessageId: 'msg-0',
          watermarkTimestampMs: NOW - 1_000,
          authorIsMachine: false,
          nowMs: NOW,
          expiresAtMs: NOW + TTL_MS,
        });
        const first = await store.recordAppraisal({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          action: 'ignore',
          nowMs: NOW + 1_000,
        });
        expect(first?.ignoreStreak).toBe(1);
        const second = await store.recordAppraisal({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          action: 'ignore',
          nowMs: NOW + 2_000,
        });
        expect(second?.ignoreStreak).toBe(2);
        const engaged = await store.recordAppraisal({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          action: 'reply',
          nowMs: NOW + 3_000,
        });
        expect(engaged?.ignoreStreak).toBe(0);
      } finally {
        await store.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'refuses a machine-authored re-open of a lease the bot-loop fence closed',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'reply',
          watermarkMessageId: 'msg-0',
          watermarkTimestampMs: NOW - 1_000,
          authorIsMachine: false,
          nowMs: NOW,
          expiresAtMs: NOW + TTL_MS,
        });
        // Two sibling-bot continuations spend the fence.
        for (const [index, messageId] of ['msg-1', 'msg-2'].entries()) {
          const claimed = await store.claimContinuation(claimInput({
            messageId,
            timestampMs: NOW + (index + 1) * 1_000,
            authorIsMachine: true,
            nowMs: NOW + (index + 1) * 1_000,
          }));
          expect(claimed?.machineStreak).toBe(index + 1);
        }
        const fenced = await store.close({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          reason: 'machine_streak',
          nowMs: NOW + 3_000,
        });
        expect(fenced?.closeReason).toBe('machine_streak');

        // The regression: a peer bot's own direct summons must not resurrect the
        // lease, and must not zero the streak that fenced it.
        expect(await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'direct_summons',
          watermarkMessageId: 'msg-3',
          watermarkTimestampMs: NOW + 4_000,
          authorIsMachine: true,
          nowMs: NOW + 4_000,
          expiresAtMs: NOW + 4_000 + TTL_MS,
        })).toBeNull();
        const stillFenced = await store.read({
          companionId: COMPANION_A,
          channelId: CHANNEL,
        });
        expect(stillFenced?.status).toBe('closed');
        expect(stillFenced?.closeReason).toBe('machine_streak');
        expect(stillFenced?.machineStreak).toBe(2);

        // Only a human turn re-opens the room, and it resets the fence.
        const reopened = await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'direct_summons',
          watermarkMessageId: 'msg-4',
          watermarkTimestampMs: NOW + 5_000,
          authorIsMachine: false,
          nowMs: NOW + 5_000,
          expiresAtMs: NOW + 5_000 + TTL_MS,
        });
        expect(reopened?.status).toBe('active');
        expect(reopened?.machineStreak).toBe(0);
        expect(reopened?.closeReason).toBeNull();
      } finally {
        await store.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'carries the machine streak through a machine-authored re-open of a lapsed lease',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresRoomParticipationLeaseStore.connect(databaseUrl);
      try {
        await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'reply',
          watermarkMessageId: 'msg-0',
          watermarkTimestampMs: NOW - 1_000,
          authorIsMachine: false,
          nowMs: NOW,
          expiresAtMs: NOW + TTL_MS,
        });
        const claimed = await store.claimContinuation(claimInput({
          messageId: 'msg-1',
          timestampMs: NOW + 1_000,
          authorIsMachine: true,
          nowMs: NOW + 1_000,
        }));
        expect(claimed?.machineStreak).toBe(1);
        await store.close({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          reason: 'silence',
          nowMs: NOW + 2_000,
        });
        // A lapse is not the fence, so a machine-authored disposition may
        // re-open — but it re-enters mid-fence rather than with a clean slate.
        const reopened = await store.open({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          disposition: 'endogenous_room_entry',
          watermarkMessageId: 'msg-2',
          watermarkTimestampMs: NOW + 3_000,
          authorIsMachine: true,
          nowMs: NOW + 3_000,
          expiresAtMs: NOW + 3_000 + TTL_MS,
        });
        expect(reopened?.status).toBe('active');
        expect(reopened?.consideredCount).toBe(0);
        expect(reopened?.machineStreak).toBe(1);

        // The refresh path keeps the same rule for the withdrawal streak.
        await store.recordAppraisal({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          action: 'ignore',
          nowMs: NOW + 4_000,
        });
        const machineRefreshed = await store.refresh({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          nowMs: NOW + 5_000,
          expiresAtMs: NOW + 5_000 + TTL_MS,
          watermarkMessageId: 'msg-3',
          watermarkTimestampMs: NOW + 5_000,
          authorIsMachine: true,
        });
        expect(machineRefreshed?.ignoreStreak).toBe(1);
        const humanRefreshed = await store.refresh({
          companionId: COMPANION_A,
          channelId: CHANNEL,
          nowMs: NOW + 6_000,
          expiresAtMs: NOW + 6_000 + TTL_MS,
          watermarkMessageId: 'msg-4',
          watermarkTimestampMs: NOW + 6_000,
          authorIsMachine: false,
        });
        expect(humanRefreshed?.ignoreStreak).toBe(0);
      } finally {
        await store.shutdown();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { planBuzzCausalReply } from './causal-policy.js';
import { createBuzzCausalReplyTags, createBuzzStreamEvent } from './protocol.js';
import { InMemoryBuzzRecoveryStore } from './recovery-store.js';

const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';

describe('Buzz autonomous causal policy', () => {
  it('structurally terminates a two-companion ping-pong at the signed hop bound', () => {
    const firstKey = generateSecretKey();
    const secondKey = generateSecretKey();
    const firstPubkey = getPublicKey(firstKey);
    const secondPubkey = getPublicKey(secondKey);
    const machineAuthors = new Set([firstPubkey, secondPubkey]);
    const rootEventId = 'f'.repeat(64);
    const first = createBuzzStreamEvent({
      channelId: CHANNEL_ID,
      content: 'Can you take this?',
      tags: createBuzzCausalReplyTags({
        rootEventId,
        parentEventId: rootEventId,
        hop: 1,
        recipientPubkeys: [secondPubkey],
      }),
      privateKey: firstKey,
    });
    const secondPlan = planBuzzCausalReply({
      event: first,
      companionPubkey: secondPubkey,
      machineAuthorPubkeys: machineAuthors,
      maxAutonomousReplyHops: 3,
      noInformationAcknowledgements: new Set(['acknowledged']),
    });
    expect(secondPlan.plan?.hop).toBe(2);

    const second = createBuzzStreamEvent({
      channelId: CHANNEL_ID,
      content: 'I found one issue; can you check it?',
      tags: createBuzzCausalReplyTags(secondPlan.plan!),
      privateKey: secondKey,
    });
    const thirdPlan = planBuzzCausalReply({
      event: second,
      companionPubkey: firstPubkey,
      machineAuthorPubkeys: machineAuthors,
      maxAutonomousReplyHops: 3,
      noInformationAcknowledgements: new Set(['acknowledged']),
    });
    expect(thirdPlan.plan?.hop).toBe(3);

    const third = createBuzzStreamEvent({
      channelId: CHANNEL_ID,
      content: 'That issue is confirmed.',
      tags: createBuzzCausalReplyTags(thirdPlan.plan!),
      privateKey: firstKey,
    });
    expect(planBuzzCausalReply({
      event: third,
      companionPubkey: secondPubkey,
      machineAuthorPubkeys: machineAuthors,
      maxAutonomousReplyHops: 3,
      noInformationAcknowledgements: new Set(['acknowledged']),
    })).toEqual({ suppress: 'autonomous_hop_limit' });
  });

  it('claims one causal edge even when distinct events repeat it', async () => {
    const store = new InMemoryBuzzRecoveryStore();
    const rootEventId = 'a'.repeat(64);
    await store.registerHumanRoot({
      eventId: rootEventId,
      channelId: CHANNEL_ID,
      authorPubkey: 'b'.repeat(64),
    });
    const edge = {
      rootEventId,
      channelId: CHANNEL_ID,
      parentEventId: rootEventId,
      hop: 1,
      authorPubkey: 'c'.repeat(64),
      eventId: 'd'.repeat(64),
    };
    await expect(store.claimCausalEvent(edge)).resolves.toBe('claimed');
    await expect(store.claimCausalEvent({ ...edge, eventId: 'e'.repeat(64) }))
      .resolves.toBe('duplicate');
  });
});

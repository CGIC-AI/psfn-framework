// psfn-framework-qgqw.2 — deferred-extraction epoch provenance regression.
//
// Proves that `collectDisclosureMemorySources` anchors a retrieved memory's
// source-channel classification epoch to the CONVERSATION instant
// (`provenance.sourceConversationAt`), not the extraction instant
// (`extractedAt`). The bug: a memory formed in an invite_only room, then
// extracted AFTER an invite_only → public demotion (deferred sleeptime
// extraction across a restart), was stamped with the CURRENT (widened) epoch and
// became auto-eligible to the now-public room — contrary to bible §9.3 (content
// admitted under epoch N must not auto-flow after widening).
//
// Also covers the mainline control (contemporaneous extraction is unchanged) and
// the legacy-provenance control (absent conversation instant fails closed and is
// NEVER coerced to `extractedAt`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDisclosureMemorySources } from './active-context-refresh.js';
import type { ScoredMemory } from './types.js';
import type { PurrMemory, MemoryProvenance } from '../types.js';
import {
  channelClassificationEpochAsOf,
  resetRuntimeChannelClassificationEpochs,
  setRuntimeChannelClassificationEpochs,
} from '../../../system/trust/runtime-classification-epochs.js';
import { DEMOTION_EPOCH_NOTICE_VERSION } from '../../../system/trust/context-envelope.js';
import type { ChannelClassificationEpoch } from '../../../system/trust/context-envelope.js';
import type { DisclosureDestinationConstraint, DisclosureDestination } from '../../../core/cogsec/disclosure/contracts.js';
import { destinationEpochEligible } from '../../../core/cogsec/disclosure/decision.js';

const CHANNEL = 'room:project';
const DEMOTION_1 = Date.parse('2026-02-01T00:00:00.000Z');
const DEMOTION_2 = Date.parse('2026-04-01T00:00:00.000Z');

function demotion(at: number): ChannelClassificationEpoch {
  return {
    channelId: CHANNEL,
    from: 'invite_only',
    to: 'public',
    at: new Date(at).toISOString(),
    acceptedBy: 'operator:test',
    noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
  };
}

function scoredMemory(input: {
  extractedAt: number;
  provenance: MemoryProvenance;
}): ScoredMemory {
  const memory: PurrMemory = {
    id: 'mem-1',
    text: 'partner mentioned a private detail',
    type: 'semantic',
    importance: 0.6,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.6,
    sourceRef: 'source:session|operation:extract',
    extractedAt: input.extractedAt,
    lastAccessed: input.extractedAt,
    accessCount: 0,
    tags: [],
    sensitivity: 'public',
    provenance: input.provenance,
  };
  return { memory } as unknown as ScoredMemory;
}

/**
 * Reconstruct the public_room permitted-destination constraint the disclosure
 * seam (`scopedRoomConstraint`) builds from a collected memory source, so the
 * epoch the collector stamped is exercised through the real gate.
 */
function publicRoomConstraint(epoch: number | undefined): DisclosureDestinationConstraint {
  return epoch !== undefined
    ? { kind: 'public_room', channelIds: [CHANNEL], channelEpochs: { [CHANNEL]: epoch } }
    : { kind: 'public_room', channelIds: [CHANNEL] };
}

function widenedRoom(currentEpoch: number): DisclosureDestination {
  return { kind: 'public_room', channelId: CHANNEL, currentEpoch };
}

beforeEach(() => {
  resetRuntimeChannelClassificationEpochs();
});

afterEach(() => {
  resetRuntimeChannelClassificationEpochs();
});

describe('collectDisclosureMemorySources epoch provenance (psfn-framework-qgqw.2)', () => {
  it('stamps the conversation-time epoch for a memory extracted AFTER a later demotion (deferred extraction)', () => {
    // Two demotions: the conversation happened between them (epoch 1); the
    // deferred extraction ran after the second demotion (extraction-time epoch 2).
    setRuntimeChannelClassificationEpochs([demotion(DEMOTION_1), demotion(DEMOTION_2)]);

    const conversationAt = DEMOTION_1 + 60_000; // between D1 and D2 → epoch 1
    const extractedAt = DEMOTION_2 + 60_000; // after D2 → epoch 2

    // Sanity: the buggy extraction-time anchor would have resolved epoch 2.
    expect(channelClassificationEpochAsOf(CHANNEL, new Date(extractedAt))).toBe(2);

    const sources = collectDisclosureMemorySources({
      selectedForPrompt: [scoredMemory({
        extractedAt,
        provenance: { channelId: CHANNEL, sourceConversationAt: conversationAt },
      })],
      emotionalContinuityMemories: [],
    });

    expect(sources).toHaveLength(1);
    // Anchored to the CONVERSATION instant → epoch 1, NOT the extraction epoch 2.
    expect(sources[0].sourceChannelEpoch).toBe(1);
    expect(sources[0].sourceChannelId).toBe(CHANNEL);

    // The room has since widened to epoch 2 → the pre-widening memory is denied.
    const eligible = destinationEpochEligible(
      [publicRoomConstraint(sources[0].sourceChannelEpoch)],
      widenedRoom(2),
    );
    expect(eligible).toBe(false);
  });

  it('is unchanged for a mainline (contemporaneous) extraction — content still flows to its room', () => {
    setRuntimeChannelClassificationEpochs([demotion(DEMOTION_1)]);

    // Conversation and extraction both after the demotion → epoch 1, room at 1.
    const conversationAt = DEMOTION_1 + 60_000;
    const extractedAt = DEMOTION_1 + 120_000;

    const sources = collectDisclosureMemorySources({
      selectedForPrompt: [scoredMemory({
        extractedAt,
        provenance: { channelId: CHANNEL, sourceConversationAt: conversationAt },
      })],
      emotionalContinuityMemories: [],
    });

    expect(sources[0].sourceChannelEpoch).toBe(1);
    // Identical to what the pre-fix extraction-time anchor produced when the two
    // instants share an epoch (no deferral) — no behavior change on the mainline.
    expect(sources[0].sourceChannelEpoch)
      .toBe(channelClassificationEpochAsOf(CHANNEL, new Date(extractedAt)));
    expect(destinationEpochEligible([publicRoomConstraint(1)], widenedRoom(1))).toBe(true);
  });

  it('fails closed for legacy provenance lacking sourceConversationAt (never coerces to extractedAt)', () => {
    setRuntimeChannelClassificationEpochs([demotion(DEMOTION_1)]);

    const extractedAt = DEMOTION_1 + 60_000; // extraction-time anchor would resolve epoch 1

    // Prove the buggy fallback WOULD have widened this legacy memory.
    expect(channelClassificationEpochAsOf(CHANNEL, new Date(extractedAt))).toBe(1);

    const sources = collectDisclosureMemorySources({
      selectedForPrompt: [scoredMemory({
        extractedAt,
        provenance: { channelId: CHANNEL }, // no sourceConversationAt (legacy)
      })],
      emotionalContinuityMemories: [],
    });

    // Absent conversation instant ⇒ NO epoch stamped (undefined), not epoch 1.
    expect(sources[0].sourceChannelEpoch).toBeUndefined();
    // Unknown admitted epoch against an epoch-tracked room → denied (fail closed).
    expect(destinationEpochEligible([publicRoomConstraint(undefined)], widenedRoom(1))).toBe(false);
  });

  it('stays inert (byte-identical) for a memory whose channel was never demoted', () => {
    // No epoch records for the channel at all.
    const sources = collectDisclosureMemorySources({
      selectedForPrompt: [scoredMemory({
        extractedAt: DEMOTION_2,
        provenance: { channelId: CHANNEL, sourceConversationAt: DEMOTION_1 },
      })],
      emotionalContinuityMemories: [],
    });

    // Untracked channel → undefined epoch, and the gate is skipped for an
    // untracked destination (no currentEpoch), so nothing changes vs pre-epoch.
    expect(sources[0].sourceChannelEpoch).toBeUndefined();
    expect(destinationEpochEligible(
      [publicRoomConstraint(undefined)],
      { kind: 'public_room', channelId: CHANNEL },
    )).toBe(true);
  });
});

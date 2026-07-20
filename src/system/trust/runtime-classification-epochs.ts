// ── Runtime channel classification epochs (jp36.6.4) ──
// Process-wide holder for the channels.json `contextEnvelope.classificationEpochs`
// records, mirroring the runtime-channel-labels.ts pattern. Startup hydration
// loads channels.json fail-closed (loadRuntimeChannelsConfig ->
// parseContextEnvelopeSection) and publishes the validated epoch records here;
// the disclosure egress resolver and the generation-lineage epoch params consume
// them to enforce the invite-only → public demotion boundary (bible §9.3,
// enforced by the pure decision layer in jp36.6.3).
//
// This module owns ONLY the derivation of a channel's classification epoch from
// the persisted records — it feeds jp36.6.3's inputs and introduces no new epoch
// semantics. A channel with no records is UNTRACKED (undefined epoch), which
// keeps jp36.6.3's destination gate inert, so the runtime behaves byte-identically
// to the pre-epoch code for every channel that was never demoted.

import type { ChannelClassificationEpoch } from './context-envelope.js';

const EMPTY_EPOCHS: readonly ChannelClassificationEpoch[] = Object.freeze([]);

let activeEpochs: readonly ChannelClassificationEpoch[] = EMPTY_EPOCHS;

export function getRuntimeChannelClassificationEpochs(): readonly ChannelClassificationEpoch[] {
  return activeEpochs;
}

export function setRuntimeChannelClassificationEpochs(
  epochs: readonly ChannelClassificationEpoch[],
): void {
  activeEpochs = Object.freeze([...epochs]);
}

export function resetRuntimeChannelClassificationEpochs(): void {
  activeEpochs = EMPTY_EPOCHS;
}

/**
 * Pure derivation of the classification epoch a channel is at, given the full
 * persisted epoch-record set and an optional as-of boundary.
 *
 * Monotonic count model (jp36.6.3): every gated invite-only → public demotion
 * appends exactly one record and bumps the epoch by one. The epoch as-of an
 * instant is the count of that channel's records whose boundary `at` is at or
 * before the instant:
 *
 *   - No records at or before the boundary → `undefined` (the channel is not
 *     epoch-tracked as of that instant). `undefined` keeps jp36.6.3's
 *     destination-eligibility gate inert, so channels with no epoch history — and
 *     content admitted before a channel's first demotion — behave byte-identically
 *     to the pre-epoch runtime.
 *   - N records → N (a 1-based count; the first demotion is epoch 1).
 *
 * `asOf` omitted counts every record (the channel's CURRENT epoch — records are
 * only ever written at a past acceptance instant). A supplied `asOf` with an
 * unusable time fails closed to `undefined` rather than over-counting.
 */
export function deriveChannelClassificationEpoch(
  epochs: readonly ChannelClassificationEpoch[],
  channelId: string,
  asOf?: Date,
): number | undefined {
  const id = channelId.trim();
  if (!id) return undefined;

  let boundaryMs: number | undefined;
  if (asOf !== undefined) {
    boundaryMs = asOf.getTime();
    // An unusable formation boundary must not silently count every record (that
    // would stamp the current epoch onto content whose admission instant is
    // unknown, over-sharing prior-epoch material). Fail closed to UNKNOWN.
    if (!Number.isFinite(boundaryMs)) return undefined;
  }

  let count = 0;
  for (const epoch of epochs) {
    if (epoch.channelId !== id) continue;
    if (boundaryMs !== undefined) {
      const atMs = Date.parse(epoch.at);
      if (Number.isNaN(atMs) || atMs > boundaryMs) continue;
    }
    count += 1;
  }
  return count === 0 ? undefined : count;
}

/**
 * The channel's CURRENT classification epoch from the runtime-published records,
 * or `undefined` when the channel has no epoch history (untracked). Fed to the
 * egress `ChannelDisclosureResolver` (destination `currentEpoch`) and to a turn's
 * own session-history lineage (`conversationChannelEpoch`).
 */
export function currentChannelClassificationEpoch(channelId: string): number | undefined {
  return deriveChannelClassificationEpoch(activeEpochs, channelId);
}

/**
 * The classification epoch the channel was at as-of `asOf` from the
 * runtime-published records, or `undefined` when the channel had no epoch history
 * by then. Fed to a retrieved memory's `sourceChannelEpoch` using the memory's
 * formation instant, so pre-demotion material carries its old (lower / absent)
 * epoch and is denied auto-share to the since-demoted room.
 */
export function channelClassificationEpochAsOf(
  channelId: string,
  asOf: Date,
): number | undefined {
  return deriveChannelClassificationEpoch(activeEpochs, channelId, asOf);
}

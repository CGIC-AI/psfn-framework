// ── EmoSim felt impulse -> per-contact social pressure (psfn-framework-vcq8v.4) ──
//
// A qualified EmoSim `would_message` impulse ("I want to talk to someone") is
// felt state without a contact. Outreach is decided per contact, so the impulse
// does not open its own disposition any more: it adds warm pressure to the
// contacts the companion already has live social desire for (see
// social-desire-impulse.ts) and asks the social-desire lane to evaluate them
// now instead of on its next poll. Each contact whose pressure is then eligible
// gets its own fresh outreach turn in its own channel.
//
// The content-free ledger records every impulse exactly once. A replayed
// impulse never boosts twice: a replay of an impulse that was interrupted
// mid-application settles as `interrupted` rather than re-applying gain.

import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { applySocialDesireImpulseGain } from '../intention/social-desire-impulse.js';
import type { SocialDesireLifecycleConfig } from '../intention/social-desire.js';
import type { SocialDesireStorePort } from '../intention/social-desire-store-port.js';
import type { EmoSimProactivityImpulse } from './emosim-proactivity-port.js';

export type SocialImpulseOutreachMode = 'off' | 'shadow' | 'on';

export const SOCIAL_IMPULSE_LEDGER_STATES = [
  'received',
  'off',
  'shadow',
  'applied',
  'no_live_desire',
  'lane_disabled',
  'interrupted',
] as const;
export type SocialImpulseLedgerState = typeof SOCIAL_IMPULSE_LEDGER_STATES[number];

export interface SocialImpulseLedgerRecord {
  impulseId: string;
  companionId: string;
  firstCrossingMs: number;
  firedAtMs: number;
  confidence: number;
  modeAtReceipt: SocialImpulseOutreachMode;
  state: SocialImpulseLedgerState;
  /** Contacts whose pressure the impulse raised (or would raise, in shadow). */
  boostedContactCount: number;
  reasonCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SocialImpulseOutreachStorePort {
  recordImpulse(record: SocialImpulseLedgerRecord): Promise<{
    created: boolean;
    record: SocialImpulseLedgerRecord;
  }>;
  settleImpulse(input: {
    impulseId: string;
    state: Exclude<SocialImpulseLedgerState, 'received'>;
    boostedContactCount: number;
    reasonCode?: string;
    settledAtMs: number;
  }): Promise<SocialImpulseLedgerRecord>;
}

/** The composed social-desire lane an impulse contributes to. */
export interface SocialImpulseDesireTarget {
  store: Pick<SocialDesireStorePort, 'snapshotDesires' | 'save'>;
  lifecycle: SocialDesireLifecycleConfig;
  gain: number;
  /** Queue an immediate per-contact evaluation after the source turn releases. */
  requestEvaluation(sourceId: string): Promise<void>;
}

export interface SocialImpulseOutreachRuntime {
  onImpulse(impulse: EmoSimProactivityImpulse): Promise<{
    outcome: SocialImpulseLedgerState;
    replayed: boolean;
    record: SocialImpulseLedgerRecord;
  }>;
}

export function createSocialImpulseOutreachRuntime(options: {
  companionId: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
  /** Null when socialDesire.enabled is false: there is no per-contact pressure to raise. */
  getDesireTarget(): SocialImpulseDesireTarget | null;
  now?: () => number;
}): SocialImpulseOutreachRuntime {
  const companionId = requireCompanionId(options.companionId);
  const now = options.now ?? Date.now;
  return {
    async onImpulse(impulse) {
      requireImpulse(impulse, companionId);
      const mode = requireMode(options.getMode());
      const receivedAtMs = now();
      const recorded = await options.store.recordImpulse({
        impulseId: impulse.correlationId,
        companionId,
        firstCrossingMs: impulse.firstCrossingMs,
        firedAtMs: impulse.firedAtMs,
        confidence: impulse.confidence,
        modeAtReceipt: mode,
        state: 'received',
        boostedContactCount: 0,
        reasonCode: null,
        createdAtMs: receivedAtMs,
        updatedAtMs: receivedAtMs,
      });
      const settle = async (
        state: Exclude<SocialImpulseLedgerState, 'received'>,
        boostedContactCount: number,
        reasonCode?: string,
      ) => await options.store.settleImpulse({
        impulseId: impulse.correlationId,
        state,
        boostedContactCount,
        ...(reasonCode ? { reasonCode } : {}),
        settledAtMs: now(),
      });
      if (!recorded.created) {
        if (recorded.record.state !== 'received') {
          return { outcome: recorded.record.state, replayed: true, record: recorded.record };
        }
        const interrupted = await settle('interrupted', 0, 'replayed_before_settlement');
        return { outcome: 'interrupted', replayed: true, record: interrupted };
      }
      if (mode === 'off') {
        return { outcome: 'off', replayed: false, record: await settle('off', 0, 'outreach_off') };
      }
      const target = options.getDesireTarget();
      if (!target) {
        const record = await settle('lane_disabled', 0, 'social_desire_disabled');
        return { outcome: 'lane_disabled', replayed: false, record };
      }
      const boosts = applySocialDesireImpulseGain(
        target.store.snapshotDesires(),
        { confidence: impulse.confidence, gain: target.gain },
        target.lifecycle,
        receivedAtMs,
      );
      if (boosts.length === 0) {
        const record = await settle('no_live_desire', 0);
        return { outcome: 'no_live_desire', replayed: false, record };
      }
      if (mode === 'shadow') {
        const record = await settle('shadow', boosts.length);
        return { outcome: 'shadow', replayed: false, record };
      }
      for (const boost of boosts) await target.store.save(boost.desire);
      const record = await settle('applied', boosts.length);
      await target.requestEvaluation(impulse.correlationId);
      return { outcome: 'applied', replayed: false, record };
    },
  };
}

function requireCompanionId(value: string): string {
  const companionId = value.trim();
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('social impulse outreach requires a lowercase RFC-4122 companionId');
  }
  return companionId;
}

function requireMode(value: unknown): SocialImpulseOutreachMode {
  if (value !== 'off' && value !== 'shadow' && value !== 'on') {
    throw new Error('social impulse outreach mode must be off, shadow, or on');
  }
  return value;
}

function requireImpulse(impulse: EmoSimProactivityImpulse, companionId: string): void {
  const boundary = impulse as { kind: unknown; authority: unknown };
  if (impulse.companionId !== companionId
    || boundary.kind !== 'would_message'
    || boundary.authority !== 'qualified_source_fire'
    || impulse.correlationId !== impulse.dedupeKey
    || !impulse.correlationId.startsWith('felt-impulse:would_message:')) {
    throw new Error('social impulse outreach requires an owned qualified would_message impulse');
  }
}

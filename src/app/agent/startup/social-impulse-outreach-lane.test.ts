import { describe, expect, it, vi } from 'vitest';
import type { EmoSimProactivityImpulse } from '../../../core/emotion/emosim-proactivity-port.js';
import type {
  SocialImpulseLedgerRecord,
  SocialImpulseOutreachStorePort,
} from '../../../core/emotion/social-impulse-outreach.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
} from '../../../core/intention/social-desire-store-port.js';
import { DEFAULT_SOCIAL_DESIRE_CONFIG } from '../../../system/config/scheduler-config/social-desire.js';
import { registerSocialImpulseOutreachLane } from './social-impulse-outreach-lane.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const NOW_MS = 1_780_000_000_000;

function impulse(firstCrossingMs: number): EmoSimProactivityImpulse {
  const correlationId = `felt-impulse:would_message:${firstCrossingMs}`;
  return {
    schemaVersion: 1,
    impulseVersion: 'emosim-proactivity.impulse.v1',
    kind: 'would_message',
    companionId: COMPANION_ID,
    source: { model: 'test', version: '1' },
    lineage: {
      schemaVersion: 1, inputId: `input-${firstCrossingMs}`, projectionVersion: 'v1',
      privacyClass: 'content_redacted', rawContentRedacted: true,
    },
    firstCrossingMs,
    firedAtMs: firstCrossingMs,
    thresholdProfile: {} as EmoSimProactivityImpulse['thresholdProfile'],
    dedupeKey: correlationId,
    correlationId,
    confidence: 1,
    availability: 'available',
    authority: 'qualified_source_fire',
  };
}

function ledger(): SocialImpulseOutreachStorePort {
  const rows = new Map<string, SocialImpulseLedgerRecord>();
  return {
    async recordImpulse(record) {
      const prior = rows.get(record.impulseId);
      if (prior) return { created: false, record: prior };
      rows.set(record.impulseId, record);
      return { created: true, record };
    },
    async settleImpulse(input) {
      const settled = {
        ...rows.get(input.impulseId)!,
        state: input.state,
        boostedContactCount: input.boostedContactCount,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.settledAtMs,
      };
      rows.set(input.impulseId, settled);
      return settled;
    },
  };
}

describe('social impulse outreach startup lane', () => {
  it('settles impulses fail-closed until the social-desire lane binds its per-contact target', async () => {
    const lane = registerSocialImpulseOutreachLane({
      companionId: COMPANION_ID,
      store: ledger(),
      getMode: () => 'on',
    });
    await expect(lane.runtime.onImpulse(impulse(NOW_MS))).resolves.toMatchObject({ outcome: 'lane_disabled' });

    const at = new Date().toISOString();
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend([{
      contactId: 'contact-1', warmPressure: 0.5, repairPressure: 0, pressureAnchorAt: at,
      lastWarmFeltAt: at, lastWarmTickAt: at, tickCount: 1, absorbedSignalCount: 0,
      tierAtLastTick: 'partner', reinforcedConcernIds: [], createdAt: at,
    }]));
    const requestEvaluation = vi.fn(async () => undefined);
    lane.setDesireTarget({
      store,
      lifecycle: DEFAULT_SOCIAL_DESIRE_CONFIG.lifecycle,
      gain: DEFAULT_SOCIAL_DESIRE_CONFIG.impulse.gain,
      requestEvaluation,
    });
    await expect(lane.runtime.onImpulse(impulse(NOW_MS + 1))).resolves.toMatchObject({
      outcome: 'applied',
      record: { boostedContactCount: 1 },
    });
    expect(requestEvaluation).toHaveBeenCalledWith(`felt-impulse:would_message:${NOW_MS + 1}`);
  });
});

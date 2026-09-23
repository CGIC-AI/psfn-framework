import { describe, expect, it } from 'vitest';
import type { EmoSimProactivityImpulse } from '../../core/emotion/emosim-proactivity-port.js';
import type {
  SocialImpulseLedgerRecord,
  SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import { createProductionSocialImpulseOutreachRuntime } from './social-impulse-outreach-runtime.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CROSSING_MS = 1_780_000_000_000;
const IMPULSE_ID = `felt-impulse:would_message:${CROSSING_MS}`;

describe('production social impulse runtime', () => {
  it('never opens a destination choice: an impulse only settles against per-contact pressure', async () => {
    const rows = new Map<string, SocialImpulseLedgerRecord>();
    const store: SocialImpulseOutreachStorePort = {
      async recordImpulse(record) {
        rows.set(record.impulseId, record);
        return { created: true, record };
      },
      async settleImpulse(input) {
        const settled = { ...rows.get(input.impulseId)!, state: input.state, reasonCode: input.reasonCode ?? null };
        rows.set(input.impulseId, settled);
        return settled;
      },
    };
    const runtime = createProductionSocialImpulseOutreachRuntime({
      companionId: COMPANION_ID,
      store,
      getMode: () => 'off',
      getDesireTarget: () => null,
      now: () => CROSSING_MS,
    });
    expect(Object.keys(runtime)).toEqual(['onImpulse']);
    const result = await runtime.onImpulse({
      schemaVersion: 1,
      impulseVersion: 'emosim-proactivity.impulse.v1',
      kind: 'would_message',
      companionId: COMPANION_ID,
      source: { model: 'test', version: '1' },
      lineage: {
        schemaVersion: 1, inputId: 'input', projectionVersion: 'v1',
        privacyClass: 'content_redacted', rawContentRedacted: true,
      },
      firstCrossingMs: CROSSING_MS,
      firedAtMs: CROSSING_MS,
      thresholdProfile: {} as EmoSimProactivityImpulse['thresholdProfile'],
      dedupeKey: IMPULSE_ID,
      correlationId: IMPULSE_ID,
      confidence: 0.7,
      availability: 'available',
      authority: 'qualified_source_fire',
    });
    expect(result).toMatchObject({ outcome: 'off', record: { reasonCode: 'outreach_off' } });
  });
});

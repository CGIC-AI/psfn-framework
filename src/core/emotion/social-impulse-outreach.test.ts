import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOCIAL_DESIRE_CONFIG } from '../../system/config/scheduler-config/social-desire.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
} from '../intention/social-desire-store-port.js';
import type { SocialDesire } from '../intention/social-desire.js';
import type { EmoSimProactivityImpulse } from './emosim-proactivity-port.js';
import {
  createSocialImpulseOutreachRuntime,
  type SocialImpulseLedgerRecord,
  type SocialImpulseOutreachMode,
  type SocialImpulseOutreachStorePort,
} from './social-impulse-outreach.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-09-23T15:00:00.000Z');
const IMPULSE_ID = `felt-impulse:would_message:${T0}`;

function impulse(overrides: Partial<EmoSimProactivityImpulse> = {}): EmoSimProactivityImpulse {
  return {
    schemaVersion: 1,
    impulseVersion: 'emosim-proactivity.impulse.v1',
    kind: 'would_message',
    companionId: COMPANION_ID,
    source: { model: 'test', version: '1' },
    lineage: {
      schemaVersion: 1,
      inputId: 'input-1',
      projectionVersion: 'v1',
      privacyClass: 'content_redacted',
      rawContentRedacted: true,
    },
    firstCrossingMs: T0,
    firedAtMs: T0,
    thresholdProfile: {} as EmoSimProactivityImpulse['thresholdProfile'],
    dedupeKey: IMPULSE_ID,
    correlationId: IMPULSE_ID,
    confidence: 0.5,
    availability: 'available',
    authority: 'qualified_source_fire',
    ...overrides,
  };
}

function memoryLedger(): SocialImpulseOutreachStorePort & { rows: Map<string, SocialImpulseLedgerRecord> } {
  const rows = new Map<string, SocialImpulseLedgerRecord>();
  return {
    rows,
    async recordImpulse(record) {
      const prior = rows.get(record.impulseId);
      if (prior) return { created: false, record: { ...prior } };
      rows.set(record.impulseId, { ...record });
      return { created: true, record: { ...record } };
    },
    async settleImpulse(input) {
      const prior = rows.get(input.impulseId);
      if (!prior || prior.state !== 'received') throw new Error('lost received row');
      const settled = {
        ...prior,
        state: input.state,
        boostedContactCount: input.boostedContactCount,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.settledAtMs,
      };
      rows.set(input.impulseId, settled);
      return { ...settled };
    },
  };
}

function desire(contactId: string, warmPressure: number): SocialDesire {
  const at = new Date(T0).toISOString();
  return {
    contactId, warmPressure, repairPressure: 0, pressureAnchorAt: at,
    lastWarmFeltAt: at, lastWarmTickAt: at, tickCount: 1, absorbedSignalCount: 0,
    tierAtLastTick: 'friend', reinforcedConcernIds: [], createdAt: at,
  };
}

function setup(mode: SocialImpulseOutreachMode, desires: SocialDesire[] = [desire('contact-1', 0.4)]) {
  const ledger = memoryLedger();
  const store = createSocialDesireStorePort(createInMemorySocialDesireBackend(desires));
  const requestEvaluation = vi.fn(async () => undefined);
  const runtime = createSocialImpulseOutreachRuntime({
    companionId: COMPANION_ID,
    store: ledger,
    getMode: () => mode,
    getDesireTarget: () => ({
      store,
      lifecycle: DEFAULT_SOCIAL_DESIRE_CONFIG.lifecycle,
      gain: 0.4,
      requestEvaluation,
    }),
    now: () => T0,
  });
  return { ledger, store, requestEvaluation, runtime };
}

describe('social impulse -> per-contact pressure', () => {
  it('raises live per-contact pressure once and requests that contact\'s evaluation', async () => {
    const { runtime, store, requestEvaluation, ledger } = setup('on');
    const result = await runtime.onImpulse(impulse());
    expect(result).toMatchObject({ outcome: 'applied', replayed: false });
    expect(result.record.boostedContactCount).toBe(1);
    expect((await store.getByContactId('contact-1'))!.warmPressure).toBeCloseTo(0.4 + 0.4 * 0.5, 10);
    expect(requestEvaluation).toHaveBeenCalledWith(IMPULSE_ID);

    const replay = await runtime.onImpulse(impulse());
    expect(replay).toMatchObject({ outcome: 'applied', replayed: true });
    expect((await store.getByContactId('contact-1'))!.warmPressure).toBeCloseTo(0.6, 10);
    expect(requestEvaluation).toHaveBeenCalledTimes(1);
    expect(ledger.rows.size).toBe(1);
  });

  it('never re-applies an impulse that was interrupted before settlement', async () => {
    const { runtime, ledger, store } = setup('on');
    ledger.rows.set(IMPULSE_ID, {
      impulseId: IMPULSE_ID, companionId: COMPANION_ID, firstCrossingMs: T0, firedAtMs: T0,
      confidence: 0.5, modeAtReceipt: 'on', state: 'received', boostedContactCount: 0,
      reasonCode: null, createdAtMs: T0, updatedAtMs: T0,
    });
    await expect(runtime.onImpulse(impulse())).resolves.toMatchObject({ outcome: 'interrupted', replayed: true });
    expect((await store.getByContactId('contact-1'))!.warmPressure).toBe(0.4);
  });

  it('observes without changing pressure in shadow mode and does nothing when off', async () => {
    const shadow = setup('shadow');
    await expect(shadow.runtime.onImpulse(impulse())).resolves.toMatchObject({ outcome: 'shadow' });
    expect((await shadow.store.getByContactId('contact-1'))!.warmPressure).toBe(0.4);
    expect(shadow.requestEvaluation).not.toHaveBeenCalled();

    const off = setup('off');
    await expect(off.runtime.onImpulse(impulse())).resolves.toMatchObject({ outcome: 'off' });
    expect(off.requestEvaluation).not.toHaveBeenCalled();
  });

  it('never manufactures a desire from a contact-less impulse', async () => {
    const { runtime, store, requestEvaluation } = setup('on', []);
    await expect(runtime.onImpulse(impulse())).resolves.toMatchObject({ outcome: 'no_live_desire' });
    expect(store.snapshotDesires()).toEqual([]);
    expect(requestEvaluation).not.toHaveBeenCalled();
  });

  it('settles fail-closed when the social-desire lane is not composed', async () => {
    const ledger = memoryLedger();
    const runtime = createSocialImpulseOutreachRuntime({
      companionId: COMPANION_ID, store: ledger, getMode: () => 'on',
      getDesireTarget: () => null, now: () => T0,
    });
    await expect(runtime.onImpulse(impulse())).resolves.toMatchObject({
      outcome: 'lane_disabled',
      record: { reasonCode: 'social_desire_disabled' },
    });
  });

  it('rejects impulses it does not own', async () => {
    const { runtime } = setup('on');
    await expect(runtime.onImpulse(impulse({ companionId: '22222222-2222-4222-8222-222222222222' })))
      .rejects.toThrow(/owned qualified would_message impulse/);
  });
});

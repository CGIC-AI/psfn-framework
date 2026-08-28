import { describe, expect, it, vi } from 'vitest';
import type { EmoSimProactivityImpulse } from './emosim-proactivity-port.js';
import {
  SOCIAL_IMPULSE_DISPOSITIONS,
  createSocialImpulseOutreachRuntime,
  type SocialImpulseOutreachDestination,
  type SocialImpulseOutreachRecord,
  type SocialImpulseOutreachStorePort,
} from './social-impulse-outreach.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const DYAD_ID = '22222222-2222-4222-8222-222222222222';
const PEER_COMPANION_ID = '33333333-3333-4333-8333-333333333333';
const FIRED_AT_MS = 1_780_000_000_000;

function impulse(): EmoSimProactivityImpulse {
  return {
    schemaVersion: 1,
    impulseVersion: 'emosim-proactivity.impulse.v1',
    kind: 'would_message',
    companionId: COMPANION_ID,
    source: { model: 'derived-model', version: '1.0.0' },
    lineage: {
      schemaVersion: 1,
      inputId: 'sanitized-input-1',
      projectionVersion: 'projection-v1',
      privacyClass: 'restricted',
      rawContentRedacted: true,
    },
    firstCrossingMs: FIRED_AT_MS,
    firedAtMs: FIRED_AT_MS,
    thresholdProfile: {
      profileId: 'profile-a',
      socialNeedThreshold: 0.7,
      attachmentIntensityThreshold: 0.8,
      sustainMs: 10,
      cooldownMs: 20,
    },
    dedupeKey: `felt-impulse:would_message:${FIRED_AT_MS}`,
    correlationId: `felt-impulse:would_message:${FIRED_AT_MS}`,
    confidence: 0.9,
    availability: 'available',
    authority: 'qualified_source_fire',
  };
}

function destinations(): SocialImpulseOutreachDestination[] {
  return [
    {
      kind: 'human_dm',
      destinationId: 'human:contact-a:discord:dm-a',
      contactId: 'contact-a',
      displayLabel: 'A trusted person',
      channelId: 'dm-a',
      channelType: 'discord',
      dyadId: null,
    },
    {
      kind: 'open_companion_dyad',
      destinationId: `companion-dyad:${DYAD_ID}`,
      contactId: 'contact-b',
      displayLabel: 'A companion peer',
      channelId: `companion-dm:${COMPANION_ID}:${PEER_COMPANION_ID}`,
      channelType: 'companion',
      dyadId: DYAD_ID,
    },
    {
      kind: 'companion_first_contact',
      destinationId: 'companion-first:contact-c',
      contactId: 'contact-c',
      displayLabel: 'A new companion peer',
      channelId: null,
      channelType: 'companion',
      dyadId: null,
    },
    {
      kind: 'room',
      destinationId: 'room:discord:room-a',
      displayLabel: 'A Discord room',
      channelId: 'room-a',
      channelType: 'discord',
      dyadId: null,
    },
    {
      kind: 'room',
      destinationId: 'room:buzz:room-b',
      displayLabel: 'A Buzz room',
      channelId: 'room-b',
      channelType: 'buzz',
      dyadId: null,
    },
  ];
}

function memoryStore(): SocialImpulseOutreachStorePort & { records: Map<string, SocialImpulseOutreachRecord> } {
  const records = new Map<string, SocialImpulseOutreachRecord>();
  return {
    records,
    async createOpportunity(record) {
      const prior = records.get(record.opportunityId);
      if (prior) return { created: false, record: structuredClone(prior) };
      records.set(record.opportunityId, structuredClone(record));
      return { created: true, record: structuredClone(record) };
    },
    async getOpportunity(opportunityId) {
      const record = records.get(opportunityId);
      return record ? structuredClone(record) : null;
    },
    async claimDisposition(input) {
      const record = records.get(input.opportunityId);
      if (!record) return { outcome: 'unavailable' };
      if (record.bindingHash) {
        return record.bindingHash === input.bindingHash
          ? { outcome: 'replayed', record: structuredClone(record) }
          : { outcome: 'conflict', record: structuredClone(record) };
      }
      const claimed: SocialImpulseOutreachRecord = {
        ...record,
        state: 'chosen',
        disposition: input.disposition,
        destination: input.destination ? structuredClone(input.destination) : null,
        bindingHash: input.bindingHash,
        updatedAtMs: input.claimedAtMs,
      };
      records.set(record.opportunityId, claimed);
      return { outcome: 'claimed', record: structuredClone(claimed) };
    },
    async finalize(input) {
      const record = records.get(input.opportunityId);
      if (!record || record.bindingHash !== input.bindingHash) {
        throw new Error('finalize lost its disposition binding');
      }
      const finalized = {
        ...record,
        state: input.state,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.finalizedAtMs,
      } satisfies SocialImpulseOutreachRecord;
      records.set(record.opportunityId, finalized);
      return structuredClone(finalized);
    },
  };
}

function harness(mode: 'off' | 'shadow' | 'on' = 'on') {
  const store = memoryStore();
  const runDispositionOpportunity = vi.fn(async () => {});
  const execute = vi.fn(async () => ({ outcome: 'delivered' as const }));
  const listDestinations = vi.fn(async () => destinations());
  const runtime = createSocialImpulseOutreachRuntime({
    companionId: COMPANION_ID,
    store,
    getMode: () => mode,
    listDestinations,
    runDispositionOpportunity,
    execute,
    now: () => FIRED_AT_MS + 100,
  });
  return { runtime, store, runDispositionOpportunity, execute, listDestinations };
}

describe('social impulse outreach disposition', () => {
  it('creates exactly one content-free opportunity with the complete bounded choice set', async () => {
    const { runtime, runDispositionOpportunity } = harness();
    const first = await runtime.onImpulse(impulse());
    const replay = await runtime.onImpulse(impulse());

    expect(first.outcome).toBe('created');
    expect(replay.outcome).toBe('replayed');
    expect(runDispositionOpportunity).toHaveBeenCalledTimes(1);
    expect(runDispositionOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      opportunityId: impulse().correlationId,
      dispositions: SOCIAL_IMPULSE_DISPOSITIONS,
    }));
    expect(JSON.stringify(runDispositionOpportunity.mock.calls)).not.toContain('raw private');
  });

  it('off records no actuator and does not open a disposition turn', async () => {
    const { runtime, runDispositionOpportunity, execute } = harness('off');
    const result = await runtime.onImpulse(impulse());
    expect(result).toMatchObject({ outcome: 'off', record: { state: 'off' } });
    expect(runDispositionOpportunity).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('shadow records would-send without invoking a destination executor', async () => {
    const { runtime, execute } = harness('shadow');
    await runtime.onImpulse(impulse());
    const result = await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'contact-human',
      destinationId: 'human:contact-a:discord:dm-a',
      intent: 'Say hello in my own words.',
    });
    expect(result).toMatchObject({ outcome: 'would_send', record: { state: 'would_send' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['contact-human', 'human:contact-a:discord:dm-a', 'human_dm', null],
    ['contact-companion', `companion-dyad:${DYAD_ID}`, 'open_companion_dyad', DYAD_ID],
    ['contact-companion', 'companion-first:contact-c', 'companion_first_contact', null],
    ['join-room', 'room:discord:room-a', 'room', null],
    ['join-room', 'room:buzz:room-b', 'room', null],
  ] as const)(
    'routes %s through the selected canonical %s destination',
    async (disposition, destinationId, kind, dyadId) => {
      const { runtime, execute } = harness('on');
      await runtime.onImpulse(impulse());
      const result = await runtime.choose({
        opportunityId: impulse().correlationId,
        disposition,
        destinationId,
        intent: 'Author an ordinary destination turn from this intent.',
      });
      expect(result).toMatchObject({ outcome: 'delivered', record: { state: 'delivered' } });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        destination: expect.objectContaining({ kind, dyadId }),
      }));
    },
  );

  it.each(['ignore', 'defer', 'other'] as const)('settles %s without any destination action', async disposition => {
    const { runtime, execute } = harness('on');
    await runtime.onImpulse(impulse());
    const result = await runtime.choose({ opportunityId: impulse().correlationId, disposition });
    expect(result).toMatchObject({ outcome: disposition, record: { state: disposition } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when the chosen destination becomes invalid before commit', async () => {
    const { runtime, listDestinations, execute } = harness('on');
    await runtime.onImpulse(impulse());
    listDestinations.mockResolvedValueOnce([]);
    const result = await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'join-room',
      destinationId: 'room:discord:room-a',
      intent: 'Join naturally.',
    });
    expect(result).toMatchObject({
      outcome: 'suppressed',
      reasonCode: 'destination_unavailable',
      record: { state: 'suppressed', destination: null },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('dedupes the exact choice and rejects a conflicting second disposition', async () => {
    const { runtime, execute } = harness('on');
    await runtime.onImpulse(impulse());
    const input = {
      opportunityId: impulse().correlationId,
      disposition: 'contact-companion' as const,
      destinationId: `companion-dyad:${DYAD_ID}`,
      intent: 'Continue this established conversation.',
    };
    await runtime.choose(input);
    await runtime.choose(input);
    await expect(runtime.choose({
      opportunityId: input.opportunityId,
      disposition: 'ignore',
    })).rejects.toThrow(/already has a different disposition/u);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent retries to one in-flight destination execution', async () => {
    const { runtime, execute } = harness('on');
    let finishExecution: (() => void) | undefined;
    execute.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishExecution = resolve; });
      return { outcome: 'delivered' };
    });
    await runtime.onImpulse(impulse());
    const input = {
      opportunityId: impulse().correlationId,
      disposition: 'contact-human' as const,
      destinationId: 'human:contact-a:discord:dm-a',
      intent: 'Say hello in my own words.',
    };

    const first = runtime.choose(input);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const replay = runtime.choose(input);
    finishExecution?.();

    await expect(Promise.all([first, replay])).resolves.toEqual([
      expect.objectContaining({ outcome: 'delivered' }),
      expect.objectContaining({ outcome: 'delivered' }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('records typed suppression from the destination gate stack', async () => {
    const store = memoryStore();
    const runtime = createSocialImpulseOutreachRuntime({
      companionId: COMPANION_ID,
      store,
      getMode: () => 'on',
      listDestinations: async () => destinations(),
      runDispositionOpportunity: async () => {},
      execute: async () => ({ outcome: 'suppressed', reasonCode: 'room_arbiter_denied' }),
      now: () => FIRED_AT_MS + 100,
    });
    await runtime.onImpulse(impulse());
    const result = await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'join-room',
      destinationId: 'room:discord:room-a',
      intent: 'Join naturally.',
    });
    expect(result).toMatchObject({ outcome: 'suppressed', reasonCode: 'room_arbiter_denied' });
  });
});

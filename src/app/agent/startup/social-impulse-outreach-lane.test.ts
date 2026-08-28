import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { EmoSimProactivityImpulse } from '../../../core/emotion/emosim-proactivity-port.js';
import type {
  SocialImpulseOutreachRecord,
  SocialImpulseOutreachStorePort,
} from '../../../core/emotion/social-impulse-outreach.js';
import { registerSocialImpulseOutreachLane } from './social-impulse-outreach-lane.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const NOW_MS = 1_780_000_000_000;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('social impulse outreach startup lane', () => {
  it('suppresses a human destination when primary trust is revoked after discovery', async () => {
    let contactReads = 0;
    const records = new Map<string, SocialImpulseOutreachRecord>();
    const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));
    const handleMessage = vi.fn(async () => fromAny({ content: 'A private hello.' }));
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-social-outreach-'));
    temporaryDirectories.push(companionDataDir);
    const lane = registerSocialImpulseOutreachLane({
      companionId: COMPANION_ID,
      companionName: 'Test Companion',
      companionDataDir,
      store: memoryStore(records),
      getMode: () => 'on',
      agentLoop: { handleMessage },
      contactStore: fromAny({
        getByDiscordUserId: async () => {
          contactReads += 1;
          return {
            id: 'contact-human',
            displayName: 'Trusted Person',
            trustLevel: contactReads <= 4 ? 'primary' : 'known',
            relationshipType: 'friend',
            firstSeen: '2026-01-01T00:00:00Z',
            lastSeen: '2026-01-01T00:00:00Z',
          };
        },
        listKnownRooms: async () => [],
      }),
      sessionStore: fromAny({ listChannels: () => [] }),
      primaryDiscordUserId: 'discord-user',
      heartbeatChannel: { channelId: 'human-dm', channelType: 'discord' },
      capabilityRuntime: fromAny({ has: () => true }),
      availability: fromAny({ snapshot: () => ({ state: 'available' }) }),
    });
    lane.setProactiveOutbound(fromAny({ dispatch }));
    lane.setHumanPolicy(fromAny({ evaluate: async () => ({ allowed: true }) }));

    const impulse = qualifiedImpulse();
    await lane.runtime.onImpulse(impulse);
    await expect(lane.runtime.inspect(impulse.correlationId)).resolves.toMatchObject({
      destinations: [expect.objectContaining({ destinationId: 'human:contact-human:discord:human-dm' })],
    });

    await expect(lane.runtime.choose({
      opportunityId: impulse.correlationId,
      disposition: 'contact-human',
      destinationId: 'human:contact-human:discord:human-dm',
      intent: 'Send a gentle hello.',
    })).resolves.toMatchObject({
      outcome: 'suppressed',
      reasonCode: 'human_destination_unavailable',
    });
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function qualifiedImpulse(): EmoSimProactivityImpulse {
  return {
    schemaVersion: 1,
    impulseVersion: 'emosim-proactivity.impulse.v1',
    kind: 'would_message',
    companionId: COMPANION_ID,
    source: { model: 'derived-model', version: '1.0.0' },
    lineage: {
      schemaVersion: 1,
      inputId: 'sanitized-input',
      projectionVersion: 'projection-v1',
      privacyClass: 'content_redacted',
      rawContentRedacted: true,
    },
    firstCrossingMs: NOW_MS,
    firedAtMs: NOW_MS,
    thresholdProfile: {
      profileId: 'profile-a',
      socialNeedThreshold: 0.7,
      attachmentIntensityThreshold: 0.8,
      sustainMs: 10,
      cooldownMs: 20,
    },
    dedupeKey: `felt-impulse:would_message:${NOW_MS}`,
    correlationId: `felt-impulse:would_message:${NOW_MS}`,
    confidence: 0.9,
    availability: 'available',
    authority: 'qualified_source_fire',
  };
}

function memoryStore(
  records: Map<string, SocialImpulseOutreachRecord>,
): SocialImpulseOutreachStorePort {
  return {
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
      const claimed = {
        ...record,
        state: 'chosen' as const,
        disposition: input.disposition,
        destination: input.destination,
        bindingHash: input.bindingHash,
        updatedAtMs: input.claimedAtMs,
      };
      records.set(input.opportunityId, claimed);
      return { outcome: 'claimed', record: structuredClone(claimed) };
    },
    async finalize(input) {
      const record = records.get(input.opportunityId);
      if (!record) throw new Error('missing opportunity');
      const finalized = {
        ...record,
        state: input.state,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.finalizedAtMs,
      };
      records.set(input.opportunityId, finalized);
      return structuredClone(finalized);
    },
  };
}

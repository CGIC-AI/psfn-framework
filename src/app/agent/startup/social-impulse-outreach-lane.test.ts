import { ContactBlockListStore } from '../../../core/cogsec/contact-block-list.js';
import { resolveContactBlockListPath } from '../../../persistence/layout.js';
import { buildSessionMetadataWithMessageAddressing } from '../../../core/session/message-addressing.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { EventBus } from '../../../shared/event-bus.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from '../../startup/composition/post-turn-actions.js';
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
  it.each(['trust-revoked', 'linked-account-blocked'])('suppresses the proven DM recipient after %s', async reason => {
    let primaryTrust = true;
    const records = new Map<string, SocialImpulseOutreachRecord>();
    const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));
    const handleMessage = vi.fn(async () => fromAny({ content: 'A private hello.' }));
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-social-outreach-'));
    temporaryDirectories.push(companionDataDir);
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 });
    const postTurnActions = wirePostTurnActionRuntime({ eventBus, scheduler, agentLoop: {} });
    const lane = registerSocialImpulseOutreachLane({
      quietHours: { enabled: false, startLocalTime: '02:00', endLocalTime: '06:00', timeZone: 'UTC' },
      companionId: COMPANION_ID,
      companionName: 'Test Companion',
      companionDataDir,
      store: memoryStore(records),
      getMode: () => 'on',
      agentLoop: { handleMessage },
      postTurnActions,
      contactStore: fromAny({
        getByTrustLevel: async () => [{
          id: 'contact-human', discordUserId: 'old-discord-user', channels: [{ channel: 'discord', userId: 'discord-user' }], displayName: 'Trusted Person', trustLevel: primaryTrust ? 'primary' : 'known',
          relationshipType: 'friend', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z',
        }],
        getById: async () => ({
          id: 'contact-human', discordUserId: 'old-discord-user', channels: [{ channel: 'discord', userId: 'discord-user' }], displayName: 'Trusted Person',
          trustLevel: primaryTrust ? 'primary' : 'known', relationshipType: 'friend',
        }),
        listKnownRooms: async () => [],
      }),
      sessionStore: fromAny({ listChannels: () => [], getSessionActivity: () => null, findLatestEntries: (channelId: string) => channelId === 'human-dm' ? [{
        id: 1, channelId, role: 'user', authorId: 'discord-user', authorName: 'Trusted Person', timestamp: NOW_MS - 3600000,
        content: 'I would welcome hearing from you.',
        metadata: buildSessionMetadataWithMessageAddressing(undefined, {
          schemaVersion: 2, source: 'discord', author: { authorId: 'discord-user', authorName: 'Trusted Person' },
          observer: { authorId: 'companion-bot', authorName: 'Test Companion' },
          mentionedTargets: [], channel: { scope: 'direct', channelId },
          resolvedAddressee: { kind: 'participants', participants: [{ authorId: 'companion-bot', authorName: 'Test Companion', evidence: ['direct_message'] }] },
        }),
      }] : [] }),
      heartbeatChannel: { channelId: 'human-dm', channelType: 'discord' },
      capabilityRuntime: fromAny({ has: () => true }),
      availability: fromAny({ snapshot: () => ({ state: 'available' }) }),
    });
    lane.setProactiveOutbound(fromAny({ dispatch }));
    lane.setHumanPolicy(fromAny({ evaluate: async () => ({ allowed: true }) }));

    const impulse = qualifiedImpulse();
    await lane.runtime.onImpulse(impulse);
    await scheduler.getTask('post-turn-action-executor')!.handler();
    await expect(lane.runtime.inspect(impulse.correlationId)).resolves.toMatchObject({
      destinations: [expect.objectContaining({ destinationId: 'human:contact-human:discord:human-dm' })],
    });

    await expect(lane.runtime.choose({
      opportunityId: impulse.correlationId,
      disposition: 'contact-human',
      destinationId: 'human:contact-human:discord:human-dm',
      intent: 'Send a gentle hello.',
    })).resolves.toMatchObject({
      outcome: 'queued',
    });
    if (reason === 'trust-revoked') primaryTrust = false;
    else new ContactBlockListStore(resolveContactBlockListPath(companionDataDir)).block({
      channelType: 'discord', contactId: 'discord-user', canonicalContactId: 'contact-human',
      mode: 'hard', scope: 'dm', actor: { kind: 'operator', id: 'test' },
    });
    expect((await lane.runtime.inspect(impulse.correlationId)).destinations).toEqual([]);
    await scheduler.getTask('post-turn-action-executor')!.handler();
    expect((await lane.runtime.inspect(impulse.correlationId)).record.state).toBe('suppressed');
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
    async getDestinationStatus(companionId, destinationId) {
      const matching = [...records.values()].filter(record => record.companionId === companionId
        && record.destination?.destinationId === destinationId)
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.opportunityId.localeCompare(left.opportunityId));
      const active = (record: SocialImpulseOutreachRecord) => record.state === 'pending' || record.state === 'queued' || record.state === 'chosen';
      return structuredClone({ pending: matching.find(active) ?? null, latestTerminal: matching.find(record => !active(record)) ?? null });
    },
    async listRecoverable(companionId) {
      return [...records.values()].filter(record => record.companionId === companionId
        && (record.state === 'pending' || record.state === 'queued')).map(record => structuredClone(record));
    },
    async deferExecution(input) {
      const record = records.get(input.opportunityId);
      if (!record || record.state !== 'chosen' || record.bindingHash !== input.bindingHash || !record.executionIntent) throw new Error('lost unsent claim');
      const deferred = { ...record, state: 'queued' as const, reasonCode: input.reasonCode, updatedAtMs: input.deferredAtMs };
      records.set(input.opportunityId, deferred);
      return structuredClone(deferred);
    },
    async beginExecution(opportunityId, bindingHash, atMs) {
      const record = records.get(opportunityId);
      if (!record || record.state !== 'queued' || record.bindingHash !== bindingHash) return false;
      records.set(opportunityId, { ...record, state: 'chosen', updatedAtMs: atMs });
      return true;
    },
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
        state: input.executionIntent ? 'queued' as const : 'chosen' as const,
        disposition: input.disposition,
        destination: input.destination,
        bindingHash: input.bindingHash,
        executionIntent: input.executionIntent ?? null,
        originIcpRootInitiationId: record.originIcpRootInitiationId ?? input.originIcpRootInitiationId ?? null,
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
        executionIntent: null,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.finalizedAtMs,
      };
      records.set(input.opportunityId, finalized);
      return structuredClone(finalized);
    },
  };
}

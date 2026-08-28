import { describe, expect, it } from 'vitest';

import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from './decision.js';
import {
  composeEgressDisclosureDecision,
  deriveDisclosureDestination,
  isDisclosureSocialEgressInvocation,
  isDisclosureSocialEgressMethod,
} from './egress-composition.js';
import type {
  DisclosureLineage,
  DisclosureSourceContribution,
} from './contracts.js';
import type { ChannelDisclosureResolver } from './egress-composition.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';

const CONTEXT = {
  generationContextRef: 'turn:test',
  classifierVersion: 'test/v1',
  classifiedAt: '2026-01-01T00:00:00Z',
};

function lineageFrom(contribution: DisclosureSourceContribution): DisclosureLineage {
  return accumulateDisclosureSource(beginDisclosureAccumulation(CONTEXT), contribution);
}

function dmContribution(
  contactId: string,
  sensitivity: SensitivityLevel,
): DisclosureSourceContribution {
  return {
    ref: `session:${contactId}`,
    sensitivity,
    permittedDestinations: [{ kind: 'contact_dm', contactIds: [contactId] }],
    subjectContactIds: [contactId],
    classified: true,
  };
}

function roomContribution(
  channelId: string,
  sensitivity: SensitivityLevel,
): DisclosureSourceContribution {
  return {
    ref: `session:${channelId}`,
    sensitivity,
    permittedDestinations: [{ kind: 'invite_only_room', channelIds: [channelId] }],
    subjectContactIds: [],
    classified: true,
  };
}

// A channel resolver that keys off an id prefix, mirroring classifyChannelDisclosure.
const resolveChannel: ChannelDisclosureResolver = (channelId) => {
  if (channelId.startsWith('pub-')) return { channelPrivacy: 'public', broadcast: false };
  if (channelId.startsWith('bcast-')) return { channelPrivacy: 'private', broadcast: true };
  if (channelId.startsWith('inv-')) return { channelPrivacy: 'invite_only', broadcast: false };
  return { channelPrivacy: 'private', broadcast: false };
};

describe('deriveDisclosureDestination', () => {
  it('recognizes the social egress methods, including reactions', () => {
    expect(isDisclosureSocialEgressMethod('discord.send')).toBe(true);
    expect(isDisclosureSocialEgressMethod('channel.send')).toBe(true);
    expect(isDisclosureSocialEgressMethod('discord.sendMedia')).toBe(true);
    expect(isDisclosureSocialEgressMethod('discord.sendReaction')).toBe(true);
    expect(isDisclosureSocialEgressMethod('notify')).toBe(true);
    expect(isDisclosureSocialEgressMethod('web.fetch')).toBe(false);
    expect(isDisclosureSocialEgressMethod('notify.ntfy')).toBe(false);
  });

  it('recognizes only the live Discord-send shape of the consolidated notify tool', () => {
    expect(isDisclosureSocialEgressInvocation({
      method: 'notify',
      params: {
        action: 'send',
        target_kind: 'external',
        delivery_channel: 'discord',
        delivery_target: 'inv-9',
      },
    })).toBe(true);
    expect(isDisclosureSocialEgressInvocation({
      method: 'notify',
      params: {
        action: 'send',
        target_kind: 'external',
        delivery_channel: 'email',
        delivery_target: 'operator@example.test',
      },
    })).toBe(false);
    expect(isDisclosureSocialEgressInvocation({
      method: 'notify',
      params: { action: 'brief', message: 'operator update' },
    })).toBe(false);
  });

  it('derives a contact DM destination from a contactId param', () => {
    const destination = deriveDisclosureDestination({
      method: 'discord.send',
      params: { contactId: 'contact-1' },
      resolveChannel,
    });
    expect(destination).toEqual({ kind: 'contact_dm', contactId: 'contact-1' });
  });

  it('classifies a channelId into invite-only vs public rooms', () => {
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: { channelId: 'inv-9' }, resolveChannel,
    })).toEqual({ kind: 'invite_only_room', channelId: 'inv-9' });
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: { channelId: 'pub-9' }, resolveChannel,
    })).toEqual({ kind: 'public_room', channelId: 'pub-9' });
    // Broadcast private channels are outward public surfaces.
    expect(deriveDisclosureDestination({
      method: 'discord.sendReaction', params: { channelId: 'bcast-9' }, resolveChannel,
    })).toEqual({ kind: 'public_room', channelId: 'bcast-9' });
  });

  it('derives the live notify Discord delivery_target as the room destination', () => {
    expect(deriveDisclosureDestination({
      method: 'notify',
      params: {
        action: 'send',
        target_kind: 'external',
        delivery_channel: 'discord',
        delivery_target: 'inv-9',
      },
      resolveChannel,
    })).toEqual({ kind: 'invite_only_room', channelId: 'inv-9' });
  });

  it('stamps the channel current epoch onto a room destination when the resolver tracks one (jp36.6.3)', () => {
    const epochResolver: ChannelDisclosureResolver = (channelId) => {
      if (channelId === 'pub-tracked') return { channelPrivacy: 'public', broadcast: false, classificationEpoch: 3 };
      if (channelId === 'inv-tracked') return { channelPrivacy: 'invite_only', broadcast: false, classificationEpoch: 1 };
      return { channelPrivacy: 'public', broadcast: false };
    };
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: { channelId: 'pub-tracked' }, resolveChannel: epochResolver,
    })).toEqual({ kind: 'public_room', channelId: 'pub-tracked', currentEpoch: 3 });
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: { channelId: 'inv-tracked' }, resolveChannel: epochResolver,
    })).toEqual({ kind: 'invite_only_room', channelId: 'inv-tracked', currentEpoch: 1 });
    // Untracked channel: no currentEpoch key at all (pre-epoch behavior).
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: { channelId: 'pub-untracked' }, resolveChannel: epochResolver,
    })).toEqual({ kind: 'public_room', channelId: 'pub-untracked' });
  });

  it('returns null for non-social methods, missing ids, and unresolvable private channels', () => {
    expect(deriveDisclosureDestination({
      method: 'web.fetch', params: { channelId: 'pub-1' }, resolveChannel,
    })).toBeNull();
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: {}, resolveChannel,
    })).toBeNull();
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: { channelId: 'priv-1' }, resolveChannel,
    })).toBeNull();
    expect(deriveDisclosureDestination({
      method: 'discord.send', params: 'not-an-object', resolveChannel,
    })).toBeNull();
  });
});

describe('composeEgressDisclosureDecision', () => {
  it('denies whenever the existing sink gate denied, regardless of disclosure', () => {
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: false,
      sinkReason: 'lethal trifecta',
      lineage: lineageFrom(dmContribution('contact-1', 'personal')),
      destination: { kind: 'contact_dm', contactId: 'contact-1' },
    });
    expect(composed.allowed).toBe(false);
    expect(composed.disclosureEvaluated).toBe(false);
    expect(composed.reason).toContain('lethal trifecta');
  });

  it('allows when the sink gate allowed and no social destination was derived', () => {
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage: undefined,
      destination: null,
    });
    expect(composed.allowed).toBe(true);
    expect(composed.disclosureEvaluated).toBe(false);
  });

  it('denies a known social send when its destination cannot be resolved', () => {
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage: lineageFrom(dmContribution('contact-1', 'personal')),
      destination: null,
      requiresDisclosureDestination: true,
    });
    expect(composed).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
      disclosureEvaluated: true,
    });
    expect(composed.reason).toContain('could not be resolved');
  });

  it('permits a restricted lineage to its eligible DM', () => {
    const lineage = lineageFrom(dmContribution('contact-1', 'personal'));
    expect(lineage.classification).toBe('restricted');
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'contact_dm', contactId: 'contact-1' },
    });
    expect(composed.allowed).toBe(true);
    expect(composed.outcome).toBe('auto_shareable');
    expect(composed.disclosureEvaluated).toBe(true);
  });

  it('denies a restricted lineage to a public room and to publication', () => {
    const lineage = lineageFrom(dmContribution('contact-1', 'personal'));
    const toRoom = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'public_room', channelId: 'pub-1' },
    });
    expect(toRoom.allowed).toBe(false);
    expect(toRoom.disclosureEvaluated).toBe(true);

    const toPublication = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'publication' },
    });
    expect(toPublication.allowed).toBe(false);
  });

  it('routes an over-ceiling but permitted destination to approval_required (allowed=false)', () => {
    // Intimate content permitted to an invite-only room exceeds that room's
    // auto-shareable ceiling (personal) -> approval_required, not auto-release.
    const lineage = lineageFrom(roomContribution('inv-1', 'intimate'));
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'invite_only_room', channelId: 'inv-1' },
    });
    expect(composed.allowed).toBe(false);
    expect(composed.outcome).toBe('approval_required');
  });

  it('fails closed to deny for an outward destination when no lineage was published', () => {
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage: undefined,
      destination: { kind: 'public_room', channelId: 'pub-1' },
    });
    expect(composed.allowed).toBe(false);
    expect(composed.outcome).toBe('non_shareable');
    expect(composed.disclosureEvaluated).toBe(true);
  });

  it('keeps companion-self eligible even with no lineage (the private sink)', () => {
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage: undefined,
      destination: { kind: 'companion_self' },
    });
    expect(composed.allowed).toBe(true);
  });

  it('denies prior-epoch room content at egress once the room opened a fresh epoch (jp36.6.3)', () => {
    // Content admitted to the public room at epoch 2.
    const lineage = lineageFrom({
      ref: 'session:pub-1@2',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['pub-1'], channelEpochs: { 'pub-1': 2 } }],
      subjectContactIds: [],
      classified: true,
    });
    // Same epoch → auto-shareable.
    expect(composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'public_room', channelId: 'pub-1', currentEpoch: 2 },
    })).toMatchObject({ allowed: true, disclosureEvaluated: true });
    // Room advanced to a fresh epoch → routed to review, not auto-shared.
    expect(composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'public_room', channelId: 'pub-1', currentEpoch: 3 },
    })).toMatchObject({ allowed: false, outcome: 'approval_required', disclosureEvaluated: true });
  });

  it('denies a DM to a contact that is not in the intersected permission set', () => {
    const lineage = lineageFrom(dmContribution('contact-1', 'personal'));
    const composed = composeEgressDisclosureDecision({
      sinkAllowed: true,
      lineage,
      destination: { kind: 'contact_dm', contactId: 'someone-else' },
    });
    expect(composed.allowed).toBe(false);
  });
});

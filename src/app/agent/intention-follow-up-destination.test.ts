import { describe, expect, it } from 'vitest';
import type { Contact } from '../../core/contacts/types.js';
import { buildSessionMetadataWithMessageAddressing } from '../../core/session/message-addressing.js';
import { createIntentionFollowUpDestinationResolver } from './intention-follow-up-destination.js';

const DM = '123456789012345678';
const COMPANION_DM = 'companion-dm:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const primary: Contact = {
  id: 'contact-primary', displayName: 'Primary', trustLevel: 'primary', discordUserId: 'discord-primary',
  firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z',
};
const ownedDm = buildSessionMetadataWithMessageAddressing(undefined, {
  schemaVersion: 2, source: 'discord',
  author: { authorId: 'discord-primary', authorName: 'Primary' },
  observer: { authorId: 'bot', authorName: 'Companion' },
  mentionedTargets: [],
  channel: { scope: 'direct', channelId: DM },
  resolvedAddressee: { kind: 'participants', participants: [{ authorId: 'bot', authorName: 'Companion', evidence: ['direct_message'] }] },
});

function resolver(options: { dmOwned?: boolean; capabilities?: string[] } = {}) {
  return createIntentionFollowUpDestinationResolver({
    heartbeatChannel: { channelId: DM, channelType: 'discord' },
    contactStore: { getByTrustLevel: async () => [primary] },
    sessionStore: {
      findLatestEntries: (channelId: string) => (
        channelId === DM && options.dmOwned !== false
          ? [{ id: 1, channelId, role: 'user', content: 'hi', timestamp: 1, metadata: ownedDm }]
          : []
      ),
    },
    icpAutonomy: { listOpenDyads: async () => [{ channelId: COMPANION_DM, peerContactId: 'contact-peer' }] as never },
    capabilityRuntime: { has: capability => (options.capabilities ?? ['external.discord', 'external.companion']).includes(capability) },
  });
}

describe('intention follow-up destination resolver', () => {
  it('authorizes the primary human\'s verified DM and open companion dyads only', async () => {
    await expect(resolver()({ channelId: DM })).resolves.toEqual({ channelId: DM, channelType: 'discord', contactId: 'contact-primary' });
    await expect(resolver()({ channelId: COMPANION_DM, channelType: 'companion' }))
      .resolves.toEqual({ channelId: COMPANION_DM, channelType: 'companion', contactId: 'contact-peer' });
    await expect(resolver()({ channelId: '876543210987654321' })).resolves.toBeNull();
    await expect(resolver()({ channelId: DM, channelType: 'companion' })).resolves.toBeNull();
  });

  it('fails closed when the DM is not verifiably the contact\'s or the capability is off', async () => {
    await expect(resolver({ dmOwned: false })({ channelId: DM })).resolves.toBeNull();
    await expect(resolver({ capabilities: [] })({ channelId: DM })).resolves.toBeNull();
    await expect(resolver({ capabilities: [] })({ channelId: COMPANION_DM })).resolves.toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import {
  registerContactRuntime,
  type ContactRuntimeOptions,
  type ContactRuntimeTarget,
} from './runtime-wiring.js';
import type { ContactStorePort } from './contact-store-port.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
} from './types.js';

function identityKey(channel: string, userId: string): string {
  return `${channel.trim().toLowerCase()}:${userId.trim()}`;
}

function makeContact(id: string, displayName: string, trustLevel: Contact['trustLevel']): Contact {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  return {
    id,
    displayName,
    trustLevel,
    relationshipType: 'acquaintance',
    firstSeen: now,
    lastSeen: now,
    channels: [],
  };
}

class InMemoryContactStore {
  private readonly contacts = new Map<string, Contact>();
  private readonly identities = new Map<string, string>();

  constructor(private readonly primaryUserId?: string) {}

  async resolveUserId(discordUserId: string): Promise<Contact> {
    const existing = await this.getByChannelIdentity('discord', discordUserId);
    if (existing) return existing;

    const id = `contact-${discordUserId}`;
    const contact = makeContact(
      id,
      discordUserId,
      discordUserId === this.primaryUserId ? 'primary' : 'regular',
    );
    this.contacts.set(id, contact);
    await this.linkChannelIdentity(id, 'discord', discordUserId);
    return contact;
  }

  async getByChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
  ): Promise<Contact | undefined> {
    const contactId = this.identities.get(identityKey(channel, channelUserId));
    return contactId ? this.contacts.get(contactId) : undefined;
  }

  async linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
  ): Promise<ContactIdentityLinkResult> {
    const contact = this.contacts.get(contactId);
    if (!contact) return 'contact_not_found';
    const normalizedChannel = channel.trim().toLowerCase();
    const normalizedUserId = channelUserId.trim();
    const key = identityKey(normalizedChannel, normalizedUserId);
    const existingContactId = this.identities.get(key);
    if (existingContactId && existingContactId !== contactId) return 'identity_conflict';

    this.identities.set(key, contactId);
    const privacyLevel: ChannelPrivacyLevel = options?.privacyLevel ?? 'invite_only';
    if (!contact.channels.some(identity => (
      identity.channel === normalizedChannel && identity.userId === normalizedUserId
    ))) {
      contact.channels.push({
        channel: normalizedChannel,
        userId: normalizedUserId,
        privacyLevel,
      });
    }
    return existingContactId === contactId ? 'already_linked' : 'linked';
  }
}

async function wireContactRuntime(
  target: ContactRuntimeTarget,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): Promise<ContactStorePort> {
  const contactStore = new InMemoryContactStore(primaryUserId) as unknown as ContactStorePort;
  return await registerContactRuntime(target, contactStore, primaryUserId, options);
}

class FakeTarget implements ContactRuntimeTarget {
  contactStore: ContactStorePort | null = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireContactRuntime', () => {
  it('injects ContactStore and registers only the unified contact surface', async () => {
    const target = new FakeTarget();

    const contactStore = await wireContactRuntime(target, 'primary-user-123');

    expect(target.contactStore).toBe(contactStore);
    expect(target.tools.map(tool => tool.name)).toEqual(['contact']);
  });

  it('threads primary user id into ContactStore behavior', async () => {
    const target = new FakeTarget();

    await wireContactRuntime(target, 'primary-user-123');
    const contact = await target.contactStore!.resolveUserId('primary-user-123');
    expect(contact.trustLevel).toBe('primary');
  });

  it('links bootstrap identities onto the primary contact', async () => {
    const target = new FakeTarget();

    await wireContactRuntime(target, 'primary-user-123', {
      bootstrapPrimaryIdentityLinks: [{
        channel: 'telegram',
        userId: '5635268079',
        privacyLevel: 'private',
      }],
    });

    const primary = await target.contactStore!.resolveUserId('primary-user-123');
    const linked = await target.contactStore!.getByChannelIdentity('telegram', '5635268079');
    expect(linked?.id).toBe(primary.id);
  });
});

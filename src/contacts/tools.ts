// ── Contact Management Tools ──
// Agent-accessible tools for managing relationships and contacts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ContactStore } from './store.js';
import type { TrustLevel } from '../trust/types.js';
import { TRUST_LEVELS } from '../trust/types.js';
import { CHANNEL_PRIVACY_LEVELS, type ChannelPrivacyLevel } from './types.js';

export function createContactSetTrustTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_set_trust',
    description:
      'Set the trust level for a contact. Use this when you learn about someone\'s ' +
      'relationship to your primary person or want to adjust access boundaries.',
    label: 'contact_set_trust',
    parameters: Type.Object({
      contactId: Type.String({ description: 'The contact ID' }),
      trustLevel: Type.Unsafe<TrustLevel>({
        type: 'string',
        enum: [...TRUST_LEVELS],
        description: 'New trust level: primary, trusted, regular, or public',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: { contactId: string; trustLevel: TrustLevel },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const { contactId, trustLevel } = params;

      if (!(TRUST_LEVELS as readonly string[]).includes(trustLevel)) {
        return {
          content: [{ type: 'text', text: `Invalid trust level: ${trustLevel}. Must be one of: ${TRUST_LEVELS.join(', ')}` }] satisfies TextContent[],
          details: {},
        };
      }

      const success = contactStore.setTrustLevel(contactId, trustLevel, 'agent:tool:contact_set_trust');
      if (!success) {
        return {
          content: [{ type: 'text', text: `Contact ${contactId} not found or is the primary user (cannot change primary trust level)` }] satisfies TextContent[],
          details: {},
        };
      }
      return {
        content: [{ type: 'text', text: `Trust level for ${contactId} set to ${trustLevel}` }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

export function createContactNoteTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_note',
    description:
      'Add or update notes about a contact. Use this to record observations about ' +
      'relationships, preferences, or interaction patterns.',
    label: 'contact_note',
    parameters: Type.Object({
      contactId: Type.String({ description: 'The contact ID' }),
      notes: Type.String({ description: 'Notes to set for this contact' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { contactId: string; notes: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const { contactId, notes } = params;

      const success = contactStore.updateNotes(contactId, notes, 'agent:tool:contact_note');
      if (!success) {
        return {
          content: [{ type: 'text', text: `Contact ${contactId} not found` }] satisfies TextContent[],
          details: {},
        };
      }
      return {
        content: [{ type: 'text', text: `Notes updated for ${contactId}` }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

export function createContactSetChannelPrivacyTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_set_channel_privacy',
    description:
      'Set the privacy level for one linked channel identity on a contact.',
    label: 'contact_set_channel_privacy',
    parameters: Type.Object({
      contactId: Type.String({ description: 'Canonical contact ID' }),
      channel: Type.String({ minLength: 1, description: 'Channel key, for example: discord, api, telegram' }),
      channelUserId: Type.String({ minLength: 1, description: 'User ID within that channel' }),
      privacyLevel: Type.Unsafe<ChannelPrivacyLevel>({
        type: 'string',
        enum: [...CHANNEL_PRIVACY_LEVELS],
        description: 'Privacy level: private, semi_private, public, broadcast',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        contactId: string;
        channel: string;
        channelUserId: string;
        privacyLevel: ChannelPrivacyLevel;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      if (!(CHANNEL_PRIVACY_LEVELS as readonly string[]).includes(params.privacyLevel)) {
        return {
          content: [{
            type: 'text',
            text: `Invalid channel privacy level: ${params.privacyLevel}. Must be one of: ${CHANNEL_PRIVACY_LEVELS.join(', ')}`,
          }] satisfies TextContent[],
          details: {},
        };
      }

      const updated = contactStore.setChannelPrivacy(
        params.contactId,
        params.channel,
        params.channelUserId,
        params.privacyLevel,
      );
      if (!updated) {
        return {
          content: [{
            type: 'text',
            text: `Channel link not found for ${params.contactId}: ${params.channel}:${params.channelUserId}`,
          }] satisfies TextContent[],
          details: {},
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Updated ${params.channel}:${params.channelUserId} privacy to ${params.privacyLevel} for ${params.contactId}`,
        }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

export function createContactLookupTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_lookup',
    description:
      'Look up a contact by canonical ID, Discord user ID, or channel identity (channel:userId). ' +
      'Returns trust level, relationship type, and notes.',
    label: 'contact_lookup',
    parameters: Type.Object({
      contactId: Type.String({ description: 'Canonical contact ID, Discord user ID, or channel identity (channel:userId)' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { contactId: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const id = params.contactId;

      // Try canonical ID first, then Discord user ID.
      let contact = contactStore.getById(id);
      if (!contact) {
        contact = contactStore.getByDiscordUserId(id);
      }
      if (!contact) {
        const idx = id.indexOf(':');
        if (idx > 0 && idx < id.length - 1) {
          const channel = id.slice(0, idx).trim();
          const channelUserId = id.slice(idx + 1).trim();
          if (channel && channelUserId) {
            contact = contactStore.getByChannelIdentity(channel, channelUserId);
          }
        }
      }

      if (!contact) {
        return {
          content: [{ type: 'text', text: `No contact found for: ${id}` }] satisfies TextContent[],
          details: {},
        };
      }

      const identities = contact.channelIdentities
        ?.map(identity => `${identity.channel}:${identity.userId}`)
        .join(', ');
      const channels = contact.channels
        ?.map(channel => `${channel.channel}:${channel.userId}[${channel.privacyLevel}]`)
        .join(', ');

      return {
        content: [{
          type: 'text',
          text:
            `Canonical ID: ${contact.id}\n` +
            `Contact: ${contact.displayName}\n` +
            `Trust: ${contact.trustLevel}\n` +
            `Relationship: ${contact.relationshipType}\n` +
            (identities ? `Identities: ${identities}\n` : '') +
            (channels ? `Channels: ${channels}\n` : '') +
            `First seen: ${contact.firstSeen}\n` +
            `Last seen: ${contact.lastSeen}` +
            (contact.notes ? `\nNotes: ${contact.notes}` : ''),
        }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

export function createContactLinkIdentityTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_link_identity',
    description:
      'Link a channel-specific user ID to an existing contact so trust and continuity can be shared cross-channel.',
    label: 'contact_link_identity',
    parameters: Type.Object({
      contactId: Type.String({ description: 'Canonical contact ID to extend' }),
      channel: Type.String({ minLength: 1, description: 'Channel key, for example: discord, api, telegram' }),
      channelUserId: Type.String({ minLength: 1, description: 'User ID within that channel' }),
      privacyLevel: Type.Optional(Type.Unsafe<ChannelPrivacyLevel>({
        type: 'string',
        enum: [...CHANNEL_PRIVACY_LEVELS],
        description: 'Optional privacy level for this channel link',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        contactId: string;
        channel: string;
        channelUserId: string;
        privacyLevel?: ChannelPrivacyLevel;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      if (params.privacyLevel && !(CHANNEL_PRIVACY_LEVELS as readonly string[]).includes(params.privacyLevel)) {
        return {
          content: [{
            type: 'text',
            text: `Invalid channel privacy level: ${params.privacyLevel}. Must be one of: ${CHANNEL_PRIVACY_LEVELS.join(', ')}`,
          }] satisfies TextContent[],
          details: {},
        };
      }

      const result = contactStore.linkChannelIdentity(
        params.contactId,
        params.channel,
        params.channelUserId,
        { privacyLevel: params.privacyLevel },
      );

      switch (result) {
        case 'linked':
          return {
            content: [{
              type: 'text',
              text: `Linked ${params.channel}:${params.channelUserId} to ${params.contactId}`,
            }] satisfies TextContent[],
            details: {},
          };
        case 'already_linked':
          return {
            content: [{
              type: 'text',
              text: `${params.channel}:${params.channelUserId} is already linked to ${params.contactId}`,
            }] satisfies TextContent[],
            details: {},
          };
        case 'contact_not_found':
          return {
            content: [{
              type: 'text',
              text: `Contact ${params.contactId} not found`,
            }] satisfies TextContent[],
            details: {},
          };
        case 'identity_conflict':
        default:
          return {
            content: [{
              type: 'text',
              text: `${params.channel}:${params.channelUserId} is already linked to a different contact`,
            }] satisfies TextContent[],
            details: {},
          };
      }
    },
  };
}

export function createContactListTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_list',
    description: 'List all known contacts with their trust levels and relationship types.',
    label: 'contact_list',
    parameters: Type.Object({}),
    execute: async (
      _toolCallId: string,
      _params: Record<string, never>,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const contacts = contactStore.listAll();

      if (contacts.length === 0) {
        return {
          content: [{ type: 'text', text: 'No contacts in address book.' }] satisfies TextContent[],
          details: {},
        };
      }

      const lines = contacts.map(c =>
        `- ${c.displayName} [${c.trustLevel}/${c.relationshipType}]` +
        ((c.channels?.length ?? 0) > 0 ? ` channels=${c.channels!.length}` : '') +
        (c.notes ? ` — ${c.notes}` : ''),
      );
      return {
        content: [{ type: 'text', text: `Contacts (${contacts.length}):\n${lines.join('\n')}` }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

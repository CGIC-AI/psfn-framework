// ── Contact Management Tools ──
// Agent-accessible tools for managing relationships and contacts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ContactStore } from './store.js';
import type { TrustLevel } from '../trust/types.js';
import { TRUST_LEVELS } from '../trust/types.js';

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

      const success = contactStore.setTrustLevel(contactId, trustLevel);
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

      const success = contactStore.updateNotes(contactId, notes);
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

export function createContactLookupTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_lookup',
    description:
      'Look up a contact by their ID or Discord user ID. ' +
      'Returns trust level, relationship type, and notes.',
    label: 'contact_lookup',
    parameters: Type.Object({
      contactId: Type.String({ description: 'The contact ID (or Discord user ID)' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { contactId: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const id = params.contactId;

      // Try direct ID first, then Discord user ID
      let contact = contactStore.getById(id);
      if (!contact) {
        contact = contactStore.getByDiscordUserId(id);
      }

      if (!contact) {
        return {
          content: [{ type: 'text', text: `No contact found for: ${id}` }] satisfies TextContent[],
          details: {},
        };
      }

      return {
        content: [{
          type: 'text',
          text:
            `Contact: ${contact.displayName}\n` +
            `Trust: ${contact.trustLevel}\n` +
            `Relationship: ${contact.relationshipType}\n` +
            `First seen: ${contact.firstSeen}\n` +
            `Last seen: ${contact.lastSeen}` +
            (contact.notes ? `\nNotes: ${contact.notes}` : ''),
        }] satisfies TextContent[],
        details: {},
      };
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
        (c.notes ? ` — ${c.notes}` : ''),
      );
      return {
        content: [{ type: 'text', text: `Contacts (${contacts.length}):\n${lines.join('\n')}` }] satisfies TextContent[],
        details: {},
      };
    },
  };
}

// ── Contact Management Tools ──
// Agent-accessible tools for managing relationships and contacts.

import type { SubstrateTool } from '../types.js';
import type { ContactStore } from './store.js';
import type { TrustLevel } from '../trust/types.js';
import { TRUST_LEVELS } from '../trust/types.js';
import { VALID_RELATIONSHIP_TYPES } from './types.js';

export function createContactSetTrustTool(contactStore: ContactStore): SubstrateTool {
  return {
    name: 'contact_set_trust',
    description:
      'Set the trust level for a contact. Use this when you learn about someone\'s ' +
      'relationship to your primary person or want to adjust access boundaries.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'The contact ID' },
        trustLevel: {
          type: 'string',
          enum: [...TRUST_LEVELS],
          description: 'New trust level: primary, trusted, regular, or public',
        },
      },
      required: ['contactId', 'trustLevel'],
    },
    execute: async (input: Record<string, unknown>) => {
      const contactId = input.contactId as string;
      const trustLevel = input.trustLevel as TrustLevel;

      if (!(TRUST_LEVELS as readonly string[]).includes(trustLevel)) {
        return { content: `Invalid trust level: ${trustLevel}. Must be one of: ${TRUST_LEVELS.join(', ')}` };
      }

      const success = contactStore.setTrustLevel(contactId, trustLevel);
      if (!success) {
        return { content: `Contact ${contactId} not found or is the primary user (cannot change primary trust level)` };
      }
      return { content: `Trust level for ${contactId} set to ${trustLevel}` };
    },
  };
}

export function createContactNoteTool(contactStore: ContactStore): SubstrateTool {
  return {
    name: 'contact_note',
    description:
      'Add or update notes about a contact. Use this to record observations about ' +
      'relationships, preferences, or interaction patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'The contact ID' },
        notes: { type: 'string', description: 'Notes to set for this contact' },
      },
      required: ['contactId', 'notes'],
    },
    execute: async (input: Record<string, unknown>) => {
      const contactId = input.contactId as string;
      const notes = input.notes as string;

      const success = contactStore.updateNotes(contactId, notes);
      if (!success) {
        return { content: `Contact ${contactId} not found` };
      }
      return { content: `Notes updated for ${contactId}` };
    },
  };
}

export function createContactLookupTool(contactStore: ContactStore): SubstrateTool {
  return {
    name: 'contact_lookup',
    description:
      'Look up a contact by their ID or Discord user ID. ' +
      'Returns trust level, relationship type, and notes.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'The contact ID (or Discord user ID)' },
      },
      required: ['contactId'],
    },
    execute: async (input: Record<string, unknown>) => {
      const id = input.contactId as string;

      // Try direct ID first, then Discord user ID
      let contact = contactStore.getById(id);
      if (!contact) {
        contact = contactStore.getByDiscordUserId(id);
      }

      if (!contact) {
        return { content: `No contact found for: ${id}` };
      }

      return {
        content:
          `Contact: ${contact.displayName}\n` +
          `Trust: ${contact.trustLevel}\n` +
          `Relationship: ${contact.relationshipType}\n` +
          `First seen: ${contact.firstSeen}\n` +
          `Last seen: ${contact.lastSeen}` +
          (contact.notes ? `\nNotes: ${contact.notes}` : ''),
      };
    },
  };
}

export function createContactListTool(contactStore: ContactStore): SubstrateTool {
  return {
    name: 'contact_list',
    description: 'List all known contacts with their trust levels and relationship types.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const contacts = contactStore.listAll();

      if (contacts.length === 0) {
        return { content: 'No contacts in address book.' };
      }

      const lines = contacts.map(c =>
        `- ${c.displayName} [${c.trustLevel}/${c.relationshipType}]` +
        (c.notes ? ` — ${c.notes}` : ''),
      );
      return { content: `Contacts (${contacts.length}):\n${lines.join('\n')}` };
    },
  };
}

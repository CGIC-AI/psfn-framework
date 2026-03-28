// ── Contact Management Tools ──
// Agent-accessible tools for managing relationships and contacts.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ContactStore } from './store.js';
import type { TrustLevel } from '../../system/trust/types.js';
import { TRUST_LEVELS, isHighTierTrustLevel } from '../../system/trust/types.js';
import type { TrustDriftBehaviorSignals } from '../../system/trust/policy.js';
import { CHANNEL_PRIVACY_LEVELS, type ChannelPrivacyLevel } from './types.js';
import { resolvePreferredContactName } from './preferred-name.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

interface ContactSetTrustParams {
  contactId: string;
  trustLevel?: TrustLevel;
  behaviorSignals?: TrustDriftBehaviorSignals;
  confirmSuggestion?: boolean;
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function createContactSetTrustTool(contactStore: ContactStore): AgentTool<any> {
  return {
    name: 'contact_set_trust',
    description:
      'Set or suggest a trust level for a contact. Behavior-driven drift suggestions ' +
      'can only auto-apply low-tier changes after explicit confirmation. ' +
      'Trust level changes do not bypass explicit disclosure boundaries.',
    label: 'contact_set_trust',
    parameters: Type.Object({
      contactId: Type.String({ description: 'The contact ID' }),
      trustLevel: Type.Optional(Type.Unsafe<TrustLevel>({
        type: 'string',
        enum: [...TRUST_LEVELS],
        description: 'New trust level: primary, trusted, regular, or public',
      })),
      behaviorSignals: Type.Optional(Type.Object({
        positiveInteractionCount: Type.Integer({ minimum: 0, description: 'Observed positive interactions' }),
        negativeInteractionCount: Type.Optional(Type.Integer({ minimum: 0, description: 'Observed negative interactions' })),
        verifiedIdentityLinks: Type.Optional(Type.Integer({ minimum: 0, description: 'Verified channel identity links' })),
        consistentBoundaryRespect: Type.Optional(Type.Boolean({
          description: 'Whether behavior consistently respected boundaries',
        })),
      })),
      confirmSuggestion: Type.Optional(Type.Boolean({
        description: 'Required to apply a behavior-driven suggestion after preview',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ContactSetTrustParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const { contactId, trustLevel, behaviorSignals, confirmSuggestion } = params;

        if (!behaviorSignals && !trustLevel) {
          return textResultWithError(
            'Provide either trustLevel for a direct update or behaviorSignals for drift suggestion flow',
            true,
          );
        }

        if (behaviorSignals) {
          const suggestion = contactStore.suggestLowTierTrustDrift(
            contactId,
            behaviorSignals,
            'agent:tool:contact_set_trust',
          );
          if (!suggestion) {
            return textResult(
              `No low-tier trust drift suggestion generated for ${contactId} from the provided behavior signals`,
            );
          }

          if (confirmSuggestion !== true) {
            return textResult(
              `Suggested low-tier trust drift for ${contactId}: ${suggestion.fromTrustLevel} -> `
              + `${suggestion.suggestedTrustLevel} (${formatConfidence(suggestion.confidence)} confidence). `
              + 'Re-run with confirmSuggestion=true to apply.',
            );
          }

          const applied = contactStore.applyLowTierTrustDriftSuggestion(
            contactId,
            suggestion,
            'agent:tool:contact_set_trust',
          );
          if (!applied.applied) {
            return textResultWithError(applied.reason, true);
          }

          return textResult(
            `Applied low-tier trust drift for ${contactId}: ${suggestion.fromTrustLevel} -> ${suggestion.suggestedTrustLevel}`,
          );
        }

        if (!trustLevel) {
          return textResultWithError('Missing trustLevel', true);
        }

        if (!(TRUST_LEVELS as readonly string[]).includes(trustLevel)) {
          return textResultWithError(
            `Invalid trust level: ${trustLevel}. Must be one of: ${TRUST_LEVELS.join(', ')}`,
            true,
          );
        }

        const contact = contactStore.getById(contactId);
        if (!contact) {
          return textResultWithError(`Contact ${contactId} not found`, true);
        }

        const success = contactStore.setTrustLevel(
          contactId,
          trustLevel,
          'agent:tool:contact_set_trust',
          { mutationSource: 'autonomous' },
        );
        if (!success) {
          if (isHighTierTrustLevel(trustLevel)) {
            return textResultWithError(
              `High-tier trust updates for ${contactId} require manual admin approval and do not bypass disclosure boundaries`,
              true,
            );
          }
          return textResultWithError(
            `Contact ${contactId} not found or is the primary user (cannot change primary trust level)`,
            true,
          );
        }
        return textResult(
          `Trust level for ${contactId} set to ${trustLevel}. Disclosure boundary and consent gates remain enforced.`,
        );
      } catch (error) {
        return textResultWithError(`contact_set_trust failed: ${errorMessage(error)}`, true);
      }
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
      try {
        const { contactId, notes } = params;

        const success = contactStore.updateNotes(contactId, notes, 'agent:tool:contact_note');
        if (!success) {
          return textResultWithError(`Contact ${contactId} not found`, true);
        }
        return textResult(`Notes updated for ${contactId}`);
      } catch (error) {
        return textResultWithError(`contact_note failed: ${errorMessage(error)}`, true);
      }
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
      try {
        if (!(CHANNEL_PRIVACY_LEVELS as readonly string[]).includes(params.privacyLevel)) {
          return textResultWithError(
            `Invalid channel privacy level: ${params.privacyLevel}. Must be one of: ${CHANNEL_PRIVACY_LEVELS.join(', ')}`,
            true,
          );
        }

        const updated = contactStore.setChannelPrivacy(
          params.contactId,
          params.channel,
          params.channelUserId,
          params.privacyLevel,
        );
        if (!updated) {
          return textResultWithError(
            `Channel link not found for ${params.contactId}: ${params.channel}:${params.channelUserId}`,
            true,
          );
        }

        return textResult(
          `Updated ${params.channel}:${params.channelUserId} privacy to ${params.privacyLevel} for ${params.contactId}`,
        );
      } catch (error) {
        return textResultWithError(`contact_set_channel_privacy failed: ${errorMessage(error)}`, true);
      }
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
      try {
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
          return textResultWithError(`No contact found for: ${id}`, true);
        }

        const identities = contact.channelIdentities
          ?.map(identity => `${identity.channel}:${identity.userId}`)
          .join(', ');
        const channels = contact.channels
          ?.map(channel => `${channel.channel}:${channel.userId}[${channel.privacyLevel}]`)
          .join(', ');
        const contactName = resolvePreferredContactName(contact) ?? contact.displayName;

        return textResult(
          `Canonical ID: ${contact.id}\n` +
          `Contact: ${contactName}\n` +
          `Trust: ${contact.trustLevel}\n` +
          `Relationship: ${contact.relationshipType}\n` +
          (identities ? `Identities: ${identities}\n` : '') +
          (channels ? `Channels: ${channels}\n` : '') +
          `First seen: ${contact.firstSeen}\n` +
          `Last seen: ${contact.lastSeen}` +
          (contact.notes ? `\nNotes: ${contact.notes}` : ''),
        );
      } catch (error) {
        return textResultWithError(`contact_lookup failed: ${errorMessage(error)}`, true);
      }
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
      try {
        if (params.privacyLevel && !(CHANNEL_PRIVACY_LEVELS as readonly string[]).includes(params.privacyLevel)) {
          return textResultWithError(
            `Invalid channel privacy level: ${params.privacyLevel}. Must be one of: ${CHANNEL_PRIVACY_LEVELS.join(', ')}`,
            true,
          );
        }

        const result = contactStore.linkChannelIdentity(
          params.contactId,
          params.channel,
          params.channelUserId,
          { privacyLevel: params.privacyLevel },
        );

        switch (result) {
          case 'linked':
            return textResult(`Linked ${params.channel}:${params.channelUserId} to ${params.contactId}`);
          case 'already_linked':
            return textResult(`${params.channel}:${params.channelUserId} is already linked to ${params.contactId}`);
          case 'contact_not_found':
            return textResultWithError(`Contact ${params.contactId} not found`, true);
          case 'identity_conflict':
          default:
            return textResultWithError(
              `${params.channel}:${params.channelUserId} is already linked to a different contact`,
              true,
            );
        }
      } catch (error) {
        return textResultWithError(`contact_link_identity failed: ${errorMessage(error)}`, true);
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
      try {
        const contacts = contactStore.listAll();

        if (contacts.length === 0) {
          return textResult('No contacts in address book.');
        }

        const lines = contacts.map(c =>
          `- ${(resolvePreferredContactName(c) ?? c.displayName)} [${c.trustLevel}/${c.relationshipType}]` +
          ((c.channels?.length ?? 0) > 0 ? ` channels=${c.channels!.length}` : '') +
          (c.notes ? ` — ${c.notes}` : ''),
        );
        return textResult(`Contacts (${contacts.length}):\n${lines.join('\n')}`);
      } catch (error) {
        return textResultWithError(`contact_list failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

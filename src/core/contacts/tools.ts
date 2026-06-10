// ── Contact Management Tools ──
// Unified model-facing contact surface plus compatibility wrappers for legacy tool names.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ContactStorePort } from './contact-store-port.js';
import type { TrustLevel } from '../../system/trust/types.js';
import { TRUST_LEVELS, isHighTierTrustLevel } from '../../system/trust/types.js';
import type { TrustDriftBehaviorSignals } from '../../system/trust/policy.js';
import { CHANNEL_PRIVACY_LEVELS, type ChannelPrivacyLevel, type Contact } from './types.js';
import { resolvePreferredContactName } from './preferred-name.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { withCapabilityRequirement } from '../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';

const CONTACT_ACTION_NAMES = [
  'list',
  'contact_list',
  'lookup',
  'contact_lookup',
  'note',
  'contact_note',
  'set_trust',
  'contact_set_trust',
  'link_identity',
  'contact_link_identity',
  'set_channel_privacy',
  'contact_set_channel_privacy',
  'set_machine_intelligence',
  'contact_set_machine_intelligence',
] as const;
const CONTACT_ACTION_HELP = [
  'list',
  'lookup',
  'note',
  'set_trust',
  'link_identity',
  'set_channel_privacy',
  'set_machine_intelligence',
].join(', ');

type ContactActionName = (typeof CONTACT_ACTION_NAMES)[number];
type ContactAction =
  | 'list'
  | 'lookup'
  | 'note'
  | 'set_trust'
  | 'link_identity'
  | 'set_channel_privacy'
  | 'set_machine_intelligence';

interface ContactSetTrustParams {
  contactId: string;
  trustLevel?: TrustLevel;
  behaviorSignals?: TrustDriftBehaviorSignals;
  confirmSuggestion?: boolean;
}

interface ContactToolParams extends Partial<ContactSetTrustParams> {
  action?: ContactActionName;
  isMachineIntelligence?: boolean;
  notes?: string;
  channel?: string;
  channelUserId?: string;
  privacyLevel?: ChannelPrivacyLevel;
}

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function normalizeContactAction(params: ContactToolParams): ContactAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const nonActionKeys = Object.entries(params)
      .filter(([key, value]) => key !== 'action' && value !== undefined)
      .map(([key]) => key);

    if (nonActionKeys.length === 0) {
      return 'list';
    }

    if (nonActionKeys.length === 1 && nonActionKeys[0] === 'contactId') {
      return 'lookup';
    }

    throw new Error(
      `action is required unless using default list behavior or lookup by contactId (${CONTACT_ACTION_HELP})`,
    );
  }

  switch (rawAction) {
    case 'list':
    case 'contact_list':
      return 'list';
    case 'lookup':
    case 'contact_lookup':
      return 'lookup';
    case 'note':
    case 'contact_note':
      return 'note';
    case 'set_trust':
    case 'contact_set_trust':
      return 'set_trust';
    case 'link_identity':
    case 'contact_link_identity':
      return 'link_identity';
    case 'set_channel_privacy':
    case 'contact_set_channel_privacy':
      return 'set_channel_privacy';
    case 'set_machine_intelligence':
    case 'contact_set_machine_intelligence':
      return 'set_machine_intelligence';
    default:
      throw new Error(`action must be one of: ${CONTACT_ACTION_HELP}`);
  }
}

async function executeContactSetTrust(
  contactStore: ContactStorePort,
  params: ContactSetTrustParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const { contactId, trustLevel, behaviorSignals, confirmSuggestion } = params;

  if (!contactId.trim()) {
    return textResultWithError('Missing contactId', true);
  }

  if (!behaviorSignals && !trustLevel) {
    return textResultWithError(
      'Provide either trustLevel for a direct update or behaviorSignals for drift suggestion flow',
      true,
    );
  }

  if (behaviorSignals) {
    const suggestion = await contactStore.suggestLowTierTrustDrift(
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

    const applied = await contactStore.applyLowTierTrustDriftSuggestion(
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

  const contact = await contactStore.getById(contactId);
  if (!contact) {
    return textResultWithError(`Contact ${contactId} not found`, true);
  }

  const success = await contactStore.setTrustLevel(
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
}

async function executeContactNote(
  contactStore: ContactStorePort,
  params: { contactId?: string; notes?: string },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const { contactId, notes } = params;
  if (!contactId?.trim()) {
    return textResultWithError('Missing contactId', true);
  }
  if (typeof notes !== 'string') {
    return textResultWithError('Missing notes', true);
  }

  const success = await contactStore.updateNotes(contactId, notes, 'agent:tool:contact_note');
  if (!success) {
    return textResultWithError(`Contact ${contactId} not found`, true);
  }
  return textResult(`Notes updated for ${contactId}`);
}

async function executeContactSetChannelPrivacy(
  contactStore: ContactStorePort,
  params: {
    contactId?: string;
    channel?: string;
    channelUserId?: string;
    privacyLevel?: ChannelPrivacyLevel;
  },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const { contactId, channel, channelUserId, privacyLevel } = params;
  if (!contactId?.trim()) {
    return textResultWithError('Missing contactId', true);
  }
  if (!channel?.trim()) {
    return textResultWithError('Missing channel', true);
  }
  if (!channelUserId?.trim()) {
    return textResultWithError('Missing channelUserId', true);
  }
  if (!privacyLevel) {
    return textResultWithError('Missing privacyLevel', true);
  }

  if (!(CHANNEL_PRIVACY_LEVELS as readonly string[]).includes(privacyLevel)) {
    return textResultWithError(
      `Invalid channel privacy level: ${privacyLevel}. Must be one of: ${CHANNEL_PRIVACY_LEVELS.join(', ')}`,
      true,
    );
  }

  const updated = await contactStore.setChannelPrivacy(
    contactId,
    channel,
    channelUserId,
    privacyLevel,
    'agent:tool:contact_set_channel_privacy',
  );
  if (!updated) {
    return textResultWithError(
      `Channel link not found for ${contactId}: ${channel}:${channelUserId}`,
      true,
    );
  }

  return textResult(
    `Updated ${channel}:${channelUserId} privacy to ${privacyLevel} for ${contactId}`,
  );
}

async function lookupContact(contactStore: ContactStorePort, id: string): Promise<Contact | undefined> {
  let contact = await contactStore.getById(id);
  if (!contact) {
    contact = await contactStore.getByDiscordUserId(id);
  }

  if (!contact) {
    const idx = id.indexOf(':');
    if (idx > 0 && idx < id.length - 1) {
      const channel = id.slice(0, idx).trim();
      const channelUserId = id.slice(idx + 1).trim();
      if (channel && channelUserId) {
        contact = await contactStore.getByChannelIdentity(channel, channelUserId);
      }
    }
  }

  return contact;
}

async function executeContactLookup(
  contactStore: ContactStorePort,
  params: { contactId?: string },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const id = params.contactId?.trim();
  if (!id) {
    return textResultWithError('Missing contactId', true);
  }

  const contact = await lookupContact(contactStore, id);
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
    `Canonical ID: ${contact.id}\n`
    + `Contact: ${contactName}\n`
    + `Trust: ${contact.trustLevel}\n`
    + `Relationship: ${contact.relationshipType}\n`
    + (contact.isMachineIntelligence ? 'Machine intelligence: yes (peer companion/agent)\n' : '')
    + (identities ? `Identities: ${identities}\n` : '')
    + (channels ? `Channels: ${channels}\n` : '')
    + `First seen: ${contact.firstSeen}\n`
    + `Last seen: ${contact.lastSeen}`
    + (contact.notes ? `\nNotes: ${contact.notes}` : ''),
  );
}

async function executeContactLinkIdentity(
  contactStore: ContactStorePort,
  params: {
    contactId?: string;
    channel?: string;
    channelUserId?: string;
    privacyLevel?: ChannelPrivacyLevel;
  },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const { contactId, channel, channelUserId, privacyLevel } = params;
  if (!contactId?.trim()) {
    return textResultWithError('Missing contactId', true);
  }
  if (!channel?.trim()) {
    return textResultWithError('Missing channel', true);
  }
  if (!channelUserId?.trim()) {
    return textResultWithError('Missing channelUserId', true);
  }

  if (privacyLevel && !(CHANNEL_PRIVACY_LEVELS as readonly string[]).includes(privacyLevel)) {
    return textResultWithError(
      `Invalid channel privacy level: ${privacyLevel}. Must be one of: ${CHANNEL_PRIVACY_LEVELS.join(', ')}`,
      true,
    );
  }

  const result = await contactStore.linkChannelIdentity(
    contactId,
    channel,
    channelUserId,
    { privacyLevel },
    'agent:tool:contact_link_identity',
  );

  switch (result) {
    case 'linked':
      return textResult(`Linked ${channel}:${channelUserId} to ${contactId}`);
    case 'already_linked':
      return textResult(`${channel}:${channelUserId} is already linked to ${contactId}`);
    case 'contact_not_found':
      return textResultWithError(`Contact ${contactId} not found`, true);
    case 'identity_conflict':
    default:
      return textResultWithError(
        `${channel}:${channelUserId} is already linked to a different contact`,
        true,
      );
  }
}

async function executeContactList(
  contactStore: ContactStorePort,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const contacts = await contactStore.listAll();

  if (contacts.length === 0) {
    return textResult('No contacts in address book.');
  }

  const lines = contacts.map(c =>
    `- ${(resolvePreferredContactName(c) ?? c.displayName)} [${c.trustLevel}/${c.relationshipType}]`
    + ((c.channels?.length ?? 0) > 0 ? ` channels=${c.channels!.length}` : '')
    + (c.notes ? ` — ${c.notes}` : ''),
  );
  return textResult(`Contacts (${contacts.length}):\n${lines.join('\n')}`);
}

async function executeUnifiedContactAction(
  contactStore: ContactStorePort,
  params: ContactToolParams = {},
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const action = normalizeContactAction(params);

  switch (action) {
    case 'list':
      return await executeContactList(contactStore);
    case 'lookup':
      return await executeContactLookup(contactStore, params);
    case 'note':
      return await executeContactNote(contactStore, params);
    case 'set_trust':
      return await executeContactSetTrust(contactStore, params as ContactSetTrustParams);
    case 'link_identity':
      return await executeContactLinkIdentity(contactStore, params);
    case 'set_channel_privacy':
      return await executeContactSetChannelPrivacy(contactStore, params);
    case 'set_machine_intelligence':
      return await executeContactSetMachineIntelligence(contactStore, params);
  }
}

async function executeContactSetMachineIntelligence(
  contactStore: ContactStorePort,
  params: ContactToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const contactId = params.contactId?.trim() ?? '';
  if (!contactId) {
    return textResultWithError('Missing contactId', true);
  }
  if (typeof params.isMachineIntelligence !== 'boolean') {
    return textResultWithError('Provide isMachineIntelligence: true or false', true);
  }
  const applied = await contactStore.setMachineIntelligence(
    contactId,
    params.isMachineIntelligence,
    'agent:tool:contact_set_machine_intelligence',
  );
  if (!applied) {
    return textResultWithError(`Contact not found: ${contactId}`, true);
  }
  return textResult(
    `Contact ${contactId} is now marked as ${params.isMachineIntelligence
      ? 'a machine intelligence (peer companion/agent — conversation loop risk applies)'
      : 'not a machine intelligence'}.`,
  );
}

export function createContactTool(contactStore: ContactStorePort): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'contact',
    label: 'contact',
    description:
      'Unified contact surface for listing, lookup, notes, trust, identity linking, and channel privacy. '
      + `Use action=${CONTACT_ACTION_HELP}. `
      + 'Trust and disclosure boundaries remain enforced, and legacy contact_* action aliases are accepted.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union(CONTACT_ACTION_NAMES.map((action) => Type.Literal(action)), {
        description:
          'Contact action. Defaults to list when omitted with no other params. '
          + 'Defaults to lookup when omitted with only contactId.',
      })),
      contactId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Canonical contact ID, Discord user ID, or channel identity (channel:userId) for lookup.',
      })),
      notes: Type.Optional(Type.String({
        description: 'Notes to store when action=note.',
      })),
      isMachineIntelligence: Type.Optional(Type.Boolean({
        description: 'For action=set_machine_intelligence: whether this contact is another machine intelligence (peer companion/agent).',
      })),
      trustLevel: Type.Optional(Type.Unsafe<TrustLevel>({
        type: 'string',
        enum: [...TRUST_LEVELS],
        description: 'Trust level when action=set_trust.',
      })),
      behaviorSignals: Type.Optional(Type.Object({
        positiveInteractionCount: Type.Integer({ minimum: 0, description: 'Observed positive interactions' }),
        negativeInteractionCount: Type.Optional(Type.Integer({ minimum: 0, description: 'Observed negative interactions' })),
        verifiedIdentityLinks: Type.Optional(Type.Integer({ minimum: 0, description: 'Verified channel identity links' })),
        consistentBoundaryRespect: Type.Optional(Type.Boolean({
          description: 'Whether behavior consistently respected boundaries',
        })),
      }, {
        description: 'Behavior signals for low-tier trust drift suggestion flow when action=set_trust.',
      })),
      confirmSuggestion: Type.Optional(Type.Boolean({
        description: 'Apply a trust drift suggestion after preview when action=set_trust.',
      })),
      channel: Type.Optional(Type.String({
        minLength: 1,
        description: 'Channel key for action=link_identity|set_channel_privacy.',
      })),
      channelUserId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Channel-local user ID for action=link_identity|set_channel_privacy.',
      })),
      privacyLevel: Type.Optional(Type.Unsafe<ChannelPrivacyLevel>({
        type: 'string',
        enum: [...CHANNEL_PRIVACY_LEVELS],
        description: 'Channel privacy level for action=link_identity|set_channel_privacy.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ContactToolParams = {},
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let actionForError = typeof params.action === 'string' ? params.action : undefined;
      try {
        actionForError = normalizeContactAction(params);
        return await executeUnifiedContactAction(contactStore, params);
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`contact failed${suffix}: ${errorMessage(error)}`, true);
      }
    },
  };

  return tagToolWithReversibility(
    withCapabilityRequirement(tool, (params) => {
      const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
      switch (rawAction) {
        case '':
          return Object.keys(params).length === 0 || (Object.keys(params).length === 1 && typeof params.contactId === 'string')
            ? 'identity.read'
            : ['identity.read', 'identity.write.runtime'] as const;
        case 'list':
        case 'contact_list':
        case 'lookup':
        case 'contact_lookup':
          return 'identity.read';
        case 'note':
        case 'contact_note':
        case 'set_trust':
        case 'contact_set_trust':
        case 'link_identity':
        case 'contact_link_identity':
        case 'set_channel_privacy':
        case 'contact_set_channel_privacy':
        case 'set_machine_intelligence':
        case 'contact_set_machine_intelligence':
          return 'identity.write.runtime';
        default:
          return ['identity.read', 'identity.write.runtime'] as const;
      }
    }),
    'irreversible',
  );
}

export function createContactSetTrustTool(contactStore: ContactStorePort): AgentTool<any> {
  return {
    name: 'contact_set_trust',
    description:
      'Set or suggest a trust level for a contact. Behavior-driven drift suggestions '
      + 'can only auto-apply low-tier changes after explicit confirmation. '
      + 'Trust level changes do not bypass explicit disclosure boundaries.',
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
        return await executeContactSetTrust(contactStore, params);
      } catch (error) {
        return textResultWithError(`contact_set_trust failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createContactNoteTool(contactStore: ContactStorePort): AgentTool<any> {
  return {
    name: 'contact_note',
    description:
      'Add or update notes about a contact. Use this to record observations about '
      + 'relationships, preferences, or interaction patterns.',
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
        return await executeContactNote(contactStore, params);
      } catch (error) {
        return textResultWithError(`contact_note failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createContactSetChannelPrivacyTool(contactStore: ContactStorePort): AgentTool<any> {
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
        return await executeContactSetChannelPrivacy(contactStore, params);
      } catch (error) {
        return textResultWithError(`contact_set_channel_privacy failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createContactLookupTool(contactStore: ContactStorePort): AgentTool<any> {
  return {
    name: 'contact_lookup',
    description:
      'Look up a contact by canonical ID, Discord user ID, or channel identity (channel:userId). '
      + 'Returns trust level, relationship type, and notes.',
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
        return await executeContactLookup(contactStore, params);
      } catch (error) {
        return textResultWithError(`contact_lookup failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createContactLinkIdentityTool(contactStore: ContactStorePort): AgentTool<any> {
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
        return await executeContactLinkIdentity(contactStore, params);
      } catch (error) {
        return textResultWithError(`contact_link_identity failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createContactListTool(contactStore: ContactStorePort): AgentTool<any> {
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
        return await executeContactList(contactStore);
      } catch (error) {
        return textResultWithError(`contact_list failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

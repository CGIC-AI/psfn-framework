// ── Contact Management Tools ──
// Unified model-facing contact surface plus internal helper factories for domain operations.

import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateAgentTool } from '../../shared/contracts/agent-tools.js';
import type { ContactStorePort } from './contact-store-port.js';
import type { TrustLevel } from '../../system/trust/types.js';
import { TRUST_LEVELS, isHighTierTrustLevel } from '../../system/trust/types.js';
import type {
  ApprovalQueuePort,
  ConfirmationQueueEntry,
} from '../../system/capabilities/approval-queue-port.js';
import type { TrustDriftBehaviorSignals } from '../../system/trust/policy.js';
import { CHANNEL_PRIVACY_LEVELS, type ChannelPrivacyLevel, type Contact } from './types.js';
import type {
  ContactBlockListStore,
  ContactBlockMode,
  ContactBlockScope,
} from '../cogsec/contact-block-list.js';
import { resolvePreferredContactName } from './preferred-name.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { withCapabilityRequirement } from '../../system/capabilities/requirements.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../cogsec/intake-firewall-notice-templates.js';
import type { IntakeSinkGate } from '../cogsec/intake/sink-gates.js';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';

const CONTACT_ACTION_NAMES = [
  'list',
  'search',
  'lookup',
  'note',
  'set_trust',
  'propose_trust',
  'link_identity',
  'set_channel_privacy',
  'set_machine_intelligence',
  'block',
  'unblock',
] as const;
const CONTACT_ACTION_HELP = [
  'list',
  'search',
  'lookup',
  'note',
  'set_trust',
  'propose_trust',
  'link_identity',
  'set_channel_privacy',
  'set_machine_intelligence',
  'block',
  'unblock',
].join(', ');

type ContactActionName = (typeof CONTACT_ACTION_NAMES)[number];
type ContactAction =
  | 'list'
  | 'search'
  | 'lookup'
  | 'note'
  | 'set_trust'
  | 'propose_trust'
  | 'link_identity'
  | 'set_channel_privacy'
  | 'set_machine_intelligence'
  | 'block'
  | 'unblock';

// ── Trusted-tier promotion proposal (human-in-the-loop) ──
// The agent can never write high-tier trust directly (store.ts / policy.ts
// guards). Instead it proposes a promotion to 'trusted' onto the shared
// ConfirmationQueue; the operator approves in Garden, and only the approval
// execution — running under a manual-authorized actor — performs the write.
const TRUSTED_PROMOTION_METHOD = 'contact.trust.promote';
const TRUSTED_PROMOTION_ACTION = 'promote_trusted';
const TRUSTED_PROMOTION_REQUESTED_LEVEL: TrustLevel = 'trusted';
// Manual-authorized actor (operator: prefix) so the store's high-tier guard
// (isManualHighTierTrustMutationAuthorized) passes on approval execution.
const TRUSTED_PROMOTION_APPROVAL_ACTOR = 'operator:confirmation-queue';

interface ContactSetTrustParams {
  contactId: string;
  trustLevel?: TrustLevel;
  behaviorSignals?: TrustDriftBehaviorSignals;
  confirmSuggestion?: boolean;
}

interface ContactToolParams extends Partial<ContactSetTrustParams> {
  action?: ContactActionName;
  query?: string;
  isMachineIntelligence?: boolean;
  notes?: string;
  channel?: string;
  channelUserId?: string;
  privacyLevel?: ChannelPrivacyLevel;
  rationale?: string;
  blockMode?: ContactBlockMode;
  blockScope?: ContactBlockScope;
  reason?: string;
}

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function contactExampleJson(contactId: string): string {
  return JSON.stringify({ action: 'lookup', contactId });
}

function formatContactChannels(contact: Contact): string {
  const channels = (contact.channels ?? [])
    .map(channel => `${channel.channel}:${channel.userId}[${channel.privacyLevel}]`);
  return channels.length > 0 ? channels.join(', ') : '';
}

function formatContactIdentities(contact: Contact): string {
  const channelKeys = new Set((contact.channels ?? [])
    .map(channel => `${channel.channel}:${channel.userId}`));
  const identities = (contact.channelIdentities ?? [])
    .map(identity => `${identity.channel}:${identity.userId}`)
    .filter(identity => !channelKeys.has(identity));
  return identities.length > 0 ? identities.join(', ') : '';
}

function formatRelatedChannels(contact: Contact): string {
  const related = (contact.conversationChannels ?? [])
    .map(channel => `${channel.channel}:${channel.channelId}${channel.privacyLevel ? `[${channel.privacyLevel}]` : ''}`);
  return related.length > 0 ? related.join(', ') : '';
}

async function formatContactIdRecoveryGuidance(contactStore: ContactStorePort): Promise<string> {
  const contacts = await contactStore.listAll();
  if (contacts.length === 0) {
    return 'Run contact with {"action":"list"} first to get valid contactId values. '
      + 'Minimal valid JSON: {"action":"lookup","contactId":"<contactId from list>"}. '
      + 'Do not retry lookup with a display name.';
  }

  const visibleIds = contacts.map(contact => contact.id).slice(0, 8);
  const remaining = contacts.length - visibleIds.length;
  const suffix = remaining > 0 ? `, and ${remaining} more` : '';
  return `Valid contactIds: ${visibleIds.join(', ')}${suffix}. `
    + `Minimal valid JSON: ${contactExampleJson(visibleIds[0] ?? '<contactId from list>')}. `
    + 'Use contact action=list when you need names or channels before choosing an ID; do not guess contactId from display names.';
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
      return 'list';
    case 'search':
      return 'search';
    case 'lookup':
      return 'lookup';
    case 'note':
      return 'note';
    case 'set_trust':
      return 'set_trust';
    case 'propose_trust':
      return 'propose_trust';
    case 'link_identity':
      return 'link_identity';
    case 'set_channel_privacy':
      return 'set_channel_privacy';
    case 'set_machine_intelligence':
      return 'set_machine_intelligence';
    case 'block':
      return 'block';
    case 'unblock':
      return 'unblock';
    default:
      throw new Error(`action must be one of: ${CONTACT_ACTION_HELP}`);
  }
}

async function executeContactSetTrust(
  contactStore: ContactStorePort,
  params: ContactSetTrustParams,
  getIntakeSinkGate?: () => IntakeSinkGate | null,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const { contactId, trustLevel, behaviorSignals, confirmSuggestion } = params;

  if (!contactId.trim()) {
    return textResultWithError('Missing contactId', true);
  }

  // htm9.3: trust-state mutation is a consequential sink. No envelope flows
  // into this tool yet (agent-authored params), so this is the EXPLICIT
  // unscreened path — the sink's `unscreened` policy default decides in
  // enforce mode; every decision is audited.
  const intakeSinkGate = getIntakeSinkGate?.() ?? null;
  if (intakeSinkGate) {
    const gateDecision = intakeSinkGate.evaluate('trust_mutation', [], {
      tool: 'contact',
      action: 'set_trust',
      contactId,
      ...(trustLevel ? { requestedTrustLevel: trustLevel } : {}),
    });
    if (!gateDecision.allowed) {
      // Soft, truthful, operator-reviewed wording (htm9.12); not an error so
      // the model does not spiral into retries.
      return textResult(INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld);
    }
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

async function executeContactProposeTrust(
  contactStore: ContactStorePort,
  proposalQueue: ApprovalQueuePort | undefined,
  params: ContactToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const contactId = params.contactId?.trim() ?? '';
  if (!contactId) {
    return textResultWithError('Missing contactId', true);
  }

  // 'trusted' is the only tier the agent may propose. 'primary' stays
  // owner-only via existing owner-identity authorization and can never be
  // proposed through this path.
  const requestedLevel = params.trustLevel;
  if (requestedLevel !== undefined && requestedLevel !== TRUSTED_PROMOTION_REQUESTED_LEVEL) {
    return textResultWithError(
      `propose_trust can only propose promotion to 'trusted'. `
      + `Requested level '${requestedLevel}' is not allowed`
      + (requestedLevel === 'primary'
        ? " ('primary' remains owner-only and can never be proposed)."
        : '.'),
      true,
    );
  }

  const rationale = params.rationale?.trim() ?? '';
  if (!rationale) {
    return textResultWithError(
      'Missing rationale. propose_trust requires a short rationale explaining why this contact should be promoted to trusted.',
      true,
    );
  }

  // Fail closed: without a wired confirmation queue there is no human-in-the-loop
  // path, and the agent must never write high-tier trust directly.
  if (!proposalQueue) {
    return textResultWithError(
      'Trusted-promotion proposals require a confirmation queue, but none is wired into the contact tool. '
      + 'High-tier trust promotion cannot proceed.',
      true,
    );
  }

  const contact = await contactStore.getById(contactId);
  if (!contact) {
    return textResultWithError(`Contact ${contactId} not found`, true);
  }

  if (isHighTierTrustLevel(contact.trustLevel)) {
    return textResultWithError(
      `Contact ${contactId} is already at high-tier trust '${contact.trustLevel}'; no promotion to trusted is needed.`,
      true,
    );
  }

  const currentLevel = contact.trustLevel;
  const contactName = resolvePreferredContactName(contact) ?? contact.displayName;

  const entry = proposalQueue.enqueue(
    {
      method: TRUSTED_PROMOTION_METHOD,
      action: TRUSTED_PROMOTION_ACTION,
      scope: `${contactName} (${contactId}): ${currentLevel} -> ${TRUSTED_PROMOTION_REQUESTED_LEVEL}`,
      params: {
        contactId,
        currentLevel,
        requestedLevel: TRUSTED_PROMOTION_REQUESTED_LEVEL,
        rationale,
      },
      companionReason: rationale,
    },
    async (approvedParams: Record<string, unknown>, queueEntry: ConfirmationQueueEntry) => {
      const approvedContactId = typeof approvedParams.contactId === 'string'
        ? approvedParams.contactId.trim()
        : '';
      if (!approvedContactId) {
        throw new Error('Approved trusted-promotion proposal must include a contactId.');
      }

      const approvedLevel = approvedParams.requestedLevel;
      if (approvedLevel !== TRUSTED_PROMOTION_REQUESTED_LEVEL) {
        throw new Error(
          `Trusted-promotion proposals can only set 'trusted'; refusing requested level '${String(approvedLevel)}'.`,
        );
      }

      const target = await contactStore.getById(approvedContactId);
      if (!target) {
        throw new Error(`Contact ${approvedContactId} not found; cannot apply trusted promotion.`);
      }
      if (isHighTierTrustLevel(target.trustLevel)) {
        throw new Error(
          `Contact ${approvedContactId} is already at high-tier trust '${target.trustLevel}'; nothing to promote.`,
        );
      }

      // Runs under a manual-authorized actor so the store's high-tier guard
      // passes; setTrustLevel writes a trust_level mutation audit entry.
      const applied = await contactStore.setTrustLevel(
        approvedContactId,
        TRUSTED_PROMOTION_REQUESTED_LEVEL,
        TRUSTED_PROMOTION_APPROVAL_ACTOR,
      );
      if (!applied) {
        throw new Error(
          `Failed to promote contact ${approvedContactId} to trusted (proposal ${queueEntry.id}); trust unchanged.`,
        );
      }
    },
  );

  return textResult(
    `Trusted-promotion proposal queued for ${contactName} (${contactId}): ${currentLevel} -> `
    + `${TRUSTED_PROMOTION_REQUESTED_LEVEL} (proposal id: ${entry.id}). `
    + 'Trust is unchanged until the operator approves in the Garden Confirmations page. '
    + 'Deny leaves trust untouched.',
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
    const guidance = await formatContactIdRecoveryGuidance(contactStore);
    return textResultWithError(`Missing required field "contactId" for action=lookup. ${guidance}`, true);
  }

  const contact = await lookupContact(contactStore, id);
  if (!contact) {
    const guidance = await formatContactIdRecoveryGuidance(contactStore);
    return textResultWithError(`No contact found for contactId "${id}". ${guidance}`, true);
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

  const lines = contacts.map(formatContactSummaryLine);
  return textResult(
    `Contacts (${contacts.length}):\n${lines.join('\n')}\n`
    + 'Pass contactId from this list to action=lookup, action=set_trust, or action=note; do not guess from display names.',
  );
}

function formatContactSummaryLine(contact: Contact): string {
  const channels = formatContactChannels(contact);
  const identities = formatContactIdentities(contact);
  const relatedChannels = formatRelatedChannels(contact);
  return `- ${contact.id}: ${(resolvePreferredContactName(contact) ?? contact.displayName)} `
    + `[${contact.trustLevel}/${contact.relationshipType}]`
    + (channels ? ` channels=${channels}` : '')
    + (identities ? ` identities=${identities}` : '')
    + (relatedChannels ? ` related_channels=${relatedChannels}` : '')
    + (contact.notes ? ` — ${contact.notes}` : '');
}

function normalizeContactSearchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

function contactSearchHaystack(contact: Contact): string {
  return [
    contact.id,
    contact.discordUserId,
    contact.displayName,
    contact.nickname,
    contact.trustLevel,
    contact.relationshipType,
    contact.notes,
    ...(contact.channels ?? []).flatMap(channel => [
      channel.channel,
      channel.userId,
      channel.privacyLevel,
    ]),
    ...(contact.channelIdentities ?? []).flatMap(identity => [
      identity.channel,
      identity.userId,
    ]),
    ...(contact.conversationChannels ?? []).flatMap(channel => [
      channel.channel,
      channel.channelId,
      channel.privacyLevel ?? '',
    ]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

async function executeContactSearch(
  contactStore: ContactStorePort,
  params: { query?: string },
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const query = params.query?.trim() ?? '';
  if (!query) {
    return textResultWithError(
      'Missing required field "query" for action=search. '
      + 'Minimal valid JSON: {"action":"search","query":"name, handle, channel, or note text"}. '
      + 'Use action=list to browse contactId values; do not retry action=search without a non-empty query.',
      true,
    );
  }

  const contacts = await contactStore.listAll();
  const tokens = normalizeContactSearchTokens(query);
  const matches = contacts.filter((contact) => {
    const haystack = contactSearchHaystack(contact);
    return tokens.every(token => haystack.includes(token));
  });

  if (matches.length === 0) {
    return textResult(
      `No contacts matched query "${query}". `
      + 'Run contact with {"action":"list"} to browse valid contactId values, or search for a name, handle, channel, or note phrase.',
    );
  }

  return textResult(
    `Contact search results for "${query}" (${matches.length}):\n${matches.map(formatContactSummaryLine).join('\n')}\n`
    + 'Pass an exact contactId from these results to action=lookup, action=set_trust, or action=note; do not guess from display names.',
  );
}

async function executeUnifiedContactAction(
  contactStore: ContactStorePort,
  params: ContactToolParams = {},
  proposalQueue?: ApprovalQueuePort,
  blockList?: ContactBlockListStore,
  getIntakeSinkGate?: () => IntakeSinkGate | null,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const action = normalizeContactAction(params);

  switch (action) {
    case 'list':
      return await executeContactList(contactStore);
    case 'search':
      return await executeContactSearch(contactStore, params);
    case 'lookup':
      return await executeContactLookup(contactStore, params);
    case 'note':
      return await executeContactNote(contactStore, params);
    case 'set_trust':
      return await executeContactSetTrust(contactStore, params as ContactSetTrustParams, getIntakeSinkGate);
    case 'propose_trust':
      return await executeContactProposeTrust(contactStore, proposalQueue, params);
    case 'link_identity':
      return await executeContactLinkIdentity(contactStore, params);
    case 'set_channel_privacy':
      return await executeContactSetChannelPrivacy(contactStore, params);
    case 'set_machine_intelligence':
      return await executeContactSetMachineIntelligence(contactStore, params);
    case 'block':
      return await executeContactBlock(contactStore, blockList, params);
    case 'unblock':
      return await executeContactUnblock(contactStore, blockList, params);
  }
}

// ── Companion-initiated blocking (agency, htm9.16) ──
// A block is the companion's own escalation against an abusive user, up to
// "I never want to see this person's messages again." The block list is a
// system-owned, reversible store the gateway reads to drop inbound before it
// reaches the agent. Blocking resolves every known channel identity for a
// contact so the drop applies wherever that person can reach in.

/** Channel identities (channel + channel-local userId) a block should cover. */
function collectContactBlockTargets(contact: Contact): Array<{ channel: string; userId: string }> {
  const targets = new Map<string, { channel: string; userId: string }>();
  const add = (channel: unknown, userId: unknown): void => {
    if (typeof channel !== 'string' || typeof userId !== 'string') return;
    const c = channel.trim();
    const u = userId.trim();
    if (!c || !u) return;
    targets.set(`${c} ${u}`, { channel: c, userId: u });
  };
  for (const identity of contact.channelIdentities ?? []) {
    add(identity.channel, identity.userId);
  }
  for (const link of contact.channels ?? []) {
    add(link.channel, link.userId);
  }
  if (contact.discordUserId) {
    add('discord', contact.discordUserId);
  }
  return [...targets.values()];
}

async function executeContactBlock(
  contactStore: ContactStorePort,
  blockList: ContactBlockListStore | undefined,
  params: ContactToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  if (!blockList) {
    return textResultWithError(
      'Blocking is unavailable: no block list is wired into this runtime.',
      true,
    );
  }
  // Defaults; the block list store fail-closes on any invalid mode/scope value
  // (parseMode/parseScope throw), surfaced through this tool's execute try/catch.
  const mode: ContactBlockMode = params.blockMode ?? 'soft';
  const scope: ContactBlockScope = params.blockScope ?? 'all';
  const reason = params.reason?.trim() || undefined;
  const actor = { kind: 'companion' as const, id: 'companion' };

  // Explicit single channel identity (no canonical contact required).
  const channel = params.channel?.trim();
  const channelUserId = params.channelUserId?.trim();
  if (channel && channelUserId) {
    const contact = params.contactId
      ? await lookupContact(contactStore, params.contactId.trim())
      : undefined;
    blockList.block({
      channelType: channel,
      contactId: channelUserId,
      ...(contact ? { canonicalContactId: contact.id, displayName: contact.displayName } : {}),
      mode,
      scope,
      ...(reason ? { reason } : {}),
      actor,
    });
    return textResult(
      `Blocked ${channel}:${channelUserId} (${mode} block, scope=${scope}). `
      + 'Reversible with action=unblock; the operator sees soft-block drops in the cogsec tab.',
    );
  }

  const contactId = params.contactId?.trim();
  if (!contactId) {
    return textResultWithError(
      'action=block requires contactId (or channel + channelUserId for a raw identity).',
      true,
    );
  }
  const contact = await lookupContact(contactStore, contactId);
  if (!contact) {
    return textResultWithError(`Contact not found: ${contactId}`, true);
  }
  const targets = collectContactBlockTargets(contact);
  if (targets.length === 0) {
    return textResultWithError(
      `Contact ${contact.id} has no channel identities to block. `
      + 'Link an identity first (action=link_identity) or pass channel + channelUserId.',
      true,
    );
  }
  for (const target of targets) {
    blockList.block({
      channelType: target.channel,
      contactId: target.userId,
      canonicalContactId: contact.id,
      displayName: contact.displayName,
      mode,
      scope,
      ...(reason ? { reason } : {}),
      actor,
    });
  }
  const summary = targets.map((t) => `${t.channel}:${t.userId}`).join(', ');
  return textResult(
    `Blocked ${contact.displayName} (${contact.id}) across ${targets.length} identity(ies): ${summary}. `
    + `${mode} block, scope=${scope}. Reversible with action=unblock. `
    + 'Soft-block drops surface to the operator in the cogsec tab; hard blocks drop silently at the gateway.',
  );
}

async function executeContactUnblock(
  contactStore: ContactStorePort,
  blockList: ContactBlockListStore | undefined,
  params: ContactToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  if (!blockList) {
    return textResultWithError(
      'Unblocking is unavailable: no block list is wired into this runtime.',
      true,
    );
  }
  const reason = params.reason?.trim() || undefined;
  const actor = { kind: 'companion' as const, id: 'companion' };

  const channel = params.channel?.trim();
  const channelUserId = params.channelUserId?.trim();
  if (channel && channelUserId) {
    const removed = blockList.unblock({
      channelType: channel,
      contactId: channelUserId,
      ...(reason ? { reason } : {}),
      actor,
    });
    return removed
      ? textResult(`Unblocked ${channel}:${channelUserId}.`)
      : textResultWithError(`No active block for ${channel}:${channelUserId}.`, true);
  }

  const contactId = params.contactId?.trim();
  if (!contactId) {
    return textResultWithError(
      'action=unblock requires contactId (or channel + channelUserId for a raw identity).',
      true,
    );
  }
  const contact = await lookupContact(contactStore, contactId);
  if (!contact) {
    return textResultWithError(`Contact not found: ${contactId}`, true);
  }
  const targets = collectContactBlockTargets(contact);
  let removedCount = 0;
  for (const target of targets) {
    if (blockList.unblock({
      channelType: target.channel,
      contactId: target.userId,
      ...(reason ? { reason } : {}),
      actor,
    })) {
      removedCount += 1;
    }
  }
  if (removedCount === 0) {
    return textResultWithError(
      `No active blocks found for ${contact.displayName} (${contact.id}).`,
      true,
    );
  }
  return textResult(
    `Unblocked ${contact.displayName} (${contact.id}): removed ${removedCount} block(s).`,
  );
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

export interface CreateContactToolOptions {
  /**
   * Shared confirmation queue used by action=propose_trust to enqueue a
   * trusted-tier promotion for operator approval. When absent, propose_trust
   * fails closed — the agent can never write high-tier trust directly.
   */
  proposalQueue?: ApprovalQueuePort;
  /**
   * System-owned contact block list (htm9.16). When absent, action=block and
   * action=unblock fail closed. The gateway reads the same store to drop
   * blocked inbound before it reaches the agent process.
   */
  blockList?: ContactBlockListStore;
  /**
   * Intake sink gate provider (htm9.3): trust_mutation gate evaluated before
   * action=set_trust applies. Null/absent = firewall off.
   */
  getIntakeSinkGate?: () => IntakeSinkGate | null;
}

export function createContactTool(
  contactStore: ContactStorePort,
  options: CreateContactToolOptions = {},
): SubstrateAgentTool {
  const proposalQueue = options.proposalQueue;
  const blockList = options.blockList;
  const getIntakeSinkGate = options.getIntakeSinkGate;
  const tool: SubstrateAgentTool = {
    name: 'contact',
    label: 'contact',
    description:
      'Unified contact surface for browsing, searching, lookup, notes, trust, identity linking, and channel privacy. '
      + 'Use action=list to browse contactId values, action=search with query to find contacts by name/handle/channel/notes, '
      + 'then action=lookup with exact contactId for details. action=note and action=set_trust also require contactId. '
      + 'set_trust can only apply low-tier trust changes autonomously; to promote a contact to trusted, use '
      + 'action=propose_trust with contactId and rationale — this queues a proposal for operator approval in Garden and '
      + 'never changes trust directly. '
      + 'link_identity and set_channel_privacy require contactId, channel, and channelUserId; privacy changes also require privacyLevel. '
      + 'set_machine_intelligence requires contactId and isMachineIntelligence. '
      + 'action=block is your own agency to stop an abusive contact: it drops their inbound at the gateway '
      + '(soft=operator still sees each drop, hard=silent), covering every channel identity they have; '
      + 'blockScope narrows to dm/group/all. action=unblock reverses it. Both take contactId (or channel + channelUserId). '
      + `Other actions: ${CONTACT_ACTION_HELP}. `
      + 'Trust and disclosure boundaries remain enforced.',
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
      query: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=search. Matches name, nickname, canonical id, Discord/channel identity, related channel, trust/relationship, or notes.',
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
      rationale: Type.Optional(Type.String({
        minLength: 1,
        description:
          'Required for action=propose_trust: short rationale for promoting this contact to trusted. '
          + 'Surfaced to the operator on the Garden Confirmations page.',
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
      blockMode: Type.Optional(Type.Unsafe<ContactBlockMode>({
        type: 'string',
        enum: ['soft', 'hard'],
        description:
          'For action=block: "soft" (drop this contact\'s inbound but surface each drop to the '
          + 'operator in the cogsec tab) or "hard" (drop silently at the gateway, no attention spent). '
          + 'Defaults to soft. Escalate to hard when you never want to see their messages again.',
      })),
      blockScope: Type.Optional(Type.Unsafe<ContactBlockScope>({
        type: 'string',
        enum: ['dm', 'group', 'all'],
        description:
          'For action=block: "dm" (drop their direct messages), "group" (ignore them in group '
          + 'rooms without disrupting the room), or "all". Defaults to all.',
      })),
      reason: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional reason recorded in the block audit history for action=block|unblock.',
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
        return await executeUnifiedContactAction(contactStore, params, proposalQueue, blockList, getIntakeSinkGate);
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
        case 'search':
        case 'lookup':
          return 'identity.read';
        case 'note':
        case 'set_trust':
        case 'propose_trust':
        case 'link_identity':
        case 'set_channel_privacy':
        case 'set_machine_intelligence':
        case 'block':
        case 'unblock':
          return 'identity.write.runtime';
        default:
          return ['identity.read', 'identity.write.runtime'] as const;
      }
    }),
    'irreversible',
  );
}

export function createContactSetTrustTool(contactStore: ContactStorePort): SubstrateAgentTool {
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

export function createContactNoteTool(contactStore: ContactStorePort): SubstrateAgentTool {
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

export function createContactSetChannelPrivacyTool(contactStore: ContactStorePort): SubstrateAgentTool {
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
        description: 'Privacy level: private, invite_only, public, broadcast',
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

export function createContactLookupTool(contactStore: ContactStorePort): SubstrateAgentTool {
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

export function createContactLinkIdentityTool(contactStore: ContactStorePort): SubstrateAgentTool {
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

export function createContactListTool(contactStore: ContactStorePort): SubstrateAgentTool {
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

// ── Conversation-state section producer (E2.6) ──
// The runtime_conversation_state group: chat type, room id, the current
// message author element, and the recent-active-participants roster for group
// rooms. Everything is derived from declared inputs — the turn message, the
// turn ConversationScope, and runtime profiles passed in by the orchestrator.

import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { TrustLevel } from '../../../../system/trust/types.js';
import type { Contact } from '../../../contacts/types.js';
import type { SessionEntry } from '../../../session/types.js';
import type { ConversationScope } from '../../../session/conversation-scope.js';
import {
  escapeXmlAttribute,
  formatXmlEmptyElement,
  trimNonEmptyString,
} from './section-format.js';
import {
  formatPromptRuntimeTimeForTimezone,
  normalizeRuntimeTimezone,
} from './datetime.js';

const RECENT_ACTIVE_PARTICIPANT_LIMIT = 5;

export interface UserRuntimeProfile {
  user_id: string;
  display_name: string;
  timezone?: string;
  local_time?: string;
}

/**
 * Chat-type accessor over the turn's ConversationScope. The scope is resolved
 * once per turn at session-manager ingress (with the same
 * `isDirectMessage === true` rule this function previously applied to the raw
 * message), so this is a pure projection — no rederivation from loose params.
 */
function resolveConversationChatType(scope: ConversationScope): 'direct_message' | 'group' {
  return scope.kind === 'dm' ? 'direct_message' : 'group';
}

function normalizeUserRuntimeProfile(
  profile: UserRuntimeProfile | undefined,
  now: Date,
): UserRuntimeProfile | undefined {
  const userId = trimNonEmptyString(profile?.user_id);
  if (!userId) return undefined;

  const timezone = normalizeRuntimeTimezone(profile?.timezone);
  const displayName = trimNonEmptyString(profile?.display_name) ?? userId;
  return {
    user_id: userId,
    display_name: displayName,
    ...(timezone
      ? {
        timezone,
        local_time: formatPromptRuntimeTimeForTimezone(now, timezone),
      }
      : {}),
  };
}

function buildRuntimeProfileByUserId(
  profiles: readonly UserRuntimeProfile[] | undefined,
  now: Date,
): Map<string, UserRuntimeProfile> {
  const map = new Map<string, UserRuntimeProfile>();
  for (const profile of profiles ?? []) {
    const normalized = normalizeUserRuntimeProfile(profile, now);
    if (!normalized) continue;
    map.set(normalized.user_id, normalized);
  }
  return map;
}

function formatRecentActiveParticipantsXml(input: {
  chatType: 'direct_message' | 'group';
  recentChannelEntries: readonly SessionEntry[];
  runtimeProfilesByUserId?: ReadonlyMap<string, UserRuntimeProfile>;
}): string {
  if (input.chatType !== 'group') return '';

  const sortedEntries = [...input.recentChannelEntries]
    .filter(entry => (
      entry.role === 'user'
      && trimNonEmptyString(entry.authorId) !== undefined
      && Number.isFinite(entry.timestamp)
    ))
    .sort((left, right) => (
      right.timestamp - left.timestamp
      || right.id - left.id
    ));

  const seenAuthorIds = new Set<string>();
  const participantLines: string[] = [];
  for (const entry of sortedEntries) {
    const authorId = trimNonEmptyString(entry.authorId);
    if (!authorId || seenAuthorIds.has(authorId)) continue;

    seenAuthorIds.add(authorId);
    const profile = input.runtimeProfilesByUserId?.get(authorId);
    participantLines.push(formatXmlEmptyElement('participant', {
      name: trimNonEmptyString(entry.authorName) ?? profile?.display_name ?? authorId,
      id: authorId,
      timezone: profile?.timezone ?? '',
      local_time: profile?.local_time ?? '',
    }));
    if (participantLines.length >= RECENT_ACTIVE_PARTICIPANT_LIMIT) break;
  }

  if (participantLines.length === 0) return '';
  return [
    `<recent_active_participants max="${RECENT_ACTIVE_PARTICIPANT_LIMIT}">`,
    ...participantLines.map(line => `  ${line}`),
    '</recent_active_participants>',
  ].join('\n');
}

export function buildConversationStatePromptVariables(input: {
  message: SubstrateMessage;
  conversationScope: ConversationScope;
  internalTurn: boolean;
  trustLevel: TrustLevel;
  relationshipType?: Contact['relationshipType'];
  now: Date;
  recentChannelEntries?: readonly SessionEntry[];
  currentUserRuntimeProfile?: UserRuntimeProfile;
  recentActiveParticipantRuntimeProfiles?: readonly UserRuntimeProfile[];
}): Record<string, string> {
  if (input.internalTurn) {
    return {
      runtime_conversation_state_available: 'false',
      runtime_chat_type: '',
      runtime_room_id: '',
      runtime_current_message_author_xml: '',
      runtime_current_message_author_name: '',
      runtime_current_message_author_id: '',
      runtime_current_message_author_name_xml_attr: '',
      runtime_current_message_author_id_xml_attr: '',
      runtime_current_message_author_trust_level: '',
      runtime_current_message_author_relationship: '',
      runtime_current_message_author_timezone: '',
      runtime_current_message_author_local_time: '',
      runtime_recent_active_participants_xml: '',
      runtime_recent_active_participants_count: '0',
    };
  }

  const chatType = resolveConversationChatType(input.conversationScope);
  const runtimeProfilesByUserId = buildRuntimeProfileByUserId(
    input.recentActiveParticipantRuntimeProfiles,
    input.now,
  );
  const currentAuthorId = trimNonEmptyString(input.message.authorId) ?? '';
  const currentAuthorName = trimNonEmptyString(input.message.authorName) ?? 'Unknown';
  const normalizedCurrentProfile = normalizeUserRuntimeProfile(input.currentUserRuntimeProfile, input.now);
  const currentProfile = normalizedCurrentProfile?.user_id === currentAuthorId
    ? normalizedCurrentProfile
    : undefined;
  if (currentProfile) {
    runtimeProfilesByUserId.set(currentProfile.user_id, currentProfile);
  }
  const recentActiveParticipantsXml = formatRecentActiveParticipantsXml({
    chatType,
    recentChannelEntries: input.recentChannelEntries ?? [],
    runtimeProfilesByUserId,
  });
  const participantCount = recentActiveParticipantsXml
    ? String((recentActiveParticipantsXml.match(/<participant\b/gu) ?? []).length)
    : '0';
  const currentMessageAuthorXml = formatXmlEmptyElement('current_message_author', {
    name: currentAuthorName,
    id: currentAuthorId,
    trust: input.trustLevel,
    relationship: input.relationshipType ?? '',
    timezone: currentProfile?.timezone ?? '',
    local_time: currentProfile?.local_time ?? '',
  });

  return {
    runtime_conversation_state_available: 'true',
    runtime_chat_type: chatType,
    runtime_room_id: input.message.channelId,
    runtime_current_message_author_xml: currentMessageAuthorXml,
    runtime_current_message_author_name: currentAuthorName,
    runtime_current_message_author_id: currentAuthorId,
    runtime_current_message_author_name_xml_attr: escapeXmlAttribute(currentAuthorName),
    runtime_current_message_author_id_xml_attr: escapeXmlAttribute(currentAuthorId),
    runtime_current_message_author_trust_level: input.trustLevel,
    runtime_current_message_author_relationship: input.relationshipType ?? '',
    runtime_current_message_author_timezone: currentProfile?.timezone ?? '',
    runtime_current_message_author_local_time: currentProfile?.local_time ?? '',
    runtime_recent_active_participants_xml: recentActiveParticipantsXml,
    runtime_recent_active_participants_count: participantCount,
  };
}

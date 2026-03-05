import {
  CHANNEL_PRIVACY_LEVELS,
  VALID_RELATIONSHIP_TYPES,
  type ChannelPrivacyLevel,
  type Contact,
  type ContactChannelLink,
  type ContactIdentityLinkVerification,
  type ContactMutationAuditEntry,
  type ContactMutationAuditQuery,
} from '../../../contacts/types.js';
import type { ContactProfileArtifact } from '../../../memory/store.js';
import type { TrustLevel } from '../../../trust/types.js';
import { escapeHtml } from './shared.js';

interface ContactWithNickname extends Contact {
  nickname?: string;
}

export interface RelatedConversationChannel {
  channel: string;
  channelId: string;
  lastSeen?: string;
}

// ── Trust level badge colors ──
const TRUST_BADGE_COLORS: Record<TrustLevel, string> = {
  primary: '#e8b931',
  trusted: '#4caf50',
  regular: '#2196f3',
  public: '#9e9e9e',
};

function trustBadge(level: TrustLevel): string {
  const color = TRUST_BADGE_COLORS[level];
  const textColor = level === 'primary' ? '#3A3226' : 'white';
  return `<span class="badge" style="background:${color};color:${textColor}">${escapeHtml(level)}</span>`;
}

const CHANNEL_PRIVACY_COLORS: Record<ChannelPrivacyLevel, string> = {
  private: '#4A7C59',
  semi_private: '#8B7355',
  public: '#4A5C8B',
  broadcast: '#C44569',
};

const LINK_VERIFICATION_COLORS: Record<string, string> = {
  pending: '#8B7355',
  verified: '#4A7C59',
  failed: '#A64545',
  expired: '#6C757D',
};

function identityKey(channel: string, userId: string): string {
  return `${channel.trim().toLowerCase()}:${userId.trim().toLowerCase()}`;
}

function resolveContactChannels(contact: Contact): ContactChannelLink[] {
  const resolved: ContactChannelLink[] = [];
  const seen = new Set<string>();

  const addChannel = (channel: ContactChannelLink): void => {
    const key = identityKey(channel.channel, channel.userId);
    if (!channel.channel.trim() || !channel.userId.trim() || seen.has(key)) return;
    resolved.push(channel);
    seen.add(key);
  };

  if (Array.isArray(contact.channels)) {
    for (const channel of contact.channels) {
      addChannel({
        channel: channel.channel,
        userId: channel.userId,
        privacyLevel: channel.privacyLevel,
        firstSeen: channel.firstSeen,
        lastSeen: channel.lastSeen,
      });
    }
  }

  if (Array.isArray(contact.channelIdentities)) {
    for (const identity of contact.channelIdentities) {
      addChannel({
        channel: identity.channel,
        userId: identity.userId,
        privacyLevel: 'semi_private',
        lastSeen: contact.lastSeen,
      });
    }
  }

  return resolved;
}

function getContactNickname(contact: Contact): string | undefined {
  const nickname = (contact as ContactWithNickname).nickname;
  if (typeof nickname !== 'string') return undefined;
  const trimmed = nickname.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getContactDisplayName(contact: Contact): string {
  const trimmed = contact.displayName.trim();
  if (trimmed.length > 0) return trimmed;
  return `contact:${contact.id}`;
}

function contactNicknameLabel(displayName: string, nickname?: string): string {
  if (!nickname) return '';
  if (displayName.trim().toLowerCase() === nickname.trim().toLowerCase()) return '';
  return `<div class="crm-notes">Nickname: ${escapeHtml(nickname)}</div>`;
}

function channelPrivacyBadge(level: ChannelPrivacyLevel): string {
  const color = CHANNEL_PRIVACY_COLORS[level];
  return `<span class="channel-privacy" style="background:${color}">${escapeHtml(level)}</span>`;
}

function linkedIdentityRow(channel: ContactChannelLink): string {
  const descriptor = `${channel.channel}:${channel.userId}`;
  return `<div class="channel-row">
    <span class="channel-chip">${escapeHtml(descriptor)}</span>
    ${channelPrivacyBadge(channel.privacyLevel)}
  </div>`;
}

function linkedIdentityList(channels: ContactChannelLink[]): string {
  if (channels.length === 0) {
    return '<span class="crm-notes">No linked channels</span>';
  }
  return `<div class="channel-list">${channels.map(linkedIdentityRow).join('')}</div>`;
}

function formatLastSeen(lastSeen?: string): string {
  if (!lastSeen) return 'unknown';
  const parsed = Date.parse(lastSeen);
  if (Number.isNaN(parsed)) return lastSeen;
  return new Date(parsed).toLocaleString();
}

function relatedConversationRow(channel: RelatedConversationChannel): string {
  const descriptor = `${channel.channel}:${channel.channelId}`;
  return `<div class="channel-row">
    <span class="channel-chip">${escapeHtml(descriptor)}</span>
    <span class="crm-notes" style="margin-top:0">Last seen: ${escapeHtml(formatLastSeen(channel.lastSeen))}</span>
  </div>`;
}

function relatedConversationList(channels: RelatedConversationChannel[]): string {
  if (channels.length === 0) {
    return '<span class="crm-notes">No related conversation channels</span>';
  }
  return `<div class="channel-list">${channels.map(relatedConversationRow).join('')}</div>`;
}

function profileCard(profile?: ContactProfileArtifact): string {
  if (!profile) {
    return '<div class="crm-profile-empty">No synthesized profile yet</div>';
  }

  const updatedAt = new Date(profile.updatedAt).toLocaleString();
  const sourceIds = profile.sourceMemoryIds.length > 0
    ? profile.sourceMemoryIds.map(id => `<code>${escapeHtml(id)}</code>`).join(', ')
    : 'none';

  return `<div class="crm-profile-card">
    <div class="crm-profile-summary">${escapeHtml(profile.summary)}</div>
    <div class="crm-profile-meta">
      Updated: ${escapeHtml(updatedAt)}<br>
      Source IDs: ${sourceIds}
    </div>
  </div>`;
}

function linkVerificationBadge(status: string): string {
  const color = LINK_VERIFICATION_COLORS[status] ?? '#6C757D';
  return `<span class="channel-privacy" style="background:${color}">${escapeHtml(status)}</span>`;
}

function linkVerificationPanel(verifications: ContactIdentityLinkVerification[]): string {
  if (verifications.length === 0) {
    return '';
  }

  const rows = verifications.slice(0, 10).map((verification) => {
    const summary = [
      `src=${verification.sourceChannel}:${verification.sourceUserId}`,
      `target=${verification.targetChannel}:${verification.targetUserId}`,
      `contact=${verification.contactId}`,
      `nonce=${verification.nonce}`,
      `expires=${verification.expiresAt}`,
      verification.failureReason ? `reason=${verification.failureReason}` : undefined,
    ].filter(Boolean).join(' · ');
    return `<div class="channel-row" style="align-items:flex-start;gap:0.5rem;margin-bottom:0.35rem">
      ${linkVerificationBadge(verification.status)}
      <div style="min-width:0">
        <div style="font-family:'Courier New',monospace;font-size:0.78rem">${escapeHtml(summary)}</div>
      </div>
    </div>`;
  }).join('');

  return `<div class="card" style="margin-bottom:0.9rem">
    <h3 style="margin-top:0">Identity link verifications</h3>
    <div class="crm-notes">Recent challenge state for cross-channel identity claims.</div>
    <div style="margin-top:0.5rem">${rows}</div>
  </div>`;
}

function mutationFieldLabel(field: string): string {
  switch (field) {
    case 'trust_level':
      return 'trust';
    case 'notes':
      return 'notes';
    default:
      return field;
  }
}

function mutationValueLabel(value: string | null): string {
  if (value === null || value.length === 0) return '<em>empty</em>';
  return `<code>${escapeHtml(value)}</code>`;
}

function mutationAuditPanel(
  entries: ContactMutationAuditEntry[],
  query: ContactMutationAuditQuery = {},
): string {
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(Math.floor(query.limit ?? 25), 200)) : 25;
  const field = query.field ?? '';
  const contactId = query.contactId ?? '';
  const actor = query.actor ?? '';

  return `<div class="card" style="margin-bottom:0.9rem">
    <h3 style="margin-top:0">Trust + note mutation audit</h3>
    <div class="crm-notes">Persistent audit trail for trust level and contact note mutations.</div>
    <form
      hx-get="/api/contacts/mutations"
      hx-target="#contact-mutation-audit-list"
      hx-swap="innerHTML"
      style="margin-top:0.65rem"
    >
      <div class="form-row" style="grid-template-columns:1.5fr 1.5fr 1fr auto auto;align-items:end">
        <div class="form-group" style="margin-bottom:0">
          <label for="mutation-contact-id">Contact ID</label>
          <input id="mutation-contact-id" type="text" name="contactId" value="${escapeHtml(contactId)}" placeholder="optional contact id">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label for="mutation-actor">Actor</label>
          <input id="mutation-actor" type="text" name="actor" value="${escapeHtml(actor)}" placeholder="optional actor">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label for="mutation-field">Field</label>
          <select id="mutation-field" name="field">
            <option value=""${field === '' ? ' selected' : ''}>all</option>
            <option value="trust_level"${field === 'trust_level' ? ' selected' : ''}>trust_level</option>
            <option value="notes"${field === 'notes' ? ' selected' : ''}>notes</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label for="mutation-limit">Limit</label>
          <input id="mutation-limit" type="number" name="limit" min="1" max="200" value="${limit}">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <button type="submit" class="btn" style="font-size:0.8rem">Query</button>
        </div>
      </div>
    </form>
    <div id="contact-mutation-audit-list" style="margin-top:0.65rem">
      ${contactMutationAuditFragment(entries)}
    </div>
  </div>`;
}

export function contactMutationAuditFragment(entries: ContactMutationAuditEntry[]): string {
  if (entries.length === 0) {
    return '<div class="crm-notes">No trust/note mutations found.</div>';
  }

  const rows = entries.map((entry) => `
    <tr>
      <td><code>${escapeHtml(entry.contactId)}</code></td>
      <td>${escapeHtml(mutationFieldLabel(entry.field))}</td>
      <td><code>${escapeHtml(entry.actor)}</code></td>
      <td>${mutationValueLabel(entry.oldValue)}</td>
      <td>${mutationValueLabel(entry.newValue)}</td>
      <td>${escapeHtml(formatLastSeen(entry.timestamp))}</td>
    </tr>
  `).join('');

  return `<table>
    <thead>
      <tr>
        <th>Contact</th><th>Field</th><th>Actor</th><th>Old value</th><th>New value</th><th>Timestamp</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function contactsPage(
  contacts: Contact[],
  profilesByContactId: ReadonlyMap<string, ContactProfileArtifact> = new Map(),
  relatedChannelsByContactId: ReadonlyMap<string, RelatedConversationChannel[]> = new Map(),
  verifications: ContactIdentityLinkVerification[] = [],
  mutationAudits: ContactMutationAuditEntry[] = [],
  mutationAuditQuery: ContactMutationAuditQuery = {},
): string {
  const contactTable = contacts.length === 0
    ? '<div class="empty">No visitors have been seen in the garden yet</div>'
    : `<div class="card">
      <table>
        <thead><tr>
          <th>Person</th><th>Linked Identities + Channels</th><th>Relationship + Profile</th><th>Activity</th><th></th>
        </tr></thead>
        <tbody id="contacts-list">${contacts.map(c => contactRow(
          c,
          profilesByContactId.get(c.id),
          relatedChannelsByContactId.get(c.id) ?? [],
        )).join('')}</tbody>
      </table>
    </div>`;

  return `
    ${linkVerificationPanel(verifications)}
    ${mutationAuditPanel(mutationAudits, mutationAuditQuery)}
    ${contactTable}`;
}

export function contactRow(
  c: Contact,
  profile?: ContactProfileArtifact,
  relatedChannels: RelatedConversationChannel[] = [],
): string {
  const displayName = getContactDisplayName(c);
  const channels = resolveContactChannels(c);
  const nickname = getContactNickname(c);
  const fallbackChannels = channels.map(channel => ({
    channel: channel.channel,
    channelId: channel.userId,
    lastSeen: channel.lastSeen,
  }));
  const renderedRelatedChannels = relatedChannels.length > 0 ? relatedChannels : fallbackChannels;
  const firstSeen = new Date(c.firstSeen).toLocaleDateString();
  const lastSeen = new Date(c.lastSeen).toLocaleDateString();
  return `<tr id="contact-row-${escapeHtml(c.id)}">
    <td>
      <div class="crm-person">
        <div><strong>${escapeHtml(displayName)}</strong> ${trustBadge(c.trustLevel)}</div>
        ${contactNicknameLabel(displayName, nickname)}
        <div class="crm-person-id">contact:${escapeHtml(c.id)}</div>
      </div>
    </td>
    <td>
      <div><strong>Linked identities</strong></div>
      ${linkedIdentityList(channels)}
      <div style="margin-top:0.55rem"><strong>Related channels</strong></div>
      ${relatedConversationList(renderedRelatedChannels)}
    </td>
    <td>
      <div><strong>${escapeHtml(c.relationshipType)}</strong></div>
      <div class="crm-notes">${c.notes ? escapeHtml(c.notes) : '<em>No notes</em>'}</div>
      ${profileCard(profile)}
    </td>
    <td class="crm-activity">
      <div>First: ${firstSeen}</div>
      <div>Last: ${lastSeen}</div>
    </td>
    <td><button class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem"
      hx-get="/api/contacts/${encodeURIComponent(c.id)}/edit"
      hx-target="#contact-row-${escapeHtml(c.id)}"
      hx-swap="outerHTML">Edit</button></td>
  </tr>`;
}

export function contactEditForm(contact: Contact): string {
  const displayName = getContactDisplayName(contact);
  const channels = resolveContactChannels(contact);
  const nickname = getContactNickname(contact);
  const trustOptions = (['primary', 'trusted', 'regular', 'public'] as TrustLevel[])
    .map(t => `<option value="${t}"${t === contact.trustLevel ? ' selected' : ''}>${t}</option>`)
    .join('');

  const relOptions = VALID_RELATIONSHIP_TYPES
    .map(r => `<option value="${r}"${r === contact.relationshipType ? ' selected' : ''}>${r}</option>`)
    .join('');

  const channelEditors = channels.length === 0
    ? '<div class="crm-notes">No linked channels available for privacy controls.</div>'
    : channels.map((channel, index) => {
      const privacyOptions = CHANNEL_PRIVACY_LEVELS
        .map(level => `<option value="${level}"${level === channel.privacyLevel ? ' selected' : ''}>${level}</option>`)
        .join('');

      return `
        <div class="form-row" style="grid-template-columns:2fr 1fr;margin-bottom:0.5rem">
          <div class="form-group" style="margin-bottom:0">
            <label>Channel</label>
            <div style="padding:0.5rem 0.75rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-family:'Courier New',monospace;font-size:0.85rem">
              ${escapeHtml(channel.channel)}:${escapeHtml(channel.userId)}
            </div>
            <input type="hidden" name="channel_${index}" value="${escapeHtml(channel.channel)}">
            <input type="hidden" name="channelUserId_${index}" value="${escapeHtml(channel.userId)}">
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Privacy</label>
            <select name="channelPrivacy_${index}">${privacyOptions}</select>
          </div>
        </div>
      `;
    }).join('');

  const addChannelPrivacyOptions = CHANNEL_PRIVACY_LEVELS
    .map(level => `<option value="${level}"${level === 'semi_private' ? ' selected' : ''}>${level}</option>`)
    .join('');

  return `<tr id="contact-row-${escapeHtml(contact.id)}">
    <td colspan="5">
      <form hx-post="/api/contacts/${encodeURIComponent(contact.id)}" hx-target="#contact-row-${escapeHtml(contact.id)}" hx-swap="outerHTML"
        style="padding:0.5rem">
        <input type="hidden" name="channelCount" value="${channels.length}">
        <div class="form-row">
          <div class="form-group">
            <label>Name (stable)</label>
            <input type="text" name="displayName" value="${escapeHtml(displayName)}" required>
          </div>
          <div class="form-group">
            <label>Nickname</label>
            <input type="text" name="nickname" value="${escapeHtml(nickname ?? '')}" placeholder="Optional alias">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Trust Level</label>
            <select name="trustLevel">${trustOptions}</select>
          </div>
          <div class="form-group">
            <label>Relationship</label>
            <select name="relationshipType">${relOptions}</select>
          </div>
        </div>
        <div class="form-group">
          <label>Linked Channels</label>
          ${channelEditors}
        </div>
        <details class="form-group" style="margin-top:0.75rem">
          <summary class="btn" style="width:fit-content;font-size:0.8rem;cursor:pointer">+ Add channel</summary>
          <div style="margin-top:0.65rem">
            <div class="crm-notes" style="margin-top:0">Link another identity to this canonical contact.</div>
            <div class="form-row" style="grid-template-columns:1.5fr 1.5fr 1fr">
              <div class="form-group" style="margin-bottom:0">
                <label>Channel</label>
                <input type="text" name="newChannel" placeholder="e.g. discord">
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label>Channel User ID</label>
                <input type="text" name="newChannelUserId" placeholder="exact user id">
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label>Privacy</label>
                <select name="newChannelPrivacy">${addChannelPrivacyOptions}</select>
              </div>
            </div>
          </div>
        </details>
        <div class="form-group">
          <label>Notes</label>
          <textarea name="notes" rows="3" style="width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:0.9rem;resize:vertical">${escapeHtml(contact.notes ?? '')}</textarea>
        </div>
        <div style="display:flex;gap:0.5rem">
          <button type="submit" class="btn" style="font-size:0.8rem">Save</button>
          <button type="button" class="btn" style="font-size:0.8rem;background:var(--text-muted)"
            hx-get="/api/contacts/list" hx-target="#contacts-list" hx-swap="innerHTML">Cancel</button>
        </div>
      </form>
    </td>
  </tr>`;
}

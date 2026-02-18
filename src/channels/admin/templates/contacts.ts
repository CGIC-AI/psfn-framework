import { CHANNEL_PRIVACY_LEVELS, VALID_RELATIONSHIP_TYPES, type ChannelPrivacyLevel, type Contact, type ContactChannelLink } from '../../../contacts/types.js';
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
  const color = TRUST_BADGE_COLORS[level] ?? '#9e9e9e';
  const textColor = level === 'primary' ? '#3A3226' : 'white';
  return `<span class="badge" style="background:${color};color:${textColor}">${escapeHtml(level)}</span>`;
}

const CHANNEL_PRIVACY_COLORS: Record<ChannelPrivacyLevel, string> = {
  private: '#4A7C59',
  semi_private: '#8B7355',
  public: '#4A5C8B',
  broadcast: '#C44569',
};

function resolveContactChannels(contact: Contact): ContactChannelLink[] {
  if (Array.isArray(contact.channels) && contact.channels.length > 0) {
    return contact.channels;
  }

  if (!Array.isArray(contact.channelIdentities)) return [];
  return contact.channelIdentities.map(identity => ({
    channel: identity.channel,
    userId: identity.userId,
    privacyLevel: 'semi_private',
  }));
}

function getContactNickname(contact: Contact): string | undefined {
  const nickname = (contact as ContactWithNickname).nickname;
  if (typeof nickname !== 'string') return undefined;
  const trimmed = nickname.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function channelPrivacyBadge(level: ChannelPrivacyLevel): string {
  const color = CHANNEL_PRIVACY_COLORS[level] ?? '#8A7E72';
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

export function contactsPage(
  contacts: Contact[],
  profilesByContactId: ReadonlyMap<string, ContactProfileArtifact> = new Map(),
  relatedChannelsByContactId: ReadonlyMap<string, RelatedConversationChannel[]> = new Map(),
): string {
  if (contacts.length === 0) {
    return '<div class="empty">No visitors have been seen in the garden yet</div>';
  }

  const rows = contacts.map(c => contactRow(
    c,
    profilesByContactId.get(c.id),
    relatedChannelsByContactId.get(c.id) ?? [],
  )).join('');
  return `
    <div class="card">
      <table>
        <thead><tr>
          <th>Person</th><th>Linked Identities + Channels</th><th>Relationship + Profile</th><th>Activity</th><th></th>
        </tr></thead>
        <tbody id="contacts-list">${rows}</tbody>
      </table>
    </div>`;
}

export function contactRow(
  c: Contact,
  profile?: ContactProfileArtifact,
  relatedChannels: RelatedConversationChannel[] = [],
): string {
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
        <div><strong>${escapeHtml(c.displayName)}</strong> ${trustBadge(c.trustLevel)}</div>
        ${nickname ? `<div class="crm-notes">aka: ${escapeHtml(nickname)}</div>` : ''}
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

  return `<tr id="contact-row-${escapeHtml(contact.id)}">
    <td colspan="5">
      <form hx-post="/api/contacts/${encodeURIComponent(contact.id)}" hx-target="#contact-row-${escapeHtml(contact.id)}" hx-swap="outerHTML"
        style="padding:0.5rem">
        <input type="hidden" name="channelCount" value="${channels.length}">
        <div class="form-row">
          <div class="form-group">
            <label>Name</label>
            <input type="text" name="displayName" value="${escapeHtml(contact.displayName)}" required>
          </div>
          <div class="form-group">
            <label>Nickname / aka</label>
            <input type="text" name="nickname" value="${escapeHtml(nickname ?? '')}" placeholder="Optional">
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

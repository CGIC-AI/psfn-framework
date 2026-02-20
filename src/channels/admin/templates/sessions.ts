import type { SessionEntry } from '../../../session/types.js';
import type { ChannelInfo } from '../types.js';
import { escapeHtml } from './shared.js';

const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  api: 'API',
  discord: 'Discord',
  'discord-voice': 'Discord Voice',
  internal: 'Internal',
  openwebui: 'OpenWebUI',
  shard: 'Shard',
  sillytavern: 'SillyTavern',
  social: 'Social',
  twitter: 'Twitter',
};

function toChannelTypeLabel(channelType: string): string {
  const normalized = channelType.trim().toLowerCase();
  if (!normalized) return 'Session';
  const mapped = CHANNEL_TYPE_LABELS[normalized];
  if (mapped) return mapped;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function toReadableChannelLabel(channelId: string): string {
  if (DISCORD_CHANNEL_ID_PATTERN.test(channelId)) {
    return `Discord · channel ${channelId}`;
  }

  const separatorIndex = channelId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= channelId.length - 1) return channelId;

  const channelType = channelId.slice(0, separatorIndex);
  const channelName = channelId.slice(separatorIndex + 1);
  const typeLabel = toChannelTypeLabel(channelType);
  return `${typeLabel} · ${channelName}`;
}

function renderLinkedContact(channel: ChannelInfo): string {
  if (!channel.linkedContactId || !channel.linkedContactName) return '';
  const fragment = encodeURIComponent(`contact-row-${channel.linkedContactId}`);
  const viewHref = `/contacts#${fragment}`;
  const editHref = `/api/contacts/${encodeURIComponent(channel.linkedContactId)}/edit`;
  return `<div class="crm-notes">Contact: <a href="${viewHref}">${escapeHtml(channel.linkedContactName)}</a> · <a href="${editHref}">edit</a></div>`;
}

export function sessionListPage(channels: ChannelInfo[]): string {
  if (channels.length === 0) return '<div class="empty">No sessions yet</div>';
  const rows = channels.map(c =>
    `<tr>
      <td>
        <a href="/sessions/${encodeURIComponent(c.channelId)}">${escapeHtml(c.displayLabel ?? toReadableChannelLabel(c.channelId))}</a>
        ${c.displayLabel && c.displayLabel !== c.channelId ? `<div class="session-label-muted">id: ${escapeHtml(c.channelId)}</div>` : ''}
        ${renderLinkedContact(c)}
      </td>
      <td>${c.messageCount}</td>
    </tr>`
  ).join('');

  return `
    <div class="card">
      <table>
        <thead><tr><th>Channel</th><th>Messages</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function sessionMessagesPage(channelId: string, messages: SessionEntry[]): string {
  const msgHtml = messages.length > 0
    ? messages.map(m => messageCard(m)).join('')
    : '<div class="empty">No messages in this session</div>';

  return `
    <p style="margin-bottom:1rem;color:var(--text-muted)">Channel: ${escapeHtml(channelId)} (${messages.length} messages)</p>
    <div id="messages">${msgHtml}</div>
    <a href="/sessions">&larr; Back to Conversation Roots</a>`;
}

export function messageCard(msg: SessionEntry): string {
  const time = new Date(msg.timestamp).toLocaleString();
  const author = msg.authorName ? escapeHtml(msg.authorName) : msg.role;
  return `<div class="message message-${msg.role}">
    <div class="meta">${author} &middot; ${time}</div>
    <div class="content">${escapeHtml(msg.content)}</div>
  </div>`;
}

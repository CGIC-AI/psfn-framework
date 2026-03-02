import type { SessionEntry } from '../../../session/types.js';
import type { ChannelInfo, CompactionAuditView } from '../types.js';
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
  const viewHref = `/legacy/contacts#${fragment}`;
  const editHref = `/api/contacts/${encodeURIComponent(channel.linkedContactId)}/edit`;
  return `<div class="crm-notes">Contact: <a href="${viewHref}">${escapeHtml(channel.linkedContactName)}</a> · <a href="${editHref}">edit</a></div>`;
}

export function sessionListPage(channels: ChannelInfo[]): string {
  if (channels.length === 0) return '<div class="empty">No sessions yet</div>';
  const rows = channels.map(c =>
    `<tr>
      <td>
        <a href="/legacy/sessions/${encodeURIComponent(c.channelId)}">${escapeHtml(c.displayLabel ?? toReadableChannelLabel(c.channelId))}</a>
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

function compactionVerificationLabel(verification: CompactionAuditView['verification']): string {
  switch (verification) {
    case 'verified':
      return 'Verified';
    case 'mismatch':
      return 'Mismatch';
    case 'missing_source':
      return 'Source Missing';
    case 'missing_hash':
    default:
      return 'Hash Missing';
  }
}

function compactionVerificationClass(verification: CompactionAuditView['verification']): string {
  switch (verification) {
    case 'verified':
      return 'compaction-audit-badge-verified';
    case 'mismatch':
      return 'compaction-audit-badge-mismatch';
    case 'missing_source':
      return 'compaction-audit-badge-missing-source';
    case 'missing_hash':
    default:
      return 'compaction-audit-badge-missing-hash';
  }
}

function renderCompactionAuditItem(entry: CompactionAuditView): string {
  const time = new Date(entry.createdAt).toLocaleString();
  const sourceRange = entry.sourceFirstMessageId !== null && entry.sourceLastMessageId !== null
    ? `${entry.sourceFirstMessageId}-${entry.sourceLastMessageId}`
    : 'unknown';
  const sourceHash = entry.sourceHash
    ? `<code>${escapeHtml(entry.sourceHash)}</code>`
    : '<span class="empty">not recorded</span>';
  const sourceCount = entry.sourceMessageCount !== null
    ? `${entry.sourceMessageCount}`
    : 'unknown';

  return `<details class="compaction-audit-item">
    <summary class="compaction-audit-summary-head">
      <span>Summary #${entry.id}</span>
      <span class="compaction-audit-badge ${compactionVerificationClass(entry.verification)}">${compactionVerificationLabel(entry.verification)}</span>
    </summary>
    <div class="compaction-audit-meta">Created ${escapeHtml(time)} • coveredUpTo=${entry.coveredUpTo}</div>
    <div class="compaction-audit-meta">Source ids ${escapeHtml(sourceRange)} • source message count ${escapeHtml(sourceCount)}</div>
    <div class="compaction-audit-meta">Source SHA-256: ${sourceHash}</div>
    <div class="compaction-audit-meta">JSONL verification: ${escapeHtml(entry.verificationDetail)}</div>
    <pre class="compaction-audit-summary">${escapeHtml(entry.summary)}</pre>
  </details>`;
}

function renderCompactionAuditSection(entries: CompactionAuditView[]): string {
  const itemHtml = entries.length > 0
    ? entries.map(entry => renderCompactionAuditItem(entry)).join('')
    : '<div class="empty">No compaction summaries for this channel yet.</div>';

  return `<div class="card">
    <h3 style="margin-top:0">Compaction audit</h3>
    <div class="crm-notes">Click a summary to inspect source material hash metadata and JSONL verification.</div>
    <div class="compaction-audit-list">${itemHtml}</div>
  </div>`;
}

export function sessionMessagesPage(
  channelId: string,
  messages: SessionEntry[],
  compactionAuditEntries: CompactionAuditView[] = [],
): string {
  const msgHtml = messages.length > 0
    ? messages.map(m => messageCard(m)).join('')
    : '<div class="empty">No messages in this session</div>';
  const auditHtml = renderCompactionAuditSection(compactionAuditEntries);

  return `
    <p style="margin-bottom:1rem;color:var(--text-muted)">Channel: ${escapeHtml(channelId)} (${messages.length} messages)</p>
    ${auditHtml}
    <div id="messages">${msgHtml}</div>
    <a href="/legacy/sessions">&larr; Back to Conversation Roots</a>`;
}

export function messageCard(msg: SessionEntry): string {
  const time = new Date(msg.timestamp).toLocaleString();
  const author = msg.authorName ? escapeHtml(msg.authorName) : msg.role;
  return `<div class="message message-${msg.role}">
    <div class="meta">${author} &middot; ${time}</div>
    <div class="content">${escapeHtml(msg.content)}</div>
  </div>`;
}

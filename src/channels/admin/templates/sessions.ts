import type { SessionEntry } from '../../../session/types.js';
import type { ChannelInfo } from '../types.js';
import { escapeHtml } from './shared.js';

export function sessionListPage(channels: ChannelInfo[]): string {
  if (channels.length === 0) return '<div class="empty">No sessions yet</div>';
  const rows = channels.map(c =>
    `<tr>
      <td><a href="/sessions/${encodeURIComponent(c.channelId)}">${escapeHtml(c.channelId)}</a></td>
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

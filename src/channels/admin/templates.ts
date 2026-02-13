// ── Admin GUI HTML Templates ──
// Server-rendered HTML with htmx for interactivity. Garden-themed.

import type { PurrMemory } from '../../memory/types.js';
import type { SessionEntry } from '../../session/types.js';
import type { ScheduledTask } from '../../scheduler/types.js';
import type { ActiveShard } from '../../shards/manager.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type { DashboardStats, ChannelInfo, EnvInfo } from './types.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gardenStyles(): string {
  return `
    :root {
      --episodic: #8B7355;
      --semantic: #4A7C59;
      --emotional: #C44569;
      --procedural: #6C5B7B;
      --reflection: #F7B731;
      --bg: #FAF8F5;
      --bg-card: #FFFFFF;
      --border: #E8E3DC;
      --text: #3A3226;
      --text-muted: #8A7E72;
      --accent: #4A7C59;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .layout {
      display: flex;
      min-height: 100vh;
    }
    nav {
      width: 220px;
      background: #2D2418;
      color: #D4C8B8;
      padding: 1.5rem 1rem;
      flex-shrink: 0;
    }
    nav h1 {
      font-size: 1.1rem;
      color: #F7B731;
      margin-bottom: 0.3rem;
    }
    nav .subtitle {
      font-size: 0.75rem;
      color: #8A7E72;
      margin-bottom: 2rem;
    }
    nav a {
      display: block;
      color: #D4C8B8;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      margin-bottom: 0.25rem;
      font-size: 0.9rem;
    }
    nav a:hover { background: rgba(255,255,255,0.08); text-decoration: none; }
    nav a.active { background: rgba(247,183,49,0.15); color: #F7B731; }

    main {
      flex: 1;
      padding: 2rem;
      max-width: 1100px;
    }
    h2 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      color: var(--text);
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
      text-align: center;
    }
    .stat-card .value {
      font-size: 2rem;
      font-weight: bold;
      color: var(--accent);
    }
    .stat-card .label {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: bold;
      color: white;
    }
    .badge-episodic { background: var(--episodic); }
    .badge-semantic { background: var(--semantic); }
    .badge-emotional { background: var(--emotional); }
    .badge-procedural { background: var(--procedural); }
    .badge-reflection { background: var(--reflection); color: #3A3226; }

    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    th {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    td { font-size: 0.9rem; }

    .message {
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      border-radius: 8px;
      border-left: 3px solid var(--border);
    }
    .message-user { border-left-color: var(--semantic); background: #F0F7F2; }
    .message-assistant { border-left-color: var(--emotional); background: #FFF5F7; }
    .message .meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.3rem;
    }
    .message .content { white-space: pre-wrap; word-break: break-word; }

    .shard-card {
      border-left: 3px solid var(--procedural);
      background: #F5F3F7;
    }

    .event-feed {
      max-height: 500px;
      overflow-y: auto;
      font-family: 'Courier New', monospace;
      font-size: 0.8rem;
      background: #2D2418;
      color: #D4C8B8;
      border-radius: 10px;
      padding: 1rem;
    }
    .event-item {
      padding: 0.3rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .event-item .event-time { color: #8A7E72; }
    .event-item .event-type { color: #F7B731; font-weight: bold; }

    .search-form {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .search-form input {
      flex: 1;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: inherit;
      font-size: 0.9rem;
    }
    .search-form button, .btn {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.9rem;
    }
    .search-form button:hover, .btn:hover { opacity: 0.9; }
    .btn-danger { background: var(--emotional); }

    .config-table td:first-child {
      font-weight: bold;
      width: 200px;
      color: var(--text-muted);
    }

    .empty { color: var(--text-muted); font-style: italic; padding: 2rem; text-align: center; }
  `;
}

export function layout(title: string, body: string, activePage: string): string {
  const navItems = [
    { href: '/', label: 'Dashboard', id: 'dashboard' },
    { href: '/memory', label: 'Memory Blossoms', id: 'memory' },
    { href: '/sessions', label: 'Conversation Roots', id: 'sessions' },
    { href: '/scheduler', label: 'Garden Rhythms', id: 'scheduler' },
    { href: '/shards', label: 'Active Branches', id: 'shards' },
    { href: '/identity', label: 'Identity', id: 'identity' },
    { href: '/settings', label: 'Settings', id: 'settings' },
    { href: '/events', label: 'Garden Pulse', id: 'events' },
  ];

  const navHtml = navItems.map(n =>
    `<a href="${n.href}" class="${n.id === activePage ? 'active' : ''}">${escapeHtml(n.label)}</a>`
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - admin UI</title>
  <style>${gardenStyles()}</style>
  <script src="/static/htmx.min.js"></script>
  <script src="/static/sse.js"></script>
</head>
<body>
  <div class="layout">
    <nav>
      <h1>admin UI</h1>
      <div class="subtitle">substrate management</div>
      ${navHtml}
    </nav>
    <main>
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </main>
  </div>
</body>
</html>`;
}

export function dashboardPage(stats: DashboardStats): string {
  const typeCards = Object.entries(stats.memoryByType)
    .map(([type, count]) =>
      `<div class="stat-card"><div class="value">${count}</div><div class="label"><span class="badge badge-${type}">${type}</span></div></div>`
    ).join('');

  return `
    <div class="stats-grid">
      <div class="stat-card"><div class="value">${stats.memoryTotal}</div><div class="label">Total Memories</div></div>
      <div class="stat-card"><div class="value">${stats.avgSalience.toFixed(2)}</div><div class="label">Avg Salience</div></div>
      <div class="stat-card"><div class="value">${stats.sessionCount}</div><div class="label">Sessions</div></div>
      <div class="stat-card"><div class="value">${stats.schedulerTasks}</div><div class="label">Scheduled Tasks</div></div>
      <div class="stat-card"><div class="value">${stats.activeShards}</div><div class="label">Active Shards</div></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Memory Types</h3>
      <div class="stats-grid">${typeCards || '<div class="empty">No memories yet</div>'}</div>
    </div>`;
}

export function memoryListPage(memories: PurrMemory[]): string {
  const searchForm = `
    <form class="search-form" hx-post="/api/memory/search" hx-target="#memory-results" hx-swap="innerHTML">
      <input type="text" name="query" placeholder="Search memories..." required>
      <button type="submit">Search</button>
    </form>`;

  const tableBody = memories.length > 0
    ? memories.map(m => memoryRow(m)).join('')
    : '<tr><td colspan="6" class="empty">No memories found</td></tr>';

  return `
    ${searchForm}
    <div class="card">
      <table>
        <thead><tr>
          <th>Type</th><th>Text</th><th>Salience</th><th>Importance</th><th>Extracted</th><th></th>
        </tr></thead>
        <tbody id="memory-results">${tableBody}</tbody>
      </table>
    </div>`;
}

export function memoryRow(m: PurrMemory): string {
  const date = new Date(m.extractedAt).toLocaleDateString();
  const truncText = m.text.length > 120 ? escapeHtml(m.text.slice(0, 120)) + '...' : escapeHtml(m.text);
  return `<tr data-memory-type="${m.type}">
    <td><span class="badge badge-${m.type}">${m.type}</span></td>
    <td><a href="/memory/${encodeURIComponent(m.id)}">${truncText}</a></td>
    <td>${m.salience.toFixed(2)}</td>
    <td>${m.importance.toFixed(2)}</td>
    <td>${date}</td>
    <td><button class="btn btn-danger" hx-post="/api/memory/${encodeURIComponent(m.id)}/supersede" hx-confirm="Supersede this memory?" hx-target="closest tr" hx-swap="outerHTML" style="font-size:0.75rem;padding:0.25rem 0.5rem">x</button></td>
  </tr>`;
}

export function memoryDetailPage(m: PurrMemory): string {
  const date = new Date(m.extractedAt).toLocaleString();
  const accessed = new Date(m.lastAccessed).toLocaleString();
  return `
    <div class="card">
      <p><span class="badge badge-${m.type}">${m.type}</span></p>
      <p style="margin:1rem 0;white-space:pre-wrap">${escapeHtml(m.text)}</p>
      <table class="config-table">
        <tr><td>ID</td><td>${escapeHtml(m.id)}</td></tr>
        <tr><td>Salience</td><td>${m.salience.toFixed(3)}</td></tr>
        <tr><td>Importance</td><td>${m.importance.toFixed(3)}</td></tr>
        <tr><td>Confidence</td><td>${m.confidence.toFixed(3)}</td></tr>
        <tr><td>Emotional Valence</td><td>${m.emotionalValence.toFixed(3)}</td></tr>
        <tr><td>Source</td><td>${escapeHtml(m.sourceRef)}</td></tr>
        <tr><td>Extracted</td><td>${date}</td></tr>
        <tr><td>Last Accessed</td><td>${accessed}</td></tr>
        <tr><td>Access Count</td><td>${m.accessCount}</td></tr>
        <tr><td>Tags</td><td>${m.tags.map(t => escapeHtml(t)).join(', ') || 'none'}</td></tr>
        ${m.supersededBy ? `<tr><td>Superseded By</td><td>${escapeHtml(m.supersededBy)}</td></tr>` : ''}
      </table>
    </div>
    <a href="/memory">&larr; Back to Memory Blossoms</a>`;
}

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

export function schedulerPage(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return '<div class="empty">No scheduled tasks</div>';
  const rows = tasks.map(t => taskRow(t)).join('');
  return `
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Interval</th><th>State</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function taskRow(t: ScheduledTask): string {
  const interval = t.type === 'every'
    ? `${Math.round(t.intervalMs / 1000)}s`
    : t.runAt ? new Date(t.runAt).toLocaleString() : '-';
  return `<tr>
    <td>${escapeHtml(t.name)}</td>
    <td>${t.type}</td>
    <td>${interval}</td>
    <td>${t.state}</td>
  </tr>`;
}

export function shardsPage(shards: ActiveShard[]): string {
  if (shards.length === 0) return '<div class="empty">No active branches</div>';
  return shards.map(s => shardCard(s)).join('');
}

export function shardCard(s: ActiveShard): string {
  const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
  return `<div class="card shard-card" data-shard-id="${escapeHtml(s.id)}">
    <strong>${escapeHtml(s.name)}</strong>
    <p style="margin-top:0.3rem;color:var(--text-muted)">${escapeHtml(s.task.slice(0, 200))}</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Running for ${elapsed}s</p>
  </div>`;
}

export function identityPage(card: CharacterCardV2, config: SubstrateConfig): string {
  const d = card.data;
  const maskedConfig: Record<string, string> = {
    'Primary Model': config.primaryModel,
    'Extraction Model': config.extractionModel,
    'Discord Bot ID': config.discordBotId,
    'Data Dir': config.dataDir,
    'Session Limit': String(config.sessionMessageLimit),
    'Memory Retrieval Limit': String(config.memoryRetrievalLimit),
  };

  const configRows = Object.entries(maskedConfig)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  return `
    <div class="card">
      <h3 style="margin-bottom:0.75rem">${escapeHtml(d.name)}</h3>
      <table class="config-table">
        <tr><td>Creator</td><td>${escapeHtml(d.creator)}</td></tr>
        <tr><td>Tags</td><td>${d.tags.map(t => escapeHtml(t)).join(', ')}</td></tr>
      </table>
      <p style="margin-top:1rem;white-space:pre-wrap">${escapeHtml(d.personality.slice(0, 500))}${d.personality.length > 500 ? '...' : ''}</p>
    </div>
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Runtime Configuration</h3>
      <table class="config-table">${configRows}</table>
    </div>`;
}

export function settingsPage(config: SubstrateConfig, envInfo: EnvInfo): string {
  const modelRows: Array<[string, string]> = [
    ['Primary Model', config.primaryModel],
    ['Primary Provider', config.primaryProvider],
    ['Extraction Model', config.extractionModel],
    ['Extraction Provider', config.extractionProvider],
  ];

  const memoryRows: Array<[string, string]> = [
    ['Retrieval Limit', String(config.memoryRetrievalLimit)],
    ['Extraction Interval', `${config.extractionInterval} messages`],
    ['Salience Floor', String(envInfo.salienceFloor)],
    ['Maintenance Interval', `${envInfo.maintenanceIntervalMs / 1000}s`],
  ];

  const sessionRows: Array<[string, string]> = [
    ['Message Limit', String(config.sessionMessageLimit)],
  ];

  const secretKeys: Array<[string, string]> = [
    ['DISCORD_TOKEN', envInfo.discordToken],
    ['API_KEY', envInfo.apiKey],
    ['ADMIN_TOKEN', envInfo.adminToken],
    ['OPENROUTER_API_KEY', envInfo.openrouterApiKey],
    ['LITELLM_BASE_URL', envInfo.litellmBaseUrl],
    ['LITELLM_API_KEY', envInfo.litellmApiKey],
    ['OLLAMA_URL', envInfo.ollamaUrl],
  ];

  function renderSection(title: string, rows: Array<[string, string]>): string {
    const rowsHtml = rows
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
      .join('');
    return `
      <div class="card">
        <h3 style="margin-bottom:0.75rem">${escapeHtml(title)}</h3>
        <table class="config-table">${rowsHtml}</table>
      </div>`;
  }

  const secretsRowsHtml = secretKeys
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  return `
    ${renderSection('Models', modelRows)}
    ${renderSection('Memory', memoryRows)}
    ${renderSection('Sessions', sessionRows)}
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Secrets</h3>
      <table class="config-table">${secretsRowsHtml}</table>
    </div>`;
}

export function eventsPage(): string {
  return `
    <div hx-ext="sse" sse-connect="/events/stream">
      <div class="event-feed" id="event-feed" sse-swap="admin-event" hx-swap="afterbegin">
        <div class="event-item"><span class="event-type">Listening for events...</span></div>
      </div>
    </div>`;
}

export function eventItem(type: string, timestamp: number, payload: Record<string, unknown>): string {
  const time = new Date(timestamp).toLocaleTimeString();
  const details = Object.entries(payload)
    .filter(([k]) => k !== 'type' && k !== 'timestamp')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `<div class="event-item"><span class="event-time">${time}</span> <span class="event-type">${escapeHtml(type)}</span> ${escapeHtml(details)}</div>`;
}

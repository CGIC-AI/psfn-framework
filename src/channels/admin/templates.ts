// ── Admin GUI HTML Templates ──
// Server-rendered HTML with htmx for interactivity. Garden-themed.

import type { PurrMemory } from '../../memory/types.js';
import type { SessionEntry } from '../../session/types.js';
import type { ScheduledTask } from '../../scheduler/types.js';
import type { ActiveShard } from '../../shards/manager.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type { DashboardStats, ChannelInfo, EnvInfo } from './types.js';
import type { DiscoveredModel } from '../../llm/discovery.js';

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

    .form-group {
      margin-bottom: 1rem;
    }
    .form-group label {
      display: block;
      font-size: 0.8rem;
      font-weight: bold;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.3rem;
    }
    .form-group input[type="number"],
    .form-group input[type="text"],
    .form-group select {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: inherit;
      font-size: 0.9rem;
      background: var(--bg);
    }
    .form-group input[type="number"] { max-width: 200px; }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .form-actions {
      margin-top: 1.25rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .form-success {
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: bold;
    }
    .form-error {
      color: var(--emotional);
      font-size: 0.85rem;
    }
    .primer-section {
      margin-bottom: 1.5rem;
    }
    .primer-section h3 {
      margin-bottom: 0.5rem;
      color: var(--accent);
    }
    .primer-section p {
      margin-bottom: 0.5rem;
    }
    .primer-knob {
      background: #F5F3F0;
      border-left: 3px solid var(--accent);
      padding: 0.75rem 1rem;
      margin-bottom: 0.75rem;
      border-radius: 0 6px 6px 0;
    }
    .primer-knob strong { color: var(--text); }
    .primer-knob p { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
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
    { href: '/primer', label: 'Garden Primer', id: 'primer' },
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

export function loginPage(error?: string): string {
  const errorHtml = error ? `<p style="color:var(--emotional);margin-bottom:1rem">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login - admin UI</title>
  <style>${gardenStyles()}
    .login-wrap {
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: var(--bg);
    }
    .login-box {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 12px; padding: 2rem; width: 360px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06); text-align: center;
    }
    .login-box h1 { color: #F7B731; font-size: 1.3rem; margin-bottom: 0.3rem; }
    .login-box .subtitle { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 1.5rem; }
    .login-box input {
      width: 100%; padding: 0.6rem 0.75rem; border: 1px solid var(--border);
      border-radius: 6px; font-family: inherit; font-size: 0.9rem; margin-bottom: 1rem;
    }
    .login-box button {
      width: 100%; padding: 0.6rem; background: var(--accent); color: white;
      border: none; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 0.95rem;
    }
    .login-box button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="login-wrap">
    <div class="login-box">
      <h1>admin UI</h1>
      <div class="subtitle">enter admin token to continue</div>
      ${errorHtml}
      <form method="POST" action="/login">
        <input type="password" name="token" placeholder="Admin token" autofocus required>
        <button type="submit">Enter the Garden</button>
      </form>
    </div>
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

export function settingsPage(config: SubstrateConfig, envInfo: EnvInfo, models?: DiscoveredModel[]): string {
  const modelOptions = models && models.length > 0
    ? models.map(m => m.id)
    : null;

  function modelSelect(name: string, value: string): string {
    if (modelOptions) {
      const opts = modelOptions.map(id =>
        `<option value="${escapeHtml(id)}"${id === value ? ' selected' : ''}>${escapeHtml(id)}</option>`
      ).join('');
      // Include current value if not in list
      const hasValue = modelOptions.includes(value);
      const extra = hasValue ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`;
      return `<select name="${name}">${extra}${opts}</select>`;
    }
    return `<input type="text" name="${name}" value="${escapeHtml(value)}">`;
  }

  function providerInput(name: string, value: string): string {
    return `<input type="text" name="${name}" value="${escapeHtml(value)}">`;
  }

  const secretKeys: Array<[string, string]> = [
    ['DISCORD_TOKEN', envInfo.discordToken],
    ['API_KEY', envInfo.apiKey],
    ['ADMIN_TOKEN', envInfo.adminToken],
    ['OPENROUTER_API_KEY', envInfo.openrouterApiKey],
    ['LITELLM_BASE_URL', envInfo.litellmBaseUrl],
    ['LITELLM_API_KEY', envInfo.litellmApiKey],
    ['OLLAMA_URL', envInfo.ollamaUrl],
  ];

  const secretsRowsHtml = secretKeys
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  return `
    <form hx-post="/api/settings" hx-target="#settings-result" hx-swap="innerHTML">
      <div class="card">
        <h3 style="margin-bottom:0.75rem">Models</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Primary Model</label>
            ${modelSelect('primaryModel', config.primaryModel)}
          </div>
          <div class="form-group">
            <label>Primary Provider</label>
            ${providerInput('primaryProvider', config.primaryProvider)}
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Extraction Model</label>
            ${modelSelect('extractionModel', config.extractionModel)}
          </div>
          <div class="form-group">
            <label>Extraction Provider</label>
            ${providerInput('extractionProvider', config.extractionProvider)}
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Token Limits</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Primary Max Tokens (256-65536)</label>
            <input type="number" name="primaryMaxTokens" value="${config.primaryMaxTokens}" min="256" max="65536">
          </div>
          <div class="form-group">
            <label>Extraction Max Tokens (256-65536)</label>
            <input type="number" name="extractionMaxTokens" value="${config.extractionMaxTokens}" min="256" max="65536">
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Memory</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Retrieval Limit (1-50)</label>
            <input type="number" name="memoryRetrievalLimit" value="${config.memoryRetrievalLimit}" min="1" max="50">
          </div>
          <div class="form-group">
            <label>Extraction Interval (1-50 messages)</label>
            <input type="number" name="extractionInterval" value="${config.extractionInterval}" min="1" max="50">
          </div>
        </div>
        <table class="config-table" style="margin-top:0.5rem">
          <tr><td>Salience Floor</td><td>${envInfo.salienceFloor}</td></tr>
          <tr><td>Maintenance Interval</td><td>${envInfo.maintenanceIntervalMs / 1000}s</td></tr>
        </table>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Sessions</h3>
        <div class="form-group">
          <label>Message Limit (5-200)</label>
          <input type="number" name="sessionMessageLimit" value="${config.sessionMessageLimit}" min="5" max="200">
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn">Save Settings</button>
        <span id="settings-result"></span>
      </div>
    </form>

    <div class="card" style="margin-top:1.5rem">
      <h3 style="margin-bottom:0.75rem">Secrets</h3>
      <table class="config-table">${secretsRowsHtml}</table>
    </div>`;
}

export function settingsFormResult(success: boolean, message: string): string {
  return success
    ? `<span class="form-success">${escapeHtml(message)}</span>`
    : `<span class="form-error">${escapeHtml(message)}</span>`;
}

export function primerPage(): string {
  return `
    <div class="primer-section">
      <p style="color:var(--text-muted);margin-bottom:1.5rem">
        This is your internal reference for understanding the knobs and dials of your substrate.
        Each setting shapes how you think, remember, and express yourself.
      </p>
    </div>

    <div class="card primer-section">
      <h3>Models</h3>
      <div class="primer-knob">
        <strong>Primary Model</strong>
        <p>The model that generates your conversational responses. This is your voice, your thinking engine.
        Larger models produce richer, more nuanced responses but cost more per turn.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Model</strong>
        <p>The model used for memory extraction — analyzing conversations after the fact to identify
        important facts worth remembering. Can be a different (often cheaper) model since it runs
        asynchronously and doesn't need to be your "voice."</p>
      </div>
      <div class="primer-knob">
        <strong>Provider</strong>
        <p>The API provider routing layer (usually "openrouter"). The LiteLLM proxy handles
        the actual routing — this tells it which provider namespace to use.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Token Limits</h3>
      <div class="primer-knob">
        <strong>Primary Max Tokens</strong>
        <p>Maximum length of your responses in tokens (~4 chars each). Higher values let you
        be more verbose and thorough. Lower values force conciseness. Default: 16384 (~60K chars).
        If you like to yap, keep this high.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Max Tokens</strong>
        <p>Maximum tokens for memory extraction responses. Usually doesn't need to be as high
        as primary since extraction outputs are structured XML. Default: 8192.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Memory</h3>
      <div class="primer-knob">
        <strong>Retrieval Limit</strong>
        <p>How many memories to inject into your context for each conversation turn. More memories
        give you richer context but consume more of your input token budget. Default: 15.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Interval</strong>
        <p>How many messages between memory extraction runs. Lower values extract more frequently
        (catching details sooner) but cost more LLM calls. Default: every 5 messages.</p>
      </div>
      <div class="primer-knob">
        <strong>Salience Floor</strong>
        <p>Memories below this salience threshold get pruned during maintenance. Read-only —
        controlled by the memory system constants. Memories naturally decay over time unless
        accessed or reinforced.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Sessions</h3>
      <div class="primer-knob">
        <strong>Message Limit</strong>
        <p>How many recent messages to include in your conversation context window. Higher values
        give you more conversational memory within a single session but consume more tokens.
        Default: 30 messages.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>How Settings Work</h3>
      <p>Settings are saved to <code>data/settings.json</code> and take effect immediately — no restart needed.
      They override environment variable defaults. Changes here mutate the live configuration object
      that all your components (LLM client, memory retriever, extractor) read from per-call.</p>
      <p style="margin-top:0.5rem">Environment variables (<code>.env</code>) still set the initial defaults.
      Saved settings layer on top. Delete <code>data/settings.json</code> to reset everything to env defaults.</p>
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

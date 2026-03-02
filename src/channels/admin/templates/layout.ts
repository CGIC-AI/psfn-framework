import { escapeHtml } from './shared.js';

const LEGACY_PREFIX = '/legacy';

const navItems = [
  { href: LEGACY_PREFIX, label: 'Dashboard', id: 'dashboard' },
  { href: `${LEGACY_PREFIX}/memory`, label: 'Memory Blossoms', id: 'memory' },
  { href: `${LEGACY_PREFIX}/sessions`, label: 'Conversation Roots', id: 'sessions' },
  { href: `${LEGACY_PREFIX}/scheduler`, label: 'Garden Rhythms', id: 'scheduler' },
  { href: `${LEGACY_PREFIX}/shards`, label: 'Active Branches', id: 'shards' },
  { href: `${LEGACY_PREFIX}/contacts`, label: 'Garden Visitors', id: 'contacts' },
  { href: `${LEGACY_PREFIX}/chat`, label: 'Garden Chat', id: 'chat' },
  { href: `${LEGACY_PREFIX}/confirmations`, label: 'Confirmations', id: 'confirmations' },
  { href: `${LEGACY_PREFIX}/identity`, label: 'Identity', id: 'identity' },
  { href: `${LEGACY_PREFIX}/settings`, label: 'Settings', id: 'settings' },
  { href: `${LEGACY_PREFIX}/skills`, label: 'Skills', id: 'skills' },
  { href: `${LEGACY_PREFIX}/prompts`, label: 'Prompt Soil', id: 'prompts' },
  { href: `${LEGACY_PREFIX}/primer`, label: 'Garden Primer', id: 'primer' },
  { href: `${LEGACY_PREFIX}/values`, label: 'Values Timeline', id: 'values' },
  { href: `${LEGACY_PREFIX}/events`, label: 'Audit Timeline', id: 'events' },
];

export function layout(title: string, body: string, activePage: string): string {
  const navHtml = navItems.map(n =>
    `<a href="${n.href}" class="${n.id === activePage ? 'active' : ''}">${escapeHtml(n.label)}</a>`
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - admin UI</title>
  <link rel="stylesheet" href="/static/admin.css">
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
  <link rel="stylesheet" href="/static/admin.css">
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

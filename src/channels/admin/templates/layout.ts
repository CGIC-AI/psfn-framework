import { escapeHtml } from './shared.js';

const navItems = [
  { href: '/', label: 'Dashboard', id: 'dashboard' },
  { href: '/memory', label: 'Memory Blossoms', id: 'memory' },
  { href: '/sessions', label: 'Conversation Roots', id: 'sessions' },
  { href: '/scheduler', label: 'Garden Rhythms', id: 'scheduler' },
  { href: '/shards', label: 'Active Branches', id: 'shards' },
  { href: '/contacts', label: 'Garden Visitors', id: 'contacts' },
  { href: '/chat', label: 'Garden Chat', id: 'chat' },
  { href: '/identity', label: 'Identity', id: 'identity' },
  { href: '/settings', label: 'Settings', id: 'settings' },
  { href: '/skills', label: 'Skills', id: 'skills' },
  { href: '/prompts', label: 'Prompt Soil', id: 'prompts' },
  { href: '/primer', label: 'Garden Primer', id: 'primer' },
  { href: '/events', label: 'Garden Pulse', id: 'events' },
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

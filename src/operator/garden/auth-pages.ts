import type { ServerResponse } from 'node:http';
import { formatPossessiveCompanionName } from '../../core/identity/companion-naming.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import { sendText } from '../../channels/backplane/http/primitives.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

export function resolveGardenTitle(config: SubstrateConfig): string {
  const companionName = resolveCompanionNameFromConfig(config);
  return `${formatPossessiveCompanionName(companionName)} Garden`;
}

function loginPage(gardenTitle: string, error?: string): string {
  const errorBlock = error
    ? `<p style="color:#b42318;margin:0 0 12px 0">${escapeHtml(error)}</p>`
    : '';
  const escapedGardenTitle = escapeHtml(gardenTitle);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login - ${escapedGardenTitle}</title>
  </head>
  <body style="font-family:system-ui,sans-serif;max-width:420px;margin:5rem auto;padding:0 1rem">
    <h1 style="margin:0 0 0.5rem 0">${escapedGardenTitle}</h1>
    <p style="margin:0 0 1rem 0;color:#666">Enter your admin token to continue.</p>
    ${errorBlock}
    <form method="POST" action="/login">
      <label for="token">Admin token</label><br>
      <input id="token" name="token" type="password" autocomplete="current-password" style="margin-top:0.5rem;width:100%;padding:0.5rem">
      <button type="submit" style="margin-top:1rem;padding:0.5rem 1rem">Sign in</button>
    </form>
  </body>
</html>`;
}

export function sendGardenLoginPage(
  res: ServerResponse,
  config: SubstrateConfig,
  error?: string,
  status: number = 200,
): void {
  sendText(
    res,
    status,
    loginPage(resolveGardenTitle(config), error),
    {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    },
  );
}

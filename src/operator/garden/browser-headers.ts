import { createHash } from 'node:crypto';

/** Hash the static Svelte bootstrap instead of allowing arbitrary inline scripts. */
export function gardenBrowserCsp(html = '', publicOrigin?: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`);
  return [
    "default-src 'self'", `script-src 'self' ${scripts.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:",
    "media-src 'self' blob:", `connect-src 'self'${publicOrigin ? ` ${publicOrigin.replace(/^https:/, 'wss:')}` : ''}`, "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

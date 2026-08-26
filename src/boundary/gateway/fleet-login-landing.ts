import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { escapeHtml } from '../../shared/utils/escaping.js';
import type { FleetLocalOperatorLoginRegistration } from './fleet-local-operator-login.js';

export interface FleetBreakGlassLoginRegistration {
  /**
   * A same-origin path owned by a separately configured emergency login
   * mechanism. Merely having a recovery or elevated-assurance route does not
   * qualify it for this registration.
   */
  readonly loginPath: string;
}

const DISCORD_LOGIN_PATH = '/v1/fleet-auth/login?return_to=%2Ffleet';
const VALIDATION_ORIGIN = 'https://fleet-login.invalid';

/**
 * The Garden login language translated into the gateway's zero-script,
 * zero-remote-asset boundary. Tokens mirror the Garden theme: canvas #FAF8F3,
 * surface #FFFFFF, sunken #F4F1E8, line #E6E0D2, ink #26231E, muted #7C7364,
 * gold accents, serif display headings with local-font fallbacks only.
 */
const PAGE_STYLE = `
:root {
  color-scheme: light;
  --canvas: #faf8f3;
  --surface: #ffffff;
  --sunken: #f4f1e8;
  --line: #e6e0d2;
  --ink: #26231e;
  --muted: #7c7364;
  --gold-50: #fbf5e4;
  --gold-300: #dfc372;
  --gold-600: #9e7b1d;
  --discord: #5865f2;
  --discord-hover: #4752c4;
  --font-display: "Fraunces", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-width: 320px;
  min-height: 100vh;
  background:
    radial-gradient(52% 38% at 82% 12%, rgba(194, 154, 43, 0.08), rgba(194, 154, 43, 0) 72%),
    radial-gradient(40% 34% at 12% 86%, rgba(79, 122, 82, 0.07), rgba(79, 122, 82, 0) 72%),
    var(--canvas);
  color: var(--ink);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
main {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 48px 20px;
}
.login {
  width: min(100%, 440px);
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(38, 35, 30, 0.04), 0 1px 12px rgba(38, 35, 30, 0.03);
  padding: 40px 36px 32px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mark {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid rgba(223, 195, 114, 0.7);
  border-radius: 12px;
  background: var(--gold-50);
  color: var(--gold-600);
  font-family: var(--font-display);
  font-size: 18px;
}
.wordmark {
  font-family: var(--font-display);
  font-size: 18px;
  line-height: 1.2;
}
.product {
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}
.rule {
  height: 1px;
  margin: 28px 0;
  background: linear-gradient(to right, var(--gold-300), var(--line), rgba(230, 224, 210, 0));
}
h1 {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: clamp(28px, 7vw, 36px);
  font-weight: 600;
  line-height: 1.15;
}
.intro {
  margin: 10px 0 28px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.6;
}
.primary {
  display: flex;
  width: 100%;
  min-height: 52px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-radius: 12px;
  background: var(--discord);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  box-shadow: 0 1px 2px rgba(38, 35, 30, 0.04), 0 1px 12px rgba(38, 35, 30, 0.03);
  transition: background-color 140ms ease;
}
.primary:hover { background: var(--discord-hover); }
.primary:focus-visible, .emergency a:focus-visible {
  outline: 2px solid var(--gold-600);
  outline-offset: 3px;
}
.privacy {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 14px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.privacy svg { flex: none; }
.emergency {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  text-align: center;
}
.emergency a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  text-underline-offset: 3px;
}
.emergency a:hover { color: var(--ink); }
@media (max-width: 420px) {
  main { padding: 24px 14px; }
  .login { padding: 28px 20px 24px; }
}
@media (prefers-reduced-motion: reduce) {
  .primary, .emergency a { transition: none; }
}
`;
const STYLE_HASH = createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64');
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
].join('; ');

function validateLoginPath(loginPath: string): void {
  if (!loginPath.startsWith('/')
    || loginPath.startsWith('//')
    || loginPath.includes('\\')
    || /[\u0000-\u0020\u007f]/u.test(loginPath)) {
    throw new Error('Fleet break-glass login registration requires a strict same-origin path');
  }
  const parsed = new URL(loginPath, VALIDATION_ORIGIN);
  if (parsed.origin !== VALIDATION_ORIGIN
    || parsed.hash
    || `${parsed.pathname}${parsed.search}` !== loginPath) {
    throw new Error('Fleet break-glass login registration requires a strict same-origin path');
  }
}

const LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const DISCORD_MARK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.79.037c-.211.375-.445.865-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.65 12.65 0 0 0-.617-1.25.077.077 0 0 0-.079-.036c-1.714.29-3.354.8-4.885 1.515a.07.07 0 0 0-.32.027C.533 9.045-.32 13.579.099 18.057a.082.082 0 0 0 .31.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .79.009c.12.099.245.198.372.292a.077.077 0 0 1-.6.127c-.598.35-1.22.645-1.873.891a.077.077 0 0 0-.41.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .84.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.182 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.946 2.418-2.157 2.418Z"/></svg>';

function pageBody(
  registration?: FleetBreakGlassLoginRegistration,
  localOperatorLogin?: FleetLocalOperatorLoginRegistration,
): Buffer {
  if (registration) validateLoginPath(registration.loginPath);
  if (localOperatorLogin) validateLoginPath(localOperatorLogin.loginPath);
  const breakGlass = registration
    ? `
      <div class="emergency">
        <a href="${escapeHtml(registration.loginPath)}">Emergency administrator login</a>
      </div>`
    : '';
  const primaryLogin = localOperatorLogin
    ? `<a class="primary" href="${escapeHtml(localOperatorLogin.loginPath)}"><span>Sign in with admin token</span></a>
      <p class="privacy">${LOCK_ICON}<span>The token is exchanged locally for a bounded operator session.</span></p>
      <div class="emergency"><a href="${DISCORD_LOGIN_PATH}">Login with Discord</a></div>`
    : `<a class="primary" href="${DISCORD_LOGIN_PATH}">${DISCORD_MARK}<span>Login with Discord</span></a>
      <p class="privacy">${LOCK_ICON}<span>Authentication is handled securely through Discord.</span></p>`;
  const introduction = localOperatorLogin
    ? 'Use the administrator token configured for this local cluster.'
    : 'Sign in to continue to the PSFN Cluster Portal. Operator identity is verified through Discord, then bound to your session.';
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Sign in · PSFN Cluster Portal</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <section class="login" aria-labelledby="login-title">
      <div class="brand" aria-label="PSFN Cluster Portal">
        <span class="mark" aria-hidden="true">P</span>
        <div>
          <div class="wordmark">PSFN</div>
          <div class="product">Cluster Portal</div>
        </div>
      </div>
      <div class="rule" aria-hidden="true"></div>
      <h1 id="login-title">Welcome back.</h1>
      <p class="intro">${introduction}</p>
      ${primaryLogin}${breakGlass}
    </section>
  </main>
</body>
</html>`, 'utf8');
}

export class GatewayFleetLoginLanding {
  private readonly body: Buffer;

  constructor(
    registration?: FleetBreakGlassLoginRegistration,
    localOperatorLogin?: FleetLocalOperatorLoginRegistration,
  ) {
    this.body = pageBody(registration, localOperatorLogin);
  }

  send(response: ServerResponse): void {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': String(this.body.byteLength),
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      Expires: '0',
      'Permissions-Policy': 'camera=(), display-capture=(), geolocation=(), microphone=()',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    response.end(this.body);
  }
}

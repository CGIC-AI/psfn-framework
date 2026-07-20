import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { escapeHtml } from '../../shared/utils/escaping.js';

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
const PAGE_STYLE = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #fff;
  color: #191a23;
}
* { box-sizing: border-box; }
body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background: #fff;
}
main {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px 20px;
}
.login {
  width: min(100%, 420px);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 44px;
}
.mark {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid #d8d9e0;
  border-radius: 12px;
  background: #f7f7f9;
  color: #24252f;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .08em;
}
.wordmark {
  font-size: 18px;
  font-weight: 750;
  letter-spacing: -.02em;
}
.product {
  margin-top: 2px;
  color: #6c6e7b;
  font-size: 13px;
}
h1 {
  margin: 0;
  color: #171821;
  font-size: clamp(30px, 8vw, 40px);
  font-weight: 700;
  letter-spacing: -.04em;
  line-height: 1.08;
}
.intro {
  margin: 16px 0 30px;
  color: #626471;
  font-size: 16px;
  line-height: 1.6;
}
.primary {
  display: flex;
  width: 100%;
  min-height: 52px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: #5865f2;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  text-decoration: none;
  transition: background-color 140ms ease, transform 140ms ease;
}
.primary:hover { background: #4752c4; }
.primary:active { transform: translateY(1px); }
.primary:focus-visible, .emergency a:focus-visible {
  outline: 3px solid #aeb5ff;
  outline-offset: 3px;
}
.privacy {
  margin: 18px 0 0;
  color: #898b96;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
.emergency {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid #ececf0;
  text-align: center;
}
.emergency a {
  color: #575966;
  font-size: 13px;
  font-weight: 650;
  text-underline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .primary { transition: none; }
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

function pageBody(registration?: FleetBreakGlassLoginRegistration): Buffer {
  if (registration) validateLoginPath(registration.loginPath);
  const breakGlass = registration
    ? `
      <div class="emergency">
        <a href="${escapeHtml(registration.loginPath)}">Emergency administrator login</a>
      </div>`
    : '';
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Sign in · PSFN Fleet Portal</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <section class="login" aria-labelledby="login-title">
      <div class="brand" aria-label="PSFN Fleet Portal">
        <span class="mark" aria-hidden="true">PSFN</span>
        <div>
          <div class="wordmark">PSFN</div>
          <div class="product">Fleet Portal</div>
        </div>
      </div>
      <h1 id="login-title">Welcome back.</h1>
      <p class="intro">Sign in to continue to the PSFN Fleet Portal.</p>
      <a class="primary" href="${DISCORD_LOGIN_PATH}">Login with Discord</a>
      <p class="privacy">Authentication is handled securely through Discord.</p>${breakGlass}
    </section>
  </main>
</body>
</html>`, 'utf8');
}

export class GatewayFleetLoginLanding {
  private readonly body: Buffer;

  constructor(registration?: FleetBreakGlassLoginRegistration) {
    this.body = pageBody(registration);
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
